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

import { CallbackHooks, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_GOOGLE_OIDC_CONFIG, DEFAULT_OIDC_CONFIG, DESKTOP_SSO_CONFIG_FILE_NAME, DesktopSsoAccessTokenCookieDetails, FetchLike, OidcConfig, cloneStatus, createFailedStatus, createPendingStatus, createSignedOutStatus, createUnconfiguredStatus, desktopSsoRuntimeState, getDesktopSsoUserInfoFilePath, getSessionPath, isServerBrokerAuthMode, resolveDesktopSsoConfigPath, setCurrentStatus, shouldUsePkce, shouldUseSystemBrowser } from "./oidc-sso.part-1";

import { getDesktopSsoLoginLabel, getDesktopSsoLogoutLabel, loadDesktopSsoConfig } from "./oidc-sso.part-2";

import { beginAuthenticatedSession, buildAuthorizeUrl, buildConfiguredLoginUrl, buildDesktopSsoProxyUrl, buildReturnToAppUrl, buildServerBrokerAuthorizeUrl, clearSession, completeAccessTokenStep, completeUserInfoStep, createPkceCodeChallenge, createPkceCodeVerifier, desktopSsoAccessTokenNeedsRefresh, desktopSsoAvatarVersion, failDesktopSsoFlow, failDesktopSsoStep, finalizeDesktopSsoLoginAttempt, getDesktopSsoAvatarCacheConfig, getJwtPayload, isDesktopSsoAvatarSourceTrusted, loadSession, normalizeStringClaim, readUserInfoFile, renderCallbackHtml, rewriteDesktopSsoProxyLocation, rewriteDesktopSsoProxySetCookieHeader, saveAccessTokenFile } from "./oidc-sso.part-3";

import { activateDesktopSsoProxy, buildCookieAccessTokenExchangeRequest, buildDesktopSsoBrowserCookieDetails, buildTokenExchangeRequest, createCookieAccessTokenClaims, exchangeCookieForAccessToken, getDefaultOidcFetch, getDesktopSsoCookieMirrorOrigins, getIdentityProviderCookieHosts, isDesktopSsoAuthorizeUrl, normalizeCallbackRequest, readCookieAccessTokenFromResponse, urlsMatchOriginAndPath } from "./oidc-sso.part-4";

import { buildLogoutUrl, cancelDesktopSsoLogin, closeCallbackServer, completeValidatedOidcLogin, createDesktopSsoCookieUserInfoClaims, ensureCallbackServer, exchangeCodeForClaims, exchangeCodeForTokenClaims, resolveLoginCallbackServerOptions, resolveLogoutCallbackServerOptions, validateIdToken } from "./oidc-sso.part-5";

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
  if (desktopSsoRuntimeState.loadedSessionPath !== getSessionPath(app)) {
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
    desktopSsoRuntimeState.pendingLogin = {
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
    const status = createPendingStatus(t("sso.waitingForIam"), desktopSsoRuntimeState.currentStatus);
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
    const status = desktopSsoRuntimeState.currentStatus.authenticated && desktopSsoRuntimeState.currentStatus.completedSteps.session
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
    return cloneStatus(desktopSsoRuntimeState.currentStatus);
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
  if (desktopSsoRuntimeState.currentStatus.user?.sub && desktopSsoRuntimeState.currentStatus.user.sub !== claims.sub) {
    if (configResult.config.userInfo?.required) {
      throw new Error(t("sso.token.userInfoSubMismatch"));
    }
    return cloneStatus(desktopSsoRuntimeState.currentStatus);
  }
  if (desktopSsoRuntimeState.currentStatus.user?.sub === claims.sub) {
    claims = { ...desktopSsoRuntimeState.currentStatus.user, ...claims };
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

export function persistDesktopSsoAccessToken(app: Pick<App, "getPath">, accessToken: string) {
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
  return desktopSsoRuntimeState.currentAccessToken || null;
}

export function isDesktopSsoCredentialRuntimeReady() {
  return desktopSsoRuntimeState.currentStatus.authenticated &&
    !desktopSsoRuntimeState.currentStatus.pending &&
    desktopSsoRuntimeState.currentStatus.completedSteps.session &&
    desktopSsoRuntimeState.currentStatus.completedSteps.accessToken &&
    Boolean(desktopSsoRuntimeState.currentAccessToken);
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
  desktopSsoRuntimeState.callbackHooks = hooks;
  const configResult = loadDesktopSsoConfig(app);
  if (desktopSsoRuntimeState.loadedSessionPath !== getSessionPath(app)) {
    loadSession(app);
  }
  const logoutIdToken = desktopSsoRuntimeState.currentIdToken;
  const logoutAuthMode = desktopSsoRuntimeState.currentSessionAuthMode;
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
