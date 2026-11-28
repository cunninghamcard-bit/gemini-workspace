#!/usr/bin/env node
/**
 * stdio entry — for Gemini desktop app "本地 MCP / Local MCP".
 *
 * The Gemini desktop app spawns this process and speaks JSON-RPC over
 * stdin/stdout. gemini-space upstream only ships an HTTP+OAuth server, so this
 * entry bypasses Express/OAuth entirely and drives the same AgyBridge in-process.
 *
 * Important: stdout is the MCP transport. Every log line must go to stderr,
 * otherwise the client fails to parse the stream. All module loading therefore
 * happens inside main() via dynamic import, AFTER stdout has been locked down.
 */

const SESSION_ID = "gemini-desktop-stdio";

// Lock down stdout before anything else can write to it.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

async function main() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const { AgyBridge, buildServerInstructions } = await import("../dist/agy-bridge.js");
  const { CodeModeManager, codeModeToolDefinitions } = await import("../dist/code-mode.js");
  const { loadConfig } = await import("../dist/config.js");
  const { discoverLocalSkills, formatSkillsForInstructions } = await import("../dist/skills.js");
  const { DEVSPACE_VERSION } = await import("../dist/version.js");

  const config = loadConfig();

  // stdio is single-user and in-process: no audit log spam into the pipe.
  const logging = { ...config.logging, level: "error", requests: false };

  const bridge = new AgyBridge(config.agy, logging);
  await bridge.start();

  const codeMode = config.codeMode.enabled
    ? new CodeModeManager(bridge, config.agy.holdMs)
    : undefined;

  const skills = discoverLocalSkills(config.skills);
  const instructions = buildServerInstructions(config.agy.holdMs, {
    skillsSection: formatSkillsForInstructions(skills),
    codeModeEnabled: Boolean(codeMode),
  });

  const server = new Server(
    { name: "devspace", version: DEVSPACE_VERSION },
    { capabilities: { tools: {} }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const agyTools = await bridge.listTools();
    const extraTools = codeMode ? codeModeToolDefinitions(config.agy.holdMs) : [];
    return { tools: [...agyTools, ...extraTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (callReq) => {
    const { name, arguments: rawToolArgs } = callReq.params;
    try {
      if (codeMode && codeMode.isCodeModeTool(name)) {
        return await codeMode.callTool(SESSION_ID, name, rawToolArgs);
      }
      return await bridge.callTool(SESSION_ID, name, rawToolArgs);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });

  let closing = false;
  const shutdown = async (why) => {
    if (closing) return;
    closing = true;
    console.error(`[devspace-stdio] shutting down (${why})`);
    try {
      await bridge.close();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[devspace-stdio] ready · workspace=${config.agy.workspace} · tools=${config.agy.exposedTools.join(",")} · codeMode=${Boolean(codeMode)}`,
  );
}

main().catch((error) => {
  console.error("[devspace-stdio] fatal:", error);
  process.exit(1);
});
