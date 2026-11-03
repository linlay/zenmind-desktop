import type { BrowserWindow } from "electron";
import {
  app,
  nativeImage,
  session,
  shell
} from "electron";
import {
  APP_ID,
  PRODUCT_NAME
} from "../../../shared/brand";
import { resolveElectronBundleRootFromRuntimeDir } from "../../infrastructure/electron/bundle-paths";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import { EnterpriseChatRuntime } from "../../modules/enterprise-chat";
import {
  completeDesktopSsoCookieLogin,
  createDesktopSsoController,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  finalizeDesktopSsoLoginAttempt,
  getDesktopSsoBusinessToken,
  getDesktopSsoCredentialGeneration,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
  type DesktopSsoRestoreResult
} from "../../modules/identity";
import { configureMarketAccessTokenIssuer, refreshMarketCatalog } from "../../modules/marketplace";
import { stopBrowserWebclient } from "../../modules/services";
import {
  notifyTunnelHubCredentialChanged,
  stopTunnelHubRuntime
} from "../../modules/tunnel";
import { createWebSurfaceRuntime } from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
import { safeConsoleError } from "../../support/logging/safe-console";
import { createMainAppState } from "../state";
import { configureSystemIdentity } from "../system-identity";
export interface AssembleSystemIdentityDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly MAIN_PROCESS_DIR: ReturnType<typeof resolveElectronBundleRootFromRuntimeDir>;
}

export function assembleSystemIdentity(dependencies: AssembleSystemIdentityDependencies) {
  return configureSystemIdentity({
    app,
    platform: dependencies.startupPlatform,
    appId: APP_ID,
    productName: PRODUCT_NAME,
    mainProcessDir: dependencies.MAIN_PROCESS_DIR,
    resourcesPath: process.resourcesPath,
    nativeImage,
    safeConsoleError
  });
}

export interface AssembleDesktopSsoControllerDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "openBrowserUrl">;
  readonly applyDesktopSsoRestoreResult: (result: DesktopSsoRestoreResult) => void;
}

export function assembleDesktopSsoController(dependencies: AssembleDesktopSsoControllerDependencies) {
  return createDesktopSsoController({
    app,
    platform: dependencies.startupPlatform,
    session,
    getMainWindow: () => dependencies.getMainWindow(),
    openBrowserUrl: dependencies.webSurfaceRuntime.openBrowserUrl,
    openExternal: shell.openExternal,
    onRestoreResult: dependencies.applyDesktopSsoRestoreResult
  });
}

/** Market reads the published canonical token; it never renews or revokes Desktop sign-in. */
export function configureMarketTokenIssuer(): void {
  configureMarketAccessTokenIssuer(() => readPublishedDesktopSsoToken());
}

export function readPublishedDesktopSsoToken() {
  return isDesktopSsoCredentialRuntimeReady() ? getDesktopSsoBusinessToken() || "" : "";
}

export interface CreateDesktopSsoMaintenanceDependencies {
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "retryDesktopSsoSessionRestoreIfNeeded" | "ensureBusinessToken">;
  readonly applyDesktopSsoRestoreResult: (result: DesktopSsoRestoreResult) => void;
  readonly desktopSsoRestoreState: DesktopSsoRestoreResult["state"];
}

/**
 * Identity's own schedule (startup, periodic check, wake). Downstream services never receive
 * this function: their failures stay local and they react to committed credential changes.
 */
export function createDesktopSsoMaintenance(dependencies: CreateDesktopSsoMaintenanceDependencies) {
  return async () => {
    const restoreResult = await dependencies.desktopSsoController.retryDesktopSsoSessionRestoreIfNeeded();
    dependencies.applyDesktopSsoRestoreResult(restoreResult);
    if (dependencies.desktopSsoRestoreState === "temporarily_unavailable") {
      return "";
    }
    return dependencies.desktopSsoController.ensureBusinessToken(false);
  };
}

export interface HandleDesktopSsoWebviewNavigationDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "desktopSsoWebviewCompletionInFlight">;
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "syncBrowserCookies" | "validateBrowserSession" | "exchangeBrowserCookieAccessToken" | "fetchBrowserUserInfo" | "returnToApp">;
}

export async function handleDesktopSsoWebviewNavigation(dependencies: HandleDesktopSsoWebviewNavigationDependencies, url: string) {
  let sessionCompleted = false;
  let completionStarted = false;
  let isCurrentAttempt = () => false;
  try {
    const status = getDesktopSsoStatus(app);
    if (dependencies.appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
      return;
    }
    const generation = getDesktopSsoCredentialGeneration();
    isCurrentAttempt = () => getDesktopSsoCredentialGeneration() === generation;
    completionStarted = true;
    dependencies.appState.desktopSsoWebviewCompletionInFlight = true;
    await dependencies.desktopSsoController.syncBrowserCookies();
    if (!isCurrentAttempt()) return;
    const browserSessionStatus = await dependencies.desktopSsoController.validateBrowserSession();
    if (!isCurrentAttempt()) return;
    if (!browserSessionStatus) {
      const accessToken = await dependencies.desktopSsoController.exchangeBrowserCookieAccessToken();
      if (!isCurrentAttempt()) return;
      if (!accessToken) {
        failDesktopSsoFlow(t("main.ssoCookieExchangeNoAccessToken"));
        return;
      }
      completeDesktopSsoCookieLogin(app, accessToken);
      finalizeDesktopSsoLoginAttempt();
      dependencies.desktopSsoController.returnToApp();
      return;
    }
    sessionCompleted = true;
    const stepErrors: string[] = [];
    try {
      await dependencies.desktopSsoController.fetchBrowserUserInfo();
      if (!isCurrentAttempt()) return;
    }
    catch (error) {
      if (!isCurrentAttempt()) return;
      const message = error instanceof Error ? error.message : String(error);
      stepErrors.push(message);
      safeConsoleError("failed to fetch desktop sso browser userinfo", { url, error: message });
    }
    let accessToken = "";
    try {
      accessToken = await dependencies.desktopSsoController.exchangeBrowserCookieAccessToken();
      if (!isCurrentAttempt()) return;
      if (!accessToken) {
        stepErrors.push(t("main.ssoCookieExchangeNoAccessToken"));
      }
    }
    catch (error) {
      if (!isCurrentAttempt()) return;
      const message = error instanceof Error ? error.message : String(error);
      stepErrors.push(message);
      safeConsoleError("failed to exchange desktop sso browser access token", { url, error: message });
    }
    finalizeDesktopSsoLoginAttempt(stepErrors);
    if (stepErrors.length === 0) {
      dependencies.desktopSsoController.returnToApp();
    }
  }
  catch (error) {
    if (!isCurrentAttempt()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (sessionCompleted) {
      failDesktopSsoStep(message);
    }
    else {
      failDesktopSsoFlow(message);
    }
    safeConsoleError("failed to complete desktop sso from webview navigation", {
      url,
      error: message
    });
  }
  finally {
    if (completionStarted) dependencies.appState.desktopSsoWebviewCompletionInFlight = false;
  }
}

export interface ApplyDesktopSsoRestoreResultDependencies {
  desktopSsoRestoreState: DesktopSsoRestoreResult["state"];
  ssoCredentialDependentRuntimesStarted: boolean;
  /** Account the downstream runtimes were last started for; kept across temporary unavailability. */
  ssoCredentialDependentIdentity: string | null;
  readonly nonCoreDesktopRuntimeStarted: boolean;
  readonly startSsoCredentialDependentRuntimes: () => void;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "refreshKanbanDeviceInfo" | "refreshKanbanCredentials">;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "refresh" | "handleSignedOut" | "handleCredentialChanged">;
}

export function readDesktopSsoDependentIdentity() {
  const user = getDesktopSsoStatus(app).user;
  return user?.sub ? JSON.stringify([user.issuer || "", user.sub, user.audience || ""]) : null;
}

/**
 * The single identity-to-downstream dispatcher. Downstream services consume the canonical token
 * read-only; only an account change rebuilds them, and same-account recovery only resumes Tunnel.
 */
export function applyDesktopSsoRestoreResult(dependencies: ApplyDesktopSsoRestoreResultDependencies, result: DesktopSsoRestoreResult) {
  if (result.state !== "authenticated") void stopBrowserWebclient();
  // Login-identity providers follow the SSO token file inside Platform; no Provider Key changes here.
  dependencies.desktopSsoRestoreState = result.state;
  if (result.state !== "authenticated") {
    dependencies.ssoCredentialDependentRuntimesStarted = false;
    if (dependencies.nonCoreDesktopRuntimeStarted) {
      void stopTunnelHubRuntime().catch(error => safeConsoleError("failed to stop Tunnel after SSO became unavailable", error));
    }
    if (result.state === "signed_out") {
      // Background revocation clears IM like an explicit sign-out. A temporary outage keeps
      // IM's own derived session; its next exchange finds no published token and parks.
      dependencies.ssoCredentialDependentIdentity = null;
      dependencies.enterpriseChatRuntime.handleSignedOut();
    }
    return;
  }
  if (dependencies.ssoCredentialDependentRuntimesStarted || !isDesktopSsoCredentialRuntimeReady()) {
    return;
  }
  const identity = readDesktopSsoDependentIdentity();
  const sameIdentity = identity !== null && identity === dependencies.ssoCredentialDependentIdentity;
  dependencies.ssoCredentialDependentIdentity = identity;
  dependencies.startSsoCredentialDependentRuntimes();
  if (sameIdentity) {
    return;
  }
  dependencies.assistantBridgeRuntime?.refreshKanbanDeviceInfo();
  void refreshMarketCatalog(app).catch((error) => {
    safeConsoleError("failed to refresh Market after desktop sso restore", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  void dependencies.enterpriseChatRuntime.refresh().catch((error) => {
    safeConsoleError("failed to refresh enterprise chat after desktop sso restore", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

/**
 * Identity committed a different canonical token. A first token or another account goes through
 * the restore dispatcher; a same-account renewal only wakes services parked on a rejected token.
 */
export function handleDesktopSsoCredentialChanged(dependencies: ApplyDesktopSsoRestoreResultDependencies) {
  // A disk candidate loaded before startup restore is not a sign-in; only act after Identity
  // has published a verified authenticated result in this process.
  if (dependencies.desktopSsoRestoreState !== "authenticated" || !isDesktopSsoCredentialRuntimeReady()) {
    return;
  }
  if (!dependencies.ssoCredentialDependentRuntimesStarted ||
    readDesktopSsoDependentIdentity() !== dependencies.ssoCredentialDependentIdentity) {
    if (dependencies.ssoCredentialDependentRuntimesStarted) {
      // An account change without an intervening sign-out still rebuilds every consumer once.
      dependencies.ssoCredentialDependentRuntimesStarted = false;
    }
    applyDesktopSsoRestoreResult(dependencies, { state: "authenticated", status: getDesktopSsoStatus(app) });
    return;
  }
  dependencies.assistantBridgeRuntime?.refreshKanbanCredentials();
  notifyTunnelHubCredentialChanged();
  dependencies.enterpriseChatRuntime.handleCredentialChanged();
}

