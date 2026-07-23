import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  type App,
  type NativeTheme,
  type Session,
  type Shell,
  type SystemPreferences
} from "electron";
import type { AssistantWorkerOpenRequest } from "../../shared/contracts";
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
import { createQuitConfirmationController } from "./quit-confirmation";
import { NativeDialogVisibilityController } from "./native-dialogs";
import { AppTrayController } from "./tray";

export type AppShellRuntimeOptions = {
  app: App;
  state: MainAppState;
  platform: NodeJS.Platform;
  mainProcessDir: string;
  productName: string;
  resourcesPath: string;
  session: { defaultSession: Session };
  shell: Pick<Shell, "openExternal">;
  nativeTheme: Pick<NativeTheme, "shouldUseDarkColors" | "on">;
  systemPreferences: Pick<SystemPreferences, "askForMediaAccess">;
  t: (...args: any[]) => string;
  quickCopilotWindowController: any;
  logsRuntime: LogsRuntime;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  parseSafeLoopbackWebUrl: (value: string) => unknown;
  isDevToolsShortcut: (platform: NodeJS.Platform, input: any) => boolean;
  isGlobalSearchShortcut: (platform: NodeJS.Platform, input: any) => boolean;
  isMediaPermissionAllowed: (input: {
    permission: string;
    contentsId: number;
    mainContentsId?: number | null;
    quickContentsId?: number | null;
    mediaTypes?: string[];
  }) => boolean;
  handleDesktopSsoWebviewNavigation: (url: string) => Promise<void> | void;
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
  hideDesktopPetWindow: (disable?: boolean) => unknown;
  restoreDesktopPetWindowLayering: () => void;
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
  const nativeDialogController = new NativeDialogVisibilityController({
    platform: options.platform,
    getTargetWindows: () => [options.state.mainWindow, options.quickCopilotWindowController.getWindow()],
    hideQuickCopilot: () => options.quickCopilotWindowController.hideForNativeDialog(),
    restoreQuickCopilot: () => options.quickCopilotWindowController.restoreAfterNativeDialog()
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
    hideDesktopPet: () => options.hideDesktopPetWindow(true),
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
    options.state.mainWindow = new BrowserWindow(buildMainWindowOptions({
      platform: options.platform,
      preloadPath: getMainPreloadPath(options.mainProcessDir, options.platform),
      initialLocaleSettings: getMainLocaleSettings(),
      shouldUseDarkColors: options.nativeTheme.shouldUseDarkColors
    }));
    const targetWindow = options.state.mainWindow;

    mainWindowLifecycle.applyAppearance(targetWindow);
    mainWindowLifecycle.attachRendererDiagnostics(targetWindow);

    configureMainWindowWebContents(targetWindow, {
      platform: options.platform,
      getMainWindow: () => options.state.mainWindow,
      servicePreloadPath: getServiceWebviewPreloadPath(),
      servicePreloadUrl: getServiceWebviewPreloadUrl(),
      isSafeServiceUrl: options.parseSafeLoopbackWebUrl,
      isDevToolsShortcut: options.isDevToolsShortcut,
      isGlobalSearchShortcut: options.isGlobalSearchShortcut,
      shouldDownloadUrl: shouldDownloadUrlFromWebview,
      resolveOpenDisposition: resolveWebviewOpenDisposition,
      collectLoadDiagnostics: options.collectWebviewLoadDiagnostics,
      report: options.safeConsoleError,
      onWebviewNavigation: options.handleDesktopSsoWebviewNavigation,
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
      isHandlingQuit: () => options.state.isHandlingQuit,
      clearWindow: (windowToClear) => {
        if (options.state.mainWindow === windowToClear) {
          options.state.mainWindow = null;
        }
      },
      isNativeDialogOpen: () => nativeDialogController.isOpen(),
      hideQuickAssistantAfterOutsideFocus: () => options.quickCopilotWindowController.hideAfterOutsideFocus(),
      restoreFloatingWindowsForFullscreen: () => options.restoreDesktopPetWindowLayering()
    });

    return targetWindow;
  }

  function configureAppMediaPermissions() {
    configureWindowMediaPermissions({
      platform: options.platform,
      permissionSession: options.session.defaultSession,
      getMainWindow: () => options.state.mainWindow,
      getQuickAssistantWindow: () => options.quickCopilotWindowController.getWindow(),
      isMediaPermissionAllowed: options.isMediaPermissionAllowed,
      askForMicrophoneAccess: () => options.systemPreferences.askForMediaAccess("microphone")
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
      requestQuit: options.requestAppQuit,
      quitWithoutConfirmation: options.beginAppQuitWithoutConfirmation
    });
  }

  function prepareQuitUi() {
    prepareQuitUiFromCleanup({
      getAllWindows: () => BrowserWindow.getAllWindows(),
      destroyTray: () => appTrayController.destroy()
    });
  }

  return {
    getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl,
    openAgentPlatformMonitorWindow,
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
