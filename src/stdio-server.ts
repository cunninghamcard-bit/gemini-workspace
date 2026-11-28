import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgyBridge, buildServerInstructions, type BridgeToolCallResult } from "./agy-bridge.js";
import { CodeModeManager, codeModeToolDefinitions } from "./code-mode.js";
import type { ServerConfig } from "./config.js";
import { discoverLocalSkills, formatSkillsForInstructions } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";

export interface StdioServerOptions {
  config: ServerConfig;
  bridge: AgyBridge;
  codeMode?: CodeModeManager;
  /**
   * Stable pseudo-session id. stdio is one client per process, so every call
   * shares a single session entry in the bridge.
   */
  sessionId?: string;
}

/**
 * Builds the same MCP `Server` that `createServer()` mounts on `/mcp`, but with
 * no HTTP layer and no OAuth: a stdio client spawns this process and owns it.
 *
 * Kept side-effect free (no transport, no config loading) so it can be driven
 * directly from tests through an in-memory transport pair.
 */
export function createStdioMcpServer(options: StdioServerOptions): Server {
  const { config, bridge, codeMode, sessionId = "stdio" } = options;

  const discoveredSkills = discoverLocalSkills(config.skills);
  const instructions = buildServerInstructions(config.agy.holdMs, {
    skillsSection: formatSkillsForInstructions(discoveredSkills),
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
    const toolArgs = rawToolArgs as Record<string, unknown> | undefined;
    let result: BridgeToolCallResult;

    try {
      if (codeMode?.isCodeModeTool(name)) {
        result = await codeMode.callTool(sessionId, name, toolArgs);
      } else {
        result = await bridge.callTool(sessionId, name, toolArgs);
      }
    } catch (error) {
      result = {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }

    return result;
  });

  return server;
}
