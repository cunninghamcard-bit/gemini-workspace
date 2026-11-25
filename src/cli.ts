#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { satisfies } from "semver";
import { AgyBridge } from "./agy-bridge.js";
import { codeModeToolDefinitions } from "./code-mode.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createServer } from "./server.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { discoverLocalSkills } from "./skills.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValue,
  writeDevspaceAuth,
  writeDevspaceConfig,
} from "./user-config.js";
import { DEVSPACE_VERSION } from "./version.js";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "config"
  | "help"
  | "version";

const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = (require("../package.json") as { engines: { node: string } }).engines.node;

async function main(argv: string[]): Promise<void> {
  if (!satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) {
    throw new Error(
      `Unsupported Node.js ${process.versions.node}. Supported range: ${SUPPORTED_NODE_RANGE}`,
    );
  }

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await runServe();
      return;
    case "init":
      runInit(args);
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      console.log(DEVSPACE_VERSION);
      return;
  }
}

function normalizeCommand(raw: string | undefined): Command {
  if (!raw || raw === "serve" || raw === "start") return "serve";
  if (raw === "init" || raw === "doctor" || raw === "config") return raw;
  if (raw === "help" || raw === "--help" || raw === "-h") return "help";
  if (raw === "version" || raw === "--version" || raw === "-v") return "version";
  throw new Error(`Unknown command: ${raw}`);
}

async function runServe(): Promise<void> {
  const { app, config, close } = await createServer();
  const httpServer = app.listen(config.listenPort, config.host, () => {
    console.log(`gemini-workspace agy-bridge listening on http://${config.host}:${config.listenPort}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`agy binary: ${config.agy.bin}`);
    console.log(`agy workspace: ${config.agy.workspace}`);
    console.log(`exposed tools: ${config.agy.exposedTools.join(", ")}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownHttpServer(httpServer, close)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("gemini-workspace shutdown failed", error);
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function runInit(args: string[]): void {
  const files = loadDevspaceFiles();
  let publicUrl: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--public-url" && args[i + 1]) {
      publicUrl = args[i + 1];
      i += 1;
    }
  }

  if (!files.configExists) {
    writeDevspaceConfig({
      configVersion: 1,
      server: publicUrl ? { publicBaseUrl: publicUrl } : {},
    });
  } else if (publicUrl) {
    setDevspaceConfigValue(["server", "publicBaseUrl"], publicUrl);
  }

  if (!files.auth.ownerToken) {
    const token = generateOwnerToken();
    const authPath = writeDevspaceAuth({ ownerToken: token });
    console.log(`Generated owner token in ${authPath}`);
  } else {
    console.log(`Existing owner token preserved in ${files.authPath}`);
  }
}

async function runDoctor(): Promise<void> {
  const config = loadConfig();
  console.log(`config dir:      ${config.configDir}`);
  console.log(`state dir:       ${config.stateDir}`);
  console.log(`listen:          http://${config.host}:${config.listenPort}/mcp`);
  console.log(`public base url: ${config.publicBaseUrl}`);
  console.log(`agy workspace:   ${config.agy.workspace}`);
  console.log(`agy state dir:   ${config.agy.agyHome}`);

  if (existsSync(config.agy.bin)) {
    try {
      const agyVersion = execFileSync(config.agy.bin, ["--version"], { encoding: "utf8" }).trim();
      console.log(`agy binary:      ${config.agy.bin} (v${agyVersion}; native engine active)`);
    } catch {
      console.log(`agy binary:      ${config.agy.bin} (native engine active)`);
    }
  } else {
    console.log(`agy binary:      not installed (using built-in deterministic agy 1.5.10 engine)`);
  }

  const db = openDatabase(config.stateDir);
  try {
    const clientCount = (
      db.sqlite.prepare("select count(*) as n from oauth_clients").get() as { n: number }
    ).n;
    const refreshCount = (
      db.sqlite.prepare("select count(*) as n from oauth_refresh_tokens").get() as { n: number }
    ).n;
    console.log(`oauth db:        ok (${clientCount} client(s), ${refreshCount} refresh token(s))`);
  } finally {
    db.close();
  }

  const skills = discoverLocalSkills(config.skills);
  console.log(`local skills:    ${skills.length} discovered (${skills.slice(0, 6).map((s) => s.name).join(", ")}${skills.length > 6 ? ", …" : ""})`);
  console.log(`code mode:       ${config.codeMode.enabled ? "enabled (execute, poll_execution, cancel_execution)" : "disabled"}`);
  console.log(`activity /web:   ${config.ui.enabled ? `${config.publicBaseUrl}/web/` : "disabled"}`);

  const bridge = new AgyBridge(config.agy, { ...config.logging, level: "error" });
  try {
    await bridge.start();
    const tools = [
      ...(await bridge.listTools()),
      ...(config.codeMode.enabled ? codeModeToolDefinitions(config.agy.holdMs) : []),
    ];
    console.log(`mcp tools:       ok (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`);
  } finally {
    await bridge.close();
  }
}

function runConfigCommand(args: string[]): void {
  const [sub, key, rawVal] = args;
  const files = loadDevspaceFiles();
  if (!sub || sub === "show" || sub === "path") {
    console.log(files.configPath);
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }
  if (sub === "set" && key && rawVal !== undefined) {
    let parsed: unknown = rawVal;
    try {
      parsed = JSON.parse(rawVal);
    } catch {
      // treat as string
    }
    const updatedPath = setDevspaceConfigValue(key.split("."), parsed as Record<string, unknown>);
    console.log(`Updated ${updatedPath}`);
    return;
  }
  throw new Error("Usage: gemini-workspace config [show | set <dot.path> <json-or-string>]");
}

function printHelp(): void {
  console.log(
    [
      "gemini-workspace — Gemini Web AGY MCP Bridge",
      "",
      "Commands:",
      "  gemini-workspace serve              Start the OAuth + AGY MCP bridge server",
      "  gemini-workspace doctor             Verify config, OAuth SQLite state, and live agy bridge tools",
      "  gemini-workspace init [--public-url <url>]  Initialize config.jsonc and owner password",
      "  gemini-workspace config [show | set <key> <value>]",
      "  gemini-workspace version",
    ].join("\n"),
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
