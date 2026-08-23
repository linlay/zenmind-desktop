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
import { BRAND_ID, PRODUCT_NAME, STORAGE_NAMESPACE } from "../shared/brand";
import {
  buildDesktopSsoAvatarUrl,
  DESKTOP_SSO_AVATAR_PROTOCOL
} from "../shared/sso-avatar";
import {
  getDesktopSsoAccessTokenFilePath,
  getDesktopStateRoot,
  getSecretsRoot
} from "./user-paths";
import { resolveRuntimeRoot } from "./env-bootstrap";
import { t } from "./i18n/main-i18n";
import { clearCachedDesktopSsoAvatar } from "./sso-avatar-storage";

type OidcConfig = {
  provider?: string;
  providerLabel?: string;
  authMode?: "server" | "oidc";
  browserMode?: "system" | "embedded";
  issuer: string;
  authorizeUrl: string;
  serverAuthorizeUrl?: string;
  loginUrl?: string;
  appendLoginState: boolean;
  loginCompletionUrl?: string;
  loginCompletionUrls?: string[];
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  prompt?: string;
  wellKnownUrl?: string;
  jwksUrl?: string;
  logoutUrl: string;
  logoutCallbackUri: string;
  browserOrigin?: string;
  usePkce?: boolean;
  cookieAccessTokenExchange?: CookieAccessTokenExchangeConfig;
  accessTokenCookie?: AccessTokenCookieConfig;
  accessTokenCookies?: AccessTokenCookieConfig[];
  browserSession?: DesktopSsoBrowserSessionConfig;
  userInfo?: DesktopSsoUserInfoConfig;
  avatarCache?: DesktopSsoAvatarCacheConfig;
  claims?: DesktopSsoClaimsConfig;
  webSessionExchange?: DesktopSsoWebSessionExchangeConfig;
};

type CookieAccessTokenExchangeConfig = {
  url: string;
  csrfUrl?: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  accessTokenPath: string;
};

export type DesktopSsoBrowserSessionConfig = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  successStatuses: number[];
  userInfoHeaders?: DesktopSsoBrowserSessionUserInfoHeaders;
};

export type DesktopSsoBrowserSessionUserInfoHeaders = {
  sub: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
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

export type DesktopSsoClaimsConfig = {
  audience: string;
  webSessionSubPrefix: string;
  ticketPlaceholderSub: string;
  cookieFallbackSub: string;
  browserFallbackSub: string;
};

export type DesktopSsoUserInfoConfig = {
  enabled: boolean;
  required: boolean;
  authMode: "bearer" | "cookie";
  url: string;
  subPath: string;
  namePath: string;
  emailPath: string;
  avatarUrlPath: string;
};

export type DesktopSsoAvatarCacheConfig = {
  enabled: true;
  trustedOrigin: string;
};

export type DesktopSsoWebSessionExchangeConfig = {
  url: string;
  provider: string;
  claims: DesktopSsoClaimsConfig;
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
  headers?: {
    get(name: string): string | null;
  };
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
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
  ) => void | DesktopSsoClaims | Promise<void | DesktopSsoClaims>;
  onAfterStatusChanged?: (
    status: DesktopSsoStatus,
    context?: DesktopSsoStatusChangeContext
  ) => void | Promise<void>;
  onStatusChanged?: (status: DesktopSsoStatus) => void;
  onReturnToAppRequested?: () => void | Promise<void>;
};

type DesktopSsoStatusChangeContext = {
  provider?: string;
  idToken?: string;
  ticket?: string;
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
  expirationDate?: number;
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
const RETURN_TO_APP_PATH = "/api/auth/oidc/return-to-app";
const SESSION_FILE_NAME = "sso-session.json";
const USER_INFO_FILE_NAME = "sso-user-info.json";
const LEGACY_SITE_TOKEN_FILE_NAME = "sso-site-token.json";
const DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS = 15 * 60_000;
export const DESKTOP_SSO_CONFIG_FILE_NAME = "sso.json";
const IDENTITY_PROVIDER_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl"
] as const;
const OIDC_CONFIG_STRING_FIELDS = [
  "provider",
  "providerLabel",
  "issuer",
  "authorizeUrl",
  "serverAuthorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "redirectUri",
  "scope",
  "prompt",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;
const OIDC_CONFIG_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "serverAuthorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "redirectUri",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;
const DEFAULT_COOKIE_ACCESS_TOKEN_PATH = "access_token";
const DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT = "text/plain,application/json,*/*";
const DEFAULT_ACCESS_TOKEN_COOKIE_NAME = "access_token";
const DEFAULT_GOOGLE_SCOPE = "openid email profile";
const DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG: DesktopSsoClaimsConfig = {
  audience: STORAGE_NAMESPACE,
  webSessionSubPrefix: `${BRAND_ID}-user:`,
  ticketPlaceholderSub: "desktop-sso-ticket",
  cookieFallbackSub: "desktop-sso-cookie",
  browserFallbackSub: "desktop-sso-browser"
};

export const DEFAULT_OIDC_CONFIG: OidcConfig = {
  issuer: "https://iam.example.com/auth/oidc/example-app",
  authorizeUrl: "https://iam.example.com/auth/oauth2/authorize",
  tokenUrl: "https://iam.example.com/auth/oauth2/token",
  clientId: "desktop-test-client",
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

let currentStatus: DesktopSsoStatus = createSignedOutStatus(t("sso.notSignedIn"));
let callbackServer: http.Server | null = null;
let callbackServerReady: Promise<void> | null = null;
let callbackServerInfo: CallbackServerInfo | null = null;
let callbackHooks: CallbackHooks = {};
let pendingLogin: PendingLogin | null = null;
let desktopSsoProxyState: DesktopSsoProxyState | null = null;
let currentAccessToken = "";
let currentIdToken = "";
let currentSessionAuthMode: DesktopSsoSessionMetadata["authMode"] | null = null;
let currentSessionApp: App | null = null;
let currentSessionMetadata: DesktopSsoSessionMetadata | null = null;
let loadedSessionPath = "";
let unverifiedCookieSessionCandidate = false;
const usedAuthorizationCodes = new Set<string>();
const usedDesktopSsoTickets = new Set<string>();

function createCompletedSteps(overrides: Partial<DesktopSsoStatus["completedSteps"]> = {}) {
  return {
    session: false,
    userInfo: false,
    accessToken: false,
    ...overrides
  };
}

function createSignedOutStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: false,
    user: null,
    completedSteps: createCompletedSteps(),
    message,
    updatedAt: new Date().toISOString()
  };
}

function createPendingStatus(message: string, preservedStatus?: DesktopSsoStatus): DesktopSsoStatus {
  if (preservedStatus?.authenticated && preservedStatus.completedSteps.session) {
    const status = cloneStatus(preservedStatus);
    delete status.error;
    return {
      ...status,
      pending: true,
      message,
      updatedAt: new Date().toISOString()
    };
  }
  return {
    configured: true,
    authenticated: false,
    pending: true,
    user: null,
    completedSteps: createCompletedSteps(),
    message,
    updatedAt: new Date().toISOString()
  };
}

function createAuthenticatedStatus(
  claims: DesktopSsoClaims | null,
  completedSteps: DesktopSsoStatus["completedSteps"] = createCompletedSteps({
    session: true,
    userInfo: Boolean(claims),
    accessToken: Boolean(currentAccessToken)
  }),
  options: { message?: string; error?: string; pending?: boolean } = {}
): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: true,
    pending: options.pending ?? false,
    user: claims,
    completedSteps: { ...completedSteps },
    message: options.message || (
      completedSteps.accessToken
        ? t("sso.completed")
        : t("sso.completedWithoutAccessToken")
    ),
    ...(options.error ? { error: options.error } : {}),
    updatedAt: new Date().toISOString()
  };
}

function getCompletedDesktopSsoMessage(
  completedSteps: DesktopSsoStatus["completedSteps"],
  hasError = false
) {
  if (!completedSteps.userInfo) {
    return t("sso.completedWithoutUserInfo");
  }
  if (!completedSteps.accessToken) {
    return t("sso.completedWithoutAccessToken");
  }
  return hasError ? t("sso.completedWithWarning") : t("sso.completed");
}

function createFailedStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: false,
    user: null,
    completedSteps: createCompletedSteps(),
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
    completedSteps: createCompletedSteps(),
    message,
    updatedAt: new Date().toISOString()
  };
}

function cloneStatus(status: DesktopSsoStatus): DesktopSsoStatus {
  return {
    ...status,
    user: status.user ? { ...status.user } : null,
    completedSteps: { ...status.completedSteps }
  };
}

function setCurrentStatus(status: DesktopSsoStatus) {
  currentStatus = cloneStatus(status);
  callbackHooks.onStatusChanged?.(cloneStatus(currentStatus));
}

function getSessionPath(app: App) {
  return path.join(getDesktopStateRoot(app), SESSION_FILE_NAME);
}

export function getDesktopSsoUserInfoFilePath(app: Pick<App, "getPath">) {
  return path.join(getDesktopStateRoot(app as App), USER_INFO_FILE_NAME);
}

function removeLegacyDesktopSsoSiteTokenFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(path.join(getSecretsRoot(app as App), LEGACY_SITE_TOKEN_FILE_NAME), { force: true });
  } catch {
    // The retired duplicate credential is best-effort cleanup; canonical auth state remains authoritative.
  }
}

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveDesktopSsoConfigPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(resolveRuntimeRoot(app, platform), ".desktop", "config", "desktop", DESKTOP_SSO_CONFIG_FILE_NAME);
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
    throw new Error(t("sso.config.stringOrArray", { key }));
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(t("sso.config.stringOnly", { key }));
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

function getRecordOptionalBoolean(record: Record<string, unknown>, key: string) {
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
  return undefined;
}

function normalizeProviderName(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

function normalizeAuthMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === "server" ? "server" : "oidc";
}

function normalizeBrowserMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "system" || normalizedValue === "external") {
    return "system";
  }
  if (normalizedValue === "embedded" || normalizedValue === "internal" || normalizedValue === "embeded") {
    return "embedded";
  }
  return undefined;
}

function isServerBrokerAuthMode(config: OidcConfig) {
  return config.authMode === "server";
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

function shouldUsePkceByDefault(config: OidcConfig) {
  return isGoogleOidcConfig(config) || !config.clientSecret?.trim();
}

function isPublicPkceOidcConfig(config: OidcConfig) {
  return shouldUsePkce(config) && !config.clientSecret?.trim();
}

function shouldUseSystemBrowser(config: OidcConfig) {
  if (config.browserMode === "system") {
    return true;
  }
  if (config.browserMode === "embedded") {
    return false;
  }
  return isServerBrokerAuthMode(config) || isGoogleOidcConfig(config);
}

function shouldUseEphemeralSystemCallback(config: OidcConfig) {
  return !config.browserMode && shouldUseSystemBrowser(config);
}

function getDesktopSsoProviderLabel(config: OidcConfig) {
  return config.providerLabel?.trim() ||
    (isGoogleOidcConfig(config) ? "Google" : PRODUCT_NAME);
}

function getDesktopSsoLoginLabel(config: OidcConfig) {
  return t("sso.providerLogin", { provider: getDesktopSsoProviderLabel(config) });
}

function getDesktopSsoLogoutLabel(config: OidcConfig) {
  return t("sso.providerLogout", { provider: getDesktopSsoProviderLabel(config) });
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
    throw new Error(t("sso.config.fileObjectOrIamHost"));
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
    throw new Error(t("sso.config.iamProtocol"));
  }
  if (!url.hostname) {
    throw new Error(t("sso.config.iamHostnameMissing"));
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
    throw new Error(t("sso.config.cookieHeadersObject"));
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(t("sso.config.cookieHeadersStringValues"));
    }
    headers[normalizedName] = value;
  }
  return headers;
}

function normalizeCookieAccessTokenExchangeMethod(record: Record<string, unknown>) {
  const method = (getRecordString(record, "method") || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error(t("sso.config.cookieMethod"));
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
    throw new Error(t("sso.config.cookieBodyPostOnly"));
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
  throw new Error(t("sso.config.cookieBodyType"));
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
    throw new Error(t("sso.config.cookieExchangeObject"));
  }
  const rawUrl = getRecordString(exchangeRecord, "url");
  if (!rawUrl) {
    throw new Error(t("sso.config.cookieExchangeUrlRequired"));
  }
  const baseOrigin = config.browserOrigin || getDesktopSsoProxyTargetOrigin(config);
  const method = normalizeCookieAccessTokenExchangeMethod(exchangeRecord);
  const headers = normalizeCookieAccessTokenExchangeHeaders(exchangeRecord);
  const body = normalizeCookieAccessTokenExchangeBody(exchangeRecord, method, headers);
  const accessTokenPath = getRecordString(exchangeRecord, "accessTokenPath") || DEFAULT_COOKIE_ACCESS_TOKEN_PATH;
  const rawCsrfUrl = getRecordString(exchangeRecord, "csrfUrl");
  return {
    url: new URL(rawUrl, baseOrigin).toString(),
    ...(rawCsrfUrl ? { csrfUrl: new URL(rawCsrfUrl, baseOrigin).toString() } : {}),
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    accessTokenPath
  };
}

function normalizeBrowserSessionSuccessStatuses(record: Record<string, unknown>) {
  const rawValue = record.successStatuses;
  if (rawValue === undefined) {
    return [200, 202];
  }
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    throw new Error(t("sso.config.browserSessionStatusesArray"));
  }
  const statuses = rawValue.map((value) => {
    if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) {
      throw new Error(t("sso.config.browserSessionStatusRange"));
    }
    return value as number;
  });
  return [...new Set(statuses)];
}

function normalizeBrowserSessionUserInfoHeaders(
  record: Record<string, unknown>
): DesktopSsoBrowserSessionUserInfoHeaders | undefined {
  if (!("userInfoHeaders" in record)) {
    return undefined;
  }
  const headersRecord = getRecordObject(record, "userInfoHeaders");
  if (!headersRecord) {
    throw new Error(t("sso.config.browserSessionUserInfoHeadersObject"));
  }
  const sub = getRecordString(headersRecord, "sub");
  if (!sub) {
    throw new Error(t("sso.config.browserSessionUserInfoSubHeaderRequired"));
  }
  const name = getRecordString(headersRecord, "name");
  const email = getRecordString(headersRecord, "email");
  const avatarUrl = getRecordString(headersRecord, "avatarUrl");
  return {
    sub,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

function normalizeBrowserSessionConfig(
  record: Record<string, unknown>,
  config: OidcConfig
): DesktopSsoBrowserSessionConfig | undefined {
  if (!("browserSession" in record)) {
    return undefined;
  }
  const sessionRecord = getRecordObject(record, "browserSession");
  if (!sessionRecord) {
    throw new Error(t("sso.config.browserSessionObject"));
  }
  const rawUrl = getRecordString(sessionRecord, "url");
  if (!rawUrl) {
    throw new Error(t("sso.config.browserSessionUrlRequired"));
  }
  const method = normalizeCookieAccessTokenExchangeMethod(sessionRecord);
  const headers = normalizeCookieAccessTokenExchangeHeaders(sessionRecord);
  const body = normalizeCookieAccessTokenExchangeBody(sessionRecord, method, headers);
  const userInfoHeaders = normalizeBrowserSessionUserInfoHeaders(sessionRecord);
  const baseUrl = config.browserOrigin || config.loginUrl || config.authorizeUrl;
  return {
    url: normalizeHttpUrl(rawUrl, baseUrl, "browserSession.url"),
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    successStatuses: normalizeBrowserSessionSuccessStatuses(sessionRecord),
    ...(userInfoHeaders ? { userInfoHeaders } : {})
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
    throw new Error(t("sso.config.accessTokenCookieObject"));
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
    throw new Error(t("sso.config.accessTokenCookieUrlProtocol"));
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
    throw new Error(t("sso.config.accessTokenCookiesArray"));
  }
  const cookieConfigs: AccessTokenCookieConfig[] = [];
  for (const item of rawValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(t("sso.config.accessTokenCookiesObjectOnly"));
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

function normalizeDesktopSsoClaimsConfig(record: Record<string, unknown>): DesktopSsoClaimsConfig {
  const claimsRecord = getRecordObject(record, "claims") || {};
  return {
    audience: getRecordString(claimsRecord, "audience") || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG.audience,
    webSessionSubPrefix: getRecordString(claimsRecord, "webSessionSubPrefix") ||
      DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG.webSessionSubPrefix,
    ticketPlaceholderSub: getRecordString(claimsRecord, "ticketPlaceholderSub") ||
      DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG.ticketPlaceholderSub,
    cookieFallbackSub: getRecordString(claimsRecord, "cookieFallbackSub") ||
      DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG.cookieFallbackSub,
    browserFallbackSub: getRecordString(claimsRecord, "browserFallbackSub") ||
      DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG.browserFallbackSub
  };
}

function normalizeHttpUrl(value: string, baseUrl: string, field: string) {
  const url = new URL(value, baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(t("sso.config.fieldHttpOnly", { field }));
  }
  return url.toString();
}

function normalizeHttpOrigin(value: string, field: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(t("sso.config.fieldHttpOnly", { field }));
  }
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function normalizeUserInfoConfig(
  record: Record<string, unknown>,
  config: OidcConfig
): DesktopSsoUserInfoConfig | undefined {
  const rawUserInfo = "userInfo" in record ? getRecordObject(record, "userInfo") : null;
  const rawUrl = rawUserInfo
    ? getRecordString(rawUserInfo, "url")
    : getRecordString(record, "userInfoUrl");
  if (!rawUserInfo && !rawUrl) {
    return undefined;
  }
  if ("userInfo" in record && !rawUserInfo) {
    throw new Error(t("sso.config.userInfoObject"));
  }
  if (rawUserInfo && getRecordBoolean(rawUserInfo, "enabled", true) === false) {
    return undefined;
  }
  if (!rawUrl) {
    throw new Error(t("sso.config.userInfoUrlRequired"));
  }
  const source = rawUserInfo || {};
  const rawAuthMode = (getRecordString(source, "authMode") || "bearer").toLowerCase();
  if (rawAuthMode !== "bearer" && rawAuthMode !== "cookie") {
    throw new Error(t("sso.config.userInfoAuthMode"));
  }
  return {
    enabled: true,
    required: getRecordBoolean(source, "required", false),
    authMode: rawAuthMode,
    url: normalizeHttpUrl(rawUrl, config.browserOrigin || config.issuer, "userInfo.url"),
    subPath: getRecordString(source, "subPath") || "sub",
    namePath: getRecordString(source, "namePath") || "name",
    emailPath: getRecordString(source, "emailPath") || "email",
    avatarUrlPath: getRecordString(source, "avatarUrlPath") || "picture"
  };
}

function normalizeAvatarCacheConfig(
  record: Record<string, unknown>
): DesktopSsoAvatarCacheConfig | undefined {
  if (!("avatarCache" in record)) {
    return undefined;
  }
  const avatarCache = getRecordObject(record, "avatarCache");
  if (!avatarCache) {
    throw new Error(t("sso.config.avatarCacheObject"));
  }
  if (getRecordBoolean(avatarCache, "enabled", true) === false) {
    return undefined;
  }
  const rawTrustedOrigin = getRecordString(avatarCache, "trustedOrigin");
  if (!rawTrustedOrigin) {
    throw new Error(t("sso.config.avatarCacheTrustedOriginRequired"));
  }
  let parsed: URL;
  try {
    parsed = new URL(rawTrustedOrigin);
  } catch {
    throw new Error(t("sso.config.avatarCacheTrustedOriginHttps"));
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(t("sso.config.avatarCacheTrustedOriginHttps"));
  }
  return {
    enabled: true,
    trustedOrigin: parsed.origin
  };
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
    throw new Error(t("sso.config.clearCookiesArray"));
  }
  const cookies: DesktopSsoWebSessionClearCookieConfig[] = [];
  for (const item of rawValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(t("sso.config.clearCookiesObjectOnly"));
    }
    const cookieRecord = item as Record<string, unknown>;
    const rawUrl = getRecordString(cookieRecord, "url");
    const name = getRecordString(cookieRecord, "name");
    if (!rawUrl) {
      throw new Error(t("sso.config.clearCookiesUrlRequired"));
    }
    if (!name) {
      throw new Error(t("sso.config.clearCookiesNameRequired"));
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
    throw new Error(t("sso.config.webSessionExchangeObject"));
  }
  const rawUrl = getRecordString(exchangeRecord, "url");
  if (!rawUrl) {
    throw new Error(t("sso.config.webSessionExchangeUrlRequired"));
  }
  const rawCookieOrigins = getRecordStringArray(exchangeRecord, "cookieOrigins");
  const baseUrl = rawCookieOrigins[0] ||
    config.browserOrigin ||
    config.serverAuthorizeUrl ||
    new URL(config.loginUrl || config.authorizeUrl).origin;
  const url = normalizeHttpUrl(rawUrl, baseUrl, "webSessionExchange.url");
  return {
    url,
    provider: getRecordString(exchangeRecord, "provider") || config.provider || "oidc",
    claims: config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG,
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
  if (!useGoogleDesktopFlow) {
    config.wellKnownUrl = getRecordString(record, "wellKnownUrl") || undefined;
    config.jwksUrl = getRecordString(record, "jwksUrl") || undefined;
    config.logoutUrl = getRecordString(record, "logoutUrl");
  }
  const normalizedProvider = normalizeProviderName(config.provider);
  config.provider = useGoogleDesktopFlow ? "google" : (normalizedProvider || undefined);
  config.authMode = normalizeAuthMode(getRecordString(record, "authMode"));
  config.browserMode = normalizeBrowserMode(getRecordString(record, "browserMode") || getRecordString(record, "mode"));
  const browserOrigin = useGoogleDesktopFlow ? "" : normalizeIdentityProviderOrigin(record);
  if (!useGoogleDesktopFlow && browserOrigin) {
    config.browserOrigin = browserOrigin;
  }
  config.appendLoginState = getRecordBoolean(record, "appendLoginState", true);
  config.usePkce = getRecordOptionalBoolean(record, "usePkce") ?? shouldUsePkceByDefault(config);
  if (useGoogleDesktopFlow) {
    config.usePkce = true;
  }
  const cookieAccessTokenExchange =
    useGoogleDesktopFlow
      ? null
      : normalizeCookieAccessTokenExchangeConfig(record, config);
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
  const browserSession = useGoogleDesktopFlow
    ? undefined
    : normalizeBrowserSessionConfig(record, config);
  if (browserSession) {
    config.browserSession = browserSession;
  }
  config.claims = normalizeDesktopSsoClaimsConfig(record);
  const userInfo = normalizeUserInfoConfig(record, config);
  if (userInfo) {
    config.userInfo = userInfo;
  }
  const avatarCache = normalizeAvatarCacheConfig(record);
  if (avatarCache) {
    config.avatarCache = avatarCache;
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
      throw new Error(t("sso.config.fieldInvalidUrl", { field }));
    }
  }
  if (isServerBrokerAuthMode(config)) {
    if (!config.serverAuthorizeUrl?.trim()) {
      throw new Error(t("sso.config.serverAuthorizeRequired"));
    }
    if (!config.webSessionExchange) {
      throw new Error(t("sso.config.serverAuthNeedsWebSession"));
    }
    return config;
  }
  if (!config.loginUrl && !config.wellKnownUrl?.trim() && !config.jwksUrl?.trim()) {
    throw new Error(t("sso.config.jwksRequired"));
  }
  if (!config.clientId.trim()) {
    throw new Error(t("sso.config.clientIdRequired"));
  }
  if (!config.clientSecret?.trim()) {
    if (isPublicPkceOidcConfig(config)) {
      return config;
    }
    if (isGoogleOidcConfig(config)) {
      throw new Error(t("sso.config.googleClientSecretRequired"));
    }
    throw new Error(t("sso.config.clientSecretRequired"));
  }
  return config;
}

export function loadDesktopSsoConfig(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform): DesktopSsoConfigLoadResult {
  const configPath = resolveDesktopSsoConfigPath(app, platform);
  if (!fs.existsSync(configPath)) {
    return {
      configured: false,
      configPath,
      message: t("sso.notConfigured")
    };
  }
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const record = parseDesktopSsoConfigContent(content);
    if (!isConfigEnabled(record)) {
      return {
        configured: false,
        configPath,
        message: t("sso.notConfigured")
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
      error: t("sso.invalidConfig", { message })
    };
  }
}

type DesktopSsoSessionMetadata = {
  issuer?: string;
  audience?: string;
  authMode?: "oidc" | "browser-cookie" | "server";
};

type DesktopSsoUserInfoSource =
  | "id_token"
  | "userinfo"
  | "browser_session"
  | "cookie_userinfo"
  | "sso";

function saveSession(
  app: App,
  status: DesktopSsoStatus,
  _idToken = "",
  metadata: DesktopSsoSessionMetadata = {}
) {
  fs.mkdirSync(path.dirname(getSessionPath(app)), { recursive: true });
  fs.writeFileSync(getSessionPath(app), JSON.stringify({
    schemaVersion: 2,
    authenticated: status.authenticated,
    issuer: metadata.issuer || status.user?.issuer || "",
    audience: metadata.audience || status.user?.audience || "",
    authMode: metadata.authMode || "oidc",
    message: status.message,
    updatedAt: status.updatedAt
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function persistCurrentSessionStatus() {
  if (!currentSessionApp || !currentSessionMetadata || !currentStatus.authenticated) {
    return;
  }
  saveSession(currentSessionApp, currentStatus, currentIdToken, currentSessionMetadata);
}

function saveUserInfoFile(
  app: Pick<App, "getPath">,
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource = "sso"
) {
  const filePath = getDesktopSsoUserInfoFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 2,
    ...user,
    updatedAt: new Date().toISOString(),
    source
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function removeUserInfoFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(getDesktopSsoUserInfoFilePath(app), { force: true });
  } catch {
    // Userinfo cleanup is best effort; local Desktop auth state is already cleared.
  }
}

function saveAccessTokenFile(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return;
  }
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the publish failure; a same-directory temp file is never authoritative.
    }
    throw error;
  }
}

function removeAccessTokenFile(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  try {
    fs.rmSync(filePath, { force: true });
    if (fs.existsSync(filePath)) {
      return new Error(`access token file still exists after removal: ${filePath}`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function readUserInfoFile(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoUserInfoFilePath(app);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopSsoClaims>;
    return typeof parsed.sub === "string" && parsed.sub.trim()
      ? parsed as DesktopSsoClaims
      : null;
  } catch {
    return null;
  }
}

function isDesktopSsoAvatarSourceTrusted(config: DesktopSsoAvatarCacheConfig, sourceUrl: string) {
  try {
    return new URL(sourceUrl).origin === config.trustedOrigin;
  } catch {
    return false;
  }
}

function desktopSsoAvatarVersion(user: DesktopSsoClaims) {
  const sourceUrl = user.avatarUrl?.trim() || "";
  return createHash("sha256")
    .update(`${user.sub.trim()}\x00${sourceUrl}`)
    .digest("hex")
    .slice(0, 24);
}

function withoutAvatarUrl(user: DesktopSsoClaims): DesktopSsoClaims {
  const { avatarUrl: _avatarUrl, ...rest } = user;
  return rest;
}

function presentDesktopSsoUser(app: Pick<App, "getPath">, user: DesktopSsoClaims | null) {
  if (!user) {
    return null;
  }
  const config = getDesktopSsoAvatarCacheConfig(app);
  if (!config) {
    return { ...user };
  }
  const sourceUrl = user.avatarUrl?.trim() || "";
  if (!sourceUrl || !isDesktopSsoAvatarSourceTrusted(config, sourceUrl)) {
    return withoutAvatarUrl(user);
  }
  return {
    ...user,
    avatarUrl: buildDesktopSsoAvatarUrl(desktopSsoAvatarVersion(user))
  };
}

function persistedDesktopSsoUser(
  app: Pick<App, "getPath">,
  user: DesktopSsoClaims
): DesktopSsoClaims {
  const avatarUrl = user.avatarUrl?.trim() || "";
  if (!avatarUrl.startsWith(`${DESKTOP_SSO_AVATAR_PROTOCOL}:`)) {
    return user;
  }
  const existing = readUserInfoFile(app);
  return existing?.avatarUrl
    ? { ...user, avatarUrl: existing.avatarUrl }
    : withoutAvatarUrl(user);
}

export function readDesktopSsoAccessToken(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function readDesktopSsoAccessTokenUser(app: Pick<App, "getPath">): DesktopSsoClaims | null {
  const payload = getJwtPayload(readDesktopSsoAccessToken(app));
  const sub = normalizeStringClaim(payload.sub);
  const expiresAt = typeof payload.exp === "number" ? payload.exp : Number.NaN;
  if (!sub || !Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
    return null;
  }
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  return {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud),
    ...(name ? { name } : {}),
    ...(email ? { email } : {})
  };
}

export function desktopSsoAccessTokenNeedsRefresh(
  app: Pick<App, "getPath">,
  minValidityMs = DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS
) {
  const token = currentAccessToken || readDesktopSsoAccessToken(app);
  if (!token) {
    return true;
  }
  const expirationClaim = getJwtPayload(token).exp;
  const expiresAtSeconds = typeof expirationClaim === "number" ? expirationClaim : Number.NaN;
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= 0) {
    return true;
  }
  return expiresAtSeconds * 1000 <= Date.now() + Math.max(0, minValidityMs);
}

function loadSession(app: App) {
  removeLegacyDesktopSsoSiteTokenFile(app);
  loadedSessionPath = getSessionPath(app);
  unverifiedCookieSessionCandidate = false;
  currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  currentIdToken = "";
  currentAccessToken = "";
  currentSessionAuthMode = null;
  currentSessionApp = null;
  currentSessionMetadata = null;
  const filePath = getSessionPath(app);
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopSsoStatus> & {
      schemaVersion?: unknown;
      issuer?: unknown;
      audience?: unknown;
      authMode?: unknown;
      idToken?: unknown;
    };
    if (parsed.authenticated) {
      const separateUser = readUserInfoFile(app);
      const legacyUser = parsed.user?.sub ? parsed.user : null;
      const user = separateUser || legacyUser;
      const sessionIssuer = typeof parsed.issuer === "string" ? parsed.issuer.trim() : "";
      const userMatchesSession = !user || !sessionIssuer || !user.issuer || user.issuer === sessionIssuer;
      const restoredUser = presentDesktopSsoUser(app, userMatchesSession ? user : null);
      currentAccessToken = readDesktopSsoAccessToken(app);
      const completedSteps = createCompletedSteps({
        session: true,
        userInfo: Boolean(restoredUser),
        accessToken: Boolean(currentAccessToken)
      });
      currentStatus = createAuthenticatedStatus(restoredUser, completedSteps, {
        message: getCompletedDesktopSsoMessage(completedSteps)
      });
      currentStatus.updatedAt = typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString();
      currentIdToken = typeof parsed.idToken === "string" ? parsed.idToken.trim() : "";
      currentSessionAuthMode =
        parsed.authMode === "oidc" ||
        parsed.authMode === "browser-cookie" ||
        parsed.authMode === "server"
          ? parsed.authMode
          : currentIdToken
            ? "oidc"
            : null;
      currentSessionApp = app;
      currentSessionMetadata = {
        issuer: sessionIssuer,
        audience: typeof parsed.audience === "string" ? parsed.audience.trim() : "",
        authMode: currentSessionAuthMode || undefined
      };
    }
  } catch {
    currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  }
}

function beginAuthenticatedSession(
  app: App,
  metadata: Required<Pick<DesktopSsoSessionMetadata, "issuer" | "audience" | "authMode">>,
  idToken = ""
) {
  const status = createAuthenticatedStatus(null, createCompletedSteps({ session: true }), {
    pending: currentStatus.pending,
    message: currentStatus.pending ? t("sso.completingLogin") : t("sso.completedWithoutUserInfo")
  });
  saveSession(app, status, idToken, metadata);
  clearCachedDesktopSsoAvatar(app);
  removeUserInfoFile(app);
  removeAccessTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  currentAccessToken = "";
  currentIdToken = idToken.trim();
  currentSessionAuthMode = metadata.authMode;
  currentSessionApp = app;
  currentSessionMetadata = { ...metadata };
  loadedSessionPath = getSessionPath(app);
  unverifiedCookieSessionCandidate = false;
  setCurrentStatus(status);
  return cloneStatus(status);
}

function completeUserInfoStep(
  app: App,
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource
) {
  if (!currentStatus.authenticated || !currentStatus.completedSteps.session) {
    throw new Error(t("sso.sessionRequiredForUserInfo"));
  }
  const sub = user.sub.trim();
  const normalizedUser: DesktopSsoClaims = {
    ...persistedDesktopSsoUser(app, user),
    sub,
    name: user.name?.trim() || sub
  };
  saveUserInfoFile(app, normalizedUser, source);
  const completedSteps = createCompletedSteps({
    ...currentStatus.completedSteps,
    session: true,
    userInfo: true
  });
  const status = createAuthenticatedStatus(presentDesktopSsoUser(app, normalizedUser), completedSteps, {
    pending: currentStatus.pending,
    message: currentStatus.pending
      ? t("sso.completingLogin")
      : getCompletedDesktopSsoMessage(completedSteps)
  });
  setCurrentStatus(status);
  persistCurrentSessionStatus();
  return cloneStatus(status);
}

function completeAccessTokenStep(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return cloneStatus(currentStatus);
  }
  saveAccessTokenFile(app, token);
  currentAccessToken = token;
  if (currentStatus.authenticated && currentStatus.completedSteps.session) {
    const completedSteps = createCompletedSteps({
      ...currentStatus.completedSteps,
      session: true,
      accessToken: true
    });
    const status = createAuthenticatedStatus(currentStatus.user, completedSteps, {
      pending: currentStatus.pending,
      message: currentStatus.pending
        ? t("sso.completingLogin")
        : getCompletedDesktopSsoMessage(completedSteps)
    });
    setCurrentStatus(status);
  }
  return cloneStatus(currentStatus);
}

export function failDesktopSsoStep(message: string): DesktopSsoStatus {
  if (!currentStatus.authenticated || !currentStatus.completedSteps.session) {
    return failDesktopSsoFlow(message);
  }
  return finalizeDesktopSsoLoginAttempt(message);
}

export function finalizeDesktopSsoLoginAttempt(
  errors: string | string[] = []
): DesktopSsoStatus {
  const messages = (Array.isArray(errors) ? errors : [errors])
    .map((message) => message.trim())
    .filter(Boolean);
  pendingLogin = null;
  if (!currentStatus.authenticated || !currentStatus.completedSteps.session) {
    return failDesktopSsoFlow(messages.join("; ") || t("sso.loginFailed"));
  }
  const status = createAuthenticatedStatus(currentStatus.user, currentStatus.completedSteps, {
    message: getCompletedDesktopSsoMessage(currentStatus.completedSteps, messages.length > 0),
    ...(messages.length > 0 ? { error: messages.join("; ") } : {})
  });
  setCurrentStatus(status);
  persistCurrentSessionStatus();
  return cloneStatus(status);
}

function clearSession(app: App) {
  pendingLogin = null;
  currentAccessToken = "";
  currentIdToken = "";
  currentSessionAuthMode = null;
  currentSessionApp = null;
  currentSessionMetadata = null;
  loadedSessionPath = getSessionPath(app);
  unverifiedCookieSessionCandidate = false;
  const accessTokenRemovalError = removeAccessTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  removeUserInfoFile(app);
  clearCachedDesktopSsoAvatar(app);
  const filePath = getSessionPath(app);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Session cleanup is best effort; the in-memory state is authoritative for this run.
  }
  return accessTokenRemovalError;
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

const DESKTOP_SSO_AVATAR_CLAIM_KEYS = ["avatarUrl", "picture", "avatar_url", "avatar"] as const;

function normalizeDesktopSsoAvatarUrlClaim(payload: Record<string, unknown>) {
  for (const key of DESKTOP_SSO_AVATAR_CLAIM_KEYS) {
    const avatarUrl = normalizeStringClaim(payload[key]);
    if (avatarUrl) {
      return avatarUrl;
    }
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
    throw new Error(t("sso.token.idTokenMissingSub"));
  }
  const claims: DesktopSsoClaims = {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud)
  };
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  const avatarUrl = normalizeDesktopSsoAvatarUrlClaim(payload);
  if (name) {
    claims.name = name;
  }
  if (email) {
    claims.email = email;
  }
  if (avatarUrl) {
    claims.avatarUrl = avatarUrl;
  }
  return claims;
}

function keyObjectFromJwk(jwk: Record<string, unknown>): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

function renderCallbackHtml(title: string, message: string, options: {
  actionHref?: string;
  actionLabel?: string;
} = {}) {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  const actionHref = options.actionHref?.trim() || "";
  const actionLabel = options.actionLabel?.trim() || "";
  const actionHtml = actionHref && actionLabel
    ? `<a class="primary-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
    : "";
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
    .primary-action { display: inline-flex; align-items: center; justify-content: center; margin-top: 24px; min-height: 42px; padding: 0 18px; border-radius: 8px; background: #1f5eff; color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; box-shadow: 0 10px 22px rgba(31, 94, 255, 0.24); }
    .primary-action:focus-visible { outline: 3px solid rgba(31, 94, 255, 0.28); outline-offset: 3px; }
    .primary-action:hover { background: #174edb; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    ${actionHtml}
  </main>
</body>
</html>`;
}

function buildReturnToAppUrl(origin: string) {
  return `${origin}${RETURN_TO_APP_PATH}`;
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
  url.searchParams.set("scope", config.scope || DEFAULT_GOOGLE_SCOPE);
  if (options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const prompt = config.prompt?.trim();
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  return url.toString();
}

function buildServerBrokerAuthorizeUrl(state: string, callbackUrl: string, config: OidcConfig) {
  if (!config.serverAuthorizeUrl) {
    throw new Error(t("sso.config.serverAuthorizeRequired"));
  }
  const url = new URL(config.serverAuthorizeUrl);
  url.searchParams.set("callback", callbackUrl);
  url.searchParams.set("state", state);
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
  if (config.browserSession) {
    origins.add(new URL(config.browserSession.url).origin);
  }
  if (config.userInfo?.authMode === "cookie") {
    origins.add(new URL(config.userInfo.url).origin);
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
    config.cookieAccessTokenExchange?.url,
    config.browserSession?.url,
    config.userInfo?.url
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

function buildCookieAccessTokenExchangeRequest(
  cookieHeader: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): CookieAccessTokenExchangeRequest | null {
  const exchangeConfig = config.cookieAccessTokenExchange;
  if (!exchangeConfig) {
    return null;
  }
  const headers: Record<string, string> = {
    Accept: DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT,
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

function normalizeCookieAccessToken(value: unknown) {
  const token = normalizeStringClaim(value);
  const bearerMatch = /^Bearer\s+(.+)$/iu.exec(token);
  return (bearerMatch?.[1] || token).trim();
}

function readCookieAccessTokenFromResponse(value: unknown, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const rawAccessToken = normalizeCookieAccessToken(value);
  if (rawAccessToken) {
    return rawAccessToken;
  }
  const pathValue = config.cookieAccessTokenExchange?.accessTokenPath || DEFAULT_COOKIE_ACCESS_TOKEN_PATH;
  const accessToken = normalizeCookieAccessToken(readJsonPathValue(value, pathValue));
  if (!accessToken) {
    throw new Error(t("sso.token.cookieAccessTokenMissingPath", { path: pathValue }));
  }
  return accessToken;
}

function isJsonFetchResponse(response: FetchResponseLike) {
  const contentType = response.headers?.get("content-type")?.toLowerCase() || "";
  return contentType.includes("json");
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
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  const avatarUrl = normalizeDesktopSsoAvatarUrlClaim(payload);
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub: normalizeStringClaim(payload.sub) || claimsConfig.cookieFallbackSub,
    issuer: normalizeStringClaim(payload.iss) || config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin,
    audience: normalizeAudience(payload.aud) || claimsConfig.audience,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
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
  if (config.cookieAccessTokenExchange?.csrfUrl) {
    const csrfHeaders: Record<string, string> = { Accept: "application/json" };
    if (cookieHeader.trim()) {
      csrfHeaders.Cookie = cookieHeader.trim();
    }
    const csrfResponse = await fetchImpl(config.cookieAccessTokenExchange.csrfUrl, {
      method: "GET",
      headers: csrfHeaders
    });
    if (!csrfResponse.ok) {
      const detail = await readFetchErrorBody(csrfResponse);
      throw new Error(`OIDC CSRF request failed: ${readFetchErrorStatus(csrfResponse)}${detail ? ` - ${detail}` : ""}`);
    }
    const csrfBody = await csrfResponse.json();
    const csrfToken = normalizeStringClaim(readJsonPathValue(csrfBody, "csrfToken"));
    if (!csrfToken) {
      throw new Error("OIDC CSRF response did not include csrfToken.");
    }
    request.headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  if (!response.ok) {
    const detail = await readFetchErrorBody(response);
    throw new Error(`OIDC request failed: ${readFetchErrorStatus(response)}${detail ? ` - ${detail}` : ""}`);
  }
  if (!isJsonFetchResponse(response) && typeof response.text === "function") {
    return readCookieAccessTokenFromResponse(await response.text(), config);
  }
  return readCookieAccessTokenFromResponse(await response.json(), config);
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

function normalizeDesktopTicketCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedTickets: Set<string> = usedDesktopSsoTickets
) {
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  const error = requestUrl.searchParams.get("error")?.trim() ?? "";
  if (error) {
    throw new Error(error);
  }
  const ticket = requestUrl.searchParams.get("ticket")?.trim() ?? "";
  if (!ticket) {
    throw new Error("missing desktop SSO ticket");
  }
  if (usedTickets.has(ticket)) {
    throw new Error("desktop SSO ticket has already been used");
  }
  usedTickets.add(ticket);
  return { ticket, state };
}

function createDesktopTicketPlaceholderClaims(config: OidcConfig): DesktopSsoClaims {
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub: claimsConfig.ticketPlaceholderSub,
    issuer: config.webSessionExchange ? new URL(config.webSessionExchange.url).origin : config.serverAuthorizeUrl || "desktop-sso-server",
    audience: claimsConfig.audience
  };
}

function isDesktopSsoClaimsValue(value: unknown): value is DesktopSsoClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sub === "string" &&
    typeof record.issuer === "string" &&
    typeof record.audience === "string";
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
    throw new Error(t("sso.token.idTokenInvalidFormat"));
  }
  const header = decodeJsonPart(headerPart);
  const payload = decodeJsonPart(payloadPart);
  if (header.alg !== "RS256") {
    throw new Error(t("sso.token.idTokenRs256Only"));
  }
  if (payload.iss !== config.issuer) {
    throw new Error(t("sso.token.issuerMismatch"));
  }
  if (!includesAudience(payload.aud, config.clientId)) {
    throw new Error(t("sso.token.audienceMismatch"));
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error(t("sso.token.expired"));
  }

  let jwksUri = config.jwksUrl?.trim() || "";
  const wellKnownUrl = config.wellKnownUrl?.trim() || "";
  if (wellKnownUrl) {
    const discovery = await fetchJson(
      fetchImpl,
      wellKnownUrl,
      undefined,
      buildOidcFetchStage("OIDC discovery", config)
    ) as { jwks_uri?: unknown };
    jwksUri = normalizeStringClaim(discovery.jwks_uri);
    if (!jwksUri) {
      throw new Error(t("sso.token.wellKnownMissingJwks"));
    }
  }
  if (!jwksUri) {
    throw new Error(t("sso.config.jwksRequired"));
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
    throw new Error(t("sso.token.noJwk"));
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  if (!verifier.verify(keyObjectFromJwk(key), Buffer.from(signaturePart, "base64url"))) {
    throw new Error(t("sso.token.signatureFailed"));
  }
  return createClaims(payload);
}

function mergeDesktopSsoUserInfoClaims(
  claims: DesktopSsoClaims,
  userInfo: unknown,
  config: OidcConfig
) {
  const userInfoConfig = config.userInfo;
  if (!userInfoConfig || !userInfo || typeof userInfo !== "object" || Array.isArray(userInfo)) {
    return claims;
  }
  const userInfoRecord = userInfo as Record<string, unknown>;
  const userInfoSub = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.subPath));
  if (userInfoSub && userInfoSub !== claims.sub) {
    if (userInfoConfig.required) {
      throw new Error(t("sso.token.userInfoSubMismatch"));
    }
    return claims;
  }
  const name = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.namePath));
  const email = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.emailPath));
  const avatarUrl = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.avatarUrlPath));
  return {
    ...claims,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

function createDesktopSsoCookieUserInfoClaims(userInfo: unknown, config: OidcConfig) {
  const userInfoConfig = config.userInfo;
  if (
    !userInfoConfig ||
    userInfoConfig.authMode !== "cookie" ||
    !userInfo ||
    typeof userInfo !== "object" ||
    Array.isArray(userInfo)
  ) {
    throw new Error(t("sso.token.cookieUserInfoInvalid"));
  }
  const record = userInfo as Record<string, unknown>;
  const sub = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.subPath));
  if (!sub) {
    throw new Error(t("sso.token.cookieUserInfoSubMissing", { path: userInfoConfig.subPath }));
  }
  const name = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.namePath));
  const email = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.emailPath));
  const avatarUrl = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.avatarUrlPath));
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub,
    issuer: config.browserOrigin || new URL(userInfoConfig.url).origin,
    audience: claimsConfig.audience,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  } satisfies DesktopSsoClaims;
}

async function enrichClaimsWithUserInfo(
  claims: DesktopSsoClaims,
  accessToken: string,
  fetchImpl: FetchLike,
  config: OidcConfig
) {
  const userInfoConfig = config.userInfo;
  if (!userInfoConfig?.enabled || (userInfoConfig.authMode || "bearer") !== "bearer") {
    return claims;
  }
  const token = accessToken.trim();
  if (!token) {
    if (userInfoConfig.required) {
      throw new Error(t("sso.token.userInfoAccessTokenMissing"));
    }
    return claims;
  }
  try {
    const userInfo = await fetchJson(fetchImpl, userInfoConfig.url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    }, buildOidcFetchStage("userinfo fetch", config));
    return mergeDesktopSsoUserInfoClaims(claims, userInfo, config);
  } catch (error) {
    if (userInfoConfig.required) {
      throw error;
    }
    return claims;
  }
}

async function exchangeCodeForValidatedTokenResponse(
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
  }, buildOidcFetchStage("token exchange", config)) as { id_token?: unknown; access_token?: unknown };
  const idToken = normalizeStringClaim(tokenResponse.id_token);
  if (!idToken) {
    throw new Error(t("sso.token.responseMissingIdToken"));
  }
  const accessToken = normalizeStringClaim(tokenResponse.access_token);
  const claims = await validateIdToken(idToken, fetchImpl, config);
  return { claims, idToken, accessToken };
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
  const tokenClaims = await exchangeCodeForValidatedTokenResponse(code, fetchImpl, config, options);
  return {
    ...tokenClaims,
    claims: await enrichClaimsWithUserInfo(tokenClaims.claims, tokenClaims.accessToken, fetchImpl, config)
  };
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

async function completeValidatedOidcLogin(
  app: App,
  tokenClaims: { claims: DesktopSsoClaims; idToken: string; accessToken: string },
  fetchImpl: FetchLike,
  config: OidcConfig
) {
  beginAuthenticatedSession(app, {
    issuer: tokenClaims.claims.issuer,
    audience: tokenClaims.claims.audience,
    authMode: "oidc"
  }, tokenClaims.idToken);
  completeUserInfoStep(app, tokenClaims.claims, "id_token");
  if (tokenClaims.accessToken) {
    completeAccessTokenStep(app, tokenClaims.accessToken);
  }
  const enrichedClaims = await enrichClaimsWithUserInfo(
    tokenClaims.claims,
    tokenClaims.accessToken,
    fetchImpl,
    config
  );
  if (enrichedClaims !== tokenClaims.claims) {
    completeUserInfoStep(app, enrichedClaims, "userinfo");
  }
  return cloneStatus(currentStatus);
}

async function handleLoginCallback(app: App, requestUrl: URL, fetchImpl?: FetchLike) {
  if (!pendingLogin) {
    throw new Error(t("sso.noPendingLogin"));
  }
  if (isServerBrokerAuthMode(pendingLogin.config)) {
    const { ticket } = normalizeDesktopTicketCallbackRequest(requestUrl, pendingLogin.state);
    const statusContext: DesktopSsoStatusChangeContext = {
      provider: pendingLogin.config.provider,
      ticket
    };
    const status = createAuthenticatedStatus(createDesktopTicketPlaceholderClaims(pendingLogin.config));
    pendingLogin = null;
    const hookClaims = await callbackHooks.onBeforeStatusChanged?.(status, statusContext);
    if (!isDesktopSsoClaimsValue(hookClaims)) {
      throw new Error("Desktop SSO web session exchange did not return user claims.");
    }
    beginAuthenticatedSession(app, {
      issuer: hookClaims.issuer,
      audience: hookClaims.audience,
      authMode: "server"
    });
    const exchangedStatus = completeUserInfoStep(app, hookClaims, "sso");
    await callbackHooks.onAfterStatusChanged?.(exchangedStatus, statusContext);
    return finalizeDesktopSsoLoginAttempt();
  }
  const { code } = normalizeCallbackRequest(requestUrl, pendingLogin.state);
  const loginConfig = pendingLogin.config;
  const tokenClaims = await exchangeCodeForValidatedTokenResponse(code, fetchImpl, loginConfig, {
    redirectUri: pendingLogin.redirectUri,
    codeVerifier: pendingLogin.codeVerifier
  });
  pendingLogin = null;
  await completeValidatedOidcLogin(
    app,
    tokenClaims,
    fetchImpl || getDefaultOidcFetch(),
    loginConfig
  );
  const statusContext: DesktopSsoStatusChangeContext = {
    provider: loginConfig.provider,
    idToken: tokenClaims.idToken
  };
  let status = cloneStatus(currentStatus);
  const hookClaims = await callbackHooks.onBeforeStatusChanged?.(status, statusContext);
  if (isDesktopSsoClaimsValue(hookClaims)) {
    status = completeUserInfoStep(app, hookClaims, "sso");
  }
  await callbackHooks.onAfterStatusChanged?.(status, statusContext);
  return finalizeDesktopSsoLoginAttempt();
}

function buildLogoutUrl(
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: { idTokenHint?: string } = {}
) {
  const url = new URL(config.logoutUrl);
  const idTokenHint = options.idTokenHint?.trim();
  if (idTokenHint) {
    url.searchParams.set("id_token_hint", idTokenHint);
    url.searchParams.set("post_logout_redirect_uri", config.logoutCallbackUri);
  }
  return url.toString();
}

function closeCallbackServerAfterResponse(response: http.ServerResponse) {
  response.once("finish", closeCallbackServer);
}

async function handleCallbackRequest(app: App, request: http.IncomingMessage, response: http.ServerResponse) {
  const fallbackOrigin = callbackServerInfo?.origin || CALLBACK_ORIGIN;
  const requestUrl = new URL(request.url || "/", fallbackOrigin);
  const closeAfterCallback = callbackServerInfo?.closeAfterCallback === true;
  if (requestUrl.pathname === RETURN_TO_APP_PATH) {
    await callbackHooks.onReturnToAppRequested?.();
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(t("sso.returnedToDesktopTitle"), t("sso.closeBrowserPage")));
    return;
  }
  if (requestUrl.pathname === LOGOUT_CALLBACK_PATH) {
    desktopSsoProxyState?.cookies.clear();
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(t("sso.logoutReturnedTitle"), t("sso.logoutReturnedMessage")));
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
      console.warn("failed to proxy desktop sso request", error);
      writeHtmlResponse(
        response,
        200,
        renderCallbackHtml(t("sso.logoutProxyFailedTitle"), t("sso.logoutProxyFailedMessage"))
      );
    }
    return;
  }

  try {
    const status = await handleLoginCallback(app, requestUrl);
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(
      t("sso.loginSuccessTitle"),
      t("sso.loginSuccessMessage", { user: status.user?.sub ?? t("sso.userFallback") }),
      {
        actionHref: buildReturnToAppUrl(fallbackOrigin),
        actionLabel: t("sso.returnToApp", { appName: PRODUCT_NAME })
      }
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (currentStatus.authenticated && currentStatus.completedSteps.session) {
      failDesktopSsoStep(message);
    } else {
      setCurrentStatus(createFailedStatus(message));
    }
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 400, renderCallbackHtml(t("sso.loginFailedTitle"), message));
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

function resolveCallbackServerOptionsFromUrl(
  value: string,
  closeAfterCallback: boolean
): CallbackServerOptions {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error(t("sso.callbackHttpOnly"));
  }
  return {
    host: url.hostname || CALLBACK_HOST,
    port: Number.parseInt(url.port || "80", 10),
    closeAfterCallback
  };
}

function resolveLoginCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
  if (useSystemBrowser) {
    if (shouldUseEphemeralSystemCallback(config)) {
      return {
        host: GOOGLE_LOOPBACK_HOST,
        port: 0,
        closeAfterCallback: true
      };
    }
    return resolveCallbackServerOptionsFromUrl(config.redirectUri, true);
  }
  return {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: false
  };
}

function resolveLogoutCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
  if (useSystemBrowser) {
    return resolveCallbackServerOptionsFromUrl(config.logoutCallbackUri, true);
  }
  return {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: false
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
        reject(new Error(t("sso.callbackPortInUse", { port: options.port })));
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
    const sessionPath = getSessionPath(app);
    if (loadedSessionPath !== sessionPath) {
      loadSession(app);
    } else if (!currentStatus.configured) {
      // A first-run env import can make sso.json available after this runtime was
      // initialized as unconfigured. Enable the interactive login entry without
      // reloading an unverified credential candidate from disk.
      currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
    }
  }
  return cloneStatus(currentStatus);
}

export type DesktopSsoRestorePreparation = {
  requiresCookieValidation: boolean;
  clearCookies?: boolean;
  status: DesktopSsoStatus;
};

export function prepareDesktopSsoSessionRestore(app: App): DesktopSsoRestorePreparation {
  removeLegacyDesktopSsoSiteTokenFile(app);
  const configResult = loadDesktopSsoConfig(app);
  const sessionPath = getSessionPath(app);
  loadedSessionPath = sessionPath;
  currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  currentAccessToken = "";
  currentIdToken = "";
  currentSessionAuthMode = null;
  currentSessionApp = null;
  currentSessionMetadata = null;
  unverifiedCookieSessionCandidate = false;

  if (!configResult.configured) {
    currentStatus = createUnconfiguredStatus(configResult.message);
    return { requiresCookieValidation: false, status: cloneStatus(currentStatus) };
  }
  if (configResult.error || !configResult.config) {
    currentStatus = createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
    return { requiresCookieValidation: false, status: cloneStatus(currentStatus) };
  }
  if (!fs.existsSync(sessionPath)) {
    return { requiresCookieValidation: false, status: cloneStatus(currentStatus) };
  }

  let parsed: {
    authenticated?: unknown;
    issuer?: unknown;
    audience?: unknown;
    authMode?: unknown;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as typeof parsed;
  } catch {
    return { requiresCookieValidation: false, status: cloneStatus(currentStatus) };
  }

  const requiresCookieValidation =
    parsed.authenticated === true &&
    Boolean(configResult.config.browserSession) &&
    Boolean(configResult.config.cookieAccessTokenExchange) &&
    parsed.authMode !== "oidc" &&
    parsed.authMode !== "server";
  if (!requiresCookieValidation) {
    loadSession(app);
    return { requiresCookieValidation: false, status: cloneStatus(currentStatus) };
  }

  const expectedIssuer = configResult.config.browserOrigin ||
    new URL(configResult.config.browserSession!.url).origin;
  const expectedAudience = (configResult.config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG).audience;
  const storedIssuer = typeof parsed.issuer === "string" ? parsed.issuer.trim() : "";
  const storedAudience = typeof parsed.audience === "string" ? parsed.audience.trim() : "";
  if (
    (storedIssuer && storedIssuer !== expectedIssuer) ||
    (storedAudience && storedAudience !== expectedAudience)
  ) {
    return {
      requiresCookieValidation: false,
      clearCookies: true,
      status: clearDesktopSsoLocalSession(app, t("sso.restoreConfigurationChanged"))
    };
  }

  currentStatus = createPendingStatus(t("sso.restoringLogin"));
  unverifiedCookieSessionCandidate = true;
  return { requiresCookieValidation: true, status: cloneStatus(currentStatus) };
}

export function markDesktopSsoRestoreTemporarilyUnavailable(app: App, message: string) {
  loadedSessionPath = getSessionPath(app);
  currentAccessToken = "";
  currentIdToken = "";
  currentSessionAuthMode = null;
  currentSessionApp = null;
  currentSessionMetadata = null;
  const status = createFailedStatus(t("sso.restoreTemporarilyUnavailable"));
  status.error = message;
  setCurrentStatus(status);
  return cloneStatus(status);
}

export function clearDesktopSsoLocalSession(app: App, message = t("sso.signedOut")) {
  clearSession(app);
  const status = createSignedOutStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

export function failDesktopSsoFlow(message: string): DesktopSsoStatus {
  pendingLogin = null;
  if (currentStatus.authenticated && currentStatus.pending && currentStatus.completedSteps.session) {
    const status = createAuthenticatedStatus(currentStatus.user, currentStatus.completedSteps, {
      message: getCompletedDesktopSsoMessage(currentStatus.completedSteps, true),
      error: message
    });
    setCurrentStatus(status);
    return cloneStatus(status);
  }
  currentAccessToken = "";
  currentIdToken = "";
  currentSessionAuthMode = null;
  currentSessionApp = null;
  currentSessionMetadata = null;
  if (!unverifiedCookieSessionCandidate) {
    loadedSessionPath = "";
  }
  const status = createFailedStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

export const failDesktopSsoLogin = failDesktopSsoFlow;

export function cancelDesktopSsoLogin(app: App, message = t("sso.cancelled")): DesktopSsoStatus {
  pendingLogin = null;
  currentAccessToken = "";
  if (!unverifiedCookieSessionCandidate) {
    loadSession(app);
  }
  const status = currentStatus.authenticated && !currentStatus.pending
    ? {
      ...cloneStatus(currentStatus),
      message,
      updatedAt: new Date().toISOString()
    }
    : createSignedOutStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

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
    const status = createFailedStatus(t("sso.missingOidcConfig"));
    setCurrentStatus(status);
    return {
      ok: false,
      status: cloneStatus(status),
      message: status.message
    };
  }
  if (loadedSessionPath !== getSessionPath(app)) {
    loadSession(app);
  }
  try {
    const useSystemBrowser = shouldUseSystemBrowser(oidcConfig);
    const callbackInfo = await ensureCallbackServer(
      app,
      hooks,
      resolveLoginCallbackServerOptions(oidcConfig, useSystemBrowser)
    );
    if (!useSystemBrowser) {
      activateDesktopSsoProxy(oidcConfig, { resetCookies: true });
    }
    const state = randomUUID();
    const useServerBroker = isServerBrokerAuthMode(oidcConfig);
    const codeVerifier = !useServerBroker && shouldUsePkce(oidcConfig) ? createPkceCodeVerifier() : undefined;
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
    const authorizeUrl = useServerBroker
      ? buildServerBrokerAuthorizeUrl(state, redirectUri, loginConfig)
      : buildAuthorizeUrl(state, loginConfig, {
        redirectUri,
        ...(codeVerifier ? { codeChallenge: createPkceCodeChallenge(codeVerifier) } : {})
      });
    const status = createPendingStatus(t("sso.waitingForIam"), currentStatus);
    setCurrentStatus(status);
    return {
      ok: true,
      authorizeUrl,
      ...(useSystemBrowser
        ? { openMode: "system" as const }
        : { browserUrl: oidcConfig.loginUrl ? undefined : buildDesktopSsoProxyUrl(authorizeUrl) }),
      browserLabel: getDesktopSsoLoginLabel(oidcConfig),
      browserOrigin: oidcConfig.browserOrigin,
      status: cloneStatus(status),
      message: t("sso.iamLoginOpened")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = currentStatus.authenticated && currentStatus.completedSteps.session
      ? failDesktopSsoStep(message)
      : failDesktopSsoFlow(message);
    return {
      ok: false,
      status: cloneStatus(status),
      message
    };
  }
}

export function getDesktopSsoBrowserSessionConfig(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.browserSession) {
    return null;
  }
  const config = configResult.config.browserSession;
  return {
    ...config,
    headers: { ...config.headers },
    successStatuses: [...config.successStatuses],
    ...(config.userInfoHeaders ? { userInfoHeaders: { ...config.userInfoHeaders } } : {})
  };
}

export function getDesktopSsoCookieUserInfoConfig(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (
    !configResult.configured ||
    configResult.error ||
    !configResult.config?.userInfo ||
    configResult.config.userInfo.authMode !== "cookie"
  ) {
    return null;
  }
  return { ...configResult.config.userInfo };
}

export function getDesktopSsoAvatarCacheConfig(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.avatarCache) {
    return null;
  }
  return { ...configResult.config.avatarCache };
}

export function resolveDesktopSsoAvatarRequest(
  app: Pick<App, "getPath">,
  version: string
) {
  const normalizedVersion = version.trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/u.test(normalizedVersion)) {
    return null;
  }
  const config = getDesktopSsoAvatarCacheConfig(app);
  const user = readUserInfoFile(app);
  const sourceUrl = user?.avatarUrl?.trim() || "";
  if (
    !config ||
    !user ||
    !sourceUrl ||
    !isDesktopSsoAvatarSourceTrusted(config, sourceUrl) ||
    desktopSsoAvatarVersion(user) !== normalizedVersion
  ) {
    return null;
  }
  return {
    sourceUrl,
    trustedOrigin: config.trustedOrigin,
    version: normalizedVersion
  };
}

export function completeDesktopSsoBrowserSession(app: App): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config?.browserSession) {
    return createFailedStatus(configResult.error || t("sso.config.browserSessionMissing"));
  }
  const claimsConfig = configResult.config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return beginAuthenticatedSession(app, {
    issuer: configResult.config.browserOrigin || new URL(configResult.config.browserSession.url).origin,
    audience: claimsConfig.audience,
    authMode: "browser-cookie"
  });
}

export function completeDesktopSsoBrowserSessionUserInfo(
  app: App,
  userInfo: { sub: string; name?: string; email?: string; avatarUrl?: string }
): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config?.browserSession) {
    return createFailedStatus(configResult.error || t("sso.config.browserSessionMissing"));
  }
  const sub = normalizeStringClaim(userInfo.sub);
  if (!sub) {
    return cloneStatus(currentStatus);
  }
  const name = normalizeStringClaim(userInfo.name);
  const email = normalizeStringClaim(userInfo.email);
  const avatarUrl = normalizeStringClaim(userInfo.avatarUrl);
  const claimsConfig = configResult.config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return completeUserInfoStep(app, {
    sub,
    issuer: configResult.config.browserOrigin || new URL(configResult.config.browserSession.url).origin,
    audience: claimsConfig.audience,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  }, "browser_session");
}

export function completeDesktopSsoBrowserUserInfo(app: App, userInfo: unknown): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    return createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
  }
  let claims = createDesktopSsoCookieUserInfoClaims(userInfo, configResult.config);
  if (currentStatus.user?.sub && currentStatus.user.sub !== claims.sub) {
    if (configResult.config.userInfo?.required) {
      throw new Error(t("sso.token.userInfoSubMismatch"));
    }
    return cloneStatus(currentStatus);
  }
  if (currentStatus.user?.sub === claims.sub) {
    claims = { ...currentStatus.user, ...claims };
  }
  return completeUserInfoStep(app, claims, "cookie_userinfo");
}

export function parseDesktopSsoCookieUserInfo(
  app: Pick<App, "getPath">,
  userInfo: unknown
) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    throw new Error(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    throw new Error(configResult.error || t("sso.missingOidcConfig"));
  }
  return createDesktopSsoCookieUserInfoClaims(userInfo, configResult.config);
}

export function getDesktopSsoCookieAccessTokenExchangeUrl(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.cookieAccessTokenExchange) {
    return null;
  }
  return configResult.config.cookieAccessTokenExchange.url;
}

export function getDesktopSsoCookieCSRFUrl(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.cookieAccessTokenExchange) {
    return null;
  }
  return configResult.config.cookieAccessTokenExchange.csrfUrl || null;
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
  const expiresAtSeconds = Number(getJwtPayload(token).exp);
  const expirationDate = Number.isFinite(expiresAtSeconds) && expiresAtSeconds > Date.now() / 1000
    ? expiresAtSeconds
    : undefined;
  return cookieConfigs.map((details) => ({
    url: details.url,
    name: details.name,
    value: token,
    path: details.path,
    ...(details.domain ? { domain: details.domain } : {}),
    ...(expirationDate ? { expirationDate } : {}),
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
    provider: config.provider,
    claims: { ...config.claims },
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
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  options: { persist?: boolean } = {}
) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return "";
  }
  const accessToken = await exchangeCookieForAccessToken(cookieHeader, fetchImpl, configResult.config);
  if (accessToken && options.persist !== false) {
    persistDesktopSsoAccessToken(app, accessToken);
  }
  return accessToken;
}

function persistDesktopSsoAccessToken(app: Pick<App, "getPath">, accessToken: string) {
  completeAccessTokenStep(app, accessToken);
}

export function completeDesktopSsoRestoredBrowserSession(
  app: App,
  accessToken: string,
  browserUserInfo: { sub: string; name?: string; email?: string; avatarUrl?: string }
) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    return createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
  }
  const token = accessToken.trim();
  if (!token) {
    return createFailedStatus(t("sso.cookieAccessTokenEmpty"));
  }

  completeDesktopSsoBrowserSession(app);
  if (!browserUserInfo.sub.trim()) {
    throw new Error(t("sso.token.cookieUserInfoSubMissing", { path: "sub" }));
  }
  completeDesktopSsoBrowserSessionUserInfo(app, browserUserInfo);
  persistDesktopSsoAccessToken(app, token);
  return finalizeDesktopSsoLoginAttempt();
}

export function getDesktopSsoAccessToken() {
  return currentAccessToken || null;
}

export function isDesktopSsoCredentialRuntimeReady() {
  return currentStatus.authenticated &&
    !currentStatus.pending &&
    currentStatus.completedSteps.session &&
    currentStatus.completedSteps.accessToken &&
    Boolean(currentAccessToken);
}

export function completeDesktopSsoBrowserLogin(app: App, completionUrl: string): DesktopSsoStatus {
  void completionUrl;
  return completeDesktopSsoBrowserSession(app);
}

export function completeDesktopSsoCookieLogin(app: App, accessToken: string): DesktopSsoStatus {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured) {
    return createUnconfiguredStatus(configResult.message);
  }
  if (configResult.error || !configResult.config) {
    return createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
  }
  const token = accessToken.trim();
  if (!token) {
    return createFailedStatus(t("sso.cookieAccessTokenEmpty"));
  }
  const claims = createCookieAccessTokenClaims(token, configResult.config);
  beginAuthenticatedSession(app, {
    issuer: claims.issuer,
    audience: claims.audience,
    authMode: "browser-cookie"
  });
  completeUserInfoStep(app, claims, "sso");
  return completeAccessTokenStep(app, token);
}

export async function logoutDesktopSso(app: App, hooks: CallbackHooks = {}): Promise<DesktopSsoLogoutResult> {
  callbackHooks = hooks;
  const configResult = loadDesktopSsoConfig(app);
  if (loadedSessionPath !== getSessionPath(app)) {
    loadSession(app);
  }
  const logoutIdToken = currentIdToken;
  const logoutAuthMode = currentSessionAuthMode;
  const accessTokenRemovalError = clearSession(app);
  const status = configResult.configured
    ? createSignedOutStatus(t("sso.signedOut"))
    : createUnconfiguredStatus(configResult.message);
  setCurrentStatus(status);
  if (accessTokenRemovalError) {
    const message = t("sso.accessTokenRevokeFailed", {
      error: accessTokenRemovalError.message
    });
    const failedStatus = createFailedStatus(message);
    setCurrentStatus(failedStatus);
    return {
      ok: false,
      status: cloneStatus(failedStatus),
      message
    };
  }
  if (!configResult.configured) {
    return {
      ok: true,
      status: cloneStatus(status),
      message: t("sso.loginStateCleared")
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
    const failedStatus = createFailedStatus(t("sso.missingOidcConfig"));
    setCurrentStatus(failedStatus);
    return {
      ok: false,
      status: cloneStatus(failedStatus),
      message: failedStatus.message
    };
  }
  if (
    logoutAuthMode !== "oidc" ||
    isServerBrokerAuthMode(oidcConfig) ||
    !oidcConfig.logoutUrl.trim()
  ) {
    return {
      ok: true,
      status: cloneStatus(status),
      message: t("sso.loginStateCleared")
    };
  }
  const useSystemBrowser = shouldUseSystemBrowser(oidcConfig);
  try {
    const callbackInfo = await ensureCallbackServer(
      app,
      hooks,
      resolveLogoutCallbackServerOptions(oidcConfig, useSystemBrowser)
    );
    if (!useSystemBrowser) {
      activateDesktopSsoProxy(oidcConfig);
    }
    const logoutConfig = {
      ...oidcConfig,
      logoutCallbackUri: callbackInfo.logoutCallbackUri
    };
    const logoutUrl = buildLogoutUrl(logoutConfig, { idTokenHint: logoutIdToken });
    return {
      ok: true,
      logoutUrl,
      ...(useSystemBrowser
        ? { openMode: "system" as const }
        : { browserUrl: buildDesktopSsoProxyUrl(logoutUrl) }),
      browserLabel: getDesktopSsoLogoutLabel(oidcConfig),
      browserOrigin: oidcConfig.browserOrigin,
      status: cloneStatus(status),
      message: t("sso.loginStateCleared")
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
  buildReturnToAppUrl,
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
  shouldUseSystemBrowser,
  buildDesktopSsoAccessTokenCookieDetails,
  cancelDesktopSsoLogin,
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  completeDesktopSsoBrowserUserInfo,
  completeDesktopSsoCookieLogin,
  desktopSsoAccessTokenNeedsRefresh,
  getDesktopSsoAccessTokenFilePath,
  getDesktopSsoUserInfoFilePath,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoBrowserSessionConfig,
  getDesktopSsoCookieUserInfoConfig,
  getDesktopSsoAvatarCacheConfig,
  resolveDesktopSsoAvatarRequest,
  getDesktopSsoAccessTokenCookieLookup,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoWebSessionClearCookies,
  isDesktopSsoLoginCompletionUrl,
  readCookieAccessTokenFromResponse,
  saveAccessTokenFile,
  normalizeCallbackRequest,
  getDefaultOidcFetch,
  completeValidatedOidcLogin,
  exchangeCodeForTokenClaims,
  exchangeCodeForClaims,
  validateIdToken,
  renderCallbackHtml,
  closeCallbackServer
};
