import { app, clipboard, globalShortcut, ipcMain, protocol } from "electron";
import { AGENT_WEBCLIENT_TARGET_PATH } from "../../shared/agent-webclient-routes";
import { INSTALLER_SHUTDOWN_ARG, STORAGE_NAMESPACE } from "../../shared/brand";
import type { AssistantAttachmentTaskProgress, AssistantNavAgentItemsResult, AssistantNavigationPushEvent, AssistantWorkerOpenRequest, EnterpriseChatScreenshotMode, ServiceOpenLogViewerRequest, WebsChangedEvent } from "../../shared/contracts";
import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../infrastructure/electron/bundle-paths";
import { getFocusedWebviewDevToolsShortcut } from "../infrastructure/electron/platform-adapter";
import { readDesktopProfileFromRoot } from "../infrastructure/filesystem/profile-store";
import { bundledEnvZipExists, configureRuntimeEnvironmentTranslator, resolveRuntimeRoot, runtimeEnvExists, runtimeEnvNeedsBundledSeedRefresh, runtimeRootExists, shouldPromptEnvRootConflict, shouldRequireEnvZipImport, type EnvRootConflictDecision } from "../infrastructure/filesystem/runtime-environment";
import { desktopDataRootExists, getDesktopConfigRoot } from "../infrastructure/filesystem/user-paths";
import { RealtimeBroker } from "../modules/agent-platform";
import { createDesktopAppearanceRuntime } from "../modules/settings";
import { createArtifactRuntime } from "../modules/artifacts";
import { createAssistantRunWakeLock, createFirstInstallBootstrapNavigation, type AssistantBridgeRuntime } from "../modules/assistant";
import { callAgentPlatform } from "../modules/desktop-actions";
import { getDesktopDeviceId, getDesktopSsoAccessToken, issueAgentAccessToken, registerDesktopSsoAvatarProtocolScheme, type DesktopSsoRestoreResult } from "../modules/identity";
import { configureAgentMarketPlatformCaller, configureConnectorMarketPlatformCaller, configureSkillMarketPlatformCaller } from "../modules/marketplace";
import { registerDesktopPetAssetProtocolScheme, type DesktopPetRuntime } from "../modules/pet";
import { createPluginClipboardBridge, type PluginBridgeRuntime } from "../modules/plugins";
import { createServicesFacade, createServicesRuntime, type ServicesFacade } from "../modules/services";
import { type AppShellRuntime, type SelectionExplainWindowController } from "../modules/shell";
import { createWebsFacade, registerWebsiteFaviconProtocolScheme, type WebsFacade } from "../modules/webs";
import { registerChatWorkPanelLocalFileProtocolScheme } from "../modules/work-panel";
import { t } from "../support/i18n/main-i18n";
import { setDeprecatedCompatibilityDesktopVersion } from "../support/logging/deprecated-compatibility";
import * as assistant from "./assembly/assistant";
import * as enterpriseChat from "./assembly/enterprise-chat";
import * as extensions from "./assembly/extensions";
import * as identity from "./assembly/identity";
import * as readyIpc from "./assembly/ready-ipc";
import * as services from "./assembly/services";
import * as settings from "./assembly/settings";
import * as shell from "./assembly/shell";
import * as webSurfaces from "./assembly/web-surfaces";
import { initializeElectronProfile } from "./bootstrap/electron-profile";
import * as appReady from "./lifecycle/app-ready";
import * as runtimeEvents from "./lifecycle/runtime-events";
import { createNoPrimaryShutdownReport, parseInstallerShutdownRequest, writeShutdownAck } from "./lifecycle/shutdown-ack";
import * as shutdownAssembly from "./lifecycle/shutdown-assembly";
import { createInstallerShutdownArgs, requestMainSingleInstanceLock } from "./lifecycle/single-instance";
import * as startupAssembly from "./lifecycle/startup-assembly";
import { type StartupPhase } from "./lifecycle/startup-phases";
import * as rendererDiagnostics from "./renderer-diagnostics";
import * as resourceWatching from "./resource-directory-watcher";
import { type ResourceDirectoryWatcher } from "./resource-directory-watcher";
import * as runtimeNotifications from "./runtime-notifications";
import { createMainAppState } from "./state";

export function createMainProcessRuntime() {
  // Assembly ports intentionally read live bindings: several callbacks run only after
  // the receiving runtime has been constructed. Do not eagerly snapshot these getters.
  let servicesFacade!: ServicesFacade;
  let websFacade!: WebsFacade;
  configureRuntimeEnvironmentTranslator(t);
  setDeprecatedCompatibilityDesktopVersion(app.getVersion());
  const startupPlatform = process.platform;
  const isFirstDesktopInstall = !desktopDataRootExists(app, startupPlatform);
  const runtimeRootAtProcessStart = resolveRuntimeRoot(app, startupPlatform);
  const runtimeRootExistedAtStartup = runtimeRootExists(app, startupPlatform);
  const runtimeEnvExistedAtStartup = runtimeEnvExists(app, startupPlatform);
  const firstInstallBootstrapNavigation = createFirstInstallBootstrapNavigation(isFirstDesktopInstall);
  const appState = createMainAppState();
  // Local service authentication is independent of website SSO.
  const identityTokenProvider = (targetApp: typeof app, reason: Parameters<typeof issueAgentAccessToken>[1]) =>
    issueAgentAccessToken(targetApp, reason, (capabilityApp, capabilityId) =>
      servicesFacade.resolveDesktopCapability(capabilityApp, capabilityId));
  const servicesIntegrationPorts = services.assembleServicesIntegration({
    get issueAgentAccessToken() { return identityTokenProvider; },
    get servicesFacade() { return servicesFacade; },
    get refreshDesktopSsoIdentityToken() { return refreshDesktopSsoIdentityToken; },
    get startupRestoreController() { return startupRestoreController; },
    get websFacade() { return websFacade; }
  });
  servicesFacade = createServicesFacade(servicesIntegrationPorts);
  configureAgentMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, { ...options, issueAgentAccessToken: identityTokenProvider })
  );
  configureSkillMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, { ...options, issueAgentAccessToken: identityTokenProvider })
  );
  configureConnectorMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, { ...options, issueAgentAccessToken: identityTokenProvider })
  );
  const websIntegrationPorts = webSurfaces.assembleWebsIntegration({
    get websFacade() { return websFacade; }
  });
  websFacade = createWebsFacade(websIntegrationPorts);
  const appearanceRuntime = createDesktopAppearanceRuntime(app, startupPlatform, () => settingsRuntime.emitDesktopConfigChanged("skin"));
  const assistantIntegrationPorts = assistant.assembleAssistantIntegration({
    appearanceRuntime,
    get servicesFacade() { return servicesFacade; },
    get issueAgentAccessToken() { return identityTokenProvider; },
    get websFacade() { return websFacade; }
  });
  const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
  const LOG_VIEWER_ROUTE = "/log-viewer";
  const AGENT_REALTIME_INSPECTOR_ROUTE = "/agent-realtime-inspector";
  const DESKTOP_ACTION_WORKBENCH_ROUTE = "/desktop-action-workbench";
  const SELECTION_EXPLAIN_WINDOW_ROUTE = "/selection-explain-window";
  const MAIN_PROCESS_DIR = resolveElectronBundleRootFromRuntimeDir(__dirname, startupPlatform);
  const MAIN_PRELOAD_PATH = getMainPreloadPath(MAIN_PROCESS_DIR, startupPlatform);
  const FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT = getFocusedWebviewDevToolsShortcut(startupPlatform);
  const INSTALLER_SHUTDOWN_ARGS = createInstallerShutdownArgs(INSTALLER_SHUTDOWN_ARG);
  const ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS =
    ".enterprise-chat-floating { visibility: hidden !important; }";

  const assistantRunWakeLock = createAssistantRunWakeLock(startupPlatform, {
    isEnabled: () => readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.preventSleepWhileRunning
  });
  let artifactRuntime: ReturnType<typeof createArtifactRuntime> | undefined;
  const realtimeBroker = new RealtimeBroker({
    app,
    issueAccessToken: identityTokenProvider,
    getDesktopDeviceId,
    onArtifactPublished: (event) => artifactRuntime?.recordPublished(event),
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
  artifactRuntime = createArtifactRuntime({
    app, platform: startupPlatform, broker: realtimeBroker, ipcMain, getMainWindow,
    onError: (error) => console.warn("[artifacts] failed to record push", error),
  });
  app.once("will-quit", () => artifactRuntime?.dispose());
  let resourceDirectoryWatcher: ResourceDirectoryWatcher | null = null;
  const startupRestoreController = startupAssembly.assembleStartupRestore({
    get getMainWindow() { return getMainWindow; }
  });
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

  const webSurfaceRuntime = webSurfaces.assembleWebSurfaceRuntime({
    get websFacade() { return websFacade; },
    get getMainWindow() { return getMainWindow; },
    get navigateMainWindow() { return navigateMainWindow; },
    get delay() { return delay; }
  });
  let selectionExplainWindowController: SelectionExplainWindowController | null = null;
  const webviewContextMenuController = webSurfaces.assembleWebviewContextMenus({
    get startupPlatform() { return startupPlatform; },
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get getMainWindow() { return getMainWindow; },
    get servicesFacade() { return servicesFacade; },
    get reportRendererDiagnostic() { return reportRendererDiagnostic; },
    get selectionExplainWindowController() { return selectionExplainWindowController; }
  });
  selectionExplainWindowController = webSurfaces.assembleSelectionExplainWindow({
    get startupPlatform() { return startupPlatform; },
    get MAIN_PRELOAD_PATH() { return MAIN_PRELOAD_PATH; },
    get SELECTION_EXPLAIN_WINDOW_ROUTE() { return SELECTION_EXPLAIN_WINDOW_ROUTE; },
    get getMainWindow() { return getMainWindow; },
    get MAIN_PROCESS_DIR() { return MAIN_PROCESS_DIR; },
    get collectWebviewLoadDiagnostics() { return collectWebviewLoadDiagnostics; },
    get reportRendererDiagnostic() { return reportRendererDiagnostic; },
    get handleDesktopSsoWebviewNavigation() { return handleDesktopSsoWebviewNavigation; },
    get webviewContextMenuController() { return webviewContextMenuController; }
  });
  let refreshDesktopSsoIdentityToken = async (_force = false) => getDesktopSsoAccessToken() || "";
  const enterpriseChatRuntime = enterpriseChat.assembleEnterpriseChat({
    get startupPlatform() { return startupPlatform; },
    get refreshDesktopSsoIdentityToken() { return refreshDesktopSsoIdentityToken; },
    get showFileDialog() { return showFileDialog; },
    get showSaveDialog() { return showSaveDialog; },
    get captureEnterpriseChatScreenshot() { return captureEnterpriseChatScreenshot; },
    get servicesFacade() { return servicesFacade; },
    get websFacade() { return websFacade; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; },
    get getMainWindow() { return getMainWindow; }
  });
  const cdpIntegration = webSurfaces.assembleCdpIntegration({
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get servicesFacade() { return servicesFacade; },
    get getMainWindow() { return getMainWindow; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; }
  });

  // Keep dev Electron runs on the same data root as packaged builds.
  const systemIdentityRuntime = identity.assembleSystemIdentity({
    get startupPlatform() { return startupPlatform; },
    get MAIN_PROCESS_DIR() { return MAIN_PROCESS_DIR; }
  });
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
  function setStartupPhase(phase: StartupPhase) {
    return startupAssembly.setStartupPhase({
      get appState() { return appState; }
    }, phase);
  }

  function initializeUserDataRootsAndSettings() {
    return startupAssembly.initializeUserDataRootsAndSettings({
      get startupPlatform() { return startupPlatform; },
      get isFirstDesktopInstall() { return isFirstDesktopInstall; },
      get desktopAppInfo() { return desktopAppInfo; },
      get petRuntime() { return petRuntime; }
    });
  }

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
    return { start() { } };
  }
  if (!gotSingleInstanceLock) {
    return { start() { } };
  }

  // Keep startup snapshots and the existing single-instance lock ahead of profile
  // creation, but configure Chromium storage before ready or any Session access.
  initializeElectronProfile(app, startupPlatform);

  function delay(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  const logsRuntime = shell.assembleLogsRuntime({
    get MAIN_PRELOAD_PATH() { return MAIN_PRELOAD_PATH; },
    get LOG_VIEWER_ROUTE() { return LOG_VIEWER_ROUTE; },
    get startupPlatform() { return startupPlatform; },
    get getMainWindow() { return getMainWindow; }
  });
  appShellRuntime = shell.assembleAppShell({
    get startupPlatform() { return startupPlatform; },
    get systemIdentityRuntime() { return systemIdentityRuntime; },
    get MAIN_PROCESS_DIR() { return MAIN_PROCESS_DIR; },
    get logsRuntime() { return logsRuntime; },
    get AGENT_REALTIME_INSPECTOR_ROUTE() { return AGENT_REALTIME_INSPECTOR_ROUTE; },
    get DESKTOP_ACTION_WORKBENCH_ROUTE() { return DESKTOP_ACTION_WORKBENCH_ROUTE; },
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get handleDesktopSsoWebviewNavigation() { return handleDesktopSsoWebviewNavigation; },
    get webviewContextMenuController() { return webviewContextMenuController; },
    get collectWebviewLoadDiagnostics() { return collectWebviewLoadDiagnostics; },
    get reportRendererDiagnostic() { return reportRendererDiagnostic; },
    get appState() { return appState; },
    get beginAppQuitWithoutConfirmation() { return beginAppQuitWithoutConfirmation; },
    get requestAppQuit() { return requestAppQuit; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; },
    get petRuntime() { return petRuntime; },
    get showDesktopPetWindow() { return showDesktopPetWindow; },
    get hideDesktopPetWindow() { return hideDesktopPetWindow; },
    get restoreDesktopPetWindowLayering() { return restoreDesktopPetWindowLayering; },
    get websFacade() { return websFacade; }
  });
  websFacade.webappWindowManager.setDisposalListener((webappId) => {
    emitWebsChanged({
      phase: "disposing",
      webappId
    });
  });
  const startupEnvironmentRuntime = startupAssembly.assembleStartupEnvironment({
    get startupPlatform() { return startupPlatform; },
    get envZipConflictNeedsDecision() { return envZipConflictNeedsDecision; },
    get requireEnvZipImportAtStartup() { return requireEnvZipImportAtStartup; },
    get runtimeRootAtProcessStart() { return runtimeRootAtProcessStart; },
    get oldRootDecisionRef() { return oldRootDecisionRef; },
    get startupRestoreController() { return startupRestoreController; },
    get appShellRuntime() { return appShellRuntime; }
  });
  petRuntime = extensions.assembleDesktopPet({
    get startupPlatform() { return startupPlatform; },
    get getMainWindow() { return getMainWindow; },
    get appState() { return appState; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; },
    get MAIN_PRELOAD_PATH() { return MAIN_PRELOAD_PATH; },
    get showMainWindow() { return showMainWindow; },
    get openAssistantWorker() { return openAssistantWorker; },
    get pluginBridgeRuntime() { return pluginBridgeRuntime; },
    get appShellRuntime() { return appShellRuntime; }
  });
  pluginBridgeRuntime = extensions.assemblePluginBridge({
    get pluginClipboardBridge() { return pluginClipboardBridge; },
    get servicesFacade() { return servicesFacade; },
    get notifyServicesChanged() { return notifyServicesChanged; },
    get petRuntime() { return petRuntime; },
    get issueAgentAccessToken() { return identityTokenProvider; }
  });
  const desktopSsoController = identity.assembleDesktopSsoController({
    get startupPlatform() { return startupPlatform; },
    get getMainWindow() { return getMainWindow; },
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get applyDesktopSsoRestoreResult() { return applyDesktopSsoRestoreResult; }
  });
  identity.configureMarketTokenIssuer({
    get desktopSsoController() { return desktopSsoController; }
  });
  refreshDesktopSsoIdentityToken = identity.createDesktopSsoTokenRefresher({
    get desktopSsoController() { return desktopSsoController; },
    get applyDesktopSsoRestoreResult() { return applyDesktopSsoRestoreResult; },
    get desktopSsoRestoreState() { return desktopSsoRestoreState; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; },
    get enterpriseChatRuntime() { return enterpriseChatRuntime; }
  });

  const settingsRuntime = settings.assembleSettingsRuntime({
    get startupPlatform() { return startupPlatform; },
    get getMainWindow() { return getMainWindow; },
    get petRuntime() { return petRuntime; },
    get logsRuntime() { return logsRuntime; },
    get buildApplicationMenu() { return buildApplicationMenu; },
    get appShellRuntime() { return appShellRuntime; },
    get showDesktopPetWindow() { return showDesktopPetWindow; },
    get hideDesktopPetWindow() { return hideDesktopPetWindow; },
    get desktopSsoController() { return desktopSsoController; },
    get notifyServicesChanged() { return notifyServicesChanged; },
    get emitKanbanChanged() { return emitKanbanChanged; },
    get assistantBridgeRuntime() { return assistantBridgeRuntime; },
    get enterpriseChatRuntime() { return enterpriseChatRuntime; }
  });
  assistantBridgeRuntime = assistant.assembleAssistantRuntime({
    get assistantIntegrationPorts() { return assistantIntegrationPorts; },
    get desktopAppInfo() { return desktopAppInfo; },
    get startupPlatform() { return startupPlatform; },
    get getMainWindow() { return getMainWindow; },
    get webSurfaceRuntime() { return webSurfaceRuntime; },
    get assistantRunWakeLock() { return assistantRunWakeLock; },
    get cdpIntegration() { return cdpIntegration; },
    get issueAgentAccessToken() { return identityTokenProvider; },
    get realtimeBroker() { return realtimeBroker; },
    get refreshDesktopSsoIdentityToken() { return refreshDesktopSsoIdentityToken; },
    get showMainWindow() { return showMainWindow; },
    get showFileDialog() { return showFileDialog; },
    get showSaveDialog() { return showSaveDialog; },
    get openLogViewerWindow() { return openLogViewerWindow; },
    get petRuntime() { return petRuntime; },
    get emitKanbanChanged() { return emitKanbanChanged; },
    get emitAssistantNavigationAgentsChanged() { return emitAssistantNavigationAgentsChanged; },
    get emitAssistantNavigationPushEvent() { return emitAssistantNavigationPushEvent; },
    get websFacade() { return websFacade; }
  });
  const startupPipeline = startupAssembly.assembleStartupPipeline({
    get desktopAppInfo() { return desktopAppInfo; },
    get isFirstDesktopInstall() { return isFirstDesktopInstall; },
    get startupEnvImportFailureMessage() { return startupEnvImportFailureMessage; },
    get startupRestoreController() { return startupRestoreController; },
    get notifyCoreServicesChanged() { return notifyCoreServicesChanged; },
    get runNonCoreStartupTask() { return runNonCoreStartupTask; },
    get createAppTray() { return createAppTray; },
    get startNonCoreDesktopRuntime() { return startNonCoreDesktopRuntime; },
    get setStartupPhase() { return setStartupPhase; },
    get servicesRuntime() { return servicesRuntime; },
    get servicesFacade() { return servicesFacade; }
  });
  const runShutdownCleanup = shutdownAssembly.assembleShutdownCleanup({
    get appState() { return appState; },
    get getMainWindow() { return getMainWindow; },
    get websFacade() { return websFacade; },
    get servicesFacade() { return servicesFacade; }
  });

  async function handleDesktopSsoWebviewNavigation(url: string) {
    return identity.handleDesktopSsoWebviewNavigation({
      get appState() { return appState; },
      get desktopSsoController() { return desktopSsoController; }
    }, url);
  }

  function clearDesktopPetIdleResetTimer() {
    return petRuntime.clearIdleResetTimer();
  }

  function refreshDesktopPetState(patch: Parameters<DesktopPetRuntime["refreshState"]>[0] = {}) {
    return petRuntime.refreshState(patch);
  }

  function hideDesktopPetWindow() {
    return petRuntime.hideWindow();
  }

  async function showAssistantTargetWindow(source: string, targetPath = ASSISTANT_TARGET_PATH) {
    return assistant.showAssistantTargetWindow({
      get showMainWindow() { return showMainWindow; },
      get servicesRuntime() { return servicesRuntime; },
      get getMainWindow() { return getMainWindow; }
    }, source, targetPath);
  }

  function showDesktopPetWindow() {
    return petRuntime.showWindow();
  }

  function restoreDesktopPetWindowLayering() {
    return petRuntime.restoreWindowLayering();
  }

  async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
    return logsRuntime.openLogViewerWindow(request);
  }

  async function openAgentPlatformMonitorWindow(url: string) {
    return appShellRuntime.openAgentPlatformMonitorWindow(url);
  }

  async function openDesktopActionWorkbenchWindow() {
    return appShellRuntime.openDesktopActionWorkbenchWindow();
  }

  async function openAgentRealtimeInspectorWindow() {
    return appShellRuntime.openAgentRealtimeInspectorWindow();
  }

  function closeDesktopActionWorkbenchWindow() {
    return appShellRuntime.closeDesktopActionWorkbenchWindow();
  }

  function closeLogViewerWindow() {
    return logsRuntime.closeLogViewerWindow();
  }

  function getServiceWebviewPreloadPath() {
    return appShellRuntime.getServiceWebviewPreloadPath();
  }

  function getServiceWebviewPreloadUrl() {
    return appShellRuntime.getServiceWebviewPreloadUrl();
  }

  function minimizeLogViewerWindow() {
    return logsRuntime.minimizeLogViewerWindow();
  }

  function maximizeLogViewerWindow() {
    return logsRuntime.maximizeLogViewerWindow();
  }

  async function captureAssistantScreenshot(chatId: string | null | undefined) {
    return assistant.captureAssistantScreenshot({
      get startupPlatform() { return startupPlatform; },
      get getMainWindow() { return getMainWindow; },
      get delay() { return delay; }
    }, chatId);
  }

  async function captureDesktopScreenshotForWebview(
    mode: EnterpriseChatScreenshotMode = "region"
  ) {
    return shell.captureDesktopScreenshotForWebview({
      get startupPlatform() { return startupPlatform; },
      get getMainWindow() { return getMainWindow; },
      get delay() { return delay; }
    }, mode);
  }

  async function captureEnterpriseChatScreenshot(mode: EnterpriseChatScreenshotMode) {
    return enterpriseChat.captureEnterpriseChatScreenshot({
      get captureDesktopScreenshotForWebview() { return captureDesktopScreenshotForWebview; },
      get getMainWindow() { return getMainWindow; },
      get ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS() { return ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS; }
    }, mode);
  }

  function refreshPluginDesktopGlobalShortcuts() {
    return extensions.refreshPluginDesktopGlobalShortcuts({
      get startupPlatform() { return startupPlatform; },
      get servicesRuntime() { return servicesRuntime; }
    });
  }

  function registerFocusedWebviewDevToolsShortcut() {
    return webSurfaces.registerFocusedWebviewDevToolsShortcut({
      get focusedWebviewDevToolsShortcutRegistered() { return focusedWebviewDevToolsShortcutRegistered; },
      set focusedWebviewDevToolsShortcutRegistered(value) { focusedWebviewDevToolsShortcutRegistered = value; },
      get FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT() { return FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT; },
      get appShellRuntime() { return appShellRuntime; },
      get webSurfaceRuntime() { return webSurfaceRuntime; }
    });
  }

  async function collectWebviewLoadDiagnostics(
    contents: Electron.WebContents,
    validatedUrl: string
  ): Promise<Record<string, unknown>> { return rendererDiagnostics.collectWebviewLoadDiagnostics(contents, validatedUrl); }

  function reportRendererDiagnostic(source: string, details: Record<string, unknown>) { return rendererDiagnostics.reportRendererDiagnostic(source, details); }

  function createWindow() {
    return appShellRuntime.createWindow();
  }

  function configureAppMediaPermissions() {
    return appShellRuntime.configureAppMediaPermissions();
  }

  function showMainWindow(targetPath?: string) {
    return appShellRuntime.showMainWindow(targetPath);
  }

  function notifyServicesChanged() {
    return runtimeNotifications.notifyServicesChanged({
      get notifyCoreServicesChanged() { return notifyCoreServicesChanged; },
      get notifyDesktopDecorationsChanged() { return notifyDesktopDecorationsChanged; }
    });
  }

  function notifyCoreServicesChanged() {
    return runtimeNotifications.notifyCoreServicesChanged({
      get appState() { return appState; },
      get pluginBridgeRuntime() { return pluginBridgeRuntime; },
      get assistantBridgeRuntime() { return assistantBridgeRuntime; },
      get getMainWindow() { return getMainWindow; }
    });
  }

  function notifyDesktopDecorationsChanged() {
    return runtimeNotifications.notifyDesktopDecorationsChanged({
      get appState() { return appState; },
      get refreshPluginDesktopGlobalShortcuts() { return refreshPluginDesktopGlobalShortcuts; }
    });
  }

  function emitWebsChanged(
    details: Partial<Omit<WebsChangedEvent, "changedAt">> = {}
  ) {
    return runtimeNotifications.emitWebsChanged({
      get getMainWindow() { return getMainWindow; }
    }, details);
  }

  function startResourceDirectoryWatcher() {
    return resourceWatching.startResourceDirectoryWatcher({
      get resourceDirectoryWatcher() { return resourceDirectoryWatcher; },
      set resourceDirectoryWatcher(value) { resourceDirectoryWatcher = value; },
      get startupPlatform() { return startupPlatform; },
      get emitWebsChanged() { return emitWebsChanged; },
      get petRuntime() { return petRuntime; },
      get notifyServicesChanged() { return notifyServicesChanged; }
    });
  }

  function stopResourceDirectoryWatcher() {
    return resourceWatching.stopResourceDirectoryWatcher({
      get resourceDirectoryWatcher() { return resourceDirectoryWatcher; },
      set resourceDirectoryWatcher(value) { resourceDirectoryWatcher = value; }
    });
  }

  function emitKanbanChanged() {
    return runtimeNotifications.emitKanbanChanged({
      get getMainWindow() { return getMainWindow; }
    });
  }

  function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
    return runtimeNotifications.emitAssistantNavigationAgentsChanged({
      get appShellRuntime() { return appShellRuntime; },
      get getMainWindow() { return getMainWindow; },
      get petRuntime() { return petRuntime; },
      get refreshDesktopPetState() { return refreshDesktopPetState; }
    }, result);
  }

  function emitAssistantNavigationPushEvent(event: AssistantNavigationPushEvent) {
    return runtimeNotifications.emitAssistantNavigationPushEvent({
      get getMainWindow() { return getMainWindow; }
    }, event);
  }

  function navigateMainWindow(targetPath: string) {
    return appShellRuntime.navigateMainWindow(targetPath);
  }

  async function openAssistantWorker(request: AssistantWorkerOpenRequest) {
    return assistant.openAssistantWorker({
      get showAssistantTargetWindow() { return showAssistantTargetWindow; }
    }, request);
  }

  function createAppTray() {
    return appShellRuntime.createAppTray();
  }

  function runNonCoreStartupTask(label: string, task: () => void) { return startupAssembly.runNonCoreStartupTask(label, task); }

  function startSsoCredentialDependentRuntimes() {
    return startupAssembly.startSsoCredentialDependentRuntimes({
      get nonCoreDesktopRuntimeStarted() { return nonCoreDesktopRuntimeStarted; },
      get ssoCredentialDependentRuntimesStarted() { return ssoCredentialDependentRuntimesStarted; },
      set ssoCredentialDependentRuntimesStarted(value) { ssoCredentialDependentRuntimesStarted = value; },
      get runNonCoreStartupTask() { return runNonCoreStartupTask; },
      get enterpriseChatRuntime() { return enterpriseChatRuntime; },
      get startupPlatform() { return startupPlatform; }
    });
  }

  function applyDesktopSsoRestoreResult(result: DesktopSsoRestoreResult) {
    return identity.applyDesktopSsoRestoreResult({
      get desktopSsoRestoreState() { return desktopSsoRestoreState; },
      set desktopSsoRestoreState(value) { desktopSsoRestoreState = value; },
      get appState() { return appState; },
      get startupPlatform() { return startupPlatform; },
      get startupRestoreController() { return startupRestoreController; },
      get servicesRuntime() { return servicesRuntime; },
      get servicesFacade() { return servicesFacade; },
      get notifyCoreServicesChanged() { return notifyCoreServicesChanged; },
      get startupPipeline() { return startupPipeline; },
      get ssoCredentialDependentRuntimesStarted() { return ssoCredentialDependentRuntimesStarted; },
      set ssoCredentialDependentRuntimesStarted(value) { ssoCredentialDependentRuntimesStarted = value; },
      get nonCoreDesktopRuntimeStarted() { return nonCoreDesktopRuntimeStarted; },
      get startSsoCredentialDependentRuntimes() { return startSsoCredentialDependentRuntimes; },
      get assistantBridgeRuntime() { return assistantBridgeRuntime; },
      get enterpriseChatRuntime() { return enterpriseChatRuntime; }
    }, result);
  }

  function startNonCoreDesktopRuntime() {
    return startupAssembly.startNonCoreDesktopRuntime({
      get nonCoreDesktopRuntimeStarted() { return nonCoreDesktopRuntimeStarted; },
      set nonCoreDesktopRuntimeStarted(value) { nonCoreDesktopRuntimeStarted = value; },
      get refreshDesktopSsoIdentityToken() { return refreshDesktopSsoIdentityToken; },
      get runNonCoreStartupTask() { return runNonCoreStartupTask; },
      get petRuntime() { return petRuntime; },
      get startupPlatform() { return startupPlatform; },
      get showDesktopPetWindow() { return showDesktopPetWindow; },
      get refreshDesktopPetState() { return refreshDesktopPetState; },
      get buildApplicationMenu() { return buildApplicationMenu; },
      get pluginBridgeRuntime() { return pluginBridgeRuntime; },
      get assistantBridgeRuntime() { return assistantBridgeRuntime; },
      get startSsoCredentialDependentRuntimes() { return startSsoCredentialDependentRuntimes; },
      get setStartupPhase() { return setStartupPhase; },
      get notifyDesktopDecorationsChanged() { return notifyDesktopDecorationsChanged; }
    });
  }

  async function showFileDialog(options: Electron.OpenDialogOptions, ownerWindow = getMainWindow()) {
    return appShellRuntime.showFileDialog(options, ownerWindow);
  }

  async function showSaveDialog(options: Electron.SaveDialogOptions, ownerWindow = getMainWindow()) {
    return appShellRuntime.showSaveDialog(options, ownerWindow);
  }

  async function showMessageBox(options: Electron.MessageBoxOptions, ownerWindow = getMainWindow()) {
    return appShellRuntime.showMessageBox(options, ownerWindow);
  }

  function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) {
    return runtimeNotifications.emitAssistantAttachmentProgress({
      get getMainWindow() { return getMainWindow; }
    }, progress);
  }

  function buildApplicationMenu() {
    return appShellRuntime.buildApplicationMenu();
  }

  function showArchiveDialog(title: string, extensions?: string[]) {
    return appShellRuntime.showArchiveDialog(title, extensions);
  }

  async function handleAppReady() {
    return appReady.handleAppReady({
      get setStartupPhase() { return setStartupPhase; },
      get systemIdentityRuntime() { return systemIdentityRuntime; },
      get startupEnvironmentRuntime() { return startupEnvironmentRuntime; },
      get startupEnvImportFailureMessage() { return startupEnvImportFailureMessage; },
      set startupEnvImportFailureMessage(value) { startupEnvImportFailureMessage = value; },
      get startupRestoreController() { return startupRestoreController; },
      get initializeUserDataRootsAndSettings() { return initializeUserDataRootsAndSettings; },
      get startupPlatform() { return startupPlatform; },
      get logsRuntime() { return logsRuntime; },
      get webSurfaceRuntime() { return webSurfaceRuntime; },
      get desktopSsoController() { return desktopSsoController; },
      get applyDesktopSsoRestoreResult() { return applyDesktopSsoRestoreResult; },
      get pluginBridgeRuntime() { return pluginBridgeRuntime; },
      get issueAgentAccessToken() { return identityTokenProvider; },
      get assistantBridgeRuntime() { return assistantBridgeRuntime; },
      get getMainWindow() { return getMainWindow; },
      get desktopAppInfo() { return desktopAppInfo; },
      get configureAppMediaPermissions() { return configureAppMediaPermissions; },
      get registerFocusedWebviewDevToolsShortcut() { return registerFocusedWebviewDevToolsShortcut; },
      get createWindow() { return createWindow; },
      get appState() { return appState; },
      get realtimeBroker() { return realtimeBroker; },
      get runShutdownCleanup() { return runShutdownCleanup; },
      get beginAppQuitWithoutConfirmation() { return beginAppQuitWithoutConfirmation; },
      get startResourceDirectoryWatcher() { return startResourceDirectoryWatcher; },
      get startupPipeline() { return startupPipeline; },
      registerIpc: (conversationShareFacade, getUpdatesRuntime) => readyIpc.registerReadyIpc({
        get setStartupPhase() { return setStartupPhase; },
        get startupRestoreController() { return startupRestoreController; },
        get startupPlatform() { return startupPlatform; },
        get logsRuntime() { return logsRuntime; },
        get webSurfaceRuntime() { return webSurfaceRuntime; },
        get desktopSsoController() { return desktopSsoController; },
        get issueAgentAccessToken() { return identityTokenProvider; },
        get assistantBridgeRuntime() { return assistantBridgeRuntime; },
        get servicesFacade() { return servicesFacade; },
        get websFacade() { return websFacade; },
        get getMainWindow() { return getMainWindow; },
        get appShellRuntime() { return appShellRuntime; },
        get assistantRunWakeLock() { return assistantRunWakeLock; },
        get petRuntime() { return petRuntime; },
        get enterpriseChatRuntime() { return enterpriseChatRuntime; },
        get desktopAppInfo() { return desktopAppInfo; },
        get oldRootDecisionRef() { return oldRootDecisionRef; },
        get isFirstDesktopInstall() { return isFirstDesktopInstall; },
        get bundledEnvZipExistsAtStartup() { return bundledEnvZipExistsAtStartup; },
        get runtimeRootExistedAtStartup() { return runtimeRootExistedAtStartup; },
        get runtimeRootAtProcessStart() { return runtimeRootAtProcessStart; },
        get firstInstallBootstrapNavigation() { return firstInstallBootstrapNavigation; },
        get showFileDialog() { return showFileDialog; },
        get showSaveDialog() { return showSaveDialog; },
        get showMessageBox() { return showMessageBox; },
        get showArchiveDialog() { return showArchiveDialog; },
        get openLogViewerWindow() { return openLogViewerWindow; },
        get closeLogViewerWindow() { return closeLogViewerWindow; },
        get minimizeLogViewerWindow() { return minimizeLogViewerWindow; },
        get maximizeLogViewerWindow() { return maximizeLogViewerWindow; },
        get openAgentPlatformMonitorWindow() { return openAgentPlatformMonitorWindow; },
        get openAgentRealtimeInspectorWindow() { return openAgentRealtimeInspectorWindow; },
        get openDesktopActionWorkbenchWindow() { return openDesktopActionWorkbenchWindow; },
        get closeDesktopActionWorkbenchWindow() { return closeDesktopActionWorkbenchWindow; },
        get getServiceWebviewPreloadPath() { return getServiceWebviewPreloadPath; },
        get getServiceWebviewPreloadUrl() { return getServiceWebviewPreloadUrl; },
        get servicesRuntime() { return servicesRuntime; },
        get refreshPluginDesktopGlobalShortcuts() { return refreshPluginDesktopGlobalShortcuts; },
        get notifyServicesChanged() { return notifyServicesChanged; },
        get startNonCoreDesktopRuntime() { return startNonCoreDesktopRuntime; },
        get settingsRuntime() { return settingsRuntime; },
        appearanceRuntime,
        get buildApplicationMenu() { return buildApplicationMenu; },
        get captureDesktopScreenshotForWebview() { return captureDesktopScreenshotForWebview; },
        get reportRendererDiagnostic() { return reportRendererDiagnostic; },
        get emitAssistantAttachmentProgress() { return emitAssistantAttachmentProgress; },
        get captureAssistantScreenshot() { return captureAssistantScreenshot; }
      }, conversationShareFacade, getUpdatesRuntime)
    });
  }

  function start() {
    return runtimeEvents.startRuntimeEvents({
      get startupPlatform() { return startupPlatform; },
      get appState() { return appState; },
      get gotSingleInstanceLock() { return gotSingleInstanceLock; },
      get INSTALLER_SHUTDOWN_ARGS() { return INSTALLER_SHUTDOWN_ARGS; },
      get FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT() { return FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT; },
      get handleAppReady() { return handleAppReady; },
      get showMainWindow() { return showMainWindow; },
      get beginAppQuitWithoutConfirmation() { return beginAppQuitWithoutConfirmation; },
      get beginInstallerShutdown() { return beginInstallerShutdown; },
      get appShellRuntime() { return appShellRuntime; },
      get pluginBridgeRuntime() { return pluginBridgeRuntime; },
      get prepareQuitUi() { return prepareQuitUi; },
      get realtimeBroker() { return realtimeBroker; },
      get runShutdownCleanup() { return runShutdownCleanup; },
      get logsRuntime() { return logsRuntime; },
      get writeInstallerShutdownAcks() { return writeInstallerShutdownAcks; },
      get assistantRunWakeLock() { return assistantRunWakeLock; },
      get clearDesktopPetIdleResetTimer() { return clearDesktopPetIdleResetTimer; },
      get assistantBridgeRuntime() { return assistantBridgeRuntime; },
      get stopResourceDirectoryWatcher() { return stopResourceDirectoryWatcher; },
      get enterpriseChatRuntime() { return enterpriseChatRuntime; }
    });
  }

  function prepareQuitUi() {
    appShellRuntime.prepareQuitUi();
  }

  function beginAppQuitWithoutConfirmation() {
    return shutdownAssembly.beginAppQuitWithoutConfirmation({
      get appState() { return appState; },
      get prepareQuitUi() { return prepareQuitUi; }
    });
  }

  function beginInstallerShutdown(commandLine: string[]) {
    return shutdownAssembly.beginInstallerShutdown({
      get INSTALLER_SHUTDOWN_ARGS() { return INSTALLER_SHUTDOWN_ARGS; },
      get appState() { return appState; },
      get writeInstallerShutdownAck() { return writeInstallerShutdownAck; },
      get beginAppQuitWithoutConfirmation() { return beginAppQuitWithoutConfirmation; }
    }, commandLine);
  }

  function writeInstallerShutdownAck(
    ackPath: string,
    report: import("../../shared/shutdown").ShutdownReport
  ) { return shutdownAssembly.writeInstallerShutdownAck(ackPath, report); }

  function writeInstallerShutdownAcks(report: import("../../shared/shutdown").ShutdownReport) {
    return shutdownAssembly.writeInstallerShutdownAcks({
      get appState() { return appState; },
      get writeInstallerShutdownAck() { return writeInstallerShutdownAck; }
    }, report);
  }

  function requestAppQuit() {
    void appShellRuntime.confirmAndRequestAppQuit();
  }

  return { start };
}
