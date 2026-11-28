import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgyBridge } from "./agy-bridge.js";
import { CodeModeManager } from "./code-mode.js";
import type { ServerConfig } from "./config.js";
import { createStdioMcpServer } from "./stdio-server.js";

interface StdioHarness {
  client: Client;
  root: string;
  close(): Promise<void>;
}

function buildConfig(root: string, codeModeEnabled: boolean): ServerConfig {
  const workspace = join(root, "workspace");
  return {
    configDir: root,
    stateDir: join(root, "state"),
    host: "127.0.0.1",
    port: 0,
    listenPort: 0,
    publicBaseUrl: "http://127.0.0.1:19999",
    allowedHosts: ["127.0.0.1", "localhost"],
    oauth: {
      ownerToken: "test-owner-password-at-least-16-chars",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86_400,
      refreshTokenGraceSeconds: 300,
      scopes: ["devspace"],
      allowedResourceUrls: [],
      allowedRedirectHosts: ["localhost", "127.0.0.1"],
    },
    agy: {
      bin: "/nonexistent/agy-binary-not-required",
      workspace,
      agyHome: join(root, "agy-home"),
      modelId: "gemini-3.1-pro-preview",
      wireProtocol: "genai",
      holdMs: 400,
      callTimeoutMs: 10_000,
      maxTurnsPerSession: 80,
      sessionIdleTtlMs: 600_000,
      exposedTools: ["read_file", "write_file", "edit_file", "run_command", "manage_task"],
    },
    skills: { enabled: false, paths: [] },
    codeMode: { enabled: codeModeEnabled },
    ui: { enabled: false },
    activity: { enabled: false, maxCalls: 200 },
    logging: {
      level: "error",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

async function startStdioHarness(codeModeEnabled: boolean): Promise<StdioHarness> {
  const root = await mkdtemp(join(tmpdir(), "devspace-stdio-"));
  const config = buildConfig(root, codeModeEnabled);
  await mkdir(config.agy.workspace, { recursive: true });
  await mkdir(config.agy.agyHome, { recursive: true, mode: 0o700 });

  const bridge = new AgyBridge(config.agy, config.logging);
  await bridge.start();

  const codeMode = codeModeEnabled
    ? new CodeModeManager(bridge, config.agy.holdMs)
    : undefined;

  const server = createStdioMcpServer({ config, bridge, codeMode });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "stdio-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    root,
    close: async () => {
      await client.close();
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("stdio server exposes the agy tools plus code mode tools", async () => {
  const harness = await startStdioHarness(true);

  try {
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "cancel_execution",
      "edit_file",
      "execute",
      "manage_task",
      "poll_execution",
      "read_file",
      "run_command",
      "write_file",
    ]);
    assert.ok(
      !names.includes("ask_question"),
      "ask_question is intentionally never exposed over MCP",
    );
  } finally {
    await harness.close();
  }
});

test("stdio server omits code mode tools when the feature is disabled", async () => {
  const harness = await startStdioHarness(false);

  try {
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "edit_file",
      "manage_task",
      "read_file",
      "run_command",
      "write_file",
    ]);
  } finally {
    await harness.close();
  }
});

test("stdio server annotates tools so clients can distinguish reads from writes", async () => {
  const harness = await startStdioHarness(true);

  try {
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    assert.deepEqual(byName.get("poll_execution")?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    // read_file must keep prompting: file reads are not bounded by agy.workspace.
    assert.deepEqual(byName.get("read_file")?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });

    for (const name of ["write_file", "edit_file", "run_command", "manage_task"]) {
      assert.equal(
        byName.get(name)?.annotations?.readOnlyHint,
        false,
        `${name} must not claim to be read-only`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("stdio server serves tool calls through the in-process bridge", async () => {
  const harness = await startStdioHarness(true);

  try {
    const filePath = join(harness.root, "workspace", "note.txt");
    await writeFile(filePath, "alpha\nbravo\ncharlie\n", "utf8");

    const result = await harness.client.callTool({
      name: "read_file",
      arguments: { Path: filePath, StartLine: 1, EndLine: 2 },
    });

    assert.notEqual(result.isError, true, `unexpected tool error: ${JSON.stringify(result)}`);

    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    assert.match(text, /alpha/);
    assert.match(text, /bravo/);
    assert.doesNotMatch(text, /charlie/, "EndLine must bound the returned range");
  } finally {
    await harness.close();
  }
});
