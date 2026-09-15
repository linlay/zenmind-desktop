import { armCallbackCleanup, closeCallbackServer, getCallbackOrigin } from "./callback-lifecycle";
export { closeCallbackServer } from "./callback-lifecycle";
import fs from "node:fs";
import http from "node:http";
import { listenCallbackServers } from "./callback-listener";
import {
  createVerify
} from "node:crypto";
import type { App } from "electron";
import type {
  DesktopSsoClaims,
  DesktopSsoStatus
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { CALLBACK_HOST, CALLBACK_PATH, CALLBACK_PORT, CallbackHooks, CallbackServerInfo, CallbackServerOptions, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_OIDC_CONFIG, DesktopSsoStatusChangeContext, FetchLike, FetchResponseLike, GOOGLE_LOOPBACK_HOST, LOGOUT_CALLBACK_PATH, OidcConfig, RETURN_TO_APP_PATH, cloneStatus, createAuthenticatedStatus, createFailedStatus, createPendingStatus, createSignedOutStatus, createUnconfiguredStatus, desktopSsoRuntimeState, getSessionPath, isGoogleOidcConfig, isServerBrokerAuthMode, removeLegacyDesktopSsoSiteTokenFile, setCurrentStatus } from "./oidc-sso.part-1";
import { loadDesktopSsoConfig } from "./oidc-sso.part-2";
import { beginAuthenticatedSession, clearSession, completeAccessTokenStep, completeUserInfoStep, createClaims, decodeJsonPart, failDesktopSsoFlow, failDesktopSsoStep, finalizeDesktopSsoLoginAttempt, includesAudience, keyObjectFromJwk, loadSession, normalizeStringClaim, readFetchErrorBody, readFetchErrorStatus, renderCallbackHtml, writeHtmlResponse } from "./oidc-sso.part-3";
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
  config: OidcConfig,
  assertCurrent: () => void = () => {}
) {
  assertCurrent();
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
  assertCurrent();
  if (enrichedClaims !== tokenClaims.claims) {
    completeUserInfoStep(app, enrichedClaims, "userinfo");
  }
  return cloneStatus(desktopSsoRuntimeState.currentStatus);
}

export async function handleLoginCallback(app: App, requestUrl: URL, fetchImpl?: FetchLike) {
  if (!desktopSsoRuntimeState.pendingLogin) {
    throw new Error(t("sso.noPendingLogin"));
  }
  const servers = desktopSsoRuntimeState.callbackServers;
  const hooks = desktopSsoRuntimeState.callbackHooks;
  const assertCurrent = () => {
    if (desktopSsoRuntimeState.callbackServers !== servers) {
      throw new Error(t("sso.cancelled"));
    }
  };
  if (isServerBrokerAuthMode(desktopSsoRuntimeState.pendingLogin.config)) {
    const { ticket } = normalizeDesktopTicketCallbackRequest(requestUrl, desktopSsoRuntimeState.pendingLogin.state);
    const statusContext: DesktopSsoStatusChangeContext = {
      provider: desktopSsoRuntimeState.pendingLogin.config.provider,
      ticket
    };
    const status = createAuthenticatedStatus(createDesktopTicketPlaceholderClaims(desktopSsoRuntimeState.pendingLogin.config));
    desktopSsoRuntimeState.pendingLogin = null;
    const hookClaims = await hooks.onBeforeStatusChanged?.(status, statusContext);
    assertCurrent();
    if (!isDesktopSsoClaimsValue(hookClaims)) {
      throw new Error("Desktop SSO web session exchange did not return user claims.");
    }
    beginAuthenticatedSession(app, {
      issuer: hookClaims.issuer,
      audience: hookClaims.audience,
      authMode: "server"
    });
    const exchangedStatus = completeUserInfoStep(app, hookClaims, "sso");
    await hooks.onAfterStatusChanged?.(exchangedStatus, statusContext);
    assertCurrent();
    return finalizeDesktopSsoLoginAttempt();
  }
  const { code } = normalizeCallbackRequest(requestUrl, desktopSsoRuntimeState.pendingLogin.state);
  const loginConfig = desktopSsoRuntimeState.pendingLogin.config;
  const tokenClaims = await exchangeCodeForValidatedTokenResponse(code, fetchImpl, loginConfig, {
    redirectUri: desktopSsoRuntimeState.pendingLogin.redirectUri,
    codeVerifier: desktopSsoRuntimeState.pendingLogin.codeVerifier
  });
  assertCurrent();
  desktopSsoRuntimeState.pendingLogin = null;
  await completeValidatedOidcLogin(
    app,
    tokenClaims,
    fetchImpl || getDefaultOidcFetch(),
    loginConfig,
    assertCurrent
  );
  assertCurrent();
  const statusContext: DesktopSsoStatusChangeContext = {
    provider: loginConfig.provider,
    idToken: tokenClaims.idToken
  };
  let status = cloneStatus(desktopSsoRuntimeState.currentStatus);
  const hookClaims = await hooks.onBeforeStatusChanged?.(status, statusContext);
  assertCurrent();
  if (isDesktopSsoClaimsValue(hookClaims)) {
    status = completeUserInfoStep(app, hookClaims, "sso");
  }
  await hooks.onAfterStatusChanged?.(status, statusContext);
  assertCurrent();
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
  const servers = desktopSsoRuntimeState.callbackServers;
  response.once("finish", () => closeCallbackServer(servers));
}

export async function handleCallbackRequest(app: App, request: http.IncomingMessage, response: http.ServerResponse) {
  const fallbackOrigin = getCallbackOrigin();
  const requestUrl = new URL(request.url || "/", fallbackOrigin);
  const closeAfterCallback = desktopSsoRuntimeState.callbackServerInfo?.closeAfterCallback === true;
  const servers = desktopSsoRuntimeState.callbackServers;
  const hooks = desktopSsoRuntimeState.callbackHooks;
  const closeAfterResponse = () => response.once("finish", () => closeCallbackServer(servers));
  if (requestUrl.pathname === RETURN_TO_APP_PATH) {
    await desktopSsoRuntimeState.callbackHooks.onReturnToAppRequested?.();
    if (closeAfterCallback) {
      closeAfterResponse();
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(t("sso.returnedToDesktopTitle"), t("sso.closeBrowserPage")));
    return;
  }
  if (requestUrl.pathname === LOGOUT_CALLBACK_PATH) {
    desktopSsoRuntimeState.desktopSsoProxyState?.cookies.clear();
    if (closeAfterCallback) {
      closeAfterResponse();
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
      closeAfterResponse();
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
    await hooks.onReturnToAppRequested?.();
    if (closeAfterCallback) {
      closeAfterResponse();
    }
    writeHtmlResponse(response, 200, renderCallbackHtml(
      t("sso.loginSuccessTitle"),
      t("sso.loginSuccessMessage", { user: status.user?.sub ?? t("sso.userFallback") })
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (desktopSsoRuntimeState.callbackServers === servers) {
      if (desktopSsoRuntimeState.currentStatus.authenticated && desktopSsoRuntimeState.currentStatus.completedSteps.session) {
        failDesktopSsoStep(message);
      } else {
        failDesktopSsoFlow(message);
      }
    }
    if (closeAfterCallback) {
      closeAfterResponse();
    }
    writeHtmlResponse(response, 400, renderCallbackHtml(t("sso.loginFailedTitle"), message));
  }
}

export function buildCallbackServerInfo(host: string, port: number, closeAfterCallback: boolean): CallbackServerInfo {
  const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
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
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Desktop SSO callback must use a loopback address.");
  }
  return {
    host: url.hostname === "[::1]" ? "::1" : url.hostname || CALLBACK_HOST,
    port: 0,
    closeAfterCallback
  };
}

export function resolveLoginCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
  if (useSystemBrowser) {
    if (!config.browserMode) {
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
    closeAfterCallback: true
  };
}

export function resolveLogoutCallbackServerOptions(config: OidcConfig, useSystemBrowser: boolean): CallbackServerOptions {
  if (useSystemBrowser) {
    return resolveCallbackServerOptionsFromUrl(config.logoutCallbackUri, true);
  }
  return {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: true
  };
}

export async function ensureCallbackServer(
  app: App,
  hooks: CallbackHooks = {},
  options: CallbackServerOptions = {
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    closeAfterCallback: true
  }
) {
  desktopSsoRuntimeState.callbackHooks = hooks;
  if (desktopSsoRuntimeState.callbackServers.length && desktopSsoRuntimeState.callbackServerReady) {
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

  const servers = [http.createServer((request, response) => {
    void handleCallbackRequest(app, request, response);
  })];
  desktopSsoRuntimeState.callbackServers = servers;
  desktopSsoRuntimeState.callbackServerReady = listenCallbackServers(servers, options.port, options.host)
    .then((port) => {
      if (desktopSsoRuntimeState.callbackServers !== servers) {
        for (const server of servers) server.close();
        throw new Error("callback server startup cancelled");
      }
      desktopSsoRuntimeState.callbackServerInfo = buildCallbackServerInfo(
        options.host, port, options.closeAfterCallback
      );
      armCallbackCleanup(app, servers, () => {
        if (desktopSsoRuntimeState.currentStatus.pending) failDesktopSsoFlow(t("sso.callbackTimeout"));
      });
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (desktopSsoRuntimeState.callbackServers === servers) closeCallbackServer();
      if (error.code === "EADDRINUSE") {
        throw new Error(t("sso.callbackPortInUse", { port: options.port }));
      }
      throw error;
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
  requiresRemoteValidation: boolean;
  authMode?: "cookie" | "bearer";
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
    return { requiresRemoteValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }
  if (configResult.error || !configResult.config) {
    desktopSsoRuntimeState.currentStatus = createFailedStatus(configResult.error || t("sso.missingOidcConfig"));
    return { requiresRemoteValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }
  if (!fs.existsSync(sessionPath)) {
    return { requiresRemoteValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
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
    return { requiresRemoteValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
  }

  const requiresRemoteValidation =
    parsed.authenticated === true &&
    Boolean(configResult.config.browserSession) &&
    Boolean(configResult.config.cookieAccessTokenExchange) &&
    parsed.authMode !== "oidc" &&
    parsed.authMode !== "server";
  if (!requiresRemoteValidation) {
    loadSession(app);
    return { requiresRemoteValidation: false, status: cloneStatus(desktopSsoRuntimeState.currentStatus) };
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
      requiresRemoteValidation: false,
      clearCookies: true,
      status: clearDesktopSsoLocalSession(app, t("sso.restoreConfigurationChanged"))
    };
  }

  desktopSsoRuntimeState.currentStatus = createPendingStatus(t("sso.restoringLogin"));
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = true;
  return {
    requiresRemoteValidation: true,
    authMode: configResult.config.sessionRestore?.authMode || "cookie",
    status: cloneStatus(desktopSsoRuntimeState.currentStatus)
  };
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
  closeCallbackServer(undefined, true);
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
