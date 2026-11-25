import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { ActivityStore } from "./activity-store.js";
import { createActivityWebRouter, WORKSPACE_WEB_PATH } from "./activity-web.js";
import { AgyBridge, buildServerInstructions, type BridgeToolCallResult } from "./agy-bridge.js";
import { CodeModeManager, codeModeToolDefinitions } from "./code-mode.js";
import { callFastTool, fastToolDefinitions, isFastTool } from "./fast-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { logEvent, requestIp, requestPath } from "./logger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { discoverLocalSkills, formatSkillsForInstructions } from "./skills.js";
import { GEMINI_WORKSPACE_VERSION } from "./version.js";

export interface RunningServer {
  app: express.Express;
  config: ServerConfig;
  bridge: AgyBridge;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  bridge?: AgyBridge;
}

export async function createServer(
  config: ServerConfig = loadConfig(),
  options: CreateServerOptions = {},
): Promise<RunningServer> {
  const app = express();
  if (config.logging.trustProxy !== false) {
    app.set("trust proxy", config.logging.trustProxy);
  }

  app.use((req, res, next) => {
    const startedAt = performance.now();
    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      logEvent(config.logging, "info", "http_request", {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ip: requestIp(req, config.logging.trustProxy) ?? null,
        host: req.header("host") ?? null,
        userAgent: req.header("user-agent") ?? null,
      });
    });
    next();
  });

  app.use(express.json({ limit: "16mb" }));

  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    app.use(localhostHostValidation());
  }

  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);

  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "gemini-workspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  const ownsBridge = !options.bridge;
  const bridge = options.bridge ?? new AgyBridge(config.agy, config.logging);
  if (ownsBridge) {
    await bridge.start();
  }

  const codeMode = config.codeMode.enabled
    ? new CodeModeManager(bridge, config.agy.holdMs)
    : undefined;

  const activityStore = config.activity.enabled || config.ui.enabled
    ? new ActivityStore(config.stateDir, config.activity.maxCalls)
    : undefined;

  const discoveredSkills = discoverLocalSkills(config.skills);
  const instructions = buildServerInstructions(config.agy.holdMs, {
    skillsSection: formatSkillsForInstructions(discoveredSkills),
    codeModeEnabled: Boolean(codeMode),
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "Gemini Workspace",
    }),
  );

  if (config.ui.enabled && activityStore) {
    app.use(
      WORKSPACE_WEB_PATH,
      createActivityWebRouter({
        ownerToken: config.oauth.ownerToken,
        activity: activityStore,
        activeMcpSessions: () => bridge.activeSessionCount(),
      }),
    );
  }

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "gemini-workspace",
      version: GEMINI_WORKSPACE_VERSION,
      activeSessions: bridge.activeSessionCount(),
      skillsCount: discoveredSkills.length,
      codeMode: Boolean(codeMode),
      webUi: config.ui.enabled,
    });
  });

  app.all("/mcp", async (req, res) => {
    try {
      await new Promise<void>((resolveAuth, rejectAuth) => {
        const finished = () => resolveAuth();
        res.once("finish", finished);
        bearerAuth(req, res, (err?: unknown) => {
          res.off("finish", finished);
          if (err) rejectAuth(err);
          else resolveAuth();
        });
      });
      if (res.headersSent) return;

      if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }

      if (req.method === "GET") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed.");
        return;
      }

      const incomingSessionId = req.header("mcp-session-id")?.trim() || undefined;

      if (req.method === "DELETE") {
        bridge.dropMcpSession(incomingSessionId);
        res.status(200).end();
        return;
      }

      if (req.method !== "POST") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed.");
        return;
      }

      const isInit = isInitializePayload(req.body);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: isInit && !incomingSessionId ? () => randomUUID() : undefined,
      });

      const mcpServer = new Server(
        { name: "gemini-workspace", version: GEMINI_WORKSPACE_VERSION },
        {
          capabilities: { tools: {} },
          instructions,
        },
      );

      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const agyTools = await bridge.listTools();
        const extraTools = codeMode ? codeModeToolDefinitions(config.agy.holdMs) : [];
        return { tools: [...agyTools, ...fastToolDefinitions(), ...extraTools] };
      });

      mcpServer.setRequestHandler(CallToolRequestSchema, async (callReq) => {
        const { name, arguments: rawToolArgs } = callReq.params;
        const toolArgs = rawToolArgs as Record<string, unknown> | undefined;
        const t0 = Date.now();
        let result: BridgeToolCallResult;
        try {
          if (codeMode?.isCodeModeTool(name)) {
            result = await codeMode.callTool(incomingSessionId, name, toolArgs);
          } else if (isFastTool(name)) {
            result = await callFastTool(name, toolArgs);
          } else {
            result = await bridge.callTool(incomingSessionId, name, toolArgs);
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

        if (config.activity.enabled && activityStore) {
          try {
            const outputText = result.content
              .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("\n");
            activityStore.recordCall({
              mcpSessionId: incomingSessionId,
              tool: name,
              args: toolArgs,
              outputText,
              durationMs: Date.now() - t0,
              isError: Boolean(result.isError),
            });
          } catch {
            // Activity journaling must never fail a primary tool call.
          }
        }

        return result;
      });

      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else if (!res.writableEnded && !res.destroyed) {
        res.destroy();
      }
    }
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (requestPath(req) !== "/mcp") return next(error);
    const status = (error as { status?: number })?.status === 413 ? 413 : 400;
    if (!res.headersSent) {
      sendJsonRpcError(res, status, -32700, "Invalid MCP request");
    } else {
      res.destroy();
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    bridge,
    close: () => {
      closePromise ??= (async () => {
        await codeMode?.close();
        if (ownsBridge) {
          await bridge.close();
        }
        activityStore?.close();
        oauthProvider.close();
      })();
      return closePromise;
    },
  };
}

function isInitializePayload(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isInitializeMessage(item));
  }
  return isInitializeMessage(body);
}

function isInitializeMessage(msg: unknown): boolean {
  return Boolean(
    msg
      && typeof msg === "object"
      && (msg as { method?: unknown }).method === "initialize",
  );
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close } = await createServer();
  const httpServer = app.listen(config.listenPort, config.host, () => {
    console.log(`gemini-workspace listening on http://${config.host}:${config.listenPort}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    if (config.ui.enabled) {
      console.log(`activity web ui: ${config.publicBaseUrl}${WORKSPACE_WEB_PATH}/`);
    }
    console.log(`agy binary: ${config.agy.bin}`);
    console.log(`agy workspace: ${config.agy.workspace}`);
    console.log(`code mode: ${config.codeMode.enabled ? "enabled" : "disabled"}`);
    console.log(`exposed agy tools: ${config.agy.exposedTools.join(", ")}`);
  });

  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownHttpServer(httpServer, close)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("gemini-workspace shutdown failed", error);
        process.exit(1);
      });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
