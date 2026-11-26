import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { expandHomePath } from "./path-utils.js";
import { canonicalScopes } from "./oauth-provider.js";
import { loadGeminiWorkspaceFiles } from "./user-config.js";

export interface AgyBridgeConfig {
  bin: string;
  workspace: string;
  agyHome: string;
  modelId: string;
  wireProtocol: "genai" | "openai";
  holdMs: number;
  callTimeoutMs: number;
  maxTurnsPerSession: number;
  sessionIdleTtlMs: number;
  exposedTools: string[];
}

export interface ServerConfig {
  configDir: string;
  stateDir: string;
  host: string;
  port: number;
  listenPort: number;
  oauth: OAuthConfig;
  allowedHosts: string[];
  publicBaseUrl: string;
  agy: AgyBridgeConfig;
  skills: { enabled: boolean; paths: string[] };
  codeMode: { enabled: boolean };
  ui: { enabled: boolean };
  activity: { enabled: boolean; maxCalls: number };
  logging: LoggingConfig;
}

export function resolveDefaultAgyBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GEMINI_WORKSPACE_AGY_BIN?.trim()) {
    return resolve(expandHomePath(env.GEMINI_WORKSPACE_AGY_BIN));
  }
  return join(homedir(), ".local", "bin", "agy");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadGeminiWorkspaceFiles(env);
  const stored = files.config;
  const stateDir = resolve(expandHomePath(stored.storage.stateDir));
  const host = stored.server.host;
  const port = stored.server.port;
  const listenPortOverride = env.GEMINI_WORKSPACE_LISTEN_PORT ?? env.SYNREX_CORE_LISTEN_PORT;
  const listenPort = listenPortOverride !== undefined ? parseListenPort(listenPortOverride) : port;

  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );

  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  const workspace = resolve(
    expandHomePath(env.GEMINI_WORKSPACE_AGY_WORKSPACE ?? stored.agy.workspace),
  );
  const agyHome = resolve(
    expandHomePath(env.GEMINI_WORKSPACE_AGY_HOME ?? stored.agy.agyHome ?? join(stateDir, "agy-home")),
  );
  const agyBin = stored.agy.bin
    ? resolve(expandHomePath(stored.agy.bin))
    : resolveDefaultAgyBin(env);

  return {
    configDir: files.dir,
    stateDir,
    host,
    port,
    listenPort,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.GEMINI_WORKSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      refreshTokenGraceSeconds: stored.oauth.refreshTokenGraceSeconds,
      scopes: canonicalScopes(stored.oauth.scopes),
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
    },
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    agy: {
      bin: agyBin,
      workspace,
      agyHome,
      modelId: env.GEMINI_WORKSPACE_AGY_MODEL ?? stored.agy.modelId,
      wireProtocol: stored.agy.wireProtocol,
      holdMs: stored.agy.holdMs,
      callTimeoutMs: stored.agy.callTimeoutMs,
      maxTurnsPerSession: stored.agy.maxTurnsPerSession,
      sessionIdleTtlMs: stored.agy.sessionIdleTtlMs,
      exposedTools: env.GEMINI_WORKSPACE_AGY_TOOLS
        ? env.GEMINI_WORKSPACE_AGY_TOOLS.split(",").map((s) => s.trim()).filter(Boolean)
        : stored.agy.exposedTools,
    },
    skills: {
      enabled: stored.skills.enabled,
      paths: stored.skills.paths,
    },
    codeMode: {
      enabled: env.GEMINI_WORKSPACE_CODE_MODE === "0"
        ? false
        : env.GEMINI_WORKSPACE_CODE_MODE === "1"
          ? true
          : stored.codeMode.enabled,
    },
    ui: {
      enabled: stored.ui.enabled,
    },
    activity: {
      enabled: stored.activity.enabled,
      maxCalls: stored.activity.maxCalls,
    },
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
  };
}

function parseListenPort(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`Invalid listen port override: ${raw}`);
  }
  return n;
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((h) => h.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: gemini-workspace init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
