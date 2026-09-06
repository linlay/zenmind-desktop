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

import { CALLBACK_HOST, CALLBACK_ORIGIN, CALLBACK_PATH, CALLBACK_PORT, CallbackHooks, CallbackServerInfo, CallbackServerOptions, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_OIDC_CONFIG, DesktopSsoStatusChangeContext, FetchLike, FetchResponseLike, GOOGLE_LOOPBACK_HOST, LOGOUT_CALLBACK_PATH, OidcConfig, RETURN_TO_APP_PATH, cloneStatus, createAuthenticatedStatus, createFailedStatus, createPendingStatus, createSignedOutStatus, createUnconfiguredStatus, desktopSsoRuntimeState, getCompletedDesktopSsoMessage, getSessionPath, isGoogleOidcConfig, isServerBrokerAuthMode, removeLegacyDesktopSsoSiteTokenFile, setCurrentStatus } from "./oidc-sso.part-1";

import { loadDesktopSsoConfig, shouldUseEphemeralSystemCallback } from "./oidc-sso.part-2";

import { beginAuthenticatedSession, buildReturnToAppUrl, clearSession, completeAccessTokenStep, completeUserInfoStep, createClaims, decodeJsonPart, failDesktopSsoFlow, failDesktopSsoStep, finalizeDesktopSsoLoginAttempt, includesAudience, keyObjectFromJwk, loadSession, normalizeStringClaim, readFetchErrorBody, readFetchErrorStatus, renderCallbackHtml, writeHtmlResponse } from "./oidc-sso.part-3";

import { buildTokenExchangeRequest, createDesktopTicketPlaceholderClaims, describeFetchError, getDefaultOidcFetch, isDesktopSsoClaimsValue, normalizeCallbackRequest, normalizeDesktopTicketCallbackRequest, proxyDesktopSsoRequest, readJsonPathValue } from "./oidc-sso.part-4";

export function buildOidcFetchStage(action: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return `${isGoogleOidcConfig(config) ? "Google" : "OIDC"} ${action}`;
}

export async function fetchJson(
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

export async function validateIdToken(
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

export function mergeDesktopSsoUserInfoClaims(
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

export function createDesktopSsoCookieUserInfoClaims(userInfo: unknown, config: OidcConfig) {
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

export async function enrichClaimsWithUserInfo(
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

export async function exchangeCodeForValidatedTokenResponse(
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

export async function exchangeCodeForTokenClaims(
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

export async function exchangeCodeForClaims(
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

export async function completeValidatedOidcLogin(
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
  return cloneStatus(desktopSsoRuntimeState.currentStatus);
}

export async function handleLoginCallback(app: App, requestUrl: URL, fetchImpl?: FetchLike) {
  if (!desktopSsoRuntimeState.pendingLogin) {
    throw new Error(t("sso.noPendingLogin"));
  }
  if (isServerBrokerAuthMode(desktopSsoRuntimeState.pendingLogin.config)) {
    const { ticket } = normalizeDesktopTicketCallbackRequest(requestUrl, desktopSsoRuntimeState.pendingLogin.state);
    const statusContext: DesktopSsoStatusChangeContext = {
      provider: desktopSsoRuntimeState.pendingLogin.config.provider,
      ticket
    };
    const status = createAuthenticatedStatus(createDesktopTicketPlaceholderClaims(desktopSsoRuntimeState.pendingLogin.config));
    desktopSsoRuntimeState.pendingLogin = null;
    const hookClaims = await desktopSsoRuntimeState.callbackHooks.onBeforeStatusChanged?.(status, statusContext);
    if (!isDesktopSsoClaimsValue(hookClaims)) {
      throw new Error("Desktop SSO web session exchange did not return user claims.");
    }
    beginAuthenticatedSession(app, {
      issuer: hookClaims.issuer,
      audience: hookClaims.audience,
      authMode: "server"
    });
    const exchangedStatus = completeUserInfoStep(app, hookClaims, "sso");
    await desktopSsoRuntimeState.callbackHooks.onAfterStatusChanged?.(exchangedStatus, statusContext);
    return finalizeDesktopSsoLoginAttempt();
  }
  const { code } = normalizeCallbackRequest(requestUrl, desktopSsoRuntimeState.pendingLogin.state);
  const loginConfig = desktopSsoRuntimeState.pendingLogin.config;
  const tokenClaims = await exchangeCodeForValidatedTokenResponse(code, fetchImpl, loginConfig, {
    redirectUri: desktopSsoRuntimeState.pendingLogin.redirectUri,
    codeVerifier: desktopSsoRuntimeState.pendingLogin.codeVerifier
  });
  desktopSsoRuntimeState.pendingLogin = null;
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
  let status = cloneStatus(desktopSsoRuntimeState.currentStatus);
  const hookClaims = await desktopSsoRuntimeState.callbackHooks.onBeforeStatusChanged?.(status, statusContext);
  if (isDesktopSsoClaimsValue(hookClaims)) {
    status = completeUserInfoStep(app, hookClaims, "sso");
  }
  await desktopSsoRuntimeState.callbackHooks.onAfterStatusChanged?.(status, statusContext);
  return finalizeDesktopSsoLoginAttempt();
}

export function buildLogoutUrl(
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

export function closeCallbackServerAfterResponse(response: http.ServerResponse) {
  response.once("finish", closeCallbackServer);
}

export async function handleCallbackRequest(app: App, request: http.IncomingMessage, response: http.ServerResponse) {
  const fallbackOrigin = desktopSsoRuntimeState.callbackServerInfo?.origin || CALLBACK_ORIGIN;
  const requestUrl = new URL(request.url || "/", fallbackOrigin);
  const closeAfterCallback = desktopSsoRuntimeState.callbackServerInfo?.closeAfterCallback === true;
  if (requestUrl.pathname === RETURN_TO_APP_PATH) {
    await desktopSsoRuntimeState.callbackHooks.onReturnToAppRequested?.();
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(t("sso.returnedToDesktopTitle"), t("sso.closeBrowserPage")));
    return;
  }
  if (requestUrl.pathname === LOGOUT_CALLBACK_PATH) {
    desktopSsoRuntimeState.desktopSsoProxyState?.cookies.clear();
    if (closeAfterCallback) {
      closeCallbackServerAfterResponse(response);
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(t("sso.logoutReturnedTitle"), t("sso.logoutReturnedMessage")));
    return;
  }
  if (requestUrl.pathname !== CALLBACK_PATH) {
    if (!desktopSsoRuntimeState.desktopSsoProxyState) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      await proxyDesktopSsoRequest(desktopSsoRuntimeState.desktopSsoProxyState, request, response, requestUrl);
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
    if (desktopSsoRuntimeState.currentStatus.authenticated && desktopSsoRuntimeState.currentStatus.completedSteps.session) {
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

export function closeCallbackServer() {
  const server = desktopSsoRuntimeState.callbackServer;
  desktopSsoRuntimeState.callbackServer = null;
  desktopSsoRuntimeState.callbackServerReady = null;
  desktopSsoRuntimeState.callbackServerInfo = null;
  desktopSsoRuntimeState.desktopSsoProxyState = null;
  if (!server) {
    return;
  }
  server.close(() => {});
}

export function buildCallbackServerInfo(host: string, port: number, closeAfterCallback: boolean): CallbackServerInfo {
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

export function resolveCallbackServerOptionsFromUrl(
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

export function resolveLoginCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
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

export function resolveLogoutCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
  if (useSystemBrowser) {
    return resolveCallbackServerOptionsFromUrl(config.logoutCallbackUri, true);
  }
  return {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: false
  };
}

export async function ensureCallbackServer(
  app: App,
  hooks: CallbackHooks = {},
  options: CallbackServerOptions = {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: false
  }
) {
  desktopSsoRuntimeState.callbackHooks = hooks;
  if (desktopSsoRuntimeState.callbackServer && desktopSsoRuntimeState.callbackServerReady) {
    if (
      desktopSsoRuntimeState.callbackServerInfo?.host === options.host &&
      desktopSsoRuntimeState.callbackServerInfo.port === options.port &&
      desktopSsoRuntimeState.callbackServerInfo.closeAfterCallback === options.closeAfterCallback
    ) {
      await desktopSsoRuntimeState.callbackServerReady;
      return desktopSsoRuntimeState.callbackServerInfo;
    }
    closeCallbackServer();
  }

  desktopSsoRuntimeState.callbackServer = http.createServer((request, response) => {
    void handleCallbackRequest(app, request, response);
  });
  desktopSsoRuntimeState.callbackServerReady = new Promise<void>((resolve, reject) => {
    const server = desktopSsoRuntimeState.callbackServer;
    if (!server) {
      reject(new Error("callback server unavailable"));
      return;
    }
    const handleError = (error: NodeJS.ErrnoException) => {
      desktopSsoRuntimeState.callbackServer = null;
      desktopSsoRuntimeState.callbackServerReady = null;
      desktopSsoRuntimeState.callbackServerInfo = null;
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
      desktopSsoRuntimeState.callbackServerInfo = buildCallbackServerInfo(
        options.host,
        address?.port || options.port,
        options.closeAfterCallback
      );
      resolve();
    });
  });
  await desktopSsoRuntimeState.callbackServerReady;
  if (!desktopSsoRuntimeState.callbackServerInfo) {
    throw new Error("callback server did not report a listening address");
  }
  return desktopSsoRuntimeState.callbackServerInfo;
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
    if (desktopSsoRuntimeState.loadedSessionPath !== sessionPath) {
      loadSession(app);
    } else if (!desktopSsoRuntimeState.currentStatus.configured) {
      // A first-run env import can make sso.json available after this runtime was
      // initialized as unconfigured. Enable the interactive login entry without
      // reloading an unverified credential candidate from disk.
      desktopSsoRuntimeState.currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
    }
  }
  return cloneStatus(desktopSsoRuntimeState.currentStatus);
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
  desktopSsoRuntimeState.loadedSessionPath = sessionPath;
  desktopSsoRuntimeState.currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;

  if (!configResult.configured) {
    desktopSsoRuntimeState.currentStatus = createUnconfiguredStatus(configResult.message);
    return { requiresCookieValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }
  if (configResult.error || !configResult.config) {
    desktopSsoRuntimeState.currentStatus = createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
    return { requiresCookieValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }
  if (!fs.existsSync(sessionPath)) {
    return { requiresCookieValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
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
    return { requiresCookieValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }

  const requiresCookieValidation =
    parsed.authenticated === true &&
    Boolean(configResult.config.browserSession) &&
    Boolean(configResult.config.cookieAccessTokenExchange) &&
    parsed.authMode !== "oidc" &&
    parsed.authMode !== "server";
  if (!requiresCookieValidation) {
    loadSession(app);
    return { requiresCookieValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
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

  desktopSsoRuntimeState.currentStatus = createPendingStatus(t("sso.restoringLogin"));
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = true;
  return { requiresCookieValidation: true, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
}

export function markDesktopSsoRestoreTemporarilyUnavailable(app: App, message: string) {
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
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

export const failDesktopSsoLogin = failDesktopSsoFlow;

export function cancelDesktopSsoLogin(app: App, message = t("sso.cancelled")): DesktopSsoStatus {
  desktopSsoRuntimeState.pendingLogin = null;
  desktopSsoRuntimeState.currentAccessToken = "";
  if (!desktopSsoRuntimeState.unverifiedCookieSessionCandidate) {
    loadSession(app);
  }
  const status = desktopSsoRuntimeState.currentStatus.authenticated && !desktopSsoRuntimeState.currentStatus.pending
    ? {
      ...cloneStatus(desktopSsoRuntimeState.currentStatus),
      message,
      updatedAt: new Date().toISOString()
    }
    : createSignedOutStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}
