import fs from "node:fs";

import {
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  session,
  systemPreferences,
  webContents,
} from "electron";

import { issueAgentAccessToken } from "../modules/identity";

import {
  completeDesktopSsoCookieLogin,
  desktopSsoAccessTokenNeedsRefresh,
  finalizeDesktopSsoLoginAttempt,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
} from "../modules/identity";

import { loadBuiltinServices } from "../modules/services";

import {
  type ServicesFacade,
  getResponsiveServiceState,
  getServiceState,
  listServices,
  readServiceLog,
  runStartupPreparation,
} from "../modules/services";

import {
  type WebsFacade,
  createDesktopMobileWebappCatalog,
  readDesktopMobileWebappItem,
  restorePublishedWebapps
} from "../modules/webs";

import { webappManager } from "../modules/webs";

import { webappWindowManager } from "../modules/webs";

import { loadInstalledPlugins } from "../modules/plugins";

import {
  configurePluginResources,
  emitPluginBridgeHook,
  getPluginBridgeEnv,
  getPluginSettingsEnv,
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  retryPendingPluginResourceSync,
  stopPluginResources,
  syncPluginResources
} from "../modules/plugins";

import { revealPathInFileManager } from "../modules/shell";

import { createAppShellRuntime, type AppShellRuntime } from "../modules/shell";

import { readDesktopProfileFromRoot } from "../infrastructure/filesystem/profile-store";

import { createServicesRuntime } from "../modules/services";

import type {
  AssistantAttachmentTaskProgress,
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  AssistantWorkerOpenRequest,
  DesktopAppInfo,
  EnterpriseChatScreenshotMode,
  ServiceOpenLogViewerRequest,
  WebsChangedEvent,
} from "../../shared/contracts";

import {
  APP_ID,
  INSTALLER_SHUTDOWN_ARG,
  PRODUCT_NAME,
  STORAGE_NAMESPACE,
} from "../../shared/brand";

import {
  desktopDataRootExists,
  ensureDataRoot,
  getDataRoot,
  getDesktopConfigRoot,
  getElectronUserDataRoot,
} from "../infrastructure/filesystem/user-paths";

import { EnterpriseChatRuntime } from "../modules/enterprise-chat";

import { redactEnterpriseChatSupportText } from "../modules/enterprise-chat";

import { readEnterpriseImSettings } from "../modules/enterprise-chat";

import { createLogsRuntime } from "../support/logging/runtime";

import { isDesktopDevelopmentRuntime } from "../infrastructure/electron/development-runtime";

import { setDeprecatedCompatibilityDesktopVersion } from "../support/logging/deprecated-compatibility";

import {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade
} from "./bootstrap/desktop-init";

import {
  bundledEnvZipExists,
  configureRuntimeEnvironmentTranslator,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeEnvNeedsBundledSeedRefresh,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  shouldRequireEnvZipImport,
  type EnvRootConflictDecision,
} from "../infrastructure/filesystem/runtime-environment";

import { createStartupEnvironmentRuntime } from "./bootstrap/startup-environment";

import { safeConsoleError } from "../support/logging/safe-console";

import {
  callAgentPlatform,
  handleAgentPlatformDesktopActionRequest,
  handleDesktopActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge
} from "../modules/desktop-actions";

import {
  callDesktopActionConfirmation,
  callDesktopActionRenderer,
  createDesktopActionOptions
} from "../modules/desktop-actions";

import {
  emitDesktopWsPush,
  getDesktopWsServerRuntimeState,
  startDesktopWsServer,
  stopDesktopWsServer
} from "../modules/desktop-protocol";

import {
  configureTunnelHubRegistrationController,
  configureTunnelHubRuntime,
  startTunnelHubRuntimeIfEnabled,
  stopTunnelHubRuntime,
} from "../modules/tunnel";

import {
  AGENT_WEBCLIENT_TARGET_PATH,
  createAgentWebclientRoute
} from "../../shared/agent-webclient-routes";

import {
  registerDesktopPetAssetProtocol,
  registerDesktopPetAssetProtocolScheme,
} from "../modules/pet";

import {
  registerWebsiteFaviconProtocol,
  registerWebsiteFaviconProtocolScheme,
} from "../modules/webs";

import {
  registerDesktopSsoAvatarProtocol,
  registerDesktopSsoAvatarProtocolScheme,
} from "../modules/identity";

import { registerChatWorkPanelLocalFileProtocolScheme } from "../modules/work-panel";

import { isDesktopPetSupportedPlatform } from "../modules/pet";

import { createDesktopPetRuntime, type DesktopPetRuntime } from "../modules/pet";

import { registerMainIpcHandlers } from "./module-registry";

import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge
} from "../modules/assistant";

import { initializeMainI18n, setMainLocale, t } from "../support/i18n/main-i18n";

import { createStartupRestoreController } from "./lifecycle/startup-restore";

import {
  getFocusedWebviewDevToolsShortcut,
  isDevToolsShortcut,
  isGlobalSearchShortcut,
  isWorkPanelCloseShortcut,
  resolveGlobalSearchCommandShortcut,
} from "../infrastructure/electron/platform-adapter";

import { MAIN_CHAT_SURFACE_ID } from "../../shared/surface-identity";

import { configureSystemIdentity } from "./system-identity";

import { openCurrentWebviewDevTools } from "../modules/web-surfaces";

import {
  createDesktopSsoController,
  type DesktopSsoRestoreResult
} from "../modules/identity";

import { createCdpIntegration } from "../modules/web-surfaces";

import { createWebSurfaceRuntime } from "../modules/webs";

import { createWebviewContextMenuController } from "../modules/web-surfaces";

import { createSettingsRuntime } from "../modules/settings";

import { readHelpSettings } from "../modules/settings";

import { createMainAppState } from "./state";

import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../infrastructure/electron/bundle-paths";

import { loadRendererRoute } from "../infrastructure/electron/renderer-route";

import { parseSafeLoopbackWebUrl } from "../infrastructure/network/loopback-url";

import {
  refreshPluginGlobalShortcuts,
  unregisterPluginGlobalShortcuts,
} from "../modules/plugins";

import { invokePluginDesktopAction } from "../modules/plugins";

import { cleanupProgramDataForVersion } from "./lifecycle/program-data-cleanup";

import { createAssistantBridgeRuntime, type AssistantBridgeRuntime } from "../modules/assistant";

import { createAssistantRunWakeLock } from "../modules/assistant";

import { createFirstInstallBootstrapNavigation } from "../modules/assistant";

import {
  ensureProviderRegisterApiKey,
  RealtimeBroker
} from "../modules/agent-platform";

import { createPluginClipboardBridge } from "../modules/plugins";

import { createPluginBridgeRuntime, type PluginBridgeRuntime } from "../modules/plugins";

import {
  createInstallerShutdownArgs,
  requestMainSingleInstanceLock,
} from "./lifecycle/single-instance";

import { createStartupPipeline } from "./lifecycle/startup";

import {
  isStartupPhaseAtLeast,
  type StartupPhase,
} from "./lifecycle/startup-phases";

import { createShutdownCleanupRunner } from "./lifecycle/shutdown";

import {
  createNoPrimaryShutdownReport,
  parseInstallerShutdownRequest,
  writeShutdownAck
} from "./lifecycle/shutdown-ack";

import { registerMainAppEvents } from "./app-events";

import { registerDesktopOpenProtocolClient } from "./deep-link";

import {
  createResourceDirectoryWatcher,
  type ResourceDirectoryWatcher
} from "./resource-directory-watcher";

import { recoverWebappInstallTransactions } from "../modules/webs";

import { configureMarketAccessTokenIssuer, refreshMarketCatalog } from "../modules/marketplace";

import { configureAgentMarketPlatformCaller } from "../modules/marketplace";

import { configureSkillMarketPlatformCaller } from "../modules/marketplace";

import {
  getDesktopDeviceId,
  getDesktopDeviceInfo
} from "../modules/identity";


import { resolveConversationAssetOrigin } from "../modules/conversation-share";

import {
  installWebsiteAppArchiveFromPath,
  readInstalledRecords,
  removeInstalledRecordByResourceKey
} from "../modules/marketplace";

import {
  deriveTunnelHubRegistrationApiOrigin,
  getTunnelHubRuntimeStatus,
  readTunnelHubRegistrationBearerToken,
  readTunnelHubSettings,
  saveTunnelHubSettings,
  startTunnelHubRuntime
} from "../modules/tunnel";

import {
  getConfiguredDesktopActionBridgePort
} from "../modules/desktop-actions";

import {
  ContainerHubClient,
  createAssistantIntegrationPorts,
  getAssistantSettings,
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform,
  readAssistantSettings,
  resolveAssistantAttachmentPath,
  resolveAssistantChatStoragePaths,
  toPublicAssistantSettings
} from "../modules/assistant";

import { toDesktopPetAgentOptions } from "../modules/pet";

import { createKanbanRuntime } from "../modules/kanban";

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
