import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgyBridge, buildServerInstructions, type BridgeToolCallResult } from "./agy-bridge.js";
import { CodeModeManager, codeModeToolDefinitions } from "./code-mode.js";
import type { ServerConfig } from "./config.js";
import { discoverLocalSkills, formatSkillsForInstructions } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";

/**
 * Tool annotations let a client decide whether a call needs interactive
 * confirmation. The MCP spec treats an absent annotation as the most pessimistic
 * case (a destructive write), so a client that honours annotations asks about
 * everything; spelling them out is what lets the safe cases run unprompted.
 *
 * read_file stays readOnlyHint:false on purpose. Nothing in this server bounds
 * file reads to agy.workspace (path-utils.ts only expands ~), so a read_file
 * marked read-only would let a client read any file on the machine — including
 * ~/.ssh — without ever asking. run_command and friends are destructive by
 * nature and keep prompting.
 */
const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  read_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  write_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  edit_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  run_command: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  manage_task: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  execute: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  poll_execution: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  cancel_execution: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

interface AnnotatedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

function withAnnotations(tool: AnnotatedTool): AnnotatedTool {
  const annotations = TOOL_ANNOTATIONS[tool.name];
  return annotations ? { ...tool, annotations } : tool;
}

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
    return { tools: [...agyTools, ...extraTools].map(withAnnotations) };
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
