import { app, clipboard, globalShortcut, protocol } from "electron";
import { getDesktopDeviceId, issueAgentAccessToken } from "../modules/identity";
import { getDesktopSsoAccessToken } from "../modules/identity";
import { createWebsFacade, type WebsFacade } from "../modules/webs";
import { type AppShellRuntime } from "../modules/shell";
import { readDesktopProfileFromRoot } from "../infrastructure/filesystem/profile-store";
import { createServicesFacade, createServicesRuntime, type ServicesFacade } from "../modules/services";
import type { AssistantAttachmentTaskProgress, AssistantNavAgentItemsResult, AssistantNavigationPushEvent, AssistantWorkerOpenRequest, EnterpriseChatScreenshotMode, ServiceOpenLogViewerRequest, WebsChangedEvent } from "../../shared/contracts";
import { INSTALLER_SHUTDOWN_ARG, STORAGE_NAMESPACE } from "../../shared/brand";
import { desktopDataRootExists, getDesktopConfigRoot } from "../infrastructure/filesystem/user-paths";
import { setDeprecatedCompatibilityDesktopVersion } from "../support/logging/deprecated-compatibility";
import { bundledEnvZipExists, configureRuntimeEnvironmentTranslator, resolveRuntimeRoot, runtimeEnvExists, runtimeEnvNeedsBundledSeedRefresh, runtimeRootExists, shouldPromptEnvRootConflict, shouldRequireEnvZipImport, type EnvRootConflictDecision } from "../infrastructure/filesystem/runtime-environment";
import { callAgentPlatform } from "../modules/desktop-actions";
import { AGENT_WEBCLIENT_TARGET_PATH } from "../../shared/agent-webclient-routes";
import { registerDesktopPetAssetProtocolScheme } from "../modules/pet";
import { registerWebsiteFaviconProtocolScheme } from "../modules/webs";
import { registerDesktopSsoAvatarProtocolScheme } from "../modules/identity";
import { registerChatWorkPanelLocalFileProtocolScheme } from "../modules/work-panel";
import { type DesktopPetRuntime } from "../modules/pet";
import { t } from "../support/i18n/main-i18n";
import { getFocusedWebviewDevToolsShortcut } from "../infrastructure/electron/platform-adapter";
import { type DesktopSsoRestoreResult } from "../modules/identity";
import { createMainAppState } from "./state";
import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../infrastructure/electron/bundle-paths";
import { type AssistantBridgeRuntime } from "../modules/assistant";
import { createAssistantRunWakeLock } from "../modules/assistant";
import { createFirstInstallBootstrapNavigation } from "../modules/assistant";
import { RealtimeBroker } from "../modules/agent-platform";
import { createPluginClipboardBridge } from "../modules/plugins";
import { type PluginBridgeRuntime } from "../modules/plugins";
import { createInstallerShutdownArgs, requestMainSingleInstanceLock } from "./lifecycle/single-instance";
import { type StartupPhase } from "./lifecycle/startup-phases";
import { createNoPrimaryShutdownReport, parseInstallerShutdownRequest, writeShutdownAck } from "./lifecycle/shutdown-ack";
import { type ResourceDirectoryWatcher } from "./resource-directory-watcher";
import { configureAgentMarketPlatformCaller } from "../modules/marketplace";
import { configureSkillMarketPlatformCaller } from "../modules/marketplace";
import { ContainerHubClient, getAssistantSettings } from "../modules/assistant";
import type { CreateMainProcessRuntimeContext } from "./runtime.shared";
import { createMainProcessRuntime_block14_2, createMainProcessRuntime_block17_3, createMainProcessRuntime_block18_4, createMainProcessRuntime_startupRestoreController_5, createMainProcessRuntime_webSurfaceRuntime_6, createMainProcessRuntime_webviewContextMenuController_7, createMainProcessRuntime_enterpriseChatRuntime_8, createMainProcessRuntime_cdpIntegration_9, createMainProcessRuntime_systemIdentityRuntime_10, createMainProcessRuntime_setStartupPhase_11, createMainProcessRuntime_initializeUserDataRootsAndSettings_12, createMainProcessRuntime_delay_13 } from "./runtime.operations-1";
import { createMainProcessRuntime_logsRuntime_1, createMainProcessRuntime_block68_2, createMainProcessRuntime_startupEnvironmentRuntime_3, createMainProcessRuntime_block71_4, createMainProcessRuntime_block72_5, createMainProcessRuntime_desktopSsoController_6, createMainProcessRuntime_block74_7, createMainProcessRuntime_block75_8, createMainProcessRuntime_settingsRuntime_9, createMainProcessRuntime_block77_10, createMainProcessRuntime_startupPipeline_11 } from "./runtime.operations-2";
import { createMainProcessRuntime_runShutdownCleanup_1, createMainProcessRuntime_handleDesktopSsoWebviewNavigation_2, createMainProcessRuntime_clearDesktopPetIdleResetTimer_3, createMainProcessRuntime_refreshDesktopPetState_4, createMainProcessRuntime_hideDesktopPetWindow_5, createMainProcessRuntime_showAssistantTargetWindow_6, createMainProcessRuntime_showDesktopPetWindow_7, createMainProcessRuntime_restoreDesktopPetWindowLayering_8, createMainProcessRuntime_openLogViewerWindow_9, createMainProcessRuntime_openAgentPlatformMonitorWindow_10, createMainProcessRuntime_openDesktopActionWorkbenchWindow_11, createMainProcessRuntime_openAgentRealtimeInspectorWindow_12, createMainProcessRuntime_closeDesktopActionWorkbenchWindow_13, createMainProcessRuntime_closeLogViewerWindow_14, createMainProcessRuntime_getServiceWebviewPreloadPath_15, createMainProcessRuntime_getServiceWebviewPreloadUrl_16, createMainProcessRuntime_minimizeLogViewerWindow_17, createMainProcessRuntime_maximizeLogViewerWindow_18, createMainProcessRuntime_captureAssistantScreenshot_19, createMainProcessRuntime_captureDesktopScreenshotForWebview_20, createMainProcessRuntime_captureEnterpriseChatScreenshot_21, createMainProcessRuntime_refreshPluginDesktopGlobalShortcuts_22, createMainProcessRuntime_registerFocusedWebviewDevToolsShortcut_23, createMainProcessRuntime_collectWebviewLoadDiagnostics_24, createMainProcessRuntime_reportRendererDiagnostic_25, createMainProcessRuntime_createWindow_26, createMainProcessRuntime_configureAppMediaPermissions_27, createMainProcessRuntime_showMainWindow_28, createMainProcessRuntime_notifyServicesChanged_29 } from "./runtime.operations-3";
import { createMainProcessRuntime_notifyCoreServicesChanged_1, createMainProcessRuntime_notifyDesktopDecorationsChanged_2, createMainProcessRuntime_emitWebsChanged_3, createMainProcessRuntime_startResourceDirectoryWatcher_4, createMainProcessRuntime_stopResourceDirectoryWatcher_5, createMainProcessRuntime_emitKanbanChanged_6, createMainProcessRuntime_emitAssistantNavigationAgentsChanged_7, createMainProcessRuntime_emitAssistantNavigationPushEvent_8, createMainProcessRuntime_navigateMainWindow_9, createMainProcessRuntime_openAssistantWorker_10, createMainProcessRuntime_createAppTray_11, createMainProcessRuntime_runNonCoreStartupTask_12, createMainProcessRuntime_startSsoCredentialDependentRuntimes_13, createMainProcessRuntime_applyDesktopSsoRestoreResult_14, createMainProcessRuntime_startNonCoreDesktopRuntime_15, createMainProcessRuntime_showFileDialog_16, createMainProcessRuntime_showSaveDialog_17, createMainProcessRuntime_showMessageBox_18, createMainProcessRuntime_emitAssistantAttachmentProgress_19, createMainProcessRuntime_buildApplicationMenu_20, createMainProcessRuntime_showArchiveDialog_21 } from "./runtime.operations-4";
import { createMainProcessRuntime_handleAppReady_1, createMainProcessRuntime_start_2, createMainProcessRuntime_prepareQuitUi_3, createMainProcessRuntime_beginAppQuitWithoutConfirmation_4, createMainProcessRuntime_beginInstallerShutdown_5, createMainProcessRuntime_writeInstallerShutdownAck_6, createMainProcessRuntime_writeInstallerShutdownAcks_7, createMainProcessRuntime_requestAppQuit_8 } from "./runtime.operations-5";

export function createMainProcessRuntime() {
  let servicesFacade!: ServicesFacade;
  let websFacade!: WebsFacade;
  const factoryContext: CreateMainProcessRuntimeContext = {
    get startupPlatform() { return startupPlatform; },
    get isFirstDesktopInstall() { return isFirstDesktopInstall; },
    get runtimeRootAtProcessStart() { return runtimeRootAtProcessStart; },
    get runtimeRootExistedAtStartup() { return runtimeRootExistedAtStartup; },
    get runtimeEnvExistedAtStartup() { return runtimeEnvExistedAtStartup; },
    get firstInstallBootstrapNavigation() { return firstInstallBootstrapNavigation; },
    get assistantIntegrationPorts() { return assistantIntegrationPorts; },
    get issueAgentAccessToken() { return identityTokenProvider; },
    get servicesFacade() { return servicesFacade; },
    get websFacade() { return websFacade; },
    get appState() { return appState; },
    get ASSISTANT_TARGET_PATH() { return ASSISTANT_TARGET_PATH; },
    get LOG_VIEWER_ROUTE() { return LOG_VIEWER_ROUTE; },
    get AGENT_REALTIME_INSPECTOR_ROUTE() { return AGENT_REALTIME_INSPECTOR_ROUTE; },
    get DESKTOP_ACTION_WORKBENCH_ROUTE() { return DESKTOP_ACTION_WORKBENCH_ROUTE; },
    get MAIN_PROCESS_DIR() { return MAIN_PROCESS_DIR; },
    get MAIN_PRELOAD_PATH() { return MAIN_PRELOAD_PATH; },
    get FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT() { return FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT; },
    get INSTALLER_SHUTDOWN_ARGS() { return INSTALLER_SHUTDOWN_ARGS; },
    get ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS() { return ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS; },
    get assistantRunWakeLock() { return assistantRunWakeLock; },
    get realtimeBroker() { return realtimeBroker; },
    get pluginClipboardBridge() { return pluginClipboardBridge; },
    get petRuntime() { return petRuntime; }, set petRuntime(value) { petRuntime = value; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; }, set assistantBridgeRuntime(value) { assistantBridgeRuntime = value; },
    get pluginBridgeRuntime() { return pluginBridgeRuntime; }, set pluginBridgeRuntime(value) { pluginBridgeRuntime = value; },
    get appShellRuntime() { return appShellRuntime; }, set appShellRuntime(value) { appShellRuntime = value; },
    get getMainWindow() { return getMainWindow; },
    get resourceDirectoryWatcher() { return resourceDirectoryWatcher; }, set resourceDirectoryWatcher(value) { resourceDirectoryWatcher = value; },
    get startupRestoreController() { return startupRestoreController; },
    get servicesRuntime() { return servicesRuntime; },
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get webviewContextMenuController() { return webviewContextMenuController; },
    get refreshDesktopSsoIdentityToken() { return refreshDesktopSsoIdentityToken; }, set refreshDesktopSsoIdentityToken(value) { refreshDesktopSsoIdentityToken = value; },
    get enterpriseChatRuntime() { return enterpriseChatRuntime; },
    get cdpIntegration() { return cdpIntegration; },
    get systemIdentityRuntime() { return systemIdentityRuntime; },
    get desktopAppInfo() { return desktopAppInfo; },
    get bundledEnvZipExistsAtStartup() { return bundledEnvZipExistsAtStartup; },
    get bundledSeedRefreshNeededAtStartup() { return bundledSeedRefreshNeededAtStartup; },
    get requireEnvZipImportAtStartup() { return requireEnvZipImportAtStartup; },
    get envZipConflictNeedsDecision() { return envZipConflictNeedsDecision; },
    get oldRootDecisionRef() { return oldRootDecisionRef; },
    get startupEnvImportFailureMessage() { return startupEnvImportFailureMessage; }, set startupEnvImportFailureMessage(value) { startupEnvImportFailureMessage = value; },
    get nonCoreDesktopRuntimeStarted() { return nonCoreDesktopRuntimeStarted; }, set nonCoreDesktopRuntimeStarted(value) { nonCoreDesktopRuntimeStarted = value; },
    get ssoCredentialDependentRuntimesStarted() { return ssoCredentialDependentRuntimesStarted; }, set ssoCredentialDependentRuntimesStarted(value) { ssoCredentialDependentRuntimesStarted = value; },
    get desktopSsoRestoreState() { return desktopSsoRestoreState; }, set desktopSsoRestoreState(value) { desktopSsoRestoreState = value; },
    get focusedWebviewDevToolsShortcutRegistered() { return focusedWebviewDevToolsShortcutRegistered; }, set focusedWebviewDevToolsShortcutRegistered(value) { focusedWebviewDevToolsShortcutRegistered = value; },
    get setStartupPhase() { return setStartupPhase; },
    get initializeUserDataRootsAndSettings() { return initializeUserDataRootsAndSettings; },
    get gotSingleInstanceLock() { return gotSingleInstanceLock; },
    get startupInstallerShutdownRequest() { return startupInstallerShutdownRequest; },
    get delay() { return delay; },
    get logsRuntime() { return logsRuntime; },
    get startupEnvironmentRuntime() { return startupEnvironmentRuntime; },
    get desktopSsoController() { return desktopSsoController; },
    get settingsRuntime() { return settingsRuntime; },
    get startupPipeline() { return startupPipeline; },
    get runShutdownCleanup() { return runShutdownCleanup; },
    get handleDesktopSsoWebviewNavigation() { return handleDesktopSsoWebviewNavigation; },
    get clearDesktopPetIdleResetTimer() { return clearDesktopPetIdleResetTimer; },
    get refreshDesktopPetState() { return refreshDesktopPetState; },
    get hideDesktopPetWindow() { return hideDesktopPetWindow; },
    get showAssistantTargetWindow() { return showAssistantTargetWindow; },
    get showDesktopPetWindow() { return showDesktopPetWindow; },
    get restoreDesktopPetWindowLayering() { return restoreDesktopPetWindowLayering; },
    get openLogViewerWindow() { return openLogViewerWindow; },
    get openAgentPlatformMonitorWindow() { return openAgentPlatformMonitorWindow; },
    get openDesktopActionWorkbenchWindow() { return openDesktopActionWorkbenchWindow; },
    get openAgentRealtimeInspectorWindow() { return openAgentRealtimeInspectorWindow; },
    get closeDesktopActionWorkbenchWindow() { return closeDesktopActionWorkbenchWindow; },
    get closeLogViewerWindow() { return closeLogViewerWindow; },
    get getServiceWebviewPreloadPath() { return getServiceWebviewPreloadPath; },
    get getServiceWebviewPreloadUrl() { return getServiceWebviewPreloadUrl; },
    get minimizeLogViewerWindow() { return minimizeLogViewerWindow; },
    get maximizeLogViewerWindow() { return maximizeLogViewerWindow; },
    get captureAssistantScreenshot() { return captureAssistantScreenshot; },
    get captureDesktopScreenshotForWebview() { return captureDesktopScreenshotForWebview; },
    get captureEnterpriseChatScreenshot() { return captureEnterpriseChatScreenshot; },
    get refreshPluginDesktopGlobalShortcuts() { return refreshPluginDesktopGlobalShortcuts; },
    get registerFocusedWebviewDevToolsShortcut() { return registerFocusedWebviewDevToolsShortcut; },
    get collectWebviewLoadDiagnostics() { return collectWebviewLoadDiagnostics; },
    get reportRendererDiagnostic() { return reportRendererDiagnostic; },
    get createWindow() { return createWindow; },
    get configureAppMediaPermissions() { return configureAppMediaPermissions; },
    get showMainWindow() { return showMainWindow; },
    get notifyServicesChanged() { return notifyServicesChanged; },
    get notifyCoreServicesChanged() { return notifyCoreServicesChanged; },
    get notifyDesktopDecorationsChanged() { return notifyDesktopDecorationsChanged; },
    get emitWebsChanged() { return emitWebsChanged; },
    get startResourceDirectoryWatcher() { return startResourceDirectoryWatcher; },
    get stopResourceDirectoryWatcher() { return stopResourceDirectoryWatcher; },
    get emitKanbanChanged() { return emitKanbanChanged; },
    get emitAssistantNavigationAgentsChanged() { return emitAssistantNavigationAgentsChanged; },
    get emitAssistantNavigationPushEvent() { return emitAssistantNavigationPushEvent; },
    get navigateMainWindow() { return navigateMainWindow; },
    get openAssistantWorker() { return openAssistantWorker; },
    get createAppTray() { return createAppTray; },
    get runNonCoreStartupTask() { return runNonCoreStartupTask; },
    get startSsoCredentialDependentRuntimes() { return startSsoCredentialDependentRuntimes; },
    get applyDesktopSsoRestoreResult() { return applyDesktopSsoRestoreResult; },
    get startNonCoreDesktopRuntime() { return startNonCoreDesktopRuntime; },
    get showFileDialog() { return showFileDialog; },
    get showSaveDialog() { return showSaveDialog; },
    get showMessageBox() { return showMessageBox; },
    get emitAssistantAttachmentProgress() { return emitAssistantAttachmentProgress; },
    get buildApplicationMenu() { return buildApplicationMenu; },
    get showArchiveDialog() { return showArchiveDialog; },
    get handleAppReady() { return handleAppReady; },
    get start() { return start; },
    get prepareQuitUi() { return prepareQuitUi; },
    get beginAppQuitWithoutConfirmation() { return beginAppQuitWithoutConfirmation; },
    get beginInstallerShutdown() { return beginInstallerShutdown; },
    get writeInstallerShutdownAck() { return writeInstallerShutdownAck; },
    get writeInstallerShutdownAcks() { return writeInstallerShutdownAcks; },
    get requestAppQuit() { return requestAppQuit; }
  };
  configureRuntimeEnvironmentTranslator(t);
  setDeprecatedCompatibilityDesktopVersion(app.getVersion());
  const startupPlatform = process.platform;
  const isFirstDesktopInstall = !desktopDataRootExists(app, startupPlatform);
  const runtimeRootAtProcessStart = resolveRuntimeRoot(app, startupPlatform);
  const runtimeRootExistedAtStartup = runtimeRootExists(app, startupPlatform);
  const runtimeEnvExistedAtStartup = runtimeEnvExists(app, startupPlatform);
  const firstInstallBootstrapNavigation = createFirstInstallBootstrapNavigation(isFirstDesktopInstall);
  const appState = createMainAppState();
  const identityTokenProvider = (targetApp: typeof app, reason: Parameters<typeof issueAgentAccessToken>[1]) =>
    issueAgentAccessToken(targetApp, reason, (capabilityApp, capabilityId) =>
      servicesFacade.resolveDesktopCapability(capabilityApp, capabilityId)
    );
  const servicesIntegrationPorts = createMainProcessRuntime_block18_4(factoryContext);
  servicesFacade = createServicesFacade(servicesIntegrationPorts);
  configureAgentMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, { ...options, issueAgentAccessToken: identityTokenProvider })
  );
  configureSkillMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, { ...options, issueAgentAccessToken: identityTokenProvider })
  );
  const websIntegrationPorts = createMainProcessRuntime_block14_2(factoryContext);
  websFacade = createWebsFacade(websIntegrationPorts);
  const assistantIntegrationPorts = createMainProcessRuntime_block17_3(factoryContext);
  const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
  const LOG_VIEWER_ROUTE = "/log-viewer";
  const AGENT_REALTIME_INSPECTOR_ROUTE = "/agent-realtime-inspector";
  const DESKTOP_ACTION_WORKBENCH_ROUTE = "/desktop-action-workbench";
  const MAIN_PROCESS_DIR = resolveElectronBundleRootFromRuntimeDir(__dirname, startupPlatform);
  const MAIN_PRELOAD_PATH = getMainPreloadPath(MAIN_PROCESS_DIR, startupPlatform);
  const FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT = getFocusedWebviewDevToolsShortcut(startupPlatform);
  const INSTALLER_SHUTDOWN_ARGS = createInstallerShutdownArgs(INSTALLER_SHUTDOWN_ARG);
  const ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS =
    ".enterprise-chat-floating { visibility: hidden !important; }";
  
  const assistantRunWakeLock = createAssistantRunWakeLock(startupPlatform, {
    isEnabled: () => readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.preventSleepWhileRunning
  });
  const realtimeBroker = new RealtimeBroker({
    app,
    issueAccessToken: identityTokenProvider,
    getDesktopDeviceId,
    onDiagnostic: (message) => console.warn(`[agent-platform-realtime] ${message}`)
  });
  const pluginClipboardBridge = createPluginClipboardBridge({
    platform: startupPlatform,
    clipboard,
    globalShortcut
  });
  let petRuntime: DesktopPetRuntime;
  let assistantBridgeRuntime: AssistantBridgeRuntime;
  let pluginBridgeRuntime: PluginBridgeRuntime;
  let appShellRuntime: AppShellRuntime;
  const getMainWindow = () => appShellRuntime?.getMainWindow() ?? null;
  let resourceDirectoryWatcher: ResourceDirectoryWatcher | null = null;
  const startupRestoreController = createMainProcessRuntime_startupRestoreController_5(factoryContext);
  const servicesRuntime = createServicesRuntime({
    app,
    getMainWindow: () => getMainWindow(),
    notifyServicesChanged,
    delay,
    getServiceState: servicesFacade.getServiceState,
    startService: servicesFacade.startService
  });
  
  registerDesktopPetAssetProtocolScheme(protocol);
  registerWebsiteFaviconProtocolScheme(protocol);
  registerDesktopSsoAvatarProtocolScheme(protocol);
  registerChatWorkPanelLocalFileProtocolScheme(protocol);
  
  const webSurfaceRuntime = createMainProcessRuntime_webSurfaceRuntime_6(factoryContext);
  const webviewContextMenuController = createMainProcessRuntime_webviewContextMenuController_7(factoryContext);
  let refreshDesktopSsoIdentityToken = async (_force = false) => getDesktopSsoAccessToken() || "";
  const enterpriseChatRuntime = createMainProcessRuntime_enterpriseChatRuntime_8(factoryContext);
  const cdpIntegration = createMainProcessRuntime_cdpIntegration_9(factoryContext);
  
  // Keep dev Electron runs on the same data root as packaged builds.
  const systemIdentityRuntime = createMainProcessRuntime_systemIdentityRuntime_10(factoryContext);
  const desktopAppInfo = systemIdentityRuntime.desktopAppInfo;
  const bundledEnvZipExistsAtStartup = bundledEnvZipExists(app, startupPlatform);
  const bundledSeedRefreshNeededAtStartup =
    bundledEnvZipExistsAtStartup &&
    runtimeEnvNeedsBundledSeedRefresh(app, startupPlatform);
  const requireEnvZipImportAtStartup = shouldRequireEnvZipImport({
    platform: startupPlatform,
    runtimeEnvExistedAtStartup
  }) || bundledSeedRefreshNeededAtStartup;
  const envZipConflictNeedsDecision = shouldPromptEnvRootConflict({
    platform: startupPlatform,
    isFirstDesktopInstall,
    bundledEnvZipExists: bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup
  });
  const oldRootDecisionRef: { current: EnvRootConflictDecision | undefined } = { current: undefined };
  let startupEnvImportFailureMessage: string | null = null;
  let nonCoreDesktopRuntimeStarted = false;
  let ssoCredentialDependentRuntimesStarted = false;
  let desktopSsoRestoreState: DesktopSsoRestoreResult["state"] = "signed_out";
  let focusedWebviewDevToolsShortcutRegistered = false;
  function setStartupPhase(phase: StartupPhase) { return createMainProcessRuntime_setStartupPhase_11(factoryContext, phase); }

  function initializeUserDataRootsAndSettings() { return createMainProcessRuntime_initializeUserDataRootsAndSettings_12(factoryContext); }
  
  const gotSingleInstanceLock = requestMainSingleInstanceLock(app);
  
  const startupInstallerShutdownRequest = parseInstallerShutdownRequest(
    process.argv,
    INSTALLER_SHUTDOWN_ARGS,
    STORAGE_NAMESPACE
  );
  if (startupInstallerShutdownRequest.requested && gotSingleInstanceLock) {
    if (startupInstallerShutdownRequest.ackPath) {
      try {
        writeShutdownAck(
          startupInstallerShutdownRequest.ackPath,
          "NO_PRIMARY",
          createNoPrimaryShutdownReport()
        );
      } catch (error) {
        console.error("[main] failed to write NO_PRIMARY shutdown acknowledgement", error);
      }
    }
    app.exit(0);
    return { start() {} };
  }
  if (!gotSingleInstanceLock) {
    return { start() {} };
  }
  
  function delay(ms: number) { return createMainProcessRuntime_delay_13(factoryContext, ms); }
  
  const logsRuntime = createMainProcessRuntime_logsRuntime_1(factoryContext);
  createMainProcessRuntime_block68_2(factoryContext);
  websFacade.webappWindowManager.setDisposalListener((webappId) => {
    emitWebsChanged({
      phase: "disposing",
      webappId
    });
  });
  const startupEnvironmentRuntime = createMainProcessRuntime_startupEnvironmentRuntime_3(factoryContext);
  createMainProcessRuntime_block71_4(factoryContext);
  createMainProcessRuntime_block72_5(factoryContext);
  const desktopSsoController = createMainProcessRuntime_desktopSsoController_6(factoryContext);
  createMainProcessRuntime_block74_7(factoryContext);
  createMainProcessRuntime_block75_8(factoryContext);

  const settingsRuntime = createMainProcessRuntime_settingsRuntime_9(factoryContext);
  createMainProcessRuntime_block77_10(factoryContext);
  const startupPipeline = createMainProcessRuntime_startupPipeline_11(factoryContext);
  const runShutdownCleanup = createMainProcessRuntime_runShutdownCleanup_1(factoryContext);
  
  async function handleDesktopSsoWebviewNavigation(url: string) { return createMainProcessRuntime_handleDesktopSsoWebviewNavigation_2(factoryContext, url); }
  
  function clearDesktopPetIdleResetTimer() { return createMainProcessRuntime_clearDesktopPetIdleResetTimer_3(factoryContext); }
  
  function refreshDesktopPetState(patch: any = {}) { return createMainProcessRuntime_refreshDesktopPetState_4(factoryContext, patch); }
  
  function hideDesktopPetWindow() { return createMainProcessRuntime_hideDesktopPetWindow_5(factoryContext); }
  
  async function showAssistantTargetWindow(source: string, targetPath = ASSISTANT_TARGET_PATH) { return createMainProcessRuntime_showAssistantTargetWindow_6(factoryContext, source, targetPath); }
  
  function showDesktopPetWindow() { return createMainProcessRuntime_showDesktopPetWindow_7(factoryContext); }

  function restoreDesktopPetWindowLayering() { return createMainProcessRuntime_restoreDesktopPetWindowLayering_8(factoryContext); }
  
  async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) { return createMainProcessRuntime_openLogViewerWindow_9(factoryContext, request); }
  
  async function openAgentPlatformMonitorWindow(url: string) { return createMainProcessRuntime_openAgentPlatformMonitorWindow_10(factoryContext, url); }

  async function openDesktopActionWorkbenchWindow() { return createMainProcessRuntime_openDesktopActionWorkbenchWindow_11(factoryContext); }

  async function openAgentRealtimeInspectorWindow() { return createMainProcessRuntime_openAgentRealtimeInspectorWindow_12(factoryContext); }

  function closeDesktopActionWorkbenchWindow() { return createMainProcessRuntime_closeDesktopActionWorkbenchWindow_13(factoryContext); }

  function closeLogViewerWindow() { return createMainProcessRuntime_closeLogViewerWindow_14(factoryContext); }
  
  function getServiceWebviewPreloadPath() { return createMainProcessRuntime_getServiceWebviewPreloadPath_15(factoryContext); }
  
  function getServiceWebviewPreloadUrl() { return createMainProcessRuntime_getServiceWebviewPreloadUrl_16(factoryContext); }
  
  function minimizeLogViewerWindow() { return createMainProcessRuntime_minimizeLogViewerWindow_17(factoryContext); }
  
  function maximizeLogViewerWindow() { return createMainProcessRuntime_maximizeLogViewerWindow_18(factoryContext); }
  
  async function captureAssistantScreenshot(chatId: string | null | undefined) { return createMainProcessRuntime_captureAssistantScreenshot_19(factoryContext, chatId); }
  
  async function captureDesktopScreenshotForWebview(
    mode: EnterpriseChatScreenshotMode = "region"
  ) { return createMainProcessRuntime_captureDesktopScreenshotForWebview_20(factoryContext, mode); }

  async function captureEnterpriseChatScreenshot(mode: EnterpriseChatScreenshotMode) { return createMainProcessRuntime_captureEnterpriseChatScreenshot_21(factoryContext, mode); }
  
  function refreshPluginDesktopGlobalShortcuts() { return createMainProcessRuntime_refreshPluginDesktopGlobalShortcuts_22(factoryContext); }
  
  function registerFocusedWebviewDevToolsShortcut() { return createMainProcessRuntime_registerFocusedWebviewDevToolsShortcut_23(factoryContext); }
  
  async function collectWebviewLoadDiagnostics(
    contents: Electron.WebContents,
    validatedUrl: string
  ): Promise<Record<string, unknown>> { return createMainProcessRuntime_collectWebviewLoadDiagnostics_24(factoryContext, contents, validatedUrl); }
  
  function reportRendererDiagnostic(source: string, details: Record<string, unknown>) { return createMainProcessRuntime_reportRendererDiagnostic_25(factoryContext, source, details); }
  
  function createWindow() { return createMainProcessRuntime_createWindow_26(factoryContext); }
  
  function configureAppMediaPermissions() { return createMainProcessRuntime_configureAppMediaPermissions_27(factoryContext); }
  
  function showMainWindow(targetPath?: string) { return createMainProcessRuntime_showMainWindow_28(factoryContext, targetPath); }
  
  function notifyServicesChanged() { return createMainProcessRuntime_notifyServicesChanged_29(factoryContext); }

  function notifyCoreServicesChanged() { return createMainProcessRuntime_notifyCoreServicesChanged_1(factoryContext); }

  function notifyDesktopDecorationsChanged() { return createMainProcessRuntime_notifyDesktopDecorationsChanged_2(factoryContext); }

  function emitWebsChanged(
    details: Partial<Omit<WebsChangedEvent, "changedAt">> = {}
  ) { return createMainProcessRuntime_emitWebsChanged_3(factoryContext, details); }

  function startResourceDirectoryWatcher() { return createMainProcessRuntime_startResourceDirectoryWatcher_4(factoryContext); }

  function stopResourceDirectoryWatcher() { return createMainProcessRuntime_stopResourceDirectoryWatcher_5(factoryContext); }
  
  function emitKanbanChanged() { return createMainProcessRuntime_emitKanbanChanged_6(factoryContext); }
  
  function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) { return createMainProcessRuntime_emitAssistantNavigationAgentsChanged_7(factoryContext, result); }

  function emitAssistantNavigationPushEvent(event: AssistantNavigationPushEvent) { return createMainProcessRuntime_emitAssistantNavigationPushEvent_8(factoryContext, event); }
  
  function navigateMainWindow(targetPath: string) { return createMainProcessRuntime_navigateMainWindow_9(factoryContext, targetPath); }
  
  async function openAssistantWorker(request: AssistantWorkerOpenRequest) { return createMainProcessRuntime_openAssistantWorker_10(factoryContext, request); }
  
  function createAppTray() { return createMainProcessRuntime_createAppTray_11(factoryContext); }

  function runNonCoreStartupTask(label: string, task: () => void) { return createMainProcessRuntime_runNonCoreStartupTask_12(factoryContext, label, task); }

  function startSsoCredentialDependentRuntimes() { return createMainProcessRuntime_startSsoCredentialDependentRuntimes_13(factoryContext); }

  function applyDesktopSsoRestoreResult(result: DesktopSsoRestoreResult) { return createMainProcessRuntime_applyDesktopSsoRestoreResult_14(factoryContext, result); }

  function startNonCoreDesktopRuntime() { return createMainProcessRuntime_startNonCoreDesktopRuntime_15(factoryContext); }
  
  async function showFileDialog(options: any, ownerWindow = getMainWindow()) { return createMainProcessRuntime_showFileDialog_16(factoryContext, options, ownerWindow); }
  
  async function showSaveDialog(options: any, ownerWindow = getMainWindow()) { return createMainProcessRuntime_showSaveDialog_17(factoryContext, options, ownerWindow); }
  
  async function showMessageBox(options: any, ownerWindow = getMainWindow()) { return createMainProcessRuntime_showMessageBox_18(factoryContext, options, ownerWindow); }
  
  function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) { return createMainProcessRuntime_emitAssistantAttachmentProgress_19(factoryContext, progress); }
  
  function buildApplicationMenu() { return createMainProcessRuntime_buildApplicationMenu_20(factoryContext); }
  
  function showArchiveDialog(title: string, extensions?: string[]) { return createMainProcessRuntime_showArchiveDialog_21(factoryContext, title, extensions); }
  
  async function handleAppReady() { return createMainProcessRuntime_handleAppReady_1(factoryContext); }
  
  function start() { return createMainProcessRuntime_start_2(factoryContext); }
  
  function prepareQuitUi() { return createMainProcessRuntime_prepareQuitUi_3(factoryContext); }
  
  function beginAppQuitWithoutConfirmation() { return createMainProcessRuntime_beginAppQuitWithoutConfirmation_4(factoryContext); }

  function beginInstallerShutdown(commandLine: string[]) { return createMainProcessRuntime_beginInstallerShutdown_5(factoryContext, commandLine); }

  function writeInstallerShutdownAck(
    ackPath: string,
    report: import("../../shared/shutdown").ShutdownReport
  ) { return createMainProcessRuntime_writeInstallerShutdownAck_6(factoryContext, ackPath, report); }

  function writeInstallerShutdownAcks(report: import("../../shared/shutdown").ShutdownReport) { return createMainProcessRuntime_writeInstallerShutdownAcks_7(factoryContext, report); }
  
  function requestAppQuit() { return createMainProcessRuntime_requestAppQuit_8(factoryContext); }
  
  return { start };
}

export * from "./runtime.shared";
