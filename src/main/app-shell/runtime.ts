import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  webContents as electronWebContents,
  type App,
  type NativeTheme,
  type Session,
  type Shell,
  type SystemPreferences
} from "electron";
import type { AssistantWorkerOpenRequest, DesktopGlobalSearchShortcut } from "../../shared/contracts";
import { DESKTOP_HELP_WEBVIEW_PARTITION } from "../../shared/help";
import type { MainAppState } from "../app-state";
import type { LogsRuntime } from "../logs/runtime";
import { getMainLocaleSettings } from "../i18n/main-i18n";
import {
  prepareQuitUi as prepareQuitUiFromCleanup
} from "../shutdown-cleanup";
import {
  buildMainWindowOptions,
  configureMediaPermissions as configureWindowMediaPermissions,
  configureMainWindowLifecycleEvents,
  configureMainWindowWebContents,
  createMainWindowActivationController,
  createMainWindowLifecycleController,
  loadMainWindowRenderer
} from "../window-manager";
import { getRendererEntry } from "../renderer-route";
import { getArchiveExtensions } from "../platform-adapter";
import { resolveWebviewOpenDisposition, shouldDownloadUrlFromWebview } from "../webview-open-tab";
import {
  getMainPreloadPath,
  getServiceWebviewPreloadPath as resolveServiceWebviewPreloadPath
} from "../electron-bundle-paths";
import { buildApplicationMenu as installApplicationMenu } from "./app-menu";
import { AgentPlatformMonitorWindowController } from "./agent-platform-monitor-window";
import { AgentRealtimeInspectorWindowController } from "./agent-realtime-inspector-window";
import { DesktopActionWorkbenchWindowController } from "./desktop-action-workbench-window";
import { createQuitConfirmationController } from "./quit-confirmation";
import { NativeDialogVisibilityController } from "./native-dialogs";
import { AppTrayController } from "./tray";
import { readHelpSettings } from "../help-settings";

export type AppShellRuntimeOptions = {
  app: App;
  state: MainAppState;
  platform: NodeJS.Platform;
  mainProcessDir: string;
  productName: string;
  resourcesPath: string;
  session: {
    defaultSession: Session;
    fromPartition(partition: string): Session;
  };
  shell: Pick<Shell, "openExternal">;
  nativeTheme: Pick<NativeTheme, "shouldUseDarkColors" | "on">;
  systemPreferences: Pick<SystemPreferences, "askForMediaAccess">;
  t: (...args: any[]) => string;
  logsRuntime: LogsRuntime;
  agentRealtimeInspectorRoute: string;
  desktopActionWorkbenchRoute: string;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  parseSafeLoopbackWebUrl: (value: string) => unknown;
  isDevToolsShortcut: (platform: NodeJS.Platform, input: any) => boolean;
  isGlobalSearchShortcut: (platform: NodeJS.Platform, input: any) => boolean;
  isWorkPanelCloseShortcut: (platform: NodeJS.Platform, input: any) => boolean;
  isWorkPanelWebview: (contents: Electron.WebContents) => boolean;
  resolveGlobalSearchCommandShortcut: (platform: NodeJS.Platform, input: any) => DesktopGlobalSearchShortcut | null;
  handleDesktopSsoWebviewNavigation: (url: string) => Promise<void> | void;
  shouldOpenWebviewPopupInWorkPanelTab: (contents: Electron.WebContents) => boolean;
  resolveBlobPopupTarget: (
    contents: Electron.WebContents,
  ) => "desktop-browser" | "work-panel" | null;
  attachWebviewContextMenu: (contents: Electron.WebContents) => void;
  collectWebviewLoadDiagnostics: (contents: Electron.WebContents, validatedUrl: string) => Promise<Record<string, unknown>>;
  reportRendererDiagnostic: (source: string, details: Record<string, unknown>) => void;
  safeConsoleError: (message: string, details: unknown) => void;
  ensureDockIdentity: () => void;
  beginAppQuitWithoutConfirmation: () => void;
  requestAppQuit: () => void;
  openAssistantWorker: (request: AssistantWorkerOpenRequest) => Promise<void> | void;
  getDesktopPetEnabled: () => boolean;
  isDesktopPetSupported: () => boolean;
  showDesktopPetWindow: () => unknown;
  hideDesktopPetWindow: () => unknown;
  restoreDesktopPetWindowLayering: () => void;
  isAllowedWebappMicrophoneRequest?: (contents: { id: number }, details: unknown) => boolean;
};

export function createAppShellRuntime(options: AppShellRuntimeOptions) {
  const mainWindowLifecycle = createMainWindowLifecycleController({
    platform: options.platform,
    getWindow: () => options.state.mainWindow,
    createWindow: () => createWindow(),
    clearWindow: (targetWindow) => {
      if (options.state.mainWindow === targetWindow) {
        options.state.mainWindow = null;
      }
    },
    isSidebarTranslucencyEnabled: () => options.state.mainWindowSidebarTranslucencyEnabled,
    nativeTheme: options.nativeTheme,
    reportRendererDiagnostic: options.reportRendererDiagnostic
  });
  const mainWindowActivation = createMainWindowActivationController({
    platform: options.platform,
    lifecycle: mainWindowLifecycle,
    ensureDockIdentity: options.ensureDockIdentity,
    focusApp: (focusOptions) => options.app.focus(focusOptions)
  });
  const agentPlatformMonitorWindowController = new AgentPlatformMonitorWindowController({
    platform: options.platform,
    onRendererError: options.safeConsoleError
  });
  const agentRealtimeInspectorWindowController = new AgentRealtimeInspectorWindowController({
    preloadPath: getMainPreloadPath(options.mainProcessDir, options.platform),
    routePath: options.agentRealtimeInspectorRoute,
    platform: options.platform,
    loadRendererRoute: options.loadRendererRoute,
    onRendererError: options.safeConsoleError
  });
  const desktopActionWorkbenchWindowController = new DesktopActionWorkbenchWindowController({
    preloadPath: getMainPreloadPath(options.mainProcessDir, options.platform),
    routePath: options.desktopActionWorkbenchRoute,
    platform: options.platform,
    loadRendererRoute: options.loadRendererRoute,
    onRendererError: options.safeConsoleError
  });
  const nativeDialogController = new NativeDialogVisibilityController({
    platform: options.platform,
    getTargetWindows: () => [options.state.mainWindow]
  });
  const quitConfirmationController = createQuitConfirmationController({
    platform: options.platform,
    t: options.t,
    getOwnerWindow: () => options.state.mainWindow,
    showMessageBox: (dialogOptions, ownerWindow) => nativeDialogController.showMessageBox(dialogOptions, ownerWindow),
    requestQuitWithoutConfirmation: options.beginAppQuitWithoutConfirmation
  });
  const appTrayController = new AppTrayController({
    platform: options.platform,
    isPackaged: options.app.isPackaged,
    appName: options.productName,
    t: options.t,
    mainDir: options.mainProcessDir,
    resourcesPath: options.resourcesPath,
    getDesktopPetEnabled: options.getDesktopPetEnabled,
    isDesktopPetSupported: options.isDesktopPetSupported,
    openAssistantChat: () => {
      void options.openAssistantWorker({
        displayName: options.productName,
        role: options.t("main.confirmationExampleRole"),
        focusComposerOnComplete: true
      });
    },
    showMainWindow: () => showMainWindow(),
    openSettings: () => showMainWindow("/settings"),
    showDesktopPet: () => options.showDesktopPetWindow(),
    hideDesktopPet: () => options.hideDesktopPetWindow(),
    quitWithoutConfirmation: options.beginAppQuitWithoutConfirmation
  });

  if (options.platform === "win32") {
    options.nativeTheme.on("updated", () => refreshMainWindowAppearance());
  }

  function getServiceWebviewPreloadPath() {
    return resolveServiceWebviewPreloadPath(options.mainProcessDir, options.platform);
  }

  function getServiceWebviewPreloadUrl() {
    return pathToFileURL(getServiceWebviewPreloadPath()).toString();
  }

  async function openAgentPlatformMonitorWindow(url: string) {
    return agentPlatformMonitorWindowController.open(url);
  }

  async function openDesktopActionWorkbenchWindow() {
    return desktopActionWorkbenchWindowController.open();
  }

  async function openAgentRealtimeInspectorWindow() {
    return agentRealtimeInspectorWindowController.open();
  }

  function closeDesktopActionWorkbenchWindow() {
    return desktopActionWorkbenchWindowController.close();
  }

  async function showFileDialog(
    dialogOptions: Parameters<NativeDialogVisibilityController["showFileDialog"]>[0],
    ownerWindow: BrowserWindow | null = options.state.mainWindow
  ) {
    return nativeDialogController.showFileDialog(dialogOptions, ownerWindow);
  }

  async function showSaveDialog(
    dialogOptions: Parameters<NativeDialogVisibilityController["showSaveDialog"]>[0],
    ownerWindow: BrowserWindow | null = options.state.mainWindow
  ) {
    return nativeDialogController.showSaveDialog(dialogOptions, ownerWindow);
  }

  async function showMessageBox(
    dialogOptions: Parameters<NativeDialogVisibilityController["showMessageBox"]>[0],
    ownerWindow: BrowserWindow | null = options.state.mainWindow
  ) {
    return nativeDialogController.showMessageBox(dialogOptions, ownerWindow);
  }

  function showArchiveDialog(title: string, extensions = getArchiveExtensions(options.platform)) {
    return showFileDialog({
      title,
      properties: ["openFile"],
      filters: [{ name: "Archive", extensions }]
    });
  }

  function createWindow() {
    options.state.workPanelKeyboardFocusActive = false;
    options.state.workPanelFullscreenActive = false;
    options.state.focusedWebviewDevToolsTargetId = null;
    options.state.mainWindow = new BrowserWindow(buildMainWindowOptions({
      platform: options.platform,
      preloadPath: getMainPreloadPath(options.mainProcessDir, options.platform),
      initialLocaleSettings: getMainLocaleSettings(),
      shouldUseDarkColors: options.nativeTheme.shouldUseDarkColors
    }));
    const targetWindow = options.state.mainWindow;

    mainWindowLifecycle.applyAppearance(targetWindow);
    mainWindowLifecycle.attachRendererDiagnostics(targetWindow);

    configureMainWindowWebContents<BrowserWindow, Electron.WebContents>(targetWindow, {
      platform: options.platform,
      getMainWindow: () => options.state.mainWindow,
      servicePreloadPath: getServiceWebviewPreloadPath(),
      servicePreloadUrl: getServiceWebviewPreloadUrl(),
      isSafeServiceUrl: options.parseSafeLoopbackWebUrl,
      isDevToolsShortcut: options.isDevToolsShortcut,
      isGlobalSearchShortcut: options.isGlobalSearchShortcut,
      isWorkPanelCloseShortcut: options.isWorkPanelCloseShortcut,
      isWorkPanelWebview: options.isWorkPanelWebview,
      isWorkPanelFullscreenActive: () => options.state.workPanelFullscreenActive,
      resolveGlobalSearchCommandShortcut: options.resolveGlobalSearchCommandShortcut,
      isGlobalSearchOverlayVisible: () => mainWindowLifecycle.isGlobalSearchOverlayVisible(),
      shouldDownloadUrl: shouldDownloadUrlFromWebview,
      resolveOpenDisposition: resolveWebviewOpenDisposition,
      collectLoadDiagnostics: options.collectWebviewLoadDiagnostics,
      report: options.safeConsoleError,
      onWebviewNavigation: options.handleDesktopSsoWebviewNavigation,
      shouldOpenPopupInWorkPanelTab: options.shouldOpenWebviewPopupInWorkPanelTab,
      resolveBlobPopupTarget: options.resolveBlobPopupTarget,
      attachWebviewContextMenu: options.attachWebviewContextMenu,
      onWebviewFocusChanged: (webContentsId, focused) => {
        if (focused) {
          options.state.focusedWebviewDevToolsTargetId = webContentsId;
        } else if (options.state.focusedWebviewDevToolsTargetId === webContentsId) {
          options.state.focusedWebviewDevToolsTargetId = null;
        }
      },
      onMainRendererFocused: () => {
        options.state.focusedWebviewDevToolsTargetId = null;
      },
      getHelpUrl: () => readHelpSettings(options.app, options.platform).url,
      isHelpWebview: (contents) =>
        contents.session === options.session.fromPartition(DESKTOP_HELP_WEBVIEW_PARTITION),
      openExternal: options.shell.openExternal,
      schedule: setImmediate
    });
    void loadMainWindowRenderer(targetWindow, {
      mode: process.env.VITE_DEV_SERVER_URL ? "dev" : "file",
      rendererEntry: getRendererEntry(),
      quit: options.beginAppQuitWithoutConfirmation,
      report: (message, error) => console.error(message, error)
    });

    configureMainWindowLifecycleEvents<BrowserWindow>(targetWindow, {
      platform: options.platform,
      lifecycle: mainWindowLifecycle,
      isDevToolsShortcut: options.isDevToolsShortcut,
      isGlobalSearchShortcut: options.isGlobalSearchShortcut,
      isWorkPanelCloseShortcut: options.isWorkPanelCloseShortcut,
      isWorkPanelKeyboardFocusActive: () => options.state.workPanelKeyboardFocusActive,
      resolveGlobalSearchCommandShortcut: options.resolveGlobalSearchCommandShortcut,
      isHandlingQuit: () => options.state.isHandlingQuit,
      clearWindow: (windowToClear) => {
        if (options.state.mainWindow === windowToClear) {
          options.state.mainWindow = null;
          options.state.workPanelKeyboardFocusActive = false;
          options.state.workPanelFullscreenActive = false;
          options.state.focusedWebviewDevToolsTargetId = null;
        }
      },
      restoreFloatingWindowsForFullscreen: () => options.restoreDesktopPetWindowLayering()
    });

    return targetWindow;
  }

  function configureAppMediaPermissions() {
    configureWindowMediaPermissions({
      platform: options.platform,
      permissionSession: options.session.defaultSession,
      getMainWindow: () => options.state.mainWindow,
      askForMicrophoneAccess: () => options.systemPreferences.askForMediaAccess("microphone"),
      isAllowedWebappMicrophoneRequest: options.isAllowedWebappMicrophoneRequest
    });
  }

  function showMainWindow(targetPath?: string) {
    mainWindowActivation.showMainWindow(targetPath);
  }

  function navigateMainWindow(targetPath: string) {
    mainWindowActivation.navigateMainWindow(targetPath);
  }

  function refreshMainWindowAppearance() {
    mainWindowLifecycle.applyAppearance(options.state.mainWindow);
  }

  function createAppTray() {
    return appTrayController.create();
  }

  function buildApplicationMenu() {
    installApplicationMenu({
      appName: options.app.name,
      platform: options.platform,
      t: options.t,
      openSettings: () => navigateMainWindow("/settings"),
      requestCloseWindow: () => {
        const targetWindow = BrowserWindow.getFocusedWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
          return;
        }
        if (targetWindow !== options.state.mainWindow) {
          targetWindow.close();
          return;
        }
        const focusedContents = electronWebContents.getFocusedWebContents();
        const focusedWorkPanelGuest = focusedContents && focusedContents !== targetWindow.webContents &&
          options.isWorkPanelWebview(focusedContents)
          ? focusedContents
          : null;
        targetWindow.webContents.send("app.workPanelCloseShortcut", {
          guestId: focusedWorkPanelGuest?.id ?? null,
          fallbackToWindowClose: true,
          workPanelFocused: options.state.workPanelKeyboardFocusActive
        });
      },
      requestQuit: options.requestAppQuit,
      quitWithoutConfirmation: options.beginAppQuitWithoutConfirmation
    });
  }

  function prepareQuitUi() {
    prepareQuitUiFromCleanup({
      getAllWindows: () => BrowserWindow.getAllWindows(),
      keepVisibleWindow: options.state.mainWindow,
      destroyTray: () => appTrayController.destroy()
    });
  }

  return {
    getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl,
    openAgentPlatformMonitorWindow,
    openAgentRealtimeInspectorWindow,
    openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow,
    showFileDialog,
    showSaveDialog,
    showMessageBox,
    showArchiveDialog,
    createWindow,
    configureAppMediaPermissions,
    showMainWindow,
    navigateMainWindow,
    refreshMainWindowAppearance,
    setGlobalSearchOverlayVisible: (visible: boolean) => mainWindowLifecycle.setGlobalSearchOverlayVisible(visible),
    setWebviewModalOverlayVisible: (sourceId: string, visible: boolean) =>
      mainWindowLifecycle.setWebviewModalOverlayVisible(sourceId, visible),
    createAppTray,
    buildApplicationMenu,
    refreshTrayContextMenu: () => appTrayController.refreshContextMenu(),
    isNativeDialogOpen: () => nativeDialogController.isOpen(),
    prepareQuitUi,
    confirmAndRequestAppQuit: () => quitConfirmationController.confirmAndRequestAppQuit(),
    getLogViewerWindow: () => options.logsRuntime.getLogViewerWindow()
  };
}

export type AppShellRuntime = ReturnType<typeof createAppShellRuntime>;
