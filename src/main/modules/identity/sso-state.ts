import { t } from "../../support/i18n/main-i18n";
import http from "node:http";
import type { CallbackServerInfo, CallbackHooks, PendingLogin, DesktopSsoProxyState, DesktopSsoSessionMetadata } from "./sso-model";
import type { App } from "electron";
import type { DesktopSsoStatus, DesktopSsoClaims } from "../../../shared/contracts";

export const desktopSsoRuntimeState = {
  currentStatus: createSignedOutStatus(t("sso.notSignedIn")),
  callbackServers: [] as http.Server[],
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
