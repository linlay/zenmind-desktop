import type { BrowserWindow } from "electron";
import {
  app,
  globalShortcut,
  session,
  shell,
  webContents
} from "electron";
import { pathToFileURL } from "node:url";
import {
  PRODUCT_NAME,
  STORAGE_NAMESPACE
} from "../../../shared/brand";
import { getMainPreloadPath, getServiceWebviewPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../../infrastructure/electron/bundle-paths";
import {
  getFocusedWebviewDevToolsShortcut
} from "../../infrastructure/electron/platform-adapter";
import { loadRendererRoute } from "../../infrastructure/electron/renderer-route";
import { parseSafeLoopbackWebUrl } from "../../infrastructure/network/loopback-url";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import {
  callDesktopActionRenderer,
  getConfiguredDesktopActionBridgePort
} from "../../modules/desktop-actions";
import {
  getDesktopDeviceId
} from "../../modules/identity";
import {
  installWebsiteAppArchiveFromPath,
  readInstalledRecords,
  removeInstalledRecordByResourceKey
} from "../../modules/marketplace";
import {
  type ServicesFacade
} from "../../modules/services";
import { configureMainWindowWebContents, SelectionExplainWindowController, type AppShellRuntime } from "../../modules/shell";
import {
  deriveTunnelHubRegistrationApiOrigin,
  getTunnelHubRuntimeStatus,
  readTunnelHubRegistrationBearerToken,
  readTunnelHubSettings,
  saveTunnelHubSettings,
  startTunnelHubRuntime
} from "../../modules/tunnel";
import {
  createCdpIntegration, createWebviewContextMenuController, openCurrentWebviewDevTools, resolveWebviewOpenDisposition,
  shouldDownloadUrlFromWebview
} from "../../modules/web-surfaces";
import {
  createWebSurfaceRuntime,
  type WebsFacade,
  type WebsIntegrationPorts
} from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
import { safeConsoleError } from "../../support/logging/safe-console";
export interface AssembleWebsIntegrationDependencies {
  readonly websFacade: WebsFacade;
}

export function assembleWebsIntegration(
  dependencies: AssembleWebsIntegrationDependencies
): WebsIntegrationPorts {
  return {
    getDesktopDeviceId,
    getConfiguredDesktopActionBridgePort,
    readInstalledRecords,
    removeInstalledRecordByResourceKey,
    installWebsiteAppArchiveFromPath: (targetApp, archivePath, options) =>
      installWebsiteAppArchiveFromPath(targetApp, archivePath, {
        ...options,
        webs: dependencies.websFacade
      }),
    deriveTunnelHubRegistrationApiOrigin,
    getTunnelHubRuntimeStatus,
    startTunnelHubRuntime,
    readTunnelHubRegistrationBearerToken,
    readTunnelHubSettings,
    saveTunnelHubSettings
  };
}

export interface AssembleWebSurfaceRuntimeDependencies {
  readonly websFacade: WebsFacade;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly navigateMainWindow: AppShellRuntime["navigateMainWindow"];
  readonly delay: (ms: number) => Promise<void>;
}

export function assembleWebSurfaceRuntime(dependencies: AssembleWebSurfaceRuntimeDependencies) {
  return createWebSurfaceRuntime({
    app,
    websFacade: dependencies.websFacade,
    getMainWindow: dependencies.getMainWindow,
    webContents,
    reportRegistrationDiagnostic: (diagnostic) => {
      safeConsoleError("[surface-registration]", diagnostic);
    },
    navigateMainWindow: dependencies.navigateMainWindow,
    delay: dependencies.delay,
    t
  });
}

export interface AssembleWebviewContextMenusDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "browserSurfaceRegistry" | "openBrowserUrl">;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly servicesFacade: Pick<ServicesFacade, "getResponsiveServiceState">;
  readonly reportRendererDiagnostic: (source: string, details: Record<string, unknown>) => void;
  readonly selectionExplainWindowController: Pick<SelectionExplainWindowController, "update"> | null;
}

export function assembleWebviewContextMenus(dependencies: AssembleWebviewContextMenusDependencies) {
  return createWebviewContextMenuController({
    platform: dependencies.startupPlatform,
    browserSurfaces: dependencies.webSurfaceRuntime.browserSurfaceRegistry,
    getMainWindow: () => dependencies.getMainWindow(),
    openBrowserUrl: dependencies.webSurfaceRuntime.openBrowserUrl,
    openWorkPanelUrl: ({ sourceGuestId, url }) => {
      const target = dependencies.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(sourceGuestId);
      const mainWindow = dependencies.getMainWindow();
      if (!target ||
        (target.surfaceType !== "chat-work-panel" && target.presentationScope !== "workpanel") ||
        !mainWindow ||
        mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("webview.openTab", {
        target: "work-panel",
        navigationKind: "network",
        sourceGuestId,
        url
      });
    },
    openExternal: (url) => shell.openExternal(url),
    isTrustedAgentWebclient: async (contents, target) => {
      if (target.serviceId !== "agent-webclient" ||
        contents.session !== session.fromPartition(`persist:${STORAGE_NAMESPACE}-service-agent-webclient`)) {
        return false;
      }
      const liveUrl = parseSafeLoopbackWebUrl(contents.getURL());
      if (!liveUrl)
        return false;
      const service = await dependencies.servicesFacade.getResponsiveServiceState(app, "agent-webclient");
      const serviceUrl = parseSafeLoopbackWebUrl(service.healthMeta.webUrl);
      return Boolean(service.status === "running" &&
        serviceUrl &&
        new URL(liveUrl.toString()).origin === new URL(serviceUrl.toString()).origin);
    },
    t,
    report: dependencies.reportRendererDiagnostic,
    updateSelectionExplainWindow: (input) =>
      dependencies.selectionExplainWindowController?.update(input)
  });
}

export interface AssembleCdpIntegrationDependencies {
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "browserSurfaceRegistry" | "getCurrentPageSnapshot">;
  readonly servicesFacade: Pick<ServicesFacade, "listServices">;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "desktopActionRendererRequests">;
}

export function assembleCdpIntegration(dependencies: AssembleCdpIntegrationDependencies) {
  return createCdpIntegration({
    browserSurfaces: dependencies.webSurfaceRuntime.browserSurfaceRegistry,
    getCurrentPageSnapshot: dependencies.webSurfaceRuntime.getCurrentPageSnapshot,
    listServices: () => dependencies.servicesFacade.listServices(app),
    isLoopbackUrl: parseSafeLoopbackWebUrl,
    controlSiteFocus: async (surfaceId, tabId, siteTarget, phase) => {
      const response = await callDesktopActionRenderer({
        requestId: `cdp-focus-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action: "desktop.web.pageControlFocus",
        args: { phase },
        siteCdpTarget: { surfaceId, tabId, ...siteTarget },
      }, {
        getMainWindow: dependencies.getMainWindow,
        pendingRequests: dependencies.assistantBridgeRuntime.desktopActionRendererRequests,
      });
      if (!response.ok) throw new Error(response.error?.message || "Desktop foreground focus could not be preserved.");
      const foregroundId = response.result && typeof response.result === "object" && "webContentsId" in response.result
        ? response.result.webContentsId : undefined;
      if (phase !== "capture" && typeof foregroundId === "number") {
        const registry = dependencies.webSurfaceRuntime.browserSurfaceRegistry;
        const foreground = registry.resolveWebviewSurfaceTarget(foregroundId);
        if (foreground?.ownerWebContentsId === dependencies.getMainWindow()?.webContents.id) {
          // Restore the focused child widget without showing or activating its window.
          registry.findWebContentsById(foregroundId)?.focus();
        }
      }
    },
    switchTab: async (surfaceId, tabId, ownerChatId, siteTarget) => {
      const response = await callDesktopActionRenderer({
        requestId: `cdp-switch-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action: ownerChatId ? "desktop.workpanel.activateTab" : "desktop.web.switchTab",
        args: ownerChatId ? { tabId } : { surfaceId, tabId },
        ...(siteTarget ? { siteCdpTarget: { surfaceId, tabId, ...siteTarget } } : {}),
        ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
      }, {
        getMainWindow: dependencies.getMainWindow,
        pendingRequests: dependencies.assistantBridgeRuntime.desktopActionRendererRequests
      });
      if (!response.ok) {
        throw new Error(response.error?.message || "Desktop tab could not be activated.");
      }
      return response.result;
    },
    openPage: async (surfaceId, tabId, url, ownerChatId, siteTarget) => {
      const response = await callDesktopActionRenderer({
        requestId: `surface-open-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action: ownerChatId ? "desktop.workpanel.openWeb" : "desktop.web.openTab",
        args: { surfaceId, tabId, url },
        ...(siteTarget ? { siteCdpTarget: { surfaceId, tabId, ...siteTarget } } : {}),
        ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
      }, {
        getMainWindow: dependencies.getMainWindow,
        pendingRequests: dependencies.assistantBridgeRuntime.desktopActionRendererRequests
      });
      if (!response.ok) throw new Error(response.error?.message || "The page could not be opened.");
      return response.result;
    },
    closeTab: async (surfaceId, tabId, ownerChatId, siteTarget) => {
      const response = await callDesktopActionRenderer({
        requestId: `cdp-close-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action: ownerChatId ? "desktop.workpanel.closeTab" : "desktop.web.closeTab",
        args: ownerChatId ? { tabId } : { surfaceId, tabId },
        ...(siteTarget ? { siteCdpTarget: { surfaceId, tabId, ...siteTarget } } : {}),
        ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
      }, {
        getMainWindow: dependencies.getMainWindow,
        pendingRequests: dependencies.assistantBridgeRuntime.desktopActionRendererRequests
      });
      if (!response.ok) {
        throw new Error(response.error?.message || "Desktop tab could not be closed.");
      }
      return response.result;
    },
    version: `${PRODUCT_NAME}/${app.getVersion()} Electron/${process.versions.electron}`
  });
}

export interface AssembleSelectionExplainWindowDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly MAIN_PRELOAD_PATH: ReturnType<typeof getMainPreloadPath>;
  readonly SELECTION_EXPLAIN_WINDOW_ROUTE: string;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly MAIN_PROCESS_DIR: ReturnType<typeof resolveElectronBundleRootFromRuntimeDir>;
  readonly collectWebviewLoadDiagnostics: (contents: Electron.WebContents, validatedUrl: string) => Promise<Record<string, unknown>>;
  readonly reportRendererDiagnostic: (source: string, details: Record<string, unknown>) => void;
  readonly handleDesktopSsoWebviewNavigation: (url: string) => Promise<void>;
  readonly webviewContextMenuController: Pick<ReturnType<typeof createWebviewContextMenuController>, "attach">;
}

export function assembleSelectionExplainWindow(
  dependencies: AssembleSelectionExplainWindowDependencies
) {
  return new SelectionExplainWindowController({
    platform: dependencies.startupPlatform,
    preloadPath: dependencies.MAIN_PRELOAD_PATH,
    routePath: dependencies.SELECTION_EXPLAIN_WINDOW_ROUTE,
    title: t("webviewSelectionToolbar.moreDetails"),
    loadRendererRoute,
    getAnchorWindow: () => dependencies.getMainWindow(),
    onRendererError: safeConsoleError,
    configureWindow: (targetWindow) => {
      const servicePreloadPath = getServiceWebviewPreloadPath(
        dependencies.MAIN_PROCESS_DIR,
        dependencies.startupPlatform
      );
      configureMainWindowWebContents(targetWindow, {
        platform: dependencies.startupPlatform,
        getMainWindow: () => targetWindow,
        servicePreloadPath,
        servicePreloadUrl: pathToFileURL(servicePreloadPath).toString(),
        isSafeServiceUrl: parseSafeLoopbackWebUrl,
        isDevToolsShortcut: () => false,
        shouldDownloadUrl: shouldDownloadUrlFromWebview,
        resolveOpenDisposition: resolveWebviewOpenDisposition,
        collectLoadDiagnostics: dependencies.collectWebviewLoadDiagnostics,
        report: dependencies.reportRendererDiagnostic,
        onWebviewNavigation: dependencies.handleDesktopSsoWebviewNavigation,
        attachWebviewContextMenu: dependencies.webviewContextMenuController.attach,
        openExternal: shell.openExternal,
        schedule: setImmediate
      });
    }
  });
}

export interface RegisterFocusedWebviewDevToolsShortcutDependencies {
  focusedWebviewDevToolsShortcutRegistered: boolean;
  readonly FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT: ReturnType<typeof getFocusedWebviewDevToolsShortcut>;
  readonly appShellRuntime: Pick<AppShellRuntime, "getFocusedWebviewDevToolsTargetId">;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "getCopilotDevToolsTarget" | "getCurrentPageSnapshot">;
}

export function registerFocusedWebviewDevToolsShortcut(dependencies: RegisterFocusedWebviewDevToolsShortcutDependencies) {
  if (dependencies.focusedWebviewDevToolsShortcutRegistered) {
    return;
  }
  const registered = globalShortcut.register(dependencies.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT, () => {
    const focusedWebviewDevToolsTargetId = dependencies.appShellRuntime.getFocusedWebviewDevToolsTargetId();
    openCurrentWebviewDevTools({
      focusedWebviewDevToolsTarget: Number.isSafeInteger(focusedWebviewDevToolsTargetId) &&
        Number(focusedWebviewDevToolsTargetId) > 0
        ? { webContentsId: Number(focusedWebviewDevToolsTargetId) }
        : null,
      preferredWebviewDevToolsTarget: dependencies.webSurfaceRuntime.getCopilotDevToolsTarget(),
      currentPageSnapshot: dependencies.webSurfaceRuntime.getCurrentPageSnapshot(),
      webContents,
    });
  });
  if (!registered) {
    console.warn(`failed to register focused webview DevTools shortcut: ${dependencies.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT}`);
    return;
  }
  dependencies.focusedWebviewDevToolsShortcutRegistered = true;
}

