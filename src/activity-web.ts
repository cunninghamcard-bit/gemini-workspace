import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { ActivityStore } from "./activity-store.js";

export const WORKSPACE_WEB_PATH = "/web";
const SESSION_COOKIE = "gemini_workspace_web_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_FAILED_LOGINS = 10;

export interface ActivityWebOptions {
  ownerToken: string;
  activity: ActivityStore;
  activeMcpSessions: () => number;
}

export function createActivityWebRouter(options: ActivityWebOptions): Router {
  const { ownerToken, activity, activeMcpSessions } = options;
  const router = express.Router();
  const webSessions = new Map<string, number>();
  const failedTimestamps: number[] = [];

  router.use(express.urlencoded({ extended: false, limit: "32kb" }));

  router.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const isAuthenticated = (req: Request): boolean => {
    const token = parseCookie(req.header("cookie"), SESSION_COOKIE);
    if (!token) return false;
    const expiresAt = webSessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
      webSessions.delete(token);
      return false;
    }
    return true;
  };

  router.post("/login", (req, res) => {
    const now = Date.now();
    while (failedTimestamps.length > 0 && now - failedTimestamps[0]! > LOGIN_WINDOW_MS) {
      failedTimestamps.shift();
    }
    if (failedTimestamps.length >= MAX_FAILED_LOGINS) {
      res.status(429).type("html").send(renderLoginHtml("Too many failed attempts. Try again later."));
      return;
    }

    const candidate = String((req.body as { owner_token?: unknown } | undefined)?.owner_token ?? "");
    if (!safeEquals(candidate, ownerToken)) {
      failedTimestamps.push(now);
      res.status(401).type("html").send(renderLoginHtml("Invalid owner password."));
      return;
    }

    const sessionToken = randomBytes(32).toString("base64url");
    webSessions.set(sessionToken, now + SESSION_TTL_MS);
    const secureAttr = isHttpsRequest(req) ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=${WORKSPACE_WEB_PATH}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureAttr}`,
    );
    res.redirect(303, `${WORKSPACE_WEB_PATH}/`);
  });

  router.post("/logout", (req, res) => {
    const token = parseCookie(req.header("cookie"), SESSION_COOKIE);
    if (token) webSessions.delete(token);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=${WORKSPACE_WEB_PATH}; Max-Age=0`,
    );
    res.redirect(303, `${WORKSPACE_WEB_PATH}/`);
  });

  router.get("/api/calls", (req, res) => {
    if (!isAuthenticated(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const sessionFilter = typeof req.query.session === "string" && req.query.session
      ? req.query.session
      : undefined;
    res.json({
      activeSessions: activeMcpSessions(),
      sessions: activity.listSessions(),
      calls: activity.listCalls({ mcpSessionId: sessionFilter, limit: 150 }),
    });
  });

  router.get(["/", ""], (req, res) => {
    if (!isAuthenticated(req)) {
      res.status(200).type("html").send(renderLoginHtml());
      return;
    }
    const sessionFilter = typeof req.query.session === "string" && req.query.session
      ? req.query.session
      : undefined;
    const sessions = activity.listSessions();
    const calls = activity.listCalls({ mcpSessionId: sessionFilter, limit: 100 });
    res.status(200).type("html").send(
      renderDashboardHtml({
        activeSessions: activeMcpSessions(),
        selectedSession: sessionFilter,
        sessions,
        calls,
      }),
    );
  });

  return router;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

function isHttpsRequest(req: Request): boolean {
  return req.secure || req.header("x-forwarded-proto") === "https";
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLoginHtml(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gemini Workspace Activity</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0b1120; color: #e2e8f0; }
    main { max-width: 400px; margin: 14vh auto; padding: 28px; background: #111827; border: 1px solid #1f2937; border-radius: 14px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 18px; color: #94a3b8; font-size: 14px; }
    input { box-sizing: border-box; width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #374151; background: #030712; color: #f8fafc; font-size: 15px; }
    button { margin-top: 14px; width: 100%; padding: 11px; border: 0; border-radius: 8px; background: #38bdf8; color: #030712; font-weight: 700; cursor: pointer; }
    .err { margin-bottom: 14px; padding: 10px; border-radius: 8px; background: #7f1d1d; color: #fecaca; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Gemini Workspace AGY Activity</h1>
    <p>Enter your owner password to inspect recent Gemini MCP sessions and tool calls.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post" action="${WORKSPACE_WEB_PATH}/login">
      <input type="password" name="owner_token" placeholder="Owner password" autofocus required />
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function renderDashboardHtml(data: {
  activeSessions: number;
  selectedSession?: string;
  sessions: ReturnType<ActivityStore["listSessions"]>;
  calls: ReturnType<ActivityStore["listCalls"]>;
}): string {
  const sessionChips = [
    `<a class="chip ${!data.selectedSession ? "active" : ""}" href="${WORKSPACE_WEB_PATH}/">All (${data.sessions.reduce((n, s) => n + s.callCount, 0)})</a>`,
    ...data.sessions.map((s) => {
      const active = data.selectedSession === s.mcpSessionId ? "active" : "";
      const short = s.mcpSessionId === "stateless" ? "stateless" : s.mcpSessionId.slice(0, 8);
      return `<a class="chip ${active}" href="${WORKSPACE_WEB_PATH}/?session=${encodeURIComponent(s.mcpSessionId)}">${esc(short)} (${s.callCount}${s.errorCount ? ` · ${s.errorCount} err` : ""})</a>`;
    }),
  ].join("");

  const rows = data.calls.length === 0
    ? `<p class="empty">No tool calls recorded yet.</p>`
    : data.calls
        .map(
          (c) => `<details class="call ${c.isError ? "err" : ""}">
  <summary>
    <span class="badge ${c.isError ? "bad" : "ok"}">${c.isError ? "ERR" : "OK"}</span>
    <strong class="tool">${esc(c.tool)}</strong>
    <span class="meta">session <code>${esc(c.mcpSessionId.slice(0, 8))}</code> · ${c.durationMs} ms · ${esc(c.createdAt.replace("T", " ").slice(0, 19))}Z</span>
  </summary>
  <div class="payload">
    <div class="lbl">Arguments</div>
    <pre>${esc(c.argsJson)}</pre>
    <div class="lbl">Output Preview</div>
    <pre>${esc(c.outputPreview)}</pre>
  </div>
</details>`,
        )
        .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gemini Workspace AGY Activity</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0b1120; color: #e2e8f0; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid #1f2937; background: #0f172a; }
    h1 { margin: 0; font-size: 18px; }
    .hdr-right { display: flex; gap: 12px; align-items: center; font-size: 13px; color: #94a3b8; }
    .btn { padding: 6px 12px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; text-decoration: none; cursor: pointer; font-size: 13px; }
    .container { max-width: 1060px; margin: 20px auto; padding: 0 20px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    .chip { padding: 6px 11px; border-radius: 999px; background: #111827; border: 1px solid #1f2937; color: #cbd5e1; text-decoration: none; font-size: 13px; }
    .chip.active { background: #0284c7; border-color: #38bdf8; color: #fff; }
    details.call { margin-bottom: 8px; border: 1px solid #1f2937; border-radius: 10px; background: #111827; overflow: hidden; }
    details.call.err { border-color: #7f1d1d; }
    summary { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; list-style: none; }
    .badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 5px; }
    .badge.ok { background: #064e3b; color: #6ee7b7; }
    .badge.bad { background: #7f1d1d; color: #fca5a5; }
    .tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
    .meta { margin-left: auto; color: #94a3b8; font-size: 12px; }
    .payload { padding: 12px 14px; border-top: 1px solid #1f2937; background: #030712; }
    .lbl { font-size: 11px; text-transform: uppercase; color: #64748b; margin: 6px 0 4px; }
    pre { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #cbd5e1; max-height: 280px; overflow: auto; }
    .empty { color: #64748b; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <h1>Gemini Workspace AGY Bridge · Activity</h1>
    <div class="hdr-right">
      <span>Live AGY sessions: <strong>${data.activeSessions}</strong></span>
      <a class="btn" href="${WORKSPACE_WEB_PATH}/${data.selectedSession ? `?session=${encodeURIComponent(data.selectedSession)}` : ""}">Refresh</a>
      <form method="post" action="${WORKSPACE_WEB_PATH}/logout" style="margin:0"><button class="btn" type="submit">Sign out</button></form>
    </div>
  </header>
  <div class="container">
    <div class="chips">${sessionChips}</div>
    ${rows}
  </div>
</body>
</html>`;
}
