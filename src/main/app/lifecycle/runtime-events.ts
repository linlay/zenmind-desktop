import {
  app,
  globalShortcut
} from "electron";
import type { ShutdownReport } from "../../../shared/shutdown";
import {
  getFocusedWebviewDevToolsShortcut
} from "../../infrastructure/electron/platform-adapter";
import {
  RealtimeBroker
} from "../../modules/agent-platform";
import { createAssistantRunWakeLock, type AssistantBridgeRuntime } from "../../modules/assistant";
import { EnterpriseChatRuntime } from "../../modules/enterprise-chat";
import { type DesktopPetRuntime } from "../../modules/pet";
import { unregisterPluginGlobalShortcuts, type PluginBridgeRuntime } from "../../modules/plugins";
import { type AppShellRuntime } from "../../modules/shell";
import {
  stopTunnelHubRuntime
} from "../../modules/tunnel";
import { createLogsRuntime } from "../../support/logging/runtime";
import { registerMainAppEvents } from "../app-events";
import { registerDesktopOpenProtocolClient } from "../deep-link";
import { createShutdownCleanupRunner } from "../lifecycle/shutdown";
import {
  createInstallerShutdownArgs,
  requestMainSingleInstanceLock,
} from "../lifecycle/single-instance";
import { createMainAppState } from "../state";
export interface StartRuntimeEventsDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly appState: ReturnType<typeof createMainAppState>;
  readonly gotSingleInstanceLock: ReturnType<typeof requestMainSingleInstanceLock>;
  readonly INSTALLER_SHUTDOWN_ARGS: ReturnType<typeof createInstallerShutdownArgs>;
  readonly FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT: ReturnType<typeof getFocusedWebviewDevToolsShortcut>;
  readonly handleAppReady: () => Promise<void>;
  readonly showMainWindow: AppShellRuntime["showMainWindow"];
  readonly beginAppQuitWithoutConfirmation: () => void;
  readonly beginInstallerShutdown: (commandLine: string[]) => void;
  readonly appShellRuntime: Pick<AppShellRuntime, "isNativeDialogOpen">;
  readonly pluginBridgeRuntime: Pick<PluginBridgeRuntime, "emitBeforeQuit" | "stop">;
  readonly prepareQuitUi: AppShellRuntime["prepareQuitUi"];
  readonly realtimeBroker: Pick<InstanceType<typeof RealtimeBroker>, "beginShutdown" | "dispose">;
  readonly runShutdownCleanup: ReturnType<typeof createShutdownCleanupRunner>;
  readonly logsRuntime: Pick<ReturnType<typeof createLogsRuntime>, "flush">;
  readonly writeInstallerShutdownAcks: (report: ShutdownReport) => void;
  readonly assistantRunWakeLock: Pick<ReturnType<typeof createAssistantRunWakeLock>, "release">;
  readonly clearDesktopPetIdleResetTimer: DesktopPetRuntime["clearIdleResetTimer"];
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "stop">;
  readonly stopResourceDirectoryWatcher: () => void;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "stop">;
}

export function startRuntimeEvents(dependencies: StartRuntimeEventsDependencies) {
  registerDesktopOpenProtocolClient(app, dependencies.startupPlatform, {
    isDefaultApp: Boolean((process as NodeJS.Process & {
      defaultApp?: boolean;
    }).defaultApp),
    execPath: process.execPath,
    appEntryPath: process.argv[1]
  });
  registerMainAppEvents({
    app,
    platform: dependencies.startupPlatform,
    state: dependencies.appState,
    gotSingleInstanceLock: dependencies.gotSingleInstanceLock,
    installerShutdownArgs: dependencies.INSTALLER_SHUTDOWN_ARGS,
    globalShortcut,
    focusedWebviewDevToolsShortcut: dependencies.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT,
    initialCommandLine: process.argv,
    onReady: dependencies.handleAppReady,
    showMainWindow: dependencies.showMainWindow,
    beginAppQuitWithoutConfirmation: dependencies.beginAppQuitWithoutConfirmation,
    beginInstallerShutdown: dependencies.beginInstallerShutdown,
    isNativeDialogOpen: () => dependencies.appShellRuntime.isNativeDialogOpen(),
    emitPluginBeforeQuit: () => dependencies.pluginBridgeRuntime.emitBeforeQuit(),
    prepareQuitUi: dependencies.prepareQuitUi,
    beginRealtimeShutdown: () => dependencies.realtimeBroker.beginShutdown(),
    runShutdownCleanup: dependencies.runShutdownCleanup,
    flushDesktopLogs: (timeoutMs) => dependencies.logsRuntime.flush(timeoutMs),
    writeInstallerShutdownAcks: dependencies.writeInstallerShutdownAcks,
    releaseAssistantRunWakeLock: () => dependencies.assistantRunWakeLock.release(),
    clearDesktopPetIdleResetTimer: dependencies.clearDesktopPetIdleResetTimer,
    stopAssistantBridgeRuntime: () => dependencies.assistantBridgeRuntime.stop(),
    stopTunnelHubRuntime,
    disposeRealtimeBroker: () => dependencies.realtimeBroker.dispose(),
    unregisterPluginGlobalShortcuts: () => unregisterPluginGlobalShortcuts(globalShortcut),
    stopResourceDirectoryWatcher: dependencies.stopResourceDirectoryWatcher,
    stopPluginBridgeRuntime: () => dependencies.pluginBridgeRuntime.stop(),
    stopEnterpriseChatRuntime: () => dependencies.enterpriseChatRuntime.stop()
  });
}

