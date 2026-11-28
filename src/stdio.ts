import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgyBridge } from "./agy-bridge.js";
import { CodeModeManager } from "./code-mode.js";
import { loadConfig } from "./config.js";
import { createStdioMcpServer } from "./stdio-server.js";

const SESSION_ID = "stdio";

/**
 * stdout carries the JSON-RPC stream in stdio mode, so a single stray log line
 * makes the client fail to parse. logger.ts emits info-level events through
 * console.log, so everything non-protocol is pushed to stderr here.
 */
function redirectLogsToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };

  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  redirectLogsToStderr();

  const config = loadConfig();

  // No audit journal and no request log in stdio mode: it would only be noise
  // on stderr for a single-client, in-process transport.
  const logging = {
    ...config.logging,
    level: "error" as const,
    requests: false,
    toolCalls: false,
  };

  const bridge = new AgyBridge(config.agy, logging);
  await bridge.start();

  const codeMode = config.codeMode.enabled
    ? new CodeModeManager(bridge, config.agy.holdMs)
    : undefined;

  const server = createStdioMcpServer({
    config,
    bridge,
    codeMode,
    sessionId: SESSION_ID,
  });

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.error(`[stdio] shutting down (${reason})`);
    try {
      await bridge.close();
    } catch {
      // Cleanup must never mask the original reason for exit.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));

  await server.connect(new StdioServerTransport());

  console.error(
    `[stdio] ready · workspace=${config.agy.workspace} · tools=${config.agy.exposedTools.join(",")} · codeMode=${Boolean(codeMode)}`,
  );
}

main().catch((error: unknown) => {
  console.error("[stdio] fatal:", error);
  process.exit(1);
});
