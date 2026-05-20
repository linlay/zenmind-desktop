import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  createPublicKey,
  createVerify,
  randomUUID,
  type KeyObject
} from "node:crypto";
import type { App } from "electron";
import type {
  DesktopSsoClaims,
  DesktopSsoLogoutResult,
  DesktopSsoStartResult,
  DesktopSsoStatus
} from "../shared/contracts";
import { getDesktopStateRoot } from "./user-paths";

type OidcConfig = {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  wellKnownUrl: string;
  logoutUrl: string;
  logoutCallbackUri: string;
};

type TokenExchangeRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: string;
};

type FetchResponseLike = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<FetchResponseLike>;

type CallbackHooks = {
  onStatusChanged?: (status: DesktopSsoStatus) => void;
};

type PendingLogin = {
  state: string;
  startedAt: string;
};

const CALLBACK_PORT = 8080;
const CALLBACK_HOST = "localhost";
const CALLBACK_PATH = "/api/auth/oidc/callback";
const LOGOUT_CALLBACK_PATH = "/api/auth/oidc/logout-callback";
const SESSION_FILE_NAME = "oidc-sso-session.json";

export const DEFAULT_OIDC_CONFIG: OidcConfig = {
  issuer: "https://eiam.qiuer.net/auth/oidc/CA68B05042044F44AD4D2B5F672A53AE",
  authorizeUrl: "https://eiam.qiuer.net/auth/oauth2/authorize",
  tokenUrl: "https://eiam.qiuer.net/auth/oauth2/token",
  clientId: "MTdjNzdjZTU3ZTExNDUzMWJmMjk4OTQ4MzdkNzY1YmU",
  clientSecret: "3CH2p8r3NMURy+5E8BYZTK/AYlWCh+Rr",
  redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
  wellKnownUrl: "https://eiam.qiuer.net/auth/oidc/CA68B05042044F44AD4D2B5F672A53AE/.well-known/openid-configuration",
  logoutUrl: "https://eiam.qiuer.net/auth/ssoLogout",
  logoutCallbackUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${LOGOUT_CALLBACK_PATH}`
};

let currentStatus: DesktopSsoStatus = createSignedOutStatus("尚未登录。");
let callbackServer: http.Server | null = null;
let callbackServerReady: Promise<void> | null = null;
let callbackHooks: CallbackHooks = {};
let pendingLogin: PendingLogin | null = null;
const usedAuthorizationCodes = new Set<string>();

function createSignedOutStatus(message: string): DesktopSsoStatus {
  return {
    authenticated: false,
    pending: false,
    user: null,
    message,
    updatedAt: new Date().toISOString()
  };
}

function createPendingStatus(message: string): DesktopSsoStatus {
  return {
    authenticated: false,
    pending: true,
    user: null,
    message,
    updatedAt: new Date().toISOString()
  };
}

function createAuthenticatedStatus(claims: DesktopSsoClaims): DesktopSsoStatus {
  return {
    authenticated: true,
    pending: false,
    user: claims,
    message: "单点登录已完成。",
    updatedAt: new Date().toISOString()
  };
}

function createFailedStatus(message: string): DesktopSsoStatus {
  return {
    authenticated: false,
    pending: false,
    user: null,
    message,
    error: message,
    updatedAt: new Date().toISOString()
  };
}

function cloneStatus(status: DesktopSsoStatus): DesktopSsoStatus {
  return {
    ...status,
    user: status.user ? { ...status.user } : null
  };
}

function setCurrentStatus(status: DesktopSsoStatus) {
  currentStatus = cloneStatus(status);
  callbackHooks.onStatusChanged?.(cloneStatus(currentStatus));
}

function getSessionPath(app: App) {
  return path.join(getDesktopStateRoot(app), SESSION_FILE_NAME);
}

function saveSession(app: App, status: DesktopSsoStatus) {
  fs.mkdirSync(path.dirname(getSessionPath(app)), { recursive: true });
  fs.writeFileSync(getSessionPath(app), JSON.stringify({
    authenticated: status.authenticated,
    user: status.user,
    message: status.message,
    updatedAt: status.updatedAt
  }, null, 2), { encoding: "utf8", mode: 0o600 });
}

function loadSession(app: App) {
  const filePath = getSessionPath(app);
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopSsoStatus>;
    if (parsed.authenticated && parsed.user?.sub) {
      currentStatus = {
        authenticated: true,
        pending: false,
        user: parsed.user,
        message: typeof parsed.message === "string" ? parsed.message : "单点登录已完成。",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
      };
    }
  } catch {
    currentStatus = createSignedOutStatus("尚未登录。");
  }
}

function clearSession(app: App) {
  pendingLogin = null;
  const filePath = getSessionPath(app);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Session cleanup is best effort; the in-memory state is authoritative for this run.
  }
}

function readFetchErrorStatus(response: FetchResponseLike) {
  const status = typeof response.status === "number" ? response.status : 0;
  const statusText = typeof response.statusText === "string" ? response.statusText : "";
  return [status, statusText].filter(Boolean).join(" ") || "request failed";
}

async function readFetchErrorBody(response: FetchResponseLike) {
  if (typeof response.text !== "function") {
    return "";
  }
  try {
    return (await response.text()).trim().slice(0, 300);
  } catch {
    return "";
  }
}

function decodeJsonPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function normalizeStringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeAudience(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string") ?? "";
  }
  return "";
}

function includesAudience(value: unknown, expected: string) {
  if (typeof value === "string") {
    return value === expected;
  }
  return Array.isArray(value) && value.includes(expected);
}

function createClaims(payload: Record<string, unknown>): DesktopSsoClaims {
  const sub = normalizeStringClaim(payload.sub);
  if (!sub) {
    throw new Error("id_token 缺少 sub。");
  }
  const claims: DesktopSsoClaims = {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud)
  };
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  if (name) {
    claims.name = name;
  }
  if (email) {
    claims.email = email;
  }
  return claims;
}

function keyObjectFromJwk(jwk: Record<string, unknown>): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

function renderCallbackHtml(title: string, message: string) {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #162033; }
    main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid #d9e2ef; border-radius: 16px; background: #fff; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.25; }
    p { margin: 0; font-size: 15px; line-height: 1.7; color: #44546a; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function writeHtmlResponse(response: http.ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function buildAuthorizeUrl(state: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "login");
  return url.toString();
}

export function getIdentityProviderCookieHosts(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const hosts = new Set<string>();
  for (const value of [
    config.issuer,
    config.authorizeUrl,
    config.tokenUrl,
    config.wellKnownUrl,
    config.logoutUrl
  ]) {
    try {
      const host = new URL(value).hostname.trim().toLowerCase();
      if (host) {
        hosts.add(host);
      }
    } catch {
      // Ignore malformed optional URLs; required URLs fail later when used.
    }
  }
  return [...hosts];
}

export function isDesktopSsoAuthorizeUrl(value: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  try {
    const url = new URL(value);
    const authorizeUrl = new URL(config.authorizeUrl);
    return url.origin === authorizeUrl.origin && url.pathname === authorizeUrl.pathname;
  } catch {
    return false;
  }
}

function buildTokenExchangeRequest(code: string, config: OidcConfig = DEFAULT_OIDC_CONFIG): TokenExchangeRequest {
  const tokenUrl = new URL(config.tokenUrl);
  tokenUrl.searchParams.set("client_id", config.clientId);
  tokenUrl.searchParams.set("client_secret", config.clientSecret);
  tokenUrl.searchParams.set("redirect_uri", config.redirectUri);
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  tokenUrl.searchParams.set("code", code);
  return {
    url: tokenUrl.toString(),
    method: "POST",
    headers: {
      "Accept": "application/json"
    }
  };
}

function normalizeCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedCodes: Set<string> = usedAuthorizationCodes
) {
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!code) {
    throw new Error("missing authorization code");
  }
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  if (usedCodes.has(code)) {
    throw new Error("authorization code has already been used");
  }
  usedCodes.add(code);
  return { code, state };
}

async function fetchJson(fetchImpl: FetchLike, url: string, init?: Parameters<FetchLike>[1]) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const detail = await readFetchErrorBody(response);
    throw new Error(`OIDC request failed: ${readFetchErrorStatus(response)}${detail ? ` - ${detail}` : ""}`);
  }
  return response.json();
}

async function validateIdToken(
  idToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): Promise<DesktopSsoClaims> {
  const [headerPart, payloadPart, signaturePart] = idToken.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error("id_token 格式不正确。");
  }
  const header = decodeJsonPart(headerPart);
  const payload = decodeJsonPart(payloadPart);
  if (header.alg !== "RS256") {
    throw new Error("id_token 只支持 RS256。");
  }
  if (payload.iss !== config.issuer) {
    throw new Error("id_token issuer 不匹配。");
  }
  if (!includesAudience(payload.aud, config.clientId)) {
    throw new Error("id_token audience 不匹配。");
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("id_token 已过期。");
  }

  const discovery = await fetchJson(fetchImpl, config.wellKnownUrl) as { jwks_uri?: unknown };
  const jwksUri = normalizeStringClaim(discovery.jwks_uri);
  if (!jwksUri) {
    throw new Error("OIDC well-known 配置缺少 jwks_uri。");
  }
  const jwks = await fetchJson(fetchImpl, jwksUri) as { keys?: unknown };
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const kid = normalizeStringClaim(header.kid);
  const key = keys.find((candidate) => {
    const record = candidate as Record<string, unknown>;
    return record.kty === "RSA" && (!kid || record.kid === kid);
  }) as Record<string, unknown> | undefined;
  if (!key) {
    throw new Error("没有找到可用于验证 id_token 的 JWK。");
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  if (!verifier.verify(keyObjectFromJwk(key), Buffer.from(signaturePart, "base64url"))) {
    throw new Error("id_token 签名校验失败。");
  }
  return createClaims(payload);
}

async function exchangeCodeForClaims(
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
) {
  const request = buildTokenExchangeRequest(code, config);
  const tokenResponse = await fetchJson(fetchImpl, request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  }) as { id_token?: unknown };
  const idToken = normalizeStringClaim(tokenResponse.id_token);
  if (!idToken) {
    throw new Error("Token 响应缺少 id_token。");
  }
  return validateIdToken(idToken, fetchImpl, config);
}

async function handleLoginCallback(app: App, requestUrl: URL, fetchImpl?: FetchLike) {
  if (!pendingLogin) {
    throw new Error("没有正在进行的单点登录。");
  }
  const { code } = normalizeCallbackRequest(requestUrl, pendingLogin.state);
  const claims = await exchangeCodeForClaims(code, fetchImpl);
  pendingLogin = null;
  const status = createAuthenticatedStatus(claims);
  setCurrentStatus(status);
  saveSession(app, status);
  return status;
}

function buildLogoutUrl(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const url = new URL(config.logoutUrl);
  url.searchParams.set("callback", config.logoutCallbackUri);
  return url.toString();
}

async function handleCallbackRequest(app: App, request: http.IncomingMessage, response: http.ServerResponse) {
  const requestUrl = new URL(request.url || "/", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
  if (requestUrl.pathname === LOGOUT_CALLBACK_PATH) {
    writeHtmlResponse(response, 200, renderCallbackHtml("已退出登录", "IAM 会话登出已返回 Desktop。"));
    return;
  }
  if (requestUrl.pathname !== CALLBACK_PATH) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const status = await handleLoginCallback(app, requestUrl);
    writeHtmlResponse(response, 200, renderCallbackHtml("登录成功", `${status.user?.sub ?? "用户"} 已完成单点登录，可以回到 Desktop 继续使用。`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCurrentStatus(createFailedStatus(message));
    writeHtmlResponse(response, 400, renderCallbackHtml("登录失败", message));
  }
}

async function ensureCallbackServer(app: App, hooks: CallbackHooks = {}) {
  callbackHooks = hooks;
  if (callbackServer && callbackServerReady) {
    return callbackServerReady;
  }

  callbackServer = http.createServer((request, response) => {
    void handleCallbackRequest(app, request, response);
  });
  callbackServerReady = new Promise((resolve, reject) => {
    const server = callbackServer;
    if (!server) {
      reject(new Error("callback server unavailable"));
      return;
    }
    const handleError = (error: NodeJS.ErrnoException) => {
      callbackServer = null;
      callbackServerReady = null;
      if (error.code === "EADDRINUSE") {
        reject(new Error("OIDC 回调端口 8080 已被占用。"));
        return;
      }
      reject(error);
    };
    server.once("error", handleError);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      server.off("error", handleError);
      resolve();
    });
  });
  return callbackServerReady;
}

export function getDesktopSsoStatus(app?: App): DesktopSsoStatus {
  if (app && !currentStatus.authenticated && !currentStatus.pending) {
    loadSession(app);
  }
  return cloneStatus(currentStatus);
}

export function failDesktopSsoLogin(message: string): DesktopSsoStatus {
  pendingLogin = null;
  const status = createFailedStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

export async function startDesktopSsoLogin(app: App, hooks: CallbackHooks = {}): Promise<DesktopSsoStartResult> {
  try {
    await ensureCallbackServer(app, hooks);
    const state = randomUUID();
    pendingLogin = {
      state,
      startedAt: new Date().toISOString()
    };
    const status = createPendingStatus("正在等待 IAM 单点登录完成。");
    setCurrentStatus(status);
    return {
      ok: true,
      authorizeUrl: buildAuthorizeUrl(state),
      status: cloneStatus(status),
      message: "已打开 IAM 单点登录。"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = createFailedStatus(message);
    setCurrentStatus(status);
    return {
      ok: false,
      status: cloneStatus(status),
      message
    };
  }
}

export async function logoutDesktopSso(app: App, hooks: CallbackHooks = {}): Promise<DesktopSsoLogoutResult> {
  callbackHooks = hooks;
  clearSession(app);
  const status = createSignedOutStatus("已退出 Desktop 单点登录。");
  setCurrentStatus(status);
  try {
    await ensureCallbackServer(app, hooks);
    return {
      ok: true,
      logoutUrl: buildLogoutUrl(),
      status: cloneStatus(status),
      message: "已清除 Desktop 登录状态。"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: cloneStatus(status),
      message
    };
  }
}

export const __testInternals = {
  DEFAULT_OIDC_CONFIG,
  buildAuthorizeUrl,
  isDesktopSsoAuthorizeUrl,
  getIdentityProviderCookieHosts,
  buildLogoutUrl,
  buildTokenExchangeRequest,
  normalizeCallbackRequest,
  validateIdToken
};
