import type { App } from "electron";
import type {
  FetchLike,
  DesktopSsoStatusChangeContext,
  CallbackServerInfo,
  CallbackServerOptions,
  OidcConfig,
  CallbackHooks
} from "./sso-model";
import { desktopSsoRuntimeState, createAuthenticatedStatus, cloneStatus } from "./sso-state";
import { t } from "../../support/i18n/main-i18n";
import { isServerBrokerAuthMode } from "./sso-config-values";
import { normalizeDesktopTicketCallbackRequest, normalizeCallbackRequest } from "./sso-callback-params";
import { createDesktopTicketPlaceholderClaims, isDesktopSsoClaimsValue } from "./sso-claims";
import {
  beginAuthenticatedSession,
  completeUserInfoStep,
  finalizeDesktopSsoLoginAttempt,
  failDesktopSsoStep,
  failDesktopSsoFlow
} from "./sso-session";
import { exchangeCodeForValidatedTokenResponse, completeValidatedOidcLogin } from "./sso-token-validation";
import { getDefaultOidcFetch } from "./sso-http";
import http from "node:http";
import { closeCallbackServer, getCallbackOrigin, armCallbackCleanup } from "./callback-lifecycle";
import {
  RETURN_TO_APP_PATH,
  LOGOUT_CALLBACK_PATH,
  CALLBACK_PATH,
  CALLBACK_HOST,
  GOOGLE_LOOPBACK_HOST,
  CALLBACK_PORT
} from "./sso-defaults";
import { writeHtmlResponse, renderCallbackHtml } from "./sso-callback-page";
import { proxyDesktopSsoRequest } from "./sso-proxy";
import { listenCallbackServers } from "./callback-listener";

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
