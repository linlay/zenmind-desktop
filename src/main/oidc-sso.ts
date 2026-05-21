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
import { resolveHomeZenmindRoot } from "./env-bootstrap";

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
  browserOrigin?: string;
};

type DesktopSsoConfigLoadResult =
  | {
    configured: false;
    configPath: string;
    message: string;
    error?: undefined;
    config?: undefined;
  }
  | {
    configured: true;
    configPath: string;
    config: OidcConfig;
    message?: undefined;
    error?: undefined;
  }
  | {
    configured: true;
    configPath: string;
    error: string;
    message?: undefined;
    config?: undefined;
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
  onBeforeStatusChanged?: (status: DesktopSsoStatus) => void | Promise<void>;
  onStatusChanged?: (status: DesktopSsoStatus) => void;
};

type PendingLogin = {
  state: string;
  startedAt: string;
  config: OidcConfig;
};

type DesktopSsoProxyState = {
  config: OidcConfig;
  cookies: Map<string, string>;
};

export type DesktopSsoBrowserCookieDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "lax";
};

const CALLBACK_PORT = 8080;
const CALLBACK_HOST = "localhost";
const CALLBACK_ORIGIN = `http://${CALLBACK_HOST}:${CALLBACK_PORT}`;
const CALLBACK_PATH = "/api/auth/oidc/callback";
const LOGOUT_CALLBACK_PATH = "/api/auth/oidc/logout-callback";
const SESSION_FILE_NAME = "oidc-sso-session.json";
export const DESKTOP_SSO_CONFIG_FILE_NAME = "desktop-sso.json";
const IDENTITY_PROVIDER_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "wellKnownUrl",
  "logoutUrl"
] as const;
const OIDC_CONFIG_STRING_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "redirectUri",
  "wellKnownUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;
const OIDC_CONFIG_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "redirectUri",
  "wellKnownUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;

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
let desktopSsoProxyState: DesktopSsoProxyState | null = null;
const usedAuthorizationCodes = new Set<string>();

function createSignedOutStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: false,
    user: null,
    message,
    updatedAt: new Date().toISOString()
  };
}

function createPendingStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: true,
    user: null,
    message,
    updatedAt: new Date().toISOString()
  };
}

function createAuthenticatedStatus(claims: DesktopSsoClaims): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: true,
    pending: false,
    user: claims,
    message: "单点登录已完成。",
    updatedAt: new Date().toISOString()
  };
}

function createFailedStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: false,
    user: null,
    message,
    error: message,
    updatedAt: new Date().toISOString()
  };
}

function createUnconfiguredStatus(message: string): DesktopSsoStatus {
  return {
    configured: false,
    authenticated: false,
    pending: false,
    user: null,
    message,
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

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveDesktopSsoConfigPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(resolveHomeZenmindRoot(app, platform), DESKTOP_SSO_CONFIG_FILE_NAME);
}

function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isConfigEnabled(record: Record<string, unknown>) {
  const value = record.enabled;
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return /^(?:true|1|on|yes)$/iu.test(value.trim());
  }
  return false;
}

function parseDesktopSsoConfigContent(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return { enabled: false };
  }
  if (!trimmed.startsWith("{")) {
    return { identityProviderHost: trimmed };
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置文件必须是 JSON 对象或单行 IAM 域名。");
  }
  return parsed as Record<string, unknown>;
}

function normalizeIdentityProviderOrigin(record: Record<string, unknown>) {
  const rawValue =
    getRecordString(record, "browserOrigin") ||
    getRecordString(record, "identityProviderHost") ||
    getRecordString(record, "host") ||
    getRecordString(record, "baseUrl") ||
    getRecordString(record, "oidcBaseUrl");
  if (!rawValue) {
    return "";
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(rawValue) ? rawValue : `https://${rawValue}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("IAM 域名只支持 http 或 https。");
  }
  if (!url.hostname) {
    throw new Error("IAM 域名缺少 hostname。");
  }
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function buildOidcConfigFromRecord(record: Record<string, unknown>) {
  const config: OidcConfig = { ...DEFAULT_OIDC_CONFIG };
  for (const field of OIDC_CONFIG_STRING_FIELDS) {
    const value = getRecordString(record, field);
    if (value) {
      config[field] = value;
    }
  }
  const browserOrigin = normalizeIdentityProviderOrigin(record);
  if (browserOrigin) {
    config.browserOrigin = browserOrigin;
  }
  for (const field of OIDC_CONFIG_URL_FIELDS) {
    try {
      new URL(config[field]);
    } catch {
      throw new Error(`${field} 不是有效 URL。`);
    }
  }
  if (!config.clientId.trim()) {
    throw new Error("clientId 不能为空。");
  }
  if (!config.clientSecret.trim()) {
    throw new Error("clientSecret 不能为空。");
  }
  return config;
}

export function loadDesktopSsoConfig(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform): DesktopSsoConfigLoadResult {
  const configPath = resolveDesktopSsoConfigPath(app, platform);
  if (!fs.existsSync(configPath)) {
    return {
      configured: false,
      configPath,
      message: "未配置 Desktop 单点登录。"
    };
  }
  try {
    const record = parseDesktopSsoConfigContent(fs.readFileSync(configPath, "utf8"));
    if (!isConfigEnabled(record)) {
      return {
        configured: false,
        configPath,
        message: "未配置 Desktop 单点登录。"
      };
    }
    return {
      configured: true,
      configPath,
      config: buildOidcConfigFromRecord(record)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configured: true,
      configPath,
      error: `Desktop 单点登录配置无效：${message}`
    };
  }
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
        configured: true,
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

function getDesktopSsoProxyTargetOrigin(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return new URL(config.authorizeUrl).origin;
}

export function buildDesktopSsoProxyUrl(value: string) {
  const targetUrl = new URL(value);
  return `${CALLBACK_ORIGIN}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
}

export function rewriteDesktopSsoProxyLocation(
  location: string,
  upstreamRequestUrl: URL,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
) {
  const resolvedLocation = new URL(location, upstreamRequestUrl);
  if (resolvedLocation.origin === CALLBACK_ORIGIN) {
    return resolvedLocation.toString();
  }
  if (resolvedLocation.origin === getDesktopSsoProxyTargetOrigin(config)) {
    return buildDesktopSsoProxyUrl(resolvedLocation.toString());
  }
  return resolvedLocation.toString();
}

function splitDesktopSsoProxySetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getDesktopSsoProxySetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoProxySetCookieHeader(setCookieHeader) : [];
}

export function rewriteDesktopSsoProxySetCookieHeader(header: string) {
  const [nameValuePair, ...attributes] = header.split(";");
  const rewrittenAttributes: string[] = [];
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }
    const separatorIndex = attribute.indexOf("=");
    const attributeName = (separatorIndex >= 0 ? attribute.slice(0, separatorIndex) : attribute)
      .trim()
      .toLowerCase();
    const attributeValue = separatorIndex >= 0 ? attribute.slice(separatorIndex + 1).trim() : "";
    if (attributeName === "domain" || attributeName === "secure") {
      continue;
    }
    if (attributeName === "samesite" && attributeValue.toLowerCase() === "none") {
      rewrittenAttributes.push("SameSite=Lax");
      continue;
    }
    rewrittenAttributes.push(attribute);
  }
  return [nameValuePair.trim(), ...rewrittenAttributes].filter(Boolean).join("; ");
}

function getDesktopSsoBrowserCookieOrigins(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const origins = new Set<string>();
  origins.add(getDesktopSsoProxyTargetOrigin(config));
  if (config.browserOrigin) {
    origins.add(config.browserOrigin);
  }
  return [...origins];
}

export function buildDesktopSsoBrowserCookieDetails(
  cookies: Map<string, string>,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): DesktopSsoBrowserCookieDetails[] {
  const origins = getDesktopSsoBrowserCookieOrigins(config);
  const cookieDetails: DesktopSsoBrowserCookieDetails[] = [];
  for (const origin of origins) {
    for (const [name, value] of cookies) {
      cookieDetails.push({
        url: origin,
        name,
        value,
        path: "/",
        secure: origin.startsWith("https:"),
        httpOnly: true,
        sameSite: "lax"
      });
    }
  }
  return cookieDetails;
}

export function getDesktopSsoProxyBrowserCookieDetails() {
  if (!desktopSsoProxyState) {
    return [];
  }
  return buildDesktopSsoBrowserCookieDetails(desktopSsoProxyState.cookies, desktopSsoProxyState.config);
}

export function getDesktopSsoCookieMirrorOrigins(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return [];
  }
  return getDesktopSsoBrowserCookieOrigins(configResult.config);
}

function activateDesktopSsoProxy(config: OidcConfig, options: { resetCookies?: boolean } = {}) {
  const currentTargetOrigin = desktopSsoProxyState
    ? getDesktopSsoProxyTargetOrigin(desktopSsoProxyState.config)
    : "";
  const nextTargetOrigin = getDesktopSsoProxyTargetOrigin(config);
  if (!desktopSsoProxyState || options.resetCookies || currentTargetOrigin !== nextTargetOrigin) {
    desktopSsoProxyState = {
      config,
      cookies: new Map()
    };
    return desktopSsoProxyState;
  }
  desktopSsoProxyState.config = config;
  return desktopSsoProxyState;
}

function updateDesktopSsoProxyCookies(proxyState: DesktopSsoProxyState, setCookieHeaders: string[]) {
  for (const header of setCookieHeaders) {
    const [nameValuePair, ...attributes] = header.split(";");
    const separatorIndex = nameValuePair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = nameValuePair.slice(0, separatorIndex).trim();
    const value = nameValuePair.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    let expired = false;
    for (const rawAttribute of attributes) {
      const attribute = rawAttribute.trim();
      const attributeSeparatorIndex = attribute.indexOf("=");
      const attributeName = (attributeSeparatorIndex >= 0
        ? attribute.slice(0, attributeSeparatorIndex)
        : attribute).trim().toLowerCase();
      const attributeValue = attributeSeparatorIndex >= 0
        ? attribute.slice(attributeSeparatorIndex + 1).trim()
        : "";
      if (attributeName === "max-age" && Number.parseInt(attributeValue, 10) <= 0) {
        expired = true;
      } else if (attributeName === "expires") {
        const expiresAt = Date.parse(attributeValue);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          expired = true;
        }
      }
    }
    if (expired) {
      proxyState.cookies.delete(name);
    } else {
      proxyState.cookies.set(name, value);
    }
  }
}

function mergeDesktopSsoProxyCookies(browserCookieHeader: string | undefined, proxyState: DesktopSsoProxyState) {
  const cookies = new Map<string, string>();
  for (const cookie of (browserCookieHeader ?? "").split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  for (const [name, value] of proxyState.cookies) {
    cookies.set(name, value);
  }
  return [...cookies]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function rewriteDesktopSsoProxyHeaderUrl(value: string, config: OidcConfig) {
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  return value
    .replaceAll(CALLBACK_ORIGIN, targetOrigin)
    .replaceAll(CALLBACK_ORIGIN.replace("localhost", "127.0.0.1"), targetOrigin);
}

function getDesktopSsoProxyRequestHeaders(
  request: http.IncomingMessage,
  upstreamUrl: URL,
  proxyState: DesktopSsoProxyState
) {
  const blockedHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
    "upgrade"
  ]);
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (blockedHeaders.has(name) || rawValue === undefined) {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers[name] = value;
  }

  headers["accept-encoding"] = "identity";
  if (headers.origin) {
    headers.origin = getDesktopSsoProxyTargetOrigin(proxyState.config);
  }
  if (headers.referer) {
    headers.referer = rewriteDesktopSsoProxyHeaderUrl(headers.referer, proxyState.config);
  }
  const cookieHeader = mergeDesktopSsoProxyCookies(request.headers.cookie, proxyState);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  } else {
    delete headers.cookie;
  }
  return headers;
}

function readDesktopSsoProxyRequestBody(request: http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function shouldRewriteDesktopSsoProxyBody(contentType: string) {
  return /(?:text|json|javascript|ecmascript|xml|x-www-form-urlencoded)/iu.test(contentType);
}

function rewriteDesktopSsoProxyBody(body: Buffer, contentType: string, config: OidcConfig) {
  if (!shouldRewriteDesktopSsoProxyBody(contentType)) {
    return body;
  }
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  const httpTargetOrigin = targetOrigin.replace(/^https:/iu, "http:");
  const rewrittenBody = body
    .toString("utf8")
    .replaceAll(targetOrigin, CALLBACK_ORIGIN)
    .replaceAll(httpTargetOrigin, CALLBACK_ORIGIN);
  return Buffer.from(rewrittenBody, "utf8");
}

async function proxyDesktopSsoRequest(
  proxyState: DesktopSsoProxyState,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL
) {
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, getDesktopSsoProxyTargetOrigin(proxyState.config));
  const method = (request.method || "GET").toUpperCase();
  const requestBodyBuffer = method === "GET" || method === "HEAD"
    ? undefined
    : await readDesktopSsoProxyRequestBody(request);
  const requestBody = requestBodyBuffer
    ? Uint8Array.from(requestBodyBuffer).buffer
    : undefined;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: getDesktopSsoProxyRequestHeaders(request, upstreamUrl, proxyState),
    body: requestBody as BodyInit | undefined,
    redirect: "manual"
  });
  const setCookieHeaders = getDesktopSsoProxySetCookieHeaders(upstreamResponse.headers);
  updateDesktopSsoProxyCookies(proxyState, setCookieHeaders);

  const blockedResponseHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "set-cookie",
    "transfer-encoding"
  ]);
  const responseHeaders: http.OutgoingHttpHeaders = {};
  upstreamResponse.headers.forEach((value, name) => {
    const headerName = name.toLowerCase();
    if (blockedResponseHeaders.has(headerName)) {
      return;
    }
    if (headerName === "location") {
      responseHeaders.location = rewriteDesktopSsoProxyLocation(value, upstreamUrl, proxyState.config);
      return;
    }
    responseHeaders[name] = value;
  });

  const rewrittenCookies = setCookieHeaders
    .map((header) => rewriteDesktopSsoProxySetCookieHeader(header))
    .filter(Boolean);
  if (rewrittenCookies.length > 0) {
    responseHeaders["set-cookie"] = rewrittenCookies;
  }

  const rawBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const body = rewriteDesktopSsoProxyBody(rawBody, upstreamResponse.headers.get("content-type") ?? "", proxyState.config);
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(method === "HEAD" ? undefined : body);
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
  const claims = await exchangeCodeForClaims(code, fetchImpl, pendingLogin.config);
  pendingLogin = null;
  const status = createAuthenticatedStatus(claims);
  await callbackHooks.onBeforeStatusChanged?.(status);
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
    desktopSsoProxyState?.cookies.clear();
    writeHtmlResponse(response, 200, renderCallbackHtml("已退出登录", "IAM 会话登出已返回 Desktop。"));
    return;
  }
  if (requestUrl.pathname !== CALLBACK_PATH) {
    if (!desktopSsoProxyState) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      await proxyDesktopSsoRequest(desktopSsoProxyState, request, response, requestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(`Desktop SSO proxy failed: ${message}`);
    }
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
  if (app) {
    const configResult = loadDesktopSsoConfig(app);
    if (!configResult.configured) {
      return createUnconfiguredStatus(configResult.message);
    }
    if (configResult.error) {
      return createFailedStatus(configResult.error);
    }
  }
  if (app && !currentStatus.authenticated && !currentStatus.pending) {
    loadSession(app);
  }
  return cloneStatus(currentStatus);
}

export function failDesktopSsoFlow(message: string): DesktopSsoStatus {
  pendingLogin = null;
  const status = createFailedStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

export const failDesktopSsoLogin = failDesktopSsoFlow;

export async function startDesktopSsoLogin(app: App, hooks: CallbackHooks = {}): Promise<DesktopSsoStartResult> {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    const status = createUnconfiguredStatus(configResult.message);
    setCurrentStatus(status);
    return {
      ok: false,
      status: cloneStatus(status),
      message: configResult.message
    };
  }
  if (configResult.error) {
    const status = createFailedStatus(configResult.error);
    setCurrentStatus(status);
    return {
      ok: false,
      status: cloneStatus(status),
      message: configResult.error
    };
  }
  const oidcConfig = configResult.config;
  if (!oidcConfig) {
    const status = createFailedStatus("Desktop 单点登录配置缺少 OIDC 参数。");
    setCurrentStatus(status);
    return {
      ok: false,
      status: cloneStatus(status),
      message: status.message
    };
  }
  try {
    await ensureCallbackServer(app, hooks);
    activateDesktopSsoProxy(oidcConfig, { resetCookies: true });
    const state = randomUUID();
    pendingLogin = {
      state,
      startedAt: new Date().toISOString(),
      config: oidcConfig
    };
    const authorizeUrl = buildAuthorizeUrl(state, oidcConfig);
    const status = createPendingStatus("正在等待 IAM 单点登录完成。");
    setCurrentStatus(status);
    return {
      ok: true,
      authorizeUrl,
      browserUrl: buildDesktopSsoProxyUrl(authorizeUrl),
      browserOrigin: oidcConfig.browserOrigin,
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
  const configResult = loadDesktopSsoConfig(app);
  clearSession(app);
  const status = configResult.configured
    ? createSignedOutStatus("已退出 Desktop 单点登录。")
    : createUnconfiguredStatus(configResult.message);
  setCurrentStatus(status);
  if (!configResult.configured) {
    return {
      ok: true,
      status: cloneStatus(status),
      message: "已清除 Desktop 登录状态。"
    };
  }
  if (configResult.error) {
    const failedStatus = createFailedStatus(configResult.error);
    setCurrentStatus(failedStatus);
    return {
      ok: false,
      status: cloneStatus(failedStatus),
      message: configResult.error
    };
  }
  const oidcConfig = configResult.config;
  if (!oidcConfig) {
    const failedStatus = createFailedStatus("Desktop 单点登录配置缺少 OIDC 参数。");
    setCurrentStatus(failedStatus);
    return {
      ok: false,
      status: cloneStatus(failedStatus),
      message: failedStatus.message
    };
  }
  try {
    await ensureCallbackServer(app, hooks);
    activateDesktopSsoProxy(oidcConfig);
    const logoutUrl = buildLogoutUrl(oidcConfig);
    return {
      ok: true,
      logoutUrl,
      browserUrl: buildDesktopSsoProxyUrl(logoutUrl),
      browserOrigin: oidcConfig.browserOrigin,
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
  DESKTOP_SSO_CONFIG_FILE_NAME,
  buildAuthorizeUrl,
  buildDesktopSsoProxyUrl,
  buildDesktopSsoBrowserCookieDetails,
  getDesktopSsoCookieMirrorOrigins,
  rewriteDesktopSsoProxyLocation,
  rewriteDesktopSsoProxySetCookieHeader,
  isDesktopSsoAuthorizeUrl,
  getIdentityProviderCookieHosts,
  loadDesktopSsoConfig,
  resolveDesktopSsoConfigPath,
  buildLogoutUrl,
  buildTokenExchangeRequest,
  normalizeCallbackRequest,
  validateIdToken
};
