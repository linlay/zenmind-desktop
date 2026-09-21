import type { App } from "electron";
import { loadDesktopSsoConfig, getDesktopSsoAvatarCacheConfig } from "./sso-config";
import {
  readUserInfoFile,
  isDesktopSsoAvatarSourceTrusted,
  desktopSsoAvatarVersion,
  beginAuthenticatedSession,
  completeUserInfoStep,
  completeAccessTokenStep,
  finalizeDesktopSsoLoginAttempt
} from "./sso-session";
import type { DesktopSsoStatus } from "../../../shared/contracts";
import { createUnconfiguredStatus, createFailedStatus, cloneStatus, desktopSsoRuntimeState } from "./sso-state";
import { t } from "../../support/i18n/main-i18n";
import { DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_OIDC_CONFIG } from "./sso-defaults";
import { normalizeStringClaim, getJwtPayload } from "./sso-claims";
import { createDesktopSsoCookieUserInfoClaims } from "./sso-token-validation";
import { urlsMatchOriginAndPath, exchangeCookieForAccessToken, createCookieAccessTokenClaims } from "./sso-cookie-token";
import type { OidcConfig, DesktopSsoAccessTokenCookieDetails, FetchLike } from "./sso-model";

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
