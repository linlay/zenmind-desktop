import { failDesktopSsoFlow, loadSession, failDesktopSsoStep, clearSession } from "./sso-session";
import type { App } from "electron";
import { t } from "../../support/i18n/main-i18n";
import type { DesktopSsoStatus, DesktopSsoStartResult, DesktopSsoLogoutResult } from "../../../shared/contracts";
import { closeCallbackServer } from "./callback-lifecycle";
import {
  desktopSsoRuntimeState,
  cloneStatus,
  createSignedOutStatus,
  setCurrentStatus,
  createUnconfiguredStatus,
  createFailedStatus,
  createPendingStatus
} from "./sso-state";
import type { CallbackHooks } from "./sso-model";
import { loadDesktopSsoConfig, getDesktopSsoLoginLabel, getDesktopSsoLogoutLabel } from "./sso-config";
import { getSessionPath } from "./sso-paths";
import { shouldUseSystemBrowser, isServerBrokerAuthMode, shouldUsePkce } from "./sso-config-values";
import { ensureCallbackServer, resolveLoginCallbackServerOptions, resolveLogoutCallbackServerOptions } from "./sso-callback-server";
import { activateDesktopSsoProxy } from "./sso-proxy";
import { randomUUID } from "node:crypto";
import {
  createPkceCodeVerifier,
  buildServerBrokerAuthorizeUrl,
  buildAuthorizeUrl,
  createPkceCodeChallenge,
  buildLogoutUrl
} from "./sso-authorization";
import { buildDesktopSsoProxyUrl } from "./sso-proxy-urls";

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

export async function startDesktopSsoLogin(app: App, hooks: CallbackHooks = {}): Promise<DesktopSsoStartResult> {
  closeCallbackServer(undefined, true);
  desktopSsoRuntimeState.pendingLogin = null;
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
    const redirectUri = callbackInfo.redirectUri;
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
