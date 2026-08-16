import type { App, GlobalShortcut } from "electron";
import type { MainAppState } from "../app-state";
import { hasInstallerShutdownArg } from "../lifecycle/single-instance";
import type { ShutdownReport } from "../../shared/shutdown";
import { findDesktopOpenDeepLink, isDesktopOpenDeepLink } from "./deep-link";

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
  showMainWindow: (targetPath?: string) => void;
  beginAppQuitWithoutConfirmation: () => void;
  beginInstallerShutdown: (commandLine: string[]) => void;
  isNativeDialogOpen: () => boolean;
  emitPluginBeforeQuit: () => void;
  beginRealtimeShutdown: () => void;
  prepareQuitUi: () => void;
  runShutdownCleanup: () => Promise<ShutdownReport>;
  writeInstallerShutdownAcks: (report: ShutdownReport) => void;
  releaseAssistantRunWakeLock: () => void;
  clearDesktopPetIdleResetTimer: () => void;
  stopAssistantBridgeRuntime: () => void;
  stopTunnelHubRuntime: () => unknown;
  stopAgentPlatformPetStatusClient: () => void;
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
  let pendingDesktopOpen = Boolean(findDesktopOpenDeepLink(options.initialCommandLine));

  const openDesktopHome = () => {
    if (!readyCompleted) {
      pendingDesktopOpen = true;
      return;
    }
    options.showMainWindow("/");
  };

  if (options.platform === "darwin") {
    options.app.on("open-url", (event, url) => {
      if (!isDesktopOpenDeepLink(url)) {
        return;
      }
      event.preventDefault();
      openDesktopHome();
    });
  }

  options.app.on("second-instance", (_event, commandLine) => {
    if (hasInstallerShutdownArg(commandLine, options.installerShutdownArgs)) {
      options.beginInstallerShutdown(commandLine);
      return;
    }
    if (options.platform === "win32" && findDesktopOpenDeepLink(commandLine)) {
      openDesktopHome();
      return;
    }
    options.showMainWindow();
  });

  void options.app.whenReady().then(async () => {
    await options.onReady();
    readyCompleted = true;
    if (pendingDesktopOpen) {
      pendingDesktopOpen = false;
      options.showMainWindow("/");
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
    }).finally(() => {
      options.beginAppQuitWithoutConfirmation();
    });
  });

  options.app.on("will-quit", () => {
    options.releaseAssistantRunWakeLock();
    options.clearDesktopPetIdleResetTimer();
    options.stopAssistantBridgeRuntime();
    void options.stopTunnelHubRuntime();
    options.stopAgentPlatformPetStatusClient();
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
