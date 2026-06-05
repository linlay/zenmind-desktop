import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  createPublicKey,
  createHash,
  createVerify,
  randomBytes,
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
import { resolveRuntimeRoot } from "./env-bootstrap";

type OidcConfig = {
  provider?: string;
  issuer: string;
  authorizeUrl: string;
  loginUrl?: string;
  appendLoginState: boolean;
  loginCompletionUrl?: string;
  loginCompletionUrls?: string[];
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  wellKnownUrl: string;
  logoutUrl: string;
  logoutCallbackUri: string;
  browserOrigin?: string;
  usePkce?: boolean;
  cookieAccessTokenExchange?: CookieAccessTokenExchangeConfig;
  accessTokenCookie?: AccessTokenCookieConfig;
  accessTokenCookies?: AccessTokenCookieConfig[];
  webSessionExchange?: DesktopSsoWebSessionExchangeConfig;
};

type CookieAccessTokenExchangeConfig = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  accessTokenPath: string;
};

type AccessTokenCookieSameSite = "lax" | "strict" | "no_restriction";

type AccessTokenCookieConfig = {
  url: string;
  name: string;
  path: string;
  domain?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: AccessTokenCookieSameSite;
};

export type DesktopSsoWebSessionClearCookieConfig = {
  url: string;
  name: string;
};

export type DesktopSsoWebSessionExchangeConfig = {
  url: string;
  cookieOrigins: string[];
  clearCookies: DesktopSsoWebSessionClearCookieConfig[];
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

type CookieAccessTokenExchangeRequest = {
  url: string;
  method: CookieAccessTokenExchangeConfig["method"];
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

type ElectronFetchRuntime = {
  net?: {
    fetch?: FetchLike;
  };
};

type CallbackHooks = {
  onBeforeStatusChanged?: (
    status: DesktopSsoStatus,
    context?: DesktopSsoStatusChangeContext
  ) => void | Promise<void>;
  onStatusChanged?: (status: DesktopSsoStatus) => void;
};

type DesktopSsoStatusChangeContext = {
  provider?: string;
  idToken?: string;
};

type PendingLogin = {
  state: string;
  startedAt: string;
  config: OidcConfig;
  redirectUri: string;
  codeVerifier?: string;
};

type DesktopSsoProxyState = {
  config: OidcConfig;
  cookies: Map<string, string>;
};

type CallbackServerInfo = {
  host: string;
  port: number;
  origin: string;
  redirectUri: string;
  logoutCallbackUri: string;
  closeAfterCallback: boolean;
};

type CallbackServerOptions = {
  host: string;
  port: number;
  closeAfterCallback: boolean;
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

export type DesktopSsoAccessTokenCookieDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  domain?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: AccessTokenCookieSameSite;
};

const CALLBACK_PORT = 8080;
const CALLBACK_HOST = "localhost";
const CALLBACK_ORIGIN = `http://${CALLBACK_HOST}:${CALLBACK_PORT}`;
const GOOGLE_LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/api/auth/oidc/callback";
const LOGOUT_CALLBACK_PATH = "/api/auth/oidc/logout-callback";
const SESSION_FILE_NAME = "oidc-sso-session.json";
const ACCESS_TOKEN_FILE_NAME = "desktop-sso-access-token.txt";
export const DESKTOP_SSO_CONFIG_FILE_NAME = "desktop-sso.json";
const IDENTITY_PROVIDER_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "wellKnownUrl",
  "logoutUrl"
] as const;
const OIDC_CONFIG_STRING_FIELDS = [
  "provider",
  "issuer",
  "authorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "redirectUri",
  "scope",
  "wellKnownUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;
const OIDC_CONFIG_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "redirectUri",
  "wellKnownUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;
const DEFAULT_COOKIE_ACCESS_TOKEN_PATH = "access_token";
const DEFAULT_ACCESS_TOKEN_COOKIE_NAME = "access_token";
const DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_HOST = ["ai", "qi" + "uer", "net"].join(".");
const DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_ORIGIN = `https://${DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_HOST}`;
const DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_URL = `${DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_ORIGIN}/authorization`;
const DEFAULT_GOOGLE_SCOPE = "openid email profile";

export const DEFAULT_OIDC_CONFIG: OidcConfig = {
  issuer: "https://iam.example.com/auth/oidc/example-app",
  authorizeUrl: "https://iam.example.com/auth/oauth2/authorize",
  tokenUrl: "https://iam.example.com/auth/oauth2/token",
  clientId: "desktop-test-client",
  clientSecret: "desktop-test-secret",
  redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
  wellKnownUrl: "https://iam.example.com/auth/oidc/example-app/.well-known/openid-configuration",
  logoutUrl: "https://iam.example.com/auth/ssoLogout",
  logoutCallbackUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${LOGOUT_CALLBACK_PATH}`,
  appendLoginState: true
};

export const DEFAULT_GOOGLE_OIDC_CONFIG: OidcConfig = {
  provider: "google",
  issuer: "https://accounts.google.com",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "",
  clientSecret: "",
  redirectUri: `http://${GOOGLE_LOOPBACK_HOST}${CALLBACK_PATH}`,
  scope: DEFAULT_GOOGLE_SCOPE,
  wellKnownUrl: "https://accounts.google.com/.well-known/openid-configuration",
  logoutUrl: "",
  logoutCallbackUri: `http://${GOOGLE_LOOPBACK_HOST}${LOGOUT_CALLBACK_PATH}`,
  appendLoginState: true,
  usePkce: true
};

let currentStatus: DesktopSsoStatus = createSignedOutStatus("尚未登录。");
let callbackServer: http.Server | null = null;
let callbackServerReady: Promise<void> | null = null;
let callbackServerInfo: CallbackServerInfo | null = null;
let callbackHooks: CallbackHooks = {};
let pendingLogin: PendingLogin | null = null;
let desktopSsoProxyState: DesktopSsoProxyState | null = null;
let currentAccessToken = "";
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

export function getDesktopSsoAccessTokenFilePath(app: Pick<App, "getPath">) {
  return path.join(getDesktopStateRoot(app as App), ACCESS_TOKEN_FILE_NAME);
}

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveDesktopSsoConfigPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(resolveRuntimeRoot(app, platform), DESKTOP_SSO_CONFIG_FILE_NAME);
}

function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getRecordObject(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getRecordStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是字符串或字符串数组。`);
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${key} 只能包含字符串。`);
    }
    const normalizedItem = item.trim();
    if (normalizedItem) {
      values.push(normalizedItem);
    }
  }
  return values;
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

function getRecordBoolean(record: Record<string, unknown>, key: string, defaultValue: boolean) {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (/^(?:true|1|on|yes)$/iu.test(value.trim())) {
      return true;
    }
    if (/^(?:false|0|off|no)$/iu.test(value.trim())) {
      return false;
    }
  }
  return defaultValue;
}

function normalizeProviderName(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

function getUrlHostname(value: string | undefined) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isGoogleAccountsUrl(value: string | undefined) {
  return getUrlHostname(value) === "accounts.google.com";
}

function isGoogleTokenUrl(value: string | undefined) {
  return getUrlHostname(value) === "oauth2.googleapis.com";
}

function looksLikeGoogleOidcConfig(input: {
  issuer?: string;
  authorizeUrl?: string;
  loginUrl?: string;
  tokenUrl?: string;
  wellKnownUrl?: string;
}) {
  return isGoogleAccountsUrl(input.issuer) ||
    isGoogleAccountsUrl(input.authorizeUrl) ||
    isGoogleAccountsUrl(input.loginUrl) ||
    isGoogleAccountsUrl(input.wellKnownUrl) ||
    isGoogleTokenUrl(input.tokenUrl);
}

function recordLooksLikeGoogleOidcConfig(record: Record<string, unknown>) {
  return looksLikeGoogleOidcConfig({
    issuer: getRecordString(record, "issuer"),
    authorizeUrl: getRecordString(record, "authorizeUrl"),
    loginUrl: getRecordString(record, "loginUrl"),
    tokenUrl: getRecordString(record, "tokenUrl"),
    wellKnownUrl: getRecordString(record, "wellKnownUrl")
  });
}

function isGoogleOidcConfig(config: OidcConfig) {
  return normalizeProviderName(config.provider) === "google" || looksLikeGoogleOidcConfig(config);
}

function shouldUsePkce(config: OidcConfig) {
  return config.usePkce === true || isGoogleOidcConfig(config);
}

function shouldUseSystemBrowser(config: OidcConfig) {
  return isGoogleOidcConfig(config);
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

function hasHeader(headers: Record<string, string>, name: string) {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

function normalizeCookieAccessTokenExchangeHeaders(record: Record<string, unknown>) {
  if (!("headers" in record)) {
    return {};
  }
  const rawHeaders = getRecordObject(record, "headers");
  if (!rawHeaders) {
    throw new Error("cookieAccessTokenExchange.headers 必须是 JSON 对象。");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error("cookieAccessTokenExchange.headers 只能包含字符串值。");
    }
    headers[normalizedName] = value;
  }
  return headers;
}

function normalizeCookieAccessTokenExchangeMethod(record: Record<string, unknown>) {
  const method = (getRecordString(record, "method") || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error("cookieAccessTokenExchange.method 只支持 GET 或 POST。");
  }
  return method;
}

function normalizeCookieAccessTokenExchangeBody(
  record: Record<string, unknown>,
  method: CookieAccessTokenExchangeConfig["method"],
  headers: Record<string, string>
) {
  if (!("body" in record)) {
    return undefined;
  }
  if (method === "GET") {
    throw new Error("cookieAccessTokenExchange.body 只能和 POST 一起使用。");
  }
  const body = record.body;
  if (typeof body === "string") {
    return body;
  }
  if (body && typeof body === "object") {
    if (!hasHeader(headers, "Content-Type")) {
      headers["Content-Type"] = "application/json";
    }
    return JSON.stringify(body);
  }
  throw new Error("cookieAccessTokenExchange.body 必须是字符串或 JSON 对象。");
}

function normalizeCookieAccessTokenExchangeConfig(
  record: Record<string, unknown>,
  config: OidcConfig
): CookieAccessTokenExchangeConfig | undefined {
  if (!("cookieAccessTokenExchange" in record)) {
    return undefined;
  }
  const exchangeRecord = getRecordObject(record, "cookieAccessTokenExchange");
  if (!exchangeRecord) {
    throw new Error("cookieAccessTokenExchange 必须是 JSON 对象。");
  }
  const rawUrl = getRecordString(exchangeRecord, "url");
  if (!rawUrl) {
    throw new Error("cookieAccessTokenExchange.url 不能为空。");
  }
  const baseOrigin = config.browserOrigin || getDesktopSsoProxyTargetOrigin(config);
  const method = normalizeCookieAccessTokenExchangeMethod(exchangeRecord);
  const headers = normalizeCookieAccessTokenExchangeHeaders(exchangeRecord);
  const body = normalizeCookieAccessTokenExchangeBody(exchangeRecord, method, headers);
  const accessTokenPath = getRecordString(exchangeRecord, "accessTokenPath") || DEFAULT_COOKIE_ACCESS_TOKEN_PATH;
  return {
    url: new URL(rawUrl, baseOrigin).toString(),
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    accessTokenPath
  };
}

function shouldUseDefaultAiCookieAccessTokenExchange(config: OidcConfig) {
  const origins = new Set<string>();
  if (config.browserOrigin) {
    origins.add(config.browserOrigin);
  }
  if (config.loginUrl) {
    try {
      origins.add(new URL(config.loginUrl).origin);
    } catch {
      // URL validation below reports the configured field name.
    }
  }
  return origins.has(DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_ORIGIN);
}

function buildDefaultCookieAccessTokenExchangeConfig(
  config: OidcConfig
): CookieAccessTokenExchangeConfig | undefined {
  if (!shouldUseDefaultAiCookieAccessTokenExchange(config)) {
    return undefined;
  }
  return {
    url: DEFAULT_AI_COOKIE_ACCESS_TOKEN_EXCHANGE_URL,
    method: "GET",
    headers: {},
    accessTokenPath: DEFAULT_COOKIE_ACCESS_TOKEN_PATH
  };
}

function normalizeAccessTokenCookieSameSite(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "strict") {
    return "strict";
  }
  if (normalizedValue === "none" || normalizedValue === "no_restriction") {
    return "no_restriction";
  }
  return "lax";
}

function normalizeAccessTokenCookieConfig(
  record: Record<string, unknown>,
  config: OidcConfig,
  enabledByDefault: boolean
): AccessTokenCookieConfig | undefined {
  if (!("accessTokenCookie" in record)) {
    if (!enabledByDefault) {
      return undefined;
    }
    const url = config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin;
    return {
      url: new URL(url).toString(),
      name: DEFAULT_ACCESS_TOKEN_COOKIE_NAME,
      path: "/",
      secure: new URL(url).protocol === "https:",
      httpOnly: false,
      sameSite: "lax"
    };
  }
  const cookieRecord = getRecordObject(record, "accessTokenCookie");
  if (!cookieRecord) {
    throw new Error("accessTokenCookie 必须是 JSON 对象。");
  }
  return normalizeAccessTokenCookieRecord(cookieRecord, config);
}

function normalizeAccessTokenCookieRecord(
  cookieRecord: Record<string, unknown>,
  config: OidcConfig
): AccessTokenCookieConfig {
  const rawUrl =
    getRecordString(cookieRecord, "url") ||
    config.browserOrigin ||
    new URL(config.loginUrl || config.authorizeUrl).origin;
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("accessTokenCookie.url 只支持 http 或 https。");
  }
  const name = getRecordString(cookieRecord, "name") || DEFAULT_ACCESS_TOKEN_COOKIE_NAME;
  const pathValue = getRecordString(cookieRecord, "path") || "/";
  const domain = getRecordString(cookieRecord, "domain");
  const secureValue = cookieRecord.secure;
  const httpOnlyValue = cookieRecord.httpOnly;
  return {
    url: url.toString(),
    name,
    path: pathValue.startsWith("/") ? pathValue : `/${pathValue}`,
    ...(domain ? { domain } : {}),
    secure: typeof secureValue === "boolean" ? secureValue : url.protocol === "https:",
    httpOnly: typeof httpOnlyValue === "boolean" ? httpOnlyValue : false,
    sameSite: normalizeAccessTokenCookieSameSite(getRecordString(cookieRecord, "sameSite"))
  };
}

function normalizeAccessTokenCookieConfigs(
  record: Record<string, unknown>,
  config: OidcConfig,
  enabledByDefault: boolean
) {
  if (!("accessTokenCookies" in record)) {
    const cookieConfig = normalizeAccessTokenCookieConfig(record, config, enabledByDefault);
    return cookieConfig ? [cookieConfig] : [];
  }
  const rawValue = record.accessTokenCookies;
  if (!Array.isArray(rawValue)) {
    throw new Error("accessTokenCookies 必须是 JSON 对象数组。");
  }
  const cookieConfigs: AccessTokenCookieConfig[] = [];
  for (const item of rawValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("accessTokenCookies 只能包含 JSON 对象。");
    }
    cookieConfigs.push(normalizeAccessTokenCookieRecord(item as Record<string, unknown>, config));
  }
  return cookieConfigs;
}

function normalizeLoginCompletionUrls(record: Record<string, unknown>, config: OidcConfig) {
  const baseOrigin = config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin;
  const rawValues = [
    ...getRecordStringArray(record, "loginCompletionUrls"),
    getRecordString(record, "loginCompletionUrl"),
    getRecordString(record, "loginSuccessUrl")
  ].filter(Boolean);
  return [...new Set(rawValues.map((value) => new URL(value, baseOrigin).toString()))];
}

function normalizeHttpUrl(value: string, baseUrl: string, field: string) {
  const url = new URL(value, baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${field} 只支持 http 或 https。`);
  }
  return url.toString();
}

function normalizeHttpOrigin(value: string, field: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${field} 只支持 http 或 https。`);
  }
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function normalizeWebSessionCookieOrigins(
  exchangeRecord: Record<string, unknown>,
  exchangeUrl: string
) {
  const rawOrigins = getRecordStringArray(exchangeRecord, "cookieOrigins");
  const origins = rawOrigins.length > 0
    ? rawOrigins
    : [new URL(exchangeUrl).origin];
  return [...new Set(origins.map((origin) =>
    normalizeHttpOrigin(origin, "webSessionExchange.cookieOrigins")
  ))];
}

function normalizeWebSessionClearCookies(
  exchangeRecord: Record<string, unknown>,
  exchangeUrl: string
): DesktopSsoWebSessionClearCookieConfig[] {
  const rawValue = exchangeRecord.clearCookies;
  if (rawValue === undefined) {
    return [];
  }
  if (!Array.isArray(rawValue)) {
    throw new Error("webSessionExchange.clearCookies 必须是 JSON 对象数组。");
  }
  const cookies: DesktopSsoWebSessionClearCookieConfig[] = [];
  for (const item of rawValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("webSessionExchange.clearCookies 只能包含 JSON 对象。");
    }
    const cookieRecord = item as Record<string, unknown>;
    const rawUrl = getRecordString(cookieRecord, "url");
    const name = getRecordString(cookieRecord, "name");
    if (!rawUrl) {
      throw new Error("webSessionExchange.clearCookies.url 不能为空。");
    }
    if (!name) {
      throw new Error("webSessionExchange.clearCookies.name 不能为空。");
    }
    cookies.push({
      url: normalizeHttpUrl(rawUrl, exchangeUrl, "webSessionExchange.clearCookies.url"),
      name
    });
  }
  return cookies;
}

function normalizeWebSessionExchangeConfig(
  record: Record<string, unknown>,
  config: OidcConfig
): DesktopSsoWebSessionExchangeConfig | undefined {
  if (!("webSessionExchange" in record)) {
    return undefined;
  }
  const exchangeRecord = getRecordObject(record, "webSessionExchange");
  if (!exchangeRecord) {
    throw new Error("webSessionExchange 必须是 JSON 对象。");
  }
  const rawUrl = getRecordString(exchangeRecord, "url");
  if (!rawUrl) {
    throw new Error("webSessionExchange.url 不能为空。");
  }
  const rawCookieOrigins = getRecordStringArray(exchangeRecord, "cookieOrigins");
  const baseUrl = rawCookieOrigins[0] ||
    config.browserOrigin ||
    new URL(config.loginUrl || config.authorizeUrl).origin;
  const url = normalizeHttpUrl(rawUrl, baseUrl, "webSessionExchange.url");
  return {
    url,
    cookieOrigins: normalizeWebSessionCookieOrigins(exchangeRecord, url),
    clearCookies: normalizeWebSessionClearCookies(exchangeRecord, url)
  };
}

function buildOidcConfigFromRecord(record: Record<string, unknown>) {
  const provider = normalizeProviderName(getRecordString(record, "provider"));
  const useGoogleDesktopFlow = provider === "google" || recordLooksLikeGoogleOidcConfig(record);
  const config: OidcConfig = useGoogleDesktopFlow
    ? { ...DEFAULT_GOOGLE_OIDC_CONFIG }
    : { ...DEFAULT_OIDC_CONFIG };
  for (const field of OIDC_CONFIG_STRING_FIELDS) {
    if (
      useGoogleDesktopFlow &&
      (
        field === "loginUrl" ||
        field === "loginCompletionUrl" ||
        field === "redirectUri" ||
        field === "logoutUrl" ||
        field === "logoutCallbackUri"
      )
    ) {
      continue;
    }
    const value = getRecordString(record, field);
    if (value) {
      config[field] = value;
    }
  }
  config.provider = useGoogleDesktopFlow ? "google" : normalizeProviderName(config.provider);
  const browserOrigin = useGoogleDesktopFlow ? "" : normalizeIdentityProviderOrigin(record);
  if (!useGoogleDesktopFlow && browserOrigin) {
    config.browserOrigin = browserOrigin;
  }
  config.appendLoginState = getRecordBoolean(record, "appendLoginState", true);
  config.usePkce = getRecordBoolean(record, "usePkce", shouldUsePkce(config));
  if (useGoogleDesktopFlow) {
    config.usePkce = true;
  }
  const cookieAccessTokenExchange =
    useGoogleDesktopFlow
      ? null
      : normalizeCookieAccessTokenExchangeConfig(record, config) ||
        buildDefaultCookieAccessTokenExchangeConfig(config);
  if (cookieAccessTokenExchange) {
    config.cookieAccessTokenExchange = cookieAccessTokenExchange;
  }
  const loginCompletionUrls = useGoogleDesktopFlow ? [] : normalizeLoginCompletionUrls(record, config);
  if (loginCompletionUrls.length > 0) {
    config.loginCompletionUrl = loginCompletionUrls[0];
    config.loginCompletionUrls = loginCompletionUrls;
  }
  const accessTokenCookies = useGoogleDesktopFlow
    ? []
    : normalizeAccessTokenCookieConfigs(record, config, Boolean(cookieAccessTokenExchange));
  if (accessTokenCookies.length > 0) {
    config.accessTokenCookie = accessTokenCookies[0];
    config.accessTokenCookies = accessTokenCookies;
  }
  const webSessionExchange = normalizeWebSessionExchangeConfig(record, config);
  if (webSessionExchange) {
    config.webSessionExchange = webSessionExchange;
  }
  for (const field of OIDC_CONFIG_URL_FIELDS) {
    if (!config[field]) {
      continue;
    }
    try {
      new URL(config[field]);
    } catch {
      throw new Error(`${field} 不是有效 URL。`);
    }
  }
  if (!config.clientId.trim()) {
    throw new Error("clientId 不能为空。");
  }
  if (!config.clientSecret?.trim()) {
    if (isGoogleOidcConfig(config)) {
      throw new Error("Google Desktop SSO 需要配置 clientSecret。");
    }
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

function saveAccessTokenFile(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return;
  }
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

function removeAccessTokenFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(getDesktopSsoAccessTokenFilePath(app), { force: true });
  } catch {
    // Token file cleanup is best effort; logout still clears in-memory state.
  }
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
  currentAccessToken = "";
  removeAccessTokenFile(app);
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

function createPkceCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function createPkceCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildAuthorizeUrl(
  state: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeChallenge?: string;
  } = {}
) {
  if (config.loginUrl) {
    return buildConfiguredLoginUrl(state, config.loginUrl, config.appendLoginState);
  }
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri || config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (isGoogleOidcConfig(config)) {
    url.searchParams.set("scope", config.scope || DEFAULT_GOOGLE_SCOPE);
    if (options.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
  } else {
    url.searchParams.set("prompt", "login");
  }
  return url.toString();
}

function buildConfiguredLoginUrl(state: string, loginUrl: string, appendState = true) {
  if (!appendState) {
    return new URL(loginUrl).toString();
  }
  const url = new URL(loginUrl);
  if (url.hash) {
    const hashValue = url.hash.slice(1);
    const queryStartIndex = hashValue.indexOf("?");
    const hashPath = queryStartIndex >= 0 ? hashValue.slice(0, queryStartIndex) : hashValue;
    const hashQuery = queryStartIndex >= 0 ? hashValue.slice(queryStartIndex + 1) : "";
    const hashParams = new URLSearchParams(hashQuery);
    hashParams.set("state", state);
    url.hash = `${hashPath}?${hashParams.toString()}`;
    return url.toString();
  }
  url.searchParams.set("state", state);
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
  if (config.loginUrl) {
    origins.add(new URL(config.loginUrl).origin);
  }
  if (config.browserOrigin) {
    origins.add(config.browserOrigin);
  }
  if (config.cookieAccessTokenExchange) {
    origins.add(new URL(config.cookieAccessTokenExchange.url).origin);
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
    config.loginUrl,
    config.tokenUrl,
    config.wellKnownUrl,
    config.logoutUrl,
    config.cookieAccessTokenExchange?.url
  ]) {
    if (!value) {
      continue;
    }
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

function buildTokenExchangeRequest(
  code: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
): TokenExchangeRequest {
  const tokenUrl = new URL(config.tokenUrl);
  if (isGoogleOidcConfig(config)) {
    const bodyParams = new URLSearchParams();
    bodyParams.set("client_id", config.clientId);
    if (config.clientSecret?.trim()) {
      bodyParams.set("client_secret", config.clientSecret.trim());
    }
    bodyParams.set("redirect_uri", options.redirectUri || config.redirectUri);
    bodyParams.set("grant_type", "authorization_code");
    bodyParams.set("code", code);
    if (options.codeVerifier) {
      bodyParams.set("code_verifier", options.codeVerifier);
    }
    return {
      url: tokenUrl.toString(),
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    };
  }
  tokenUrl.searchParams.set("client_id", config.clientId);
  tokenUrl.searchParams.set("client_secret", config.clientSecret || "");
  tokenUrl.searchParams.set("redirect_uri", options.redirectUri || config.redirectUri);
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

function buildCookieAccessTokenExchangeRequest(
  cookieHeader: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): CookieAccessTokenExchangeRequest | null {
  const exchangeConfig = config.cookieAccessTokenExchange;
  if (!exchangeConfig) {
    return null;
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...exchangeConfig.headers
  };
  const normalizedCookieHeader = cookieHeader.trim();
  if (normalizedCookieHeader) {
    headers.Cookie = normalizedCookieHeader;
  }
  return {
    url: exchangeConfig.url,
    method: exchangeConfig.method,
    headers,
    ...(exchangeConfig.body !== undefined ? { body: exchangeConfig.body } : {})
  };
}

function readJsonPathValue(value: unknown, pathValue: string) {
  let currentValue = value;
  for (const segment of pathValue.split(".")) {
    const key = segment.trim();
    if (!key) {
      return undefined;
    }
    if (!currentValue || typeof currentValue !== "object") {
      return undefined;
    }
    currentValue = (currentValue as Record<string, unknown>)[key];
  }
  return currentValue;
}

function readCookieAccessTokenFromResponse(value: unknown, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const pathValue = config.cookieAccessTokenExchange?.accessTokenPath || DEFAULT_COOKIE_ACCESS_TOKEN_PATH;
  const accessToken = normalizeStringClaim(readJsonPathValue(value, pathValue));
  if (!accessToken) {
    throw new Error(`Cookie access_token 响应缺少 ${pathValue}。`);
  }
  return accessToken;
}

function getJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    return {};
  }
  try {
    return decodeJsonPart(payloadPart);
  } catch {
    return {};
  }
}

function createCookieAccessTokenClaims(accessToken: string, config: OidcConfig): DesktopSsoClaims {
  const payload = getJwtPayload(accessToken);
  return {
    sub: normalizeStringClaim(payload.sub) || "desktop-sso-cookie",
    issuer: normalizeStringClaim(payload.iss) || config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin,
    audience: normalizeAudience(payload.aud) || config.cookieAccessTokenExchange?.url || config.clientId,
    ...(normalizeStringClaim(payload.name) ? { name: normalizeStringClaim(payload.name) } : {}),
    ...(normalizeStringClaim(payload.email) ? { email: normalizeStringClaim(payload.email) } : {})
  };
}

function urlsMatchOriginAndPath(value: string, expected: string) {
  try {
    const valueUrl = new URL(value);
    const expectedUrl = new URL(expected);
    return valueUrl.origin === expectedUrl.origin && valueUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

async function exchangeCookieForAccessToken(
  cookieHeader: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
) {
  const request = buildCookieAccessTokenExchangeRequest(cookieHeader, config);
  if (!request) {
    return "";
  }
  const tokenResponse = await fetchJson(fetchImpl, request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  return readCookieAccessTokenFromResponse(tokenResponse, config);
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

function loadElectronFetchRuntime(): ElectronFetchRuntime | null {
  try {
    const runtime = require("electron") as unknown;
    return runtime && typeof runtime === "object" ? runtime as ElectronFetchRuntime : null;
  } catch {
    return null;
  }
}

function getElectronNetFetch(runtime: ElectronFetchRuntime | null = loadElectronFetchRuntime()): FetchLike | null {
  const net = runtime?.net;
  const netFetch = net?.fetch;
  if (typeof netFetch !== "function") {
    return null;
  }
  return ((url, init) => netFetch.call(net, url, init)) as FetchLike;
}

function getDefaultOidcFetch(runtime?: ElectronFetchRuntime | null): FetchLike {
  return getElectronNetFetch(runtime === undefined ? loadElectronFetchRuntime() : runtime) ||
    (fetch as unknown as FetchLike);
}

function describeFetchError(error: unknown) {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      if (cause.message && cause.message !== error.message) {
        parts.push(cause.message);
      }
      const code = (cause as Error & { code?: unknown }).code;
      if (typeof code === "string" && !parts.includes(code)) {
        parts.push(code);
      }
    } else if (typeof cause === "string" && cause && cause !== error.message) {
      parts.push(cause);
    }
  } else if (typeof error === "string") {
    parts.push(error);
  }
  return parts.filter(Boolean).join(" - ") || String(error);
}

function buildOidcFetchStage(action: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return `${isGoogleOidcConfig(config) ? "Google" : "OIDC"} ${action}`;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init?: Parameters<FetchLike>[1],
  stage = "OIDC request"
) {
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${stage} failed: ${describeFetchError(error)}`);
  }
  if (!response.ok) {
    const detail = await readFetchErrorBody(response);
    throw new Error(`${stage} failed: ${readFetchErrorStatus(response)}${detail ? ` - ${detail}` : ""}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${stage} failed: invalid JSON response - ${describeFetchError(error)}`);
  }
}

async function validateIdToken(
  idToken: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
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

  const discovery = await fetchJson(
    fetchImpl,
    config.wellKnownUrl,
    undefined,
    buildOidcFetchStage("OIDC discovery", config)
  ) as { jwks_uri?: unknown };
  const jwksUri = normalizeStringClaim(discovery.jwks_uri);
  if (!jwksUri) {
    throw new Error("OIDC well-known 配置缺少 jwks_uri。");
  }
  const jwks = await fetchJson(
    fetchImpl,
    jwksUri,
    undefined,
    buildOidcFetchStage("JWKS fetch", config)
  ) as { keys?: unknown };
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

async function exchangeCodeForTokenClaims(
  code: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
) {
  const request = buildTokenExchangeRequest(code, config, options);
  const tokenResponse = await fetchJson(fetchImpl, request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  }, buildOidcFetchStage("token exchange", config)) as { id_token?: unknown };
  const idToken = normalizeStringClaim(tokenResponse.id_token);
  if (!idToken) {
    throw new Error("Token 响应缺少 id_token。");
  }
  const claims = await validateIdToken(idToken, fetchImpl, config);
  return { claims, idToken };
}

async function exchangeCodeForClaims(
  code: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
) {
  return (await exchangeCodeForTokenClaims(code, fetchImpl, config, options)).claims;
}

async function handleLoginCallback(app: App, requestUrl: URL, fetchImpl?: FetchLike) {
  if (!pendingLogin) {
    throw new Error("没有正在进行的单点登录。");
  }
  const { code } = normalizeCallbackRequest(requestUrl, pendingLogin.state);
  const tokenClaims = await exchangeCodeForTokenClaims(code, fetchImpl, pendingLogin.config, {
    redirectUri: pendingLogin.redirectUri,
    codeVerifier: pendingLogin.codeVerifier
  });
  const claims = tokenClaims.claims;
  const statusContext: DesktopSsoStatusChangeContext = {
    provider: pendingLogin.config.provider,
    idToken: tokenClaims.idToken
  };
  pendingLogin = null;
  const status = createAuthenticatedStatus(claims);
  await callbackHooks.onBeforeStatusChanged?.(status, statusContext);
  setCurrentStatus(status);
  saveSession(app, status);
  return status;
}

function buildLogoutUrl(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const url = new URL(config.logoutUrl);
  url.searchParams.set("callback", config.logoutCallbackUri);
  return url.toString();
}

function closeCallbackServerAfterResponse(response: http.ServerResponse) {
  response.once("finish", closeCallbackServer);
}

async function handleCallbackRequest(app: App, request: http.IncomingMessage, response: http.ServerResponse) {
  const fallbackOrigin = callbackServerInfo?.origin || CALLBACK_ORIGIN;
  const requestUrl = new URL(request.url || "/", fallbackOrigin);
  const closeAfterCallback = callbackServerInfo?.closeAfterCallback === true;
  if (requestUrl.pathname === LOGOUT_CALLBACK_PATH) {
    desktopSsoProxyState?.cookies.clear();
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
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
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml("登录成功", `${status.user?.sub ?? "用户"} 已完成单点登录，可以回到 Desktop 继续使用。`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCurrentStatus(createFailedStatus(message));
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 400, renderCallbackHtml("登录失败", message));
  }
}

function closeCallbackServer() {
  const server = callbackServer;
  callbackServer = null;
  callbackServerReady = null;
  callbackServerInfo = null;
  desktopSsoProxyState = null;
  if (!server) {
    return;
  }
  server.close(() => {});
}

function buildCallbackServerInfo(host: string, port: number, closeAfterCallback: boolean): CallbackServerInfo {
  const origin = `http://${host}:${port}`;
  return {
    host,
    port,
    origin,
    redirectUri: `${origin}${CALLBACK_PATH}`,
    logoutCallbackUri: `${origin}${LOGOUT_CALLBACK_PATH}`,
    closeAfterCallback
  };
}

async function ensureCallbackServer(
  app: App,
  hooks: CallbackHooks = {},
  options: CallbackServerOptions = {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: false
  }
) {
  callbackHooks = hooks;
  if (callbackServer && callbackServerReady) {
    if (
      callbackServerInfo?.host === options.host &&
      callbackServerInfo.port === options.port &&
      callbackServerInfo.closeAfterCallback === options.closeAfterCallback
    ) {
      await callbackServerReady;
      return callbackServerInfo;
    }
    closeCallbackServer();
  }

  callbackServer = http.createServer((request, response) => {
    void handleCallbackRequest(app, request, response);
  });
  callbackServerReady = new Promise<void>((resolve, reject) => {
    const server = callbackServer;
    if (!server) {
      reject(new Error("callback server unavailable"));
      return;
    }
    const handleError = (error: NodeJS.ErrnoException) => {
      callbackServer = null;
      callbackServerReady = null;
      callbackServerInfo = null;
      if (error.code === "EADDRINUSE") {
        reject(new Error(`OIDC 回调端口 ${options.port} 已被占用。`));
        return;
      }
      reject(error);
    };
    server.once("error", handleError);
    server.listen(options.port, options.host, () => {
      server.off("error", handleError);
      const address = server.address() as AddressInfo | null;
      callbackServerInfo = buildCallbackServerInfo(
        options.host,
        address?.port || options.port,
        options.closeAfterCallback
      );
      resolve();
    });
  });
  await callbackServerReady;
  if (!callbackServerInfo) {
    throw new Error("callback server did not report a listening address");
  }
  return callbackServerInfo;
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
  currentAccessToken = "";
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
    currentAccessToken = "";
    removeAccessTokenFile(app);
    const useSystemBrowser = shouldUseSystemBrowser(oidcConfig);
    const callbackInfo = await ensureCallbackServer(
      app,
      hooks,
      useSystemBrowser
        ? {
          host: GOOGLE_LOOPBACK_HOST,
          port: 0,
          closeAfterCallback: true
        }
        : {
          host: CALLBACK_HOST,
          port: CALLBACK_PORT,
          closeAfterCallback: false
        }
    );
    if (!useSystemBrowser) {
      activateDesktopSsoProxy(oidcConfig, { resetCookies: true });
    }
    const state = randomUUID();
    const codeVerifier = shouldUsePkce(oidcConfig) ? createPkceCodeVerifier() : undefined;
    const redirectUri = useSystemBrowser ? callbackInfo.redirectUri : oidcConfig.redirectUri;
    const loginConfig = {
      ...oidcConfig,
      redirectUri
    };
    pendingLogin = {
      state,
      startedAt: new Date().toISOString(),
      config: loginConfig,
      redirectUri,
      ...(codeVerifier ? { codeVerifier } : {})
    };
    const authorizeUrl = buildAuthorizeUrl(state, loginConfig, {
      redirectUri,
      ...(codeVerifier ? { codeChallenge: createPkceCodeChallenge(codeVerifier) } : {})
    });
    const status = createPendingStatus("正在等待 IAM 单点登录完成。");
    setCurrentStatus(status);
    return {
      ok: true,
      authorizeUrl,
      ...(useSystemBrowser
        ? { openMode: "system" as const }
        : { browserUrl: oidcConfig.loginUrl ? undefined : buildDesktopSsoProxyUrl(authorizeUrl) }),
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

export function getDesktopSsoCookieAccessTokenExchangeUrl(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.cookieAccessTokenExchange) {
    return null;
  }
  return configResult.config.cookieAccessTokenExchange.url;
}

export function isDesktopSsoLoginCompletionUrl(app: Pick<App, "getPath">, value: string) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return false;
  }
  const completionUrls = configResult.config.loginCompletionUrls ||
    (configResult.config.loginCompletionUrl ? [configResult.config.loginCompletionUrl] : []);
  return completionUrls.some((completionUrl) => urlsMatchOriginAndPath(value, completionUrl));
}

export function buildDesktopSsoAccessTokenCookieDetails(
  accessToken: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): DesktopSsoAccessTokenCookieDetails[] {
  const token = accessToken.trim();
  const cookieConfigs = config.accessTokenCookies ||
    (config.accessTokenCookie ? [config.accessTokenCookie] : []);
  if (!token || cookieConfigs.length === 0) {
    return [];
  }
  return cookieConfigs.map((details) => ({
    url: details.url,
    name: details.name,
    value: token,
    path: details.path,
    ...(details.domain ? { domain: details.domain } : {}),
    secure: details.secure,
    httpOnly: details.httpOnly,
    sameSite: details.sameSite
  }));
}

export function getDesktopSsoAccessTokenCookieDetails(app: Pick<App, "getPath">, accessToken: string) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return [];
  }
  return buildDesktopSsoAccessTokenCookieDetails(accessToken, configResult.config);
}

export function getDesktopSsoAccessTokenCookieLookup(app: Pick<App, "getPath">) {
  return getDesktopSsoAccessTokenCookieLookups(app)[0] || null;
}

export function getDesktopSsoAccessTokenCookieLookups(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return [];
  }
  const cookieConfigs = configResult.config.accessTokenCookies ||
    (configResult.config.accessTokenCookie ? [configResult.config.accessTokenCookie] : []);
  return cookieConfigs.map((cookieConfig) => ({
    url: cookieConfig.url,
    name: cookieConfig.name
  }));
}

export function getDesktopSsoWebSessionExchangeConfig(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.webSessionExchange) {
    return null;
  }
  const config = configResult.config.webSessionExchange;
  return {
    url: config.url,
    cookieOrigins: [...config.cookieOrigins],
    clearCookies: config.clearCookies.map((cookie) => ({ ...cookie }))
  };
}

export function getDesktopSsoWebSessionClearCookies(app: Pick<App, "getPath">) {
  return getDesktopSsoWebSessionExchangeConfig(app)?.clearCookies ?? [];
}

export async function exchangeConfiguredDesktopSsoCookieForAccessToken(
  app: Pick<App, "getPath">,
  cookieHeader: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return "";
  }
  const accessToken = await exchangeCookieForAccessToken(cookieHeader, fetchImpl, configResult.config);
  if (accessToken) {
    currentAccessToken = accessToken;
    saveAccessTokenFile(app, accessToken);
  }
  return accessToken;
}

export function getDesktopSsoAccessToken() {
  return currentAccessToken || null;
}

export function completeDesktopSsoBrowserLogin(app: App, completionUrl: string): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    return createFailedStatus(configResult.error || "Desktop 单点登录配置缺少 OIDC 参数。");
  }
  pendingLogin = null;
  const parsedUrl = new URL(completionUrl);
  const status = createAuthenticatedStatus({
    sub: parsedUrl.hostname || "desktop-sso-browser",
    issuer: configResult.config.browserOrigin || parsedUrl.origin,
    audience: configResult.config.browserOrigin || parsedUrl.origin
  });
  setCurrentStatus(status);
  saveSession(app, status);
  return cloneStatus(status);
}

export function completeDesktopSsoCookieLogin(app: App, accessToken: string): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    return createFailedStatus(configResult.error || "Desktop 单点登录配置缺少 OIDC 参数。");
  }
  const token = accessToken.trim();
  if (!token) {
    return createFailedStatus("Cookie access_token 为空。");
  }
  pendingLogin = null;
  currentAccessToken = token;
  saveAccessTokenFile(app, token);
  const status = createAuthenticatedStatus(createCookieAccessTokenClaims(token, configResult.config));
  setCurrentStatus(status);
  saveSession(app, status);
  return cloneStatus(status);
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
  if (shouldUseSystemBrowser(oidcConfig)) {
    closeCallbackServer();
    return {
      ok: true,
      status: cloneStatus(status),
      message: "已清除 Desktop 登录状态。"
    };
  }
  try {
    const callbackInfo = await ensureCallbackServer(app, hooks);
    activateDesktopSsoProxy(oidcConfig);
    const logoutConfig = {
      ...oidcConfig,
      logoutCallbackUri: callbackInfo.logoutCallbackUri
    };
    const logoutUrl = buildLogoutUrl(logoutConfig);
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
  DEFAULT_GOOGLE_OIDC_CONFIG,
  DESKTOP_SSO_CONFIG_FILE_NAME,
  buildAuthorizeUrl,
  createPkceCodeChallenge,
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
  buildConfiguredLoginUrl,
  buildTokenExchangeRequest,
  buildCookieAccessTokenExchangeRequest,
  buildDesktopSsoAccessTokenCookieDetails,
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoCookieLogin,
  getDesktopSsoAccessTokenFilePath,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoAccessTokenCookieLookup,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoWebSessionClearCookies,
  isDesktopSsoLoginCompletionUrl,
  readCookieAccessTokenFromResponse,
  normalizeCallbackRequest,
  getDefaultOidcFetch,
  exchangeCodeForTokenClaims,
  exchangeCodeForClaims,
  validateIdToken,
  closeCallbackServer
};
