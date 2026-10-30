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
  desktopSsoIdTokenNeedsRefresh,
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

export interface ConfigureMarketTokenIssuerDependencies {
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "ensureBusinessToken">;
}

export function configureMarketTokenIssuer(dependencies: ConfigureMarketTokenIssuerDependencies): void {
  configureMarketAccessTokenIssuer(async (_marketApp, reason) => {
    const currentToken = isDesktopSsoCredentialRuntimeReady()
      ? getDesktopSsoBusinessToken() || ""
      : "";
    if (currentToken && reason === "missing") {
      return currentToken;
    }
    return dependencies.desktopSsoController.ensureBusinessToken(true);
  });
}

export interface CreateDesktopSsoTokenRefresherDependencies {
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "retryDesktopSsoSessionRestoreIfNeeded" | "ensureBusinessToken">;
  readonly applyDesktopSsoRestoreResult: (result: DesktopSsoRestoreResult) => void;
  readonly desktopSsoRestoreState: DesktopSsoRestoreResult["state"];
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "refreshKanbanDeviceInfo">;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "refresh">;
}

export function createDesktopSsoTokenRefresher(dependencies: CreateDesktopSsoTokenRefresherDependencies) {
  return async (force = false) => {
    const restoreResult = await dependencies.desktopSsoController.retryDesktopSsoSessionRestoreIfNeeded();
    dependencies.applyDesktopSsoRestoreResult(restoreResult);
    if (dependencies.desktopSsoRestoreState === "temporarily_unavailable") {
      return "";
    }
    const needsRefresh = force || desktopSsoIdTokenNeedsRefresh(app);
    const accessToken = await dependencies.desktopSsoController.ensureBusinessToken(force);
    if (needsRefresh && accessToken) {
      dependencies.assistantBridgeRuntime?.refreshKanbanDeviceInfo();
      void dependencies.enterpriseChatRuntime.refresh().catch((error) => {
        safeConsoleError("failed to refresh enterprise chat after desktop sso token renewal", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return accessToken;
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
  readonly nonCoreDesktopRuntimeStarted: boolean;
  readonly startSsoCredentialDependentRuntimes: () => void;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "refreshKanbanDeviceInfo">;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "refresh">;
}

export function applyDesktopSsoRestoreResult(dependencies: ApplyDesktopSsoRestoreResultDependencies, result: DesktopSsoRestoreResult) {
  if (result.state !== "authenticated") void stopBrowserWebclient();
  // Login-identity providers follow the SSO token file inside Platform; no Provider Key changes here.
  dependencies.desktopSsoRestoreState = result.state;
  if (result.state !== "authenticated") {
    dependencies.ssoCredentialDependentRuntimesStarted = false;
    if (dependencies.nonCoreDesktopRuntimeStarted) {
      void stopTunnelHubRuntime().catch(error => safeConsoleError("failed to stop Tunnel after SSO became unavailable", error));
    }
    return;
  }
  if (result.state !== "authenticated" ||
    dependencies.ssoCredentialDependentRuntimesStarted ||
    !isDesktopSsoCredentialRuntimeReady()) {
    return;
  }
  dependencies.startSsoCredentialDependentRuntimes();
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

