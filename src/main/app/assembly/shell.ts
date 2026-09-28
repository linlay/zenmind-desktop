import type { BrowserWindow } from "electron";
import {
  app,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  webContents
} from "electron";
import {
  PRODUCT_NAME
} from "../../../shared/brand";
import type {
  EnterpriseChatScreenshotMode
} from "../../../shared/contracts";
import { MAIN_CHAT_SURFACE_ID } from "../../../shared/surface-identity";
import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../../infrastructure/electron/bundle-paths";
import {
  isDesktopCloseShortcut,
  isDevToolsShortcut,
  isGlobalSearchShortcut,
  resolveGlobalSearchCommandShortcut
} from "../../infrastructure/electron/platform-adapter";
import { loadRendererRoute } from "../../infrastructure/electron/renderer-route";
import { parseSafeLoopbackWebUrl } from "../../infrastructure/network/loopback-url";
import { captureScreenshotForBridge, getAssistantSettings, type AssistantBridgeRuntime } from "../../modules/assistant";
import { isDesktopPetSupportedPlatform, type DesktopPetRuntime } from "../../modules/pet";
import { readHelpSettings } from "../../modules/settings";
import { createAppShellRuntime } from "../../modules/shell";
import { createWebviewContextMenuController, resolveRegisteredWebviewPopupTarget } from "../../modules/web-surfaces";
import {
  createWebSurfaceRuntime,
  type WebsFacade
} from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
import { createLogsRuntime } from "../../support/logging/runtime";
import { safeConsoleError } from "../../support/logging/safe-console";
import { createMainAppState } from "../state";
import { configureSystemIdentity } from "../system-identity";
export interface AssembleLogsRuntimeDependencies {
  readonly MAIN_PRELOAD_PATH: ReturnType<typeof getMainPreloadPath>;
  readonly LOG_VIEWER_ROUTE: string;
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
}

export function assembleLogsRuntime(dependencies: AssembleLogsRuntimeDependencies) {
  return createLogsRuntime({
    app,
    preloadPath: dependencies.MAIN_PRELOAD_PATH,
    routePath: dependencies.LOG_VIEWER_ROUTE,
    platform: dependencies.startupPlatform,
    getOwnerWindow: () => {
      const mainWindow = dependencies.getMainWindow();
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    },
    loadRendererRoute,
    onRendererError: safeConsoleError
  });
}

export interface AssembleAppShellDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly systemIdentityRuntime: Pick<ReturnType<typeof configureSystemIdentity>, "effectiveAppId" | "ensureDockIdentity">;
  readonly MAIN_PROCESS_DIR: ReturnType<typeof resolveElectronBundleRootFromRuntimeDir>;
  readonly logsRuntime: ReturnType<typeof createLogsRuntime>;
  readonly AGENT_REALTIME_INSPECTOR_ROUTE: string;
  readonly DESKTOP_ACTION_WORKBENCH_ROUTE: string;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "browserSurfaceRegistry">;
  readonly handleDesktopSsoWebviewNavigation: (url: string) => Promise<void>;
  readonly webviewContextMenuController: Pick<ReturnType<typeof createWebviewContextMenuController>, "attach">;
  readonly collectWebviewLoadDiagnostics: (contents: Electron.WebContents, validatedUrl: string) => Promise<Record<string, unknown>>;
  readonly reportRendererDiagnostic: (source: string, details: Record<string, unknown>) => void;
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "isHandlingQuit">;
  readonly beginAppQuitWithoutConfirmation: () => void;
  readonly requestAppQuit: () => void;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "getNavigationSnapshot">;
  readonly petRuntime: Pick<DesktopPetRuntime, "getSettings">;
  readonly showDesktopPetWindow: DesktopPetRuntime["showWindow"];
  readonly hideDesktopPetWindow: DesktopPetRuntime["hideWindow"];
  readonly restoreDesktopPetWindowLayering: DesktopPetRuntime["restoreWindowLayering"];
  readonly websFacade: Pick<WebsFacade, "webappRuntime">;
}

export function assembleAppShell(dependencies: AssembleAppShellDependencies) {
  return createAppShellRuntime({
    app,
    platform: dependencies.startupPlatform,
    effectiveAppId: dependencies.systemIdentityRuntime.effectiveAppId,
    mainProcessDir: dependencies.MAIN_PROCESS_DIR,
    productName: PRODUCT_NAME,
    resourcesPath: process.resourcesPath,
    session,
    shell,
    nativeTheme,
    systemPreferences,
    t,
    logsRuntime: dependencies.logsRuntime,
    agentRealtimeInspectorRoute: dependencies.AGENT_REALTIME_INSPECTOR_ROUTE,
    desktopActionWorkbenchRoute: dependencies.DESKTOP_ACTION_WORKBENCH_ROUTE,
    loadRendererRoute,
    parseSafeLoopbackWebUrl,
    isDevToolsShortcut,
    isGlobalSearchShortcut,
    isDesktopCloseShortcut,
    isWorkPanelWebview: (contents) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return Boolean(target?.active &&
        (target.presentationScope === "workpanel" || (target.surfaceLevel === "child" &&
          target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
          target.ownerChatId &&
          [
            "overview",
            "debug",
            "btw",
            "source",
            "project",
            "file-diff",
            "artifact",
            "reference",
            "file",
            "planning",
            "agent",
            "copilot",
            "skill",
            "workpanel-web",
          ].includes(target.surfaceRole))));
    },
    isMainChatWebview: (contents) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return Boolean(target?.active &&
        target.surfaceId === MAIN_CHAT_SURFACE_ID &&
        target.surfaceRole === "main-chat" &&
        target.surfaceLevel === "root" &&
        target.surfaceType === "agent-chat");
    },
    resolveWebsiteCloseTarget: (contents) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      if (!target?.active || target.surfaceType !== "website" || target.surfaceRole !== "website" ||
        target.surfaceLevel !== "root" || target.presentationScope === "workpanel") return null;
      return { surfaceId: target.surfaceId, registrationId: target.registrationId };
    },
    resolveGlobalSearchCommandShortcut,
    handleDesktopSsoWebviewNavigation: dependencies.handleDesktopSsoWebviewNavigation,
    shouldOpenWebviewPopupInWorkPanelTab: (contents) => (() => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return resolveRegisteredWebviewPopupTarget(target) === "work-panel";
    })(),
    shouldOpenWebviewPopupExternally: (contents) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return target?.serviceId === "agent-webclient";
    },
    resolveBlobPopupTarget: (contents) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return resolveRegisteredWebviewPopupTarget(target);
    },
    attachWebviewContextMenu: dependencies.webviewContextMenuController.attach,
    collectWebviewLoadDiagnostics: dependencies.collectWebviewLoadDiagnostics,
    reportRendererDiagnostic: dependencies.reportRendererDiagnostic,
    safeConsoleError,
    ensureDockIdentity: () => dependencies.systemIdentityRuntime.ensureDockIdentity(),
    isHandlingQuit: () => dependencies.appState.isHandlingQuit,
    beginAppQuitWithoutConfirmation: dependencies.beginAppQuitWithoutConfirmation,
    requestAppQuit: dependencies.requestAppQuit,
    getAssistantNavigationSnapshot: () => dependencies.assistantBridgeRuntime?.getNavigationSnapshot(),
    getDefaultChatAgentKey: () => getAssistantSettings(app).chatDefaultAgentKey,
    getDesktopPetEnabled: () => dependencies.petRuntime?.getSettings()?.enabled === true,
    isDesktopPetSupported: () => isDesktopPetSupportedPlatform(dependencies.startupPlatform),
    showDesktopPetWindow: dependencies.showDesktopPetWindow,
    hideDesktopPetWindow: dependencies.hideDesktopPetWindow,
    restoreDesktopPetWindowLayering: dependencies.restoreDesktopPetWindowLayering,
    isAllowedWebappMicrophoneRequest: (contents, details) => {
      const guest = webContents.fromId(contents.id);
      if (!guest || guest.isDestroyed()) {
        return false;
      }
      const liveUrl = guest.getURL();
      const requestingUrl = details && typeof details === "object" &&
        "requestingUrl" in details && typeof details.requestingUrl === "string"
        ? details.requestingUrl
        : liveUrl;
      try {
        if (new URL(liveUrl).origin !== new URL(requestingUrl).origin) {
          return false;
        }
      }
      catch {
        return false;
      }
      return dependencies.websFacade.webappRuntime
        .allowsLocalPageCapability(requestingUrl, "desktop.microphone");
    },
    getHelpUrl: () => readHelpSettings(app, dependencies.startupPlatform).url
  });
}

export interface CaptureDesktopScreenshotForWebviewDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly delay: (ms: number) => Promise<void>;
}

export async function captureDesktopScreenshotForWebview(dependencies: CaptureDesktopScreenshotForWebviewDependencies, mode: EnterpriseChatScreenshotMode) {
  return captureScreenshotForBridge({
    platform: dependencies.startupPlatform,
    getMainWindow: () => dependencies.getMainWindow(),
    delay: dependencies.delay
  }, mode);
}

