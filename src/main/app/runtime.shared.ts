import { issueAgentAccessToken } from "../modules/identity";
import {
  type ServicesFacade
} from "../modules/services";
import {
  type WebsFacade
} from "../modules/webs";
import { type AppShellRuntime } from "../modules/shell";
import { createServicesRuntime } from "../modules/services";
import type {
  DesktopAppInfo
} from "../../shared/contracts";
import { EnterpriseChatRuntime } from "../modules/enterprise-chat";
import { createLogsRuntime } from "../support/logging/runtime";
import {
  bundledEnvZipExists,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  type EnvRootConflictDecision
} from "../infrastructure/filesystem/runtime-environment";
import { createStartupEnvironmentRuntime } from "./bootstrap/startup-environment";
import { type DesktopPetRuntime } from "../modules/pet";
import { createStartupRestoreController } from "./lifecycle/startup-restore";
import {
  getFocusedWebviewDevToolsShortcut
} from "../infrastructure/electron/platform-adapter";
import { configureSystemIdentity } from "./system-identity";
import {
  createDesktopSsoController,
  type DesktopSsoRestoreResult
} from "../modules/identity";
import { createCdpIntegration } from "../modules/web-surfaces";
import { createWebSurfaceRuntime } from "../modules/webs";
import { createWebviewContextMenuController } from "../modules/web-surfaces";
import { createSettingsRuntime } from "../modules/settings";
import { createMainAppState } from "./state";
import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../infrastructure/electron/bundle-paths";
import { type AssistantBridgeRuntime } from "../modules/assistant";
import { createAssistantRunWakeLock } from "../modules/assistant";
import { createFirstInstallBootstrapNavigation } from "../modules/assistant";
import {
  RealtimeBroker
} from "../modules/agent-platform";
import { createPluginClipboardBridge } from "../modules/plugins";
import { type PluginBridgeRuntime } from "../modules/plugins";
import {
  createInstallerShutdownArgs,
  requestMainSingleInstanceLock,
} from "./lifecycle/single-instance";
import { createStartupPipeline } from "./lifecycle/startup";
import { createShutdownCleanupRunner } from "./lifecycle/shutdown";
import {
  parseInstallerShutdownRequest
} from "./lifecycle/shutdown-ack";
import {
  type ResourceDirectoryWatcher
} from "./resource-directory-watcher";
import {
  createAssistantIntegrationPorts
} from "../modules/assistant";





export interface CreateMainProcessRuntimeContext {
  startupPlatform: NodeJS.Platform;
  isFirstDesktopInstall: boolean;
  runtimeRootAtProcessStart: ReturnType<typeof resolveRuntimeRoot>;
  runtimeRootExistedAtStartup: ReturnType<typeof runtimeRootExists>;
  runtimeEnvExistedAtStartup: ReturnType<typeof runtimeEnvExists>;
  firstInstallBootstrapNavigation: ReturnType<typeof createFirstInstallBootstrapNavigation>;
  assistantIntegrationPorts: ReturnType<typeof createAssistantIntegrationPorts>;
  issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  servicesFacade: ServicesFacade;
  websFacade: WebsFacade;
  appState: ReturnType<typeof createMainAppState>;
  ASSISTANT_TARGET_PATH: string;
  LOG_VIEWER_ROUTE: string;
  AGENT_REALTIME_INSPECTOR_ROUTE: string;
  DESKTOP_ACTION_WORKBENCH_ROUTE: string;
  MAIN_PROCESS_DIR: ReturnType<typeof resolveElectronBundleRootFromRuntimeDir>;
  MAIN_PRELOAD_PATH: ReturnType<typeof getMainPreloadPath>;
  FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT: ReturnType<typeof getFocusedWebviewDevToolsShortcut>;
  INSTALLER_SHUTDOWN_ARGS: ReturnType<typeof createInstallerShutdownArgs>;
  ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS: string;
  assistantRunWakeLock: ReturnType<typeof createAssistantRunWakeLock>;
  realtimeBroker: InstanceType<typeof RealtimeBroker>;
  pluginClipboardBridge: ReturnType<typeof createPluginClipboardBridge>;
  petRuntime: DesktopPetRuntime;
  assistantBridgeRuntime: AssistantBridgeRuntime;
  pluginBridgeRuntime: PluginBridgeRuntime;
  appShellRuntime: AppShellRuntime;
  getMainWindow: (...args: any[]) => any;
  resourceDirectoryWatcher: ResourceDirectoryWatcher | null;
  startupRestoreController: ReturnType<typeof createStartupRestoreController>;
  servicesRuntime: ReturnType<typeof createServicesRuntime>;
  webSurfaceRuntime: ReturnType<typeof createWebSurfaceRuntime>;
  webviewContextMenuController: ReturnType<typeof createWebviewContextMenuController>;
  refreshDesktopSsoIdentityToken: (...args: any[]) => any;
  enterpriseChatRuntime: InstanceType<typeof EnterpriseChatRuntime>;
  cdpIntegration: ReturnType<typeof createCdpIntegration>;
  systemIdentityRuntime: ReturnType<typeof configureSystemIdentity>;
  desktopAppInfo: DesktopAppInfo;
  bundledEnvZipExistsAtStartup: ReturnType<typeof bundledEnvZipExists>;
  bundledSeedRefreshNeededAtStartup: boolean;
  requireEnvZipImportAtStartup: boolean;
  envZipConflictNeedsDecision: ReturnType<typeof shouldPromptEnvRootConflict>;
  oldRootDecisionRef: { current: EnvRootConflictDecision | undefined };
  startupEnvImportFailureMessage: string | null;
  nonCoreDesktopRuntimeStarted: boolean;
  ssoCredentialDependentRuntimesStarted: boolean;
  desktopSsoRestoreState: DesktopSsoRestoreResult["state"];
  focusedWebviewDevToolsShortcutRegistered: boolean;
  setStartupPhase: (...args: any[]) => any;
  initializeUserDataRootsAndSettings: (...args: any[]) => any;
  gotSingleInstanceLock: ReturnType<typeof requestMainSingleInstanceLock>;
  startupInstallerShutdownRequest: ReturnType<typeof parseInstallerShutdownRequest>;
  delay: (...args: any[]) => any;
  logsRuntime: ReturnType<typeof createLogsRuntime>;
  startupEnvironmentRuntime: ReturnType<typeof createStartupEnvironmentRuntime>;
  desktopSsoController: ReturnType<typeof createDesktopSsoController>;
  settingsRuntime: ReturnType<typeof createSettingsRuntime>;
  startupPipeline: ReturnType<typeof createStartupPipeline>;
  runShutdownCleanup: ReturnType<typeof createShutdownCleanupRunner>;
  handleDesktopSsoWebviewNavigation: (...args: any[]) => any;
  clearDesktopPetIdleResetTimer: (...args: any[]) => any;
  refreshDesktopPetState: (...args: any[]) => any;
  hideDesktopPetWindow: (...args: any[]) => any;
  showAssistantTargetWindow: (...args: any[]) => any;
  showDesktopPetWindow: (...args: any[]) => any;
  restoreDesktopPetWindowLayering: (...args: any[]) => any;
  openLogViewerWindow: (...args: any[]) => any;
  openAgentPlatformMonitorWindow: (...args: any[]) => any;
  openDesktopActionWorkbenchWindow: (...args: any[]) => any;
  openAgentRealtimeInspectorWindow: (...args: any[]) => any;
  closeDesktopActionWorkbenchWindow: (...args: any[]) => any;
  closeLogViewerWindow: (...args: any[]) => any;
  getServiceWebviewPreloadPath: (...args: any[]) => any;
  getServiceWebviewPreloadUrl: (...args: any[]) => any;
  minimizeLogViewerWindow: (...args: any[]) => any;
  maximizeLogViewerWindow: (...args: any[]) => any;
  captureAssistantScreenshot: (...args: any[]) => any;
  captureDesktopScreenshotForWebview: (...args: any[]) => any;
  captureEnterpriseChatScreenshot: (...args: any[]) => any;
  refreshPluginDesktopGlobalShortcuts: (...args: any[]) => any;
  registerFocusedWebviewDevToolsShortcut: (...args: any[]) => any;
  collectWebviewLoadDiagnostics: (...args: any[]) => any;
  reportRendererDiagnostic: (...args: any[]) => any;
  createWindow: (...args: any[]) => any;
  configureAppMediaPermissions: (...args: any[]) => any;
  showMainWindow: (...args: any[]) => any;
  notifyServicesChanged: (...args: any[]) => any;
  notifyCoreServicesChanged: (...args: any[]) => any;
  notifyDesktopDecorationsChanged: (...args: any[]) => any;
  emitWebsChanged: (...args: any[]) => any;
  startResourceDirectoryWatcher: (...args: any[]) => any;
  stopResourceDirectoryWatcher: (...args: any[]) => any;
  emitKanbanChanged: (...args: any[]) => any;
  emitAssistantNavigationAgentsChanged: (...args: any[]) => any;
  emitAssistantNavigationPushEvent: (...args: any[]) => any;
  navigateMainWindow: (...args: any[]) => any;
  openAssistantWorker: (...args: any[]) => any;
  createAppTray: (...args: any[]) => any;
  runNonCoreStartupTask: (...args: any[]) => any;
  startSsoCredentialDependentRuntimes: (...args: any[]) => any;
  applyDesktopSsoRestoreResult: (...args: any[]) => any;
  startNonCoreDesktopRuntime: (...args: any[]) => any;
  showFileDialog: (...args: any[]) => any;
  showSaveDialog: (...args: any[]) => any;
  showMessageBox: (...args: any[]) => any;
  emitAssistantAttachmentProgress: (...args: any[]) => any;
  buildApplicationMenu: (...args: any[]) => any;
  showArchiveDialog: (...args: any[]) => any;
  handleAppReady: (...args: any[]) => any;
  start: (...args: any[]) => any;
  prepareQuitUi: (...args: any[]) => any;
  beginAppQuitWithoutConfirmation: (...args: any[]) => any;
  beginInstallerShutdown: (...args: any[]) => any;
  writeInstallerShutdownAck: (...args: any[]) => any;
  writeInstallerShutdownAcks: (...args: any[]) => any;
  requestAppQuit: (...args: any[]) => any;
}
