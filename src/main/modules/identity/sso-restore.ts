import type { App } from "electron";
import type { DesktopSsoStatus } from "../../../shared/contracts";
import { loadDesktopSsoConfig } from "./sso-config";
import {
  createUnconfiguredStatus,
  createFailedStatus,
  desktopSsoRuntimeState,
  createSignedOutStatus,
  cloneStatus,
  createPendingStatus,
  setCurrentStatus
} from "./sso-state";
import { getSessionPath, removeLegacyDesktopSsoSiteTokenFile } from "./sso-paths";
import { loadSession, clearSession } from "./sso-session";
import { t } from "../../support/i18n/main-i18n";
import fs from "node:fs";
import { DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG } from "./sso-defaults";

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
