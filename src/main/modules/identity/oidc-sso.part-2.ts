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

import { AccessTokenCookieConfig, CookieAccessTokenExchangeConfig, DEFAULT_ACCESS_TOKEN_COOKIE_NAME, DEFAULT_COOKIE_ACCESS_TOKEN_PATH, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_GOOGLE_OIDC_CONFIG, DEFAULT_OIDC_CONFIG, DesktopSsoAvatarCacheConfig, DesktopSsoBrowserSessionConfig, DesktopSsoBrowserSessionUserInfoHeaders, DesktopSsoClaimsConfig, DesktopSsoConfigLoadResult, DesktopSsoUserInfoConfig, DesktopSsoWebSessionClearCookieConfig, DesktopSsoWebSessionExchangeConfig, OIDC_CONFIG_STRING_FIELDS, OIDC_CONFIG_URL_FIELDS, OidcConfig, getRecordBoolean, getRecordObject, getRecordOptionalBoolean, getRecordString, getRecordStringArray, isConfigEnabled, isGoogleOidcConfig, isPublicPkceOidcConfig, isServerBrokerAuthMode, normalizeAuthMode, normalizeBrowserMode, normalizeProviderName, recordLooksLikeGoogleOidcConfig, resolveDesktopSsoConfigPath, shouldUsePkceByDefault, shouldUseSystemBrowser } from "./oidc-sso.part-1";

function getDesktopSsoProxyTargetOrigin(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return new URL(config.authorizeUrl).origin;
}

export function shouldUseEphemeralSystemCallback(config: OidcConfig) {
  return !config.browserMode && shouldUseSystemBrowser(config);
}

export function getDesktopSsoProviderLabel(config: OidcConfig) {
  return config.providerLabel?.trim() ||
    (isGoogleOidcConfig(config) ? "Google" : PRODUCT_NAME);
}

export function getDesktopSsoLoginLabel(config: OidcConfig) {
  return t("sso.providerLogin", { provider: getDesktopSsoProviderLabel(config) });
}

export function getDesktopSsoLogoutLabel(config: OidcConfig) {
  return t("sso.providerLogout", { provider: getDesktopSsoProviderLabel(config) });
}

export function parseDesktopSsoConfigContent(content: string) {
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

export function normalizeIdentityProviderOrigin(record: Record<string, unknown>) {
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

export function hasHeader(headers: Record<string, string>, name: string) {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

export function normalizeCookieAccessTokenExchangeHeaders(record: Record<string, unknown>) {
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

export function normalizeCookieAccessTokenExchangeMethod(record: Record<string, unknown>) {
  const method = (getRecordString(record, "method") || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error(t("sso.config.cookieMethod"));
  }
  return method;
}

export function normalizeCookieAccessTokenExchangeBody(
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

export function normalizeCookieAccessTokenExchangeConfig(
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
  const rawValidationMode = getRecordString(exchangeRecord, "validationMode").toLowerCase();
  if (rawValidationMode && rawValidationMode !== "identity" && rawValidationMode !== "remote") {
    throw new Error(t("sso.config.cookieTokenValidationMode"));
  }
  const validationMode = rawValidationMode === "remote" ? "remote" : "identity";
  const accessTokenIssuer = getRecordString(exchangeRecord, "accessTokenIssuer");
  const accessTokenAudience = getRecordString(exchangeRecord, "accessTokenAudience");
  if (validationMode === "identity" && Boolean(accessTokenIssuer) !== Boolean(accessTokenAudience)) {
    throw new Error(t("sso.config.cookieTokenIdentityPairRequired"));
  }
  if (validationMode === "remote" && (accessTokenIssuer || accessTokenAudience)) {
    throw new Error(t("sso.config.cookieTokenRemoteSelectorsRejected"));
  }
  const rawCsrfUrl = getRecordString(exchangeRecord, "csrfUrl");
  return {
    url: new URL(rawUrl, baseOrigin).toString(),
    ...(rawCsrfUrl ? { csrfUrl: new URL(rawCsrfUrl, baseOrigin).toString() } : {}),
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    accessTokenPath,
    validationMode,
    ...(accessTokenIssuer ? {
      accessTokenIssuer: normalizeHttpUrl(accessTokenIssuer, accessTokenIssuer, "cookieAccessTokenExchange.accessTokenIssuer"),
      accessTokenAudience
    } : {})
  };
}

export function normalizeBrowserSessionSuccessStatuses(record: Record<string, unknown>) {
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

export function normalizeBrowserSessionUserInfoHeaders(
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

export function normalizeBrowserSessionConfig(
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

export function normalizeAccessTokenCookieSameSite(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "strict") {
    return "strict";
  }
  if (normalizedValue === "none" || normalizedValue === "no_restriction") {
    return "no_restriction";
  }
  return "lax";
}

export function normalizeAccessTokenCookieConfig(
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

export function normalizeAccessTokenCookieRecord(
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

export function normalizeAccessTokenCookieConfigs(
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

export function normalizeLoginCompletionUrls(record: Record<string, unknown>, config: OidcConfig) {
  const baseOrigin = config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin;
  const rawValues = [
    ...getRecordStringArray(record, "loginCompletionUrls"),
    getRecordString(record, "loginCompletionUrl"),
    getRecordString(record, "loginSuccessUrl")
  ].filter(Boolean);
  return [...new Set(rawValues.map((value) => new URL(value, baseOrigin).toString()))];
}

export function normalizeDesktopSsoClaimsConfig(record: Record<string, unknown>): DesktopSsoClaimsConfig {
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

export function normalizeHttpUrl(value: string, baseUrl: string, field: string) {
  const url = new URL(value, baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(t("sso.config.fieldHttpOnly", { field }));
  }
  return url.toString();
}

export function normalizeHttpOrigin(value: string, field: string) {
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

export function normalizeUserInfoConfig(
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

export function normalizeAvatarCacheConfig(
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

export function normalizeWebSessionCookieOrigins(
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

export function normalizeWebSessionClearCookies(
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

export function normalizeWebSessionExchangeConfig(
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

export function buildOidcConfigFromRecord(record: Record<string, unknown>) {
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

export type DesktopSsoUserInfoSource =
  | "id_token"
  | "userinfo"
  | "browser_session"
  | "cookie_userinfo"
  | "sso";
