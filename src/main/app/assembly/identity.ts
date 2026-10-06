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
import {
  clearAccessTokenProviderKeys,
  getProviderRegisterMode,
  invalidateProviderRegistration
} from "../../modules/agent-platform";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import { EnterpriseChatRuntime } from "../../modules/enterprise-chat";
import {
  completeDesktopSsoCookieLogin,
  createDesktopSsoController,
  desktopSsoAccessTokenNeedsRefresh,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  finalizeDesktopSsoLoginAttempt,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
  type DesktopSsoRestoreResult
} from "../../modules/identity";
import { configureMarketAccessTokenIssuer, refreshMarketCatalog } from "../../modules/marketplace";
import {
  createServicesRuntime,
  stopBrowserWebclient,
  type ServicesIntegrationPorts
} from "../../modules/services";
import {
  stopTunnelHubRuntime
} from "../../modules/tunnel";
import { createWebSurfaceRuntime } from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
import { safeConsoleError } from "../../support/logging/safe-console";
import {
  isStartupPhaseAtLeast
} from "../lifecycle/startup-phases";
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
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "refreshBrowserCookieAccessTokenIfNeeded">;
}

export function configureMarketTokenIssuer(dependencies: ConfigureMarketTokenIssuerDependencies): void {
  configureMarketAccessTokenIssuer(async (_marketApp, reason) => {
    const currentToken = isDesktopSsoCredentialRuntimeReady()
      ? getDesktopSsoAccessToken() || ""
      : "";
    if (currentToken && reason === "missing") {
      return currentToken;
    }
    return dependencies.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(true);
  });
}

export interface CreateDesktopSsoTokenRefresherDependencies {
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "retryDesktopSsoSessionRestoreIfNeeded" | "refreshBrowserCookieAccessTokenIfNeeded">;
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
    const needsRefresh = force || desktopSsoAccessTokenNeedsRefresh(app);
    const accessToken = await dependencies.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(force);
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
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "syncBrowserCookies" | "validateBrowserSession" | "exchangeBrowserCookieAccessToken" | "fetchBrowserUserInfo">;
}

export async function handleDesktopSsoWebviewNavigation(dependencies: HandleDesktopSsoWebviewNavigationDependencies, url: string) {
  let sessionCompleted = false;
  try {
    const status = getDesktopSsoStatus(app);
    if (dependencies.appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
      return;
    }
    dependencies.appState.desktopSsoWebviewCompletionInFlight = true;
    await dependencies.desktopSsoController.syncBrowserCookies();
    const browserSessionStatus = await dependencies.desktopSsoController.validateBrowserSession();
    if (!browserSessionStatus) {
      const accessToken = await dependencies.desktopSsoController.exchangeBrowserCookieAccessToken();
      if (!accessToken) {
        failDesktopSsoFlow(t("main.ssoCookieExchangeNoAccessToken"));
        return;
      }
      completeDesktopSsoCookieLogin(app, accessToken);
      finalizeDesktopSsoLoginAttempt();
      return;
    }
    sessionCompleted = true;
    const stepErrors: string[] = [];
    try {
      await dependencies.desktopSsoController.fetchBrowserUserInfo();
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stepErrors.push(message);
      safeConsoleError("failed to fetch desktop sso browser userinfo", { url, error: message });
    }
    let accessToken = "";
    try {
      accessToken = await dependencies.desktopSsoController.exchangeBrowserCookieAccessToken();
      if (!accessToken) {
        stepErrors.push(t("main.ssoCookieExchangeNoAccessToken"));
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stepErrors.push(message);
      safeConsoleError("failed to exchange desktop sso browser access token", { url, error: message });
    }
    finalizeDesktopSsoLoginAttempt(stepErrors);
  }
  catch (error) {
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
    dependencies.appState.desktopSsoWebviewCompletionInFlight = false;
  }
}

export interface ApplyDesktopSsoRestoreResultDependencies {
  desktopSsoRestoreState: DesktopSsoRestoreResult["state"];
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "startupPhase">;
  readonly startupPlatform: NodeJS.Platform;
  readonly servicesRuntime: Pick<ReturnType<typeof createServicesRuntime>, "runServiceMutation">;
  readonly servicesIntegrationPorts: Pick<ServicesIntegrationPorts, "ensureProviderRegisterApiKey">;
  ssoCredentialDependentRuntimesStarted: boolean;
  readonly nonCoreDesktopRuntimeStarted: boolean;
  readonly startSsoCredentialDependentRuntimes: () => void;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "refreshKanbanDeviceInfo">;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "refresh">;
}

export function applyDesktopSsoRestoreResult(dependencies: ApplyDesktopSsoRestoreResultDependencies, result: DesktopSsoRestoreResult) {
  if (result.state !== "authenticated") void stopBrowserWebclient();
  const previousRestoreState = dependencies.desktopSsoRestoreState;
  dependencies.desktopSsoRestoreState = result.state;
  // Provider registration policy is independent of SSO configuration and never falls back to Grant.
  const shellStarted = isStartupPhaseAtLeast(dependencies.appState.startupPhase, "core-services-starting");
  if (shellStarted && getProviderRegisterMode(app, dependencies.startupPlatform) === "access-token") {
    if (result.state !== "authenticated" && previousRestoreState === "authenticated") {
      invalidateProviderRegistration(app, dependencies.startupPlatform);
      void dependencies.servicesRuntime.runServiceMutation(async () => {
        clearAccessTokenProviderKeys(app, dependencies.startupPlatform);
      }).catch(error => safeConsoleError("failed to clear access-token Provider Keys", { error: String(error) }));
    } else if (result.state === "authenticated" && previousRestoreState !== "authenticated" &&
      isDesktopSsoCredentialRuntimeReady()) {
      // Update the selected Provider in place; do not start or restart local services.
      void dependencies.servicesRuntime.runServiceMutation(() =>
        dependencies.servicesIntegrationPorts.ensureProviderRegisterApiKey(app)
      ).catch(error => safeConsoleError("failed to register access-token Provider Key", { error: String(error) }));
    }
  }
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

