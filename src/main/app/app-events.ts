import type { App, GlobalShortcut } from "electron";
import type { MainAppState } from "./state";
import { hasInstallerShutdownArg } from "./lifecycle/single-instance";
import type { ShutdownReport } from "../../shared/shutdown";
import { findDesktopOpenDeepLink, isDesktopOpenDeepLink } from "./deep-link";
import { findDesktopDocumentPaths, isSupportedDesktopDocumentPath } from "./open-file";

export type MainAppEventsOptions = {
  app: App;
  platform: NodeJS.Platform;
  state: MainAppState;
  gotSingleInstanceLock: boolean;
  installerShutdownArgs: ReadonlySet<string>;
  globalShortcut: Pick<GlobalShortcut, "unregister">;
  focusedWebviewDevToolsShortcut: string;
  onReady: () => Promise<void> | void;
  initialCommandLine: readonly string[];
  initialWorkingDirectory?: string;
  showMainWindow: (targetPath?: string) => void;
  openLocalDocument: (filePath: string) => Promise<void> | void;
  beginAppQuitWithoutConfirmation: () => void;
  beginInstallerShutdown: (commandLine: string[]) => void;
  isNativeDialogOpen: () => boolean;
  emitPluginBeforeQuit: () => void;
  beginRealtimeShutdown: () => void;
  prepareQuitUi: () => void;
  runShutdownCleanup: () => Promise<ShutdownReport>;
  flushDesktopLogs: (timeoutMs?: number) => Promise<void>;
  writeInstallerShutdownAcks: (report: ShutdownReport) => void;
  releaseAssistantRunWakeLock: () => void;
  clearDesktopPetIdleResetTimer: () => void;
  stopAssistantBridgeRuntime: () => void;
  stopTunnelHubRuntime: () => unknown;
  disposeRealtimeBroker: () => void;
  unregisterPluginGlobalShortcuts: () => void;
  stopResourceDirectoryWatcher: () => void;
  stopPluginBridgeRuntime: () => void;
  stopEnterpriseChatRuntime: () => void;
};

export function registerMainAppEvents(options: MainAppEventsOptions) {
  if (!options.gotSingleInstanceLock) {
    return;
  }

  let readyCompleted = false;
  const initialInstallerShutdown = options.initialCommandLine.some((argument) => options.installerShutdownArgs.has(argument));
  const initialWorkingDirectory = options.initialWorkingDirectory ?? process.cwd();
  let pendingDesktopOpen = !initialInstallerShutdown && Boolean(findDesktopOpenDeepLink(options.initialCommandLine));
  let pendingMainWindowOpen = false;
  const pendingLocalDocuments = initialInstallerShutdown
    ? []
    : findDesktopDocumentPaths(options.initialCommandLine, options.platform, initialWorkingDirectory);

  const dispatchLocalDocument = (filePath: string) => {
    // Isolate each file's failure so a failed or slow preview cannot discard the
    // remaining files from the same Finder/Explorer selection.
    void (async () => {
      try {
        await options.openLocalDocument(filePath);
      } catch (error) {
        console.error("[main] local document open failed", error);
      }
    })();
  };

  const openLocalDocuments = (filePaths: readonly string[]) => {
    if (!readyCompleted) {
      pendingLocalDocuments.push(...filePaths);
      return;
    }
    for (const filePath of filePaths) {
      dispatchLocalDocument(filePath);
    }
  };

  const openDesktopHome = () => {
    if (!readyCompleted) {
      pendingDesktopOpen = true;
      return;
    }
    options.showMainWindow("/");
  };

  if (options.platform === "darwin") {
    options.app.on("open-file", (event, filePath) => {
      if (!isSupportedDesktopDocumentPath(filePath)) {
        return;
      }
      event.preventDefault();
      openLocalDocuments([filePath]);
    });
    options.app.on("open-url", (event, url) => {
      if (!isDesktopOpenDeepLink(url)) {
        return;
      }
      event.preventDefault();
      openDesktopHome();
    });
  }

  options.app.on("second-instance", (_event, commandLine, workingDirectory) => {
    if (hasInstallerShutdownArg(commandLine, options.installerShutdownArgs)) {
      options.beginInstallerShutdown(commandLine);
      return;
    }
    if (options.platform === "win32") {
      const desktopOpen = Boolean(findDesktopOpenDeepLink(commandLine));
      const documentPaths = findDesktopDocumentPaths(commandLine, options.platform, workingDirectory || initialWorkingDirectory);
      if (desktopOpen) {
        openDesktopHome();
      }
      openLocalDocuments(documentPaths);
      if (desktopOpen || documentPaths.length > 0) {
        return;
      }
    }
    if (!readyCompleted) {
      pendingMainWindowOpen = true;
      return;
    }
    options.showMainWindow();
  });

  void options.app.whenReady().then(async () => {
    await options.onReady();
    readyCompleted = true;
    if (pendingDesktopOpen) {
      pendingDesktopOpen = false;
      pendingMainWindowOpen = false;
      options.showMainWindow("/");
    } else if (pendingMainWindowOpen) {
      pendingMainWindowOpen = false;
      options.showMainWindow();
    }
    for (const filePath of pendingLocalDocuments.splice(0)) {
      dispatchLocalDocument(filePath);
    }
    options.app.on("activate", () => {
      if (options.isNativeDialogOpen()) {
        return;
      }
      options.showMainWindow();
    });
  });

  options.app.on("before-quit", (event) => {
    if (options.state.shutdownCleanupComplete) {
      return;
    }
    event.preventDefault();
    options.state.isHandlingQuit = true;
    options.beginRealtimeShutdown();
    options.emitPluginBeforeQuit();
    options.prepareQuitUi();
    void options.runShutdownCleanup().then(async (report) => {
      options.writeInstallerShutdownAcks(report);
      if (report.mode === "user") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 160);
        });
      }
    }).catch((error) => {
      console.error("[main] shutdown cleanup failed before report generation", error);
    }).then(() => {
      return options.flushDesktopLogs(500);
    }).catch(() => {
      // Log flushing is best-effort and must not trap the app in before-quit.
    }).finally(() => {
      options.beginAppQuitWithoutConfirmation();
    });
  });

  options.app.on("will-quit", () => {
    options.releaseAssistantRunWakeLock();
    options.clearDesktopPetIdleResetTimer();
    options.stopAssistantBridgeRuntime();
    void options.stopTunnelHubRuntime();
    options.disposeRealtimeBroker();
    options.unregisterPluginGlobalShortcuts();
    options.globalShortcut.unregister(options.focusedWebviewDevToolsShortcut);
    options.stopResourceDirectoryWatcher();
    options.stopPluginBridgeRuntime();
    options.stopEnterpriseChatRuntime();
  });

  options.app.on("window-all-closed", () => {
    if (options.platform !== "darwin" && options.state.isHandlingQuit) {
      options.app.quit();
    }
  });
}
