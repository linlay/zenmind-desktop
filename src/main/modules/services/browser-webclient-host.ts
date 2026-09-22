import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { AgentWebclientHostRecord } from "./webclient-host-types";
import { readRuntimeConfig, createRuntimeConfigScript, resolveRouteTarget } from "./webclient-host-config";
import { resolveFrontendRequest, sendFile } from "./webclient-static-files";
import { t } from "../../support/i18n/main-i18n";

const SESSION_MS = 60 * 60_000;
const TICKET_MS = 60_000;
const secret = () => randomBytes(32).toString("hex");
type Grant = { identity: string; expires: number };

// Claims only bind a token already issued by the trusted Main provider; this is not JWT verification.
function identityOf(token: string) {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.iss !== "string" || !claims.iss ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("Invalid browser access identity");
  return JSON.stringify([claims.iss, claims.sub, claims.deviceId ?? claims.device_id ?? ""]);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function createBrowserWebclientHost(record: AgentWebclientHostRecord, preferredPort = 7081) {
  const platformRoute = record.hosting.proxyRoutes.find(route => route.path === "/api" && route.targetEnv === "BASE_URL");
  const target = platformRoute && resolveRouteTarget(record, platformRoute);
  // This endpoint shares the running local Platform, never a renderer-supplied remote destination.
  if (!target || target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password) {
    throw new Error(t("settings.localServices.browserTargetInvalid"));
  }
  const platformOrigin = target.origin;
  const server = http.createServer();
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<http.ClientRequest>();
  const websocketSessions = new Map<Socket, Grant>();
  const tickets = new Map<string, Grant>();
  const sessions = new Map<string, Grant>();
  const cookieName = `zenmind_browser_${secret().slice(0, 16)}`;
  let origin = "";
  let stopped = false;
  let checking = false;

  async function issueToken(expected?: string) {
    const result = await record.issueAccessToken?.("missing");
    if (stopped || !result?.ok || !result.token) throw new Error("Browser authorization unavailable");
    const identity = identityOf(result.token);
    if (expected && expected !== identity) throw new Error("Browser identity changed");
    return { token: result.token, identity };
  }
  function prune() {
    for (const map of [tickets, sessions]) for (const [key, grant] of map) if (grant.expires <= Date.now()) map.delete(key);
    for (const [socket, grant] of websocketSessions) if (grant.expires <= Date.now()) socket.destroy();
  }
  function validRequest(req: http.IncomingMessage, websocket = false) {
    if (stopped || req.headers.host !== new URL(origin).host) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    // Browser writes and upgrades must originate at this exact port; CORS is not authentication.
    return !(websocket || !["GET", "HEAD"].includes(req.method || "")) || req.headers.origin === origin;
  }
  function sessionKeyFor(req: http.IncomingMessage) {
    const cookie = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    return cookie?.slice(cookieName.length + 1) || "";
  }
  function grantFor(req: http.IncomingMessage) {
    prune();
    return sessions.get(sessionKeyFor(req));
  }
  function denied(res: http.ServerResponse, status = 401) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(t("settings.localServices.browserReopen"));
  }
  function upstreamHeaders(req: http.IncomingMessage, token: string) {
    const headers: http.OutgoingHttpHeaders = {};
    for (const name of ["accept", "accept-language", "content-type", "content-length", "range", "if-range", "if-none-match", "x-document-revision"]) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    headers.authorization = `Bearer ${token}`;
    return headers;
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (!validRequest(req)) return denied(res, 403);
    const url = new URL(req.url || "/", origin);
    if (url.pathname === "/__desktop/open" && req.method === "GET") {
      const nonce = secret();
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // The one-use launch ticket is erased before any requests; Platform credentials never enter this document.
      res.end(`<!doctype html><meta charset="utf-8"><title>Agent WebClient</title><p id="status">${escapeHtml(t("settings.localServices.browserConnecting"))}</p><script nonce="${nonce}">const ticket=location.hash.slice(1);history.replaceState(null,'','/__desktop/open');fetch('/__desktop/session',{method:'POST',headers:{'Content-Type':'text/plain'},body:ticket}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('status').textContent=${JSON.stringify(t("settings.localServices.browserReopen"))}});</script>`);
      return;
    }
    if (url.pathname === "/__desktop/session" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (body.length > 128) return denied(res, 413); }
      prune();
      const grant = tickets.get(body);
      tickets.delete(body);
      if (!grant) return denied(res);
      await issueToken(grant.identity);
      let session = sessionKeyFor(req);
      const existing = sessions.get(session);
      if (existing?.identity === grant.identity) {
        // Reopening the same browser renews its session, including its live sockets.
        existing.expires = Date.now() + SESSION_MS;
      } else {
        if (sessions.size >= 16) return denied(res, 429);
        session = secret();
        sessions.set(session, { identity: grant.identity, expires: Date.now() + SESSION_MS });
      }
      res.setHeader("Set-Cookie", `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
      res.writeHead(204); res.end(); return;
    }
    const grant = grantFor(req);
    if (!grant) return denied(res);
    if (url.pathname === record.hosting.runtimeConfigPath && ["GET", "HEAD"].includes(req.method || "")) {
      const config = { ...readRuntimeConfig(record), DESKTOP_APP: "false", BACKEND_MODE: "platform", BASE_URL: origin, VOICE_ENABLED: "false" };
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : createRuntimeConfigScript(config)); return;
    }
    const pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/desktop" || pathname.startsWith("/api/desktop/")) return denied(res, 403);
      const { token } = await issueToken(grant.identity);
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, platformOrigin);
      upstreamUrl.searchParams.delete("token"); upstreamUrl.searchParams.delete("access_token");
      const upstream = http.request(upstreamUrl, { method: req.method, headers: upstreamHeaders(req, token) }, response => {
        if (stopped) { response.destroy(); res.destroy(); return; }
        if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) { response.resume(); denied(res, 502); return; }
        const headers = { ...response.headers, "cache-control": "no-store" };
        delete headers["set-cookie"]; delete headers["access-control-allow-origin"]; delete headers["access-control-allow-credentials"];
        res.writeHead(response.statusCode || 502, headers); response.pipe(res);
      });
      upstreamRequests.add(upstream);
      upstream.on("close", () => upstreamRequests.delete(upstream));
      upstream.on("error", () => { if (!res.headersSent) denied(res, 502); else res.destroy(); });
      upstream.setTimeout(120_000, () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream); return;
    }
    if (!["GET", "HEAD"].includes(req.method || "")) return denied(res, 404);
    const file = resolveFrontendRequest(record, url.pathname);
    if (file.type !== "file") return denied(res, 404);
    sendFile(req, res, file.filePath);
  }
  server.on("connection", (socket: Socket) => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); websocketSessions.delete(socket); }); });
  server.on("request", (req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) denied(res); else res.destroy(); }); });
  server.on("upgrade", (req, socket: Socket, head) => {
    const reject = () => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    void (async () => {
      if (!validRequest(req, true)) { reject(); return; }
      const url = new URL(req.url || "/", origin);
      if (url.pathname !== "/ws") { reject(); return; }
      const grant = grantFor(req);
      if (!grant) { reject(); return; }
      const { token } = await issueToken(grant.identity);
      if (socket.destroyed) return;
      // Browser connections can never impersonate Desktop's privileged physical lanes.
      const upstreamUrl = new URL("/ws", platformOrigin);
      upstreamUrl.searchParams.set("source", "webclient");
      if (url.searchParams.has("surfaceId")) upstreamUrl.searchParams.set("surfaceId", url.searchParams.get("surfaceId")!.slice(0, 128));
      const upstream = http.request(upstreamUrl, { headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": req.headers["sec-websocket-key"], "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": `bearer.${token}`
      } });
      upstreamRequests.add(upstream);
      upstream.on("close", () => upstreamRequests.delete(upstream));
      upstream.on("error", reject);
      upstream.setTimeout(15_000, () => upstream.destroy());
      upstream.on("response", response => { response.resume(); reject(); });
      upstream.on("upgrade", (response, peer, upstreamHead) => {
        if (stopped || socket.destroyed || grant.expires <= Date.now()) { peer.destroy(); socket.destroy(); return; }
        // Strip the upstream bearer subprotocol: the browser receives no Platform token.
        const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}`, "", ""];
        socket.write(lines.join("\r\n"));
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) peer.write(head);
        websocketSessions.set(socket, grant);
        peer.setTimeout(0);
        socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
        socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
        socket.pipe(peer); peer.pipe(socket);
      });
      socket.on("close", () => upstream.destroy()); upstream.end();
    })().catch(reject);
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const error = (reason: Error) => { server.off("listening", ready); reject(reason); };
    const ready = () => { server.off("error", error); resolve(); };
    server.once("error", error); server.once("listening", ready);
    // Both Windows and macOS use explicit IPv4 loopback; no wildcard or DNS-family fallback.
    server.listen(port, "127.0.0.1");
  });
  try { await listen(preferredPort); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setInterval(() => {
    prune();
    if (checking || !websocketSessions.size) return;
    checking = true;
    void issueToken().then(({ identity }) => {
      for (const [socket, grant] of websocketSessions) if (grant.identity !== identity) socket.destroy();
    }).catch(() => { for (const socket of websocketSessions.keys()) socket.destroy(); }).finally(() => { checking = false; });
  }, 10_000);
  timer.unref();
  return {
    url: origin,
    async launchUrl() {
      const { identity } = await issueToken();
      prune();
      if (tickets.size >= 16) tickets.delete(tickets.keys().next().value!);
      const ticket = secret(); tickets.set(ticket, { identity, expires: Date.now() + TICKET_MS });
      return `${origin}/__desktop/open#${ticket}`;
    },
    stop() {
      stopped = true; clearInterval(timer); tickets.clear(); sessions.clear();
      for (const req of upstreamRequests) req.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
