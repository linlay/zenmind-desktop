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
} from "../../../shared/contracts";

import { BRAND_ID, PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/brand";

import {
  buildDesktopSsoAvatarUrl,
  DESKTOP_SSO_AVATAR_PROTOCOL
} from "../../../shared/sso-avatar";

import {
  getDesktopSsoAccessTokenFilePath,
  getDesktopStateRoot,
  getSecretsRoot
} from "../../infrastructure/filesystem/user-paths";

import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

import { t } from "../../support/i18n/main-i18n";

import { clearCachedDesktopSsoAvatar } from "./avatar-storage";

export type DesktopSsoSessionMetadata = {
  issuer?: string;
  audience?: string;
  authMode?: "oidc" | "browser-cookie" | "server";
};
export const desktopSsoRuntimeState = {
  currentStatus: createSignedOutStatus(t("sso.notSignedIn")),
  callbackServer: null as http.Server | null,
  callbackServerReady: null as Promise<void> | null,
  callbackServerInfo: null as CallbackServerInfo | null,
  callbackHooks: {} as CallbackHooks,
  pendingLogin: null as PendingLogin | null,
  desktopSsoProxyState: null as DesktopSsoProxyState | null,
  currentAccessToken: "",
  currentIdToken: "",
  currentSessionAuthMode: null as DesktopSsoSessionMetadata["authMode"] | null,
  currentSessionApp: null as App | null,
  currentSessionMetadata: null as DesktopSsoSessionMetadata | null,
  loadedSessionPath: "",
  unverifiedCookieSessionCandidate: false
};


export type OidcConfig = {
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

export type CookieAccessTokenExchangeConfig = {
  url: string;
  csrfUrl?: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  accessTokenPath: string;
  validationMode: "identity" | "remote";
  accessTokenIssuer?: string;
  accessTokenAudience?: string;
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

export type AccessTokenCookieSameSite = "lax" | "strict" | "no_restriction";

export type AccessTokenCookieConfig = {
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

export type DesktopSsoConfigLoadResult =
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

export type TokenExchangeRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: string;
};

export type CookieAccessTokenExchangeRequest = {
  url: string;
  method: CookieAccessTokenExchangeConfig["method"];
  headers: Record<string, string>;
  body?: string;
};

export type FetchResponseLike = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: {
    get(name: string): string | null;
  };
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export type ElectronFetchRuntime = {
  net?: {
    fetch?: FetchLike;
  };
};

export type CallbackHooks = {
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

export type DesktopSsoStatusChangeContext = {
  provider?: string;
  idToken?: string;
  ticket?: string;
};

export type PendingLogin = {
  state: string;
  startedAt: string;
  config: OidcConfig;
  redirectUri: string;
  codeVerifier?: string;
};

export type DesktopSsoProxyState = {
  config: OidcConfig;
  cookies: Map<string, string>;
};

export type CallbackServerInfo = {
  host: string;
  port: number;
  origin: string;
  redirectUri: string;
  logoutCallbackUri: string;
  closeAfterCallback: boolean;
};

export type CallbackServerOptions = {
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

export const CALLBACK_PORT = 8080;

export const CALLBACK_HOST = "localhost";

export const CALLBACK_ORIGIN = `http://${CALLBACK_HOST}:${CALLBACK_PORT}`;

export const GOOGLE_LOOPBACK_HOST = "127.0.0.1";

export const CALLBACK_PATH = "/api/auth/oidc/callback";

export const LOGOUT_CALLBACK_PATH = "/api/auth/oidc/logout-callback";

export const RETURN_TO_APP_PATH = "/api/auth/oidc/return-to-app";

export const SESSION_FILE_NAME = "sso-session.json";

export const USER_INFO_FILE_NAME = "sso-user-info.json";

export const LEGACY_SITE_TOKEN_FILE_NAME = "sso-site-token.json";

export const DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS = 15 * 60_000;

export const DESKTOP_SSO_CONFIG_FILE_NAME = "sso.json";

export const IDENTITY_PROVIDER_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl"
] as const;

export const OIDC_CONFIG_STRING_FIELDS = [
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

export const OIDC_CONFIG_URL_FIELDS = [
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

export const DEFAULT_COOKIE_ACCESS_TOKEN_PATH = "access_token";

export const DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT = "text/plain,application/json,*/*";

export const DEFAULT_ACCESS_TOKEN_COOKIE_NAME = "access_token";

export const DEFAULT_GOOGLE_SCOPE = "openid email profile";

export const DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG: DesktopSsoClaimsConfig = {
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

export const usedAuthorizationCodes = new Set<string>();

export const usedDesktopSsoTickets = new Set<string>();

export function createCompletedSteps(overrides: Partial<DesktopSsoStatus["completedSteps"]> = {}) {
  return {
    session: false,
    userInfo: false,
    accessToken: false,
    ...overrides
  };
}

export function createSignedOutStatus(message: string): DesktopSsoStatus {
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

export function createPendingStatus(message: string, preservedStatus?: DesktopSsoStatus): DesktopSsoStatus {
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

export function createAuthenticatedStatus(
  claims: DesktopSsoClaims | null,
  completedSteps: DesktopSsoStatus["completedSteps"] = createCompletedSteps({
    session: true,
    userInfo: Boolean(claims),
    accessToken: Boolean(desktopSsoRuntimeState.currentAccessToken)
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

export function getCompletedDesktopSsoMessage(
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

export function createFailedStatus(message: string): DesktopSsoStatus {
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

export function createUnconfiguredStatus(message: string): DesktopSsoStatus {
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

export function cloneStatus(status: DesktopSsoStatus): DesktopSsoStatus {
  return {
    ...status,
    user: status.user ? { ...status.user } : null,
    completedSteps: { ...status.completedSteps }
  };
}

export function setCurrentStatus(status: DesktopSsoStatus) {
  desktopSsoRuntimeState.currentStatus = cloneStatus(status);
  desktopSsoRuntimeState.callbackHooks.onStatusChanged?.(cloneStatus(desktopSsoRuntimeState.currentStatus));
}

export function getSessionPath(app: App) {
  return path.join(getDesktopStateRoot(app), SESSION_FILE_NAME);
}

export function getDesktopSsoUserInfoFilePath(app: Pick<App, "getPath">) {
  return path.join(getDesktopStateRoot(app as App), USER_INFO_FILE_NAME);
}

export function removeLegacyDesktopSsoSiteTokenFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(path.join(getSecretsRoot(app as App), LEGACY_SITE_TOKEN_FILE_NAME), { force: true });
  } catch {
    // The retired duplicate credential is best-effort cleanup; canonical auth state remains authoritative.
  }
}

export function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveDesktopSsoConfigPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(resolveRuntimeRoot(app, platform), ".desktop", "config", "desktop", DESKTOP_SSO_CONFIG_FILE_NAME);
}

export function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function getRecordObject(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getRecordStringArray(record: Record<string, unknown>, key: string) {
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

export function isConfigEnabled(record: Record<string, unknown>) {
  const value = record.enabled;
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return /^(?:true|1|on|yes)$/iu.test(value.trim());
  }
  return false;
}

export function getRecordBoolean(record: Record<string, unknown>, key: string, defaultValue: boolean) {
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

export function getRecordOptionalBoolean(record: Record<string, unknown>, key: string) {
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

export function normalizeProviderName(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

export function normalizeAuthMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === "server" ? "server" : "oidc";
}

export function normalizeBrowserMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "system" || normalizedValue === "external") {
    return "system";
  }
  if (normalizedValue === "embedded" || normalizedValue === "internal" || normalizedValue === "embeded") {
    return "embedded";
  }
  return undefined;
}

export function isServerBrokerAuthMode(config: OidcConfig) {
  return config.authMode === "server";
}

export function getUrlHostname(value: string | undefined) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isGoogleAccountsUrl(value: string | undefined) {
  return getUrlHostname(value) === "accounts.google.com";
}

export function isGoogleTokenUrl(value: string | undefined) {
  return getUrlHostname(value) === "oauth2.googleapis.com";
}

export function looksLikeGoogleOidcConfig(input: {
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

export function recordLooksLikeGoogleOidcConfig(record: Record<string, unknown>) {
  return looksLikeGoogleOidcConfig({
    issuer: getRecordString(record, "issuer"),
    authorizeUrl: getRecordString(record, "authorizeUrl"),
    loginUrl: getRecordString(record, "loginUrl"),
    tokenUrl: getRecordString(record, "tokenUrl"),
    wellKnownUrl: getRecordString(record, "wellKnownUrl")
  });
}

export function isGoogleOidcConfig(config: OidcConfig) {
  return normalizeProviderName(config.provider) === "google" || looksLikeGoogleOidcConfig(config);
}

export function shouldUsePkce(config: OidcConfig) {
  return config.usePkce === true || isGoogleOidcConfig(config);
}

export function shouldUsePkceByDefault(config: OidcConfig) {
  return isGoogleOidcConfig(config) || !config.clientSecret?.trim();
}

export function isPublicPkceOidcConfig(config: OidcConfig) {
  return shouldUsePkce(config) && !config.clientSecret?.trim();
}

export function shouldUseSystemBrowser(config: OidcConfig) {
  if (config.browserMode === "system") {
    return true;
  }
  if (config.browserMode === "embedded") {
    return false;
  }
  return isServerBrokerAuthMode(config) || isGoogleOidcConfig(config);
}
