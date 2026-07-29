import type { App, GlobalShortcut } from "electron";
import type { MainAppState } from "../app-state";
import { hasInstallerShutdownArg } from "../lifecycle/single-instance";
import type { ShutdownReport } from "../../shared/shutdown";

export type MainAppEventsOptions = {
  app: App;
  platform: NodeJS.Platform;
  state: MainAppState;
  gotSingleInstanceLock: boolean;
  installerShutdownArgs: ReadonlySet<string>;
  globalShortcut: Pick<GlobalShortcut, "unregister">;
  focusedWebviewDevToolsShortcut: string;
  onReady: () => Promise<void> | void;
  showMainWindow: () => void;
  beginAppQuitWithoutConfirmation: () => void;
  beginInstallerShutdown: (commandLine: string[]) => void;
  isNativeDialogOpen: () => boolean;
  emitPluginBeforeQuit: () => void;
  prepareQuitUi: () => void;
  runShutdownCleanup: () => Promise<ShutdownReport>;
  writeInstallerShutdownAcks: (report: ShutdownReport) => void;
  releaseAssistantRunWakeLock: () => void;
  clearDesktopPetIdleResetTimer: () => void;
  stopAssistantBridgeRuntime: () => void;
  stopTunnelHubRuntime: () => unknown;
  stopAgentPlatformPetStatusClient: () => void;
  unregisterPluginGlobalShortcuts: () => void;
  stopResourceDirectoryWatcher: () => void;
  stopPluginBridgeRuntime: () => void;
  stopEnterpriseChatRuntime: () => void;
};

export function registerMainAppEvents(options: MainAppEventsOptions) {
  if (!options.gotSingleInstanceLock) {
    return;
  }

  options.app.on("second-instance", (_event, commandLine) => {
    if (hasInstallerShutdownArg(commandLine, options.installerShutdownArgs)) {
      options.beginInstallerShutdown(commandLine);
      return;
    }
    options.showMainWindow();
  });

  void options.app.whenReady().then(async () => {
    await options.onReady();
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
