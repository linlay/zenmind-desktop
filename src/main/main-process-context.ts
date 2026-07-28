import type { MainAppState } from "./app-state";
import type { LogStreamSubscriptionRegistry } from "./logs/subscriptions";

export interface MainProcessContext {
  state: MainAppState;
  app: unknown;
  ipcMain: unknown;
  platform: NodeJS.Platform;
  shell: unknown;
  session: unknown;
  nativeTheme: unknown;
  webContents?: {
    fromId: (id: number) => any;
  };
}

export function createMainProcessContext(options: MainProcessContext): MainProcessContext {
  return options;
}

export interface DesktopActionContextDependencies {
  assistantBridge: unknown;
  navigate: (...args: any[]) => unknown;
  openLogViewer: (...args: any[]) => unknown;
  showFileDialog?: (...args: any[]) => unknown;
  callRendererAction: (...args: any[]) => unknown;
  confirmRendererAction?: (...args: any[]) => unknown;
  cdpIntegration: any;
  hasTunnelWebappSubscriber?: () => boolean;
  emitWebappChanged?: (...args: any[]) => unknown;
  desktopPet?: {
    refreshState: (...args: any[]) => unknown;
    showWindow: (...args: any[]) => unknown;
    hideWindow: (...args: any[]) => unknown;
    saveSettings: (...args: any[]) => unknown;
  };
}

export function createDesktopActionOptions(
  context: MainProcessContext,
  dependencies: DesktopActionContextDependencies
): any {
  return {
    app: context.app as any,
    assistantBridge: dependencies.assistantBridge as any,
    getMainWindow: () => context.state.mainWindow,
    getCurrentPageSnapshot: () => context.state.currentPageSnapshot,
    navigate: dependencies.navigate,
    openLogViewer: dependencies.openLogViewer,
    showFileDialog: dependencies.showFileDialog,
    callRendererAction: dependencies.callRendererAction,
    confirmRendererAction: dependencies.confirmRendererAction,
    executeCdpCommand: async (request: unknown) => {
      const gateway = dependencies.cdpIntegration.start();
      return gateway.executeCommand(request);
    },
    getKanbanRuntime: () => context.state.kanbanRuntime,
    hasTunnelWebappSubscriber: dependencies.hasTunnelWebappSubscriber,
    emitWebappChanged: dependencies.emitWebappChanged,
    desktopPet: dependencies.desktopPet
      ? {
          refreshState: () => dependencies.desktopPet?.refreshState(),
          saveSettings: (input: unknown) => dependencies.desktopPet?.saveSettings(input),
          show: () => dependencies.desktopPet?.showWindow(),
          hide: () => dependencies.desktopPet?.hideWindow()
        }
      : undefined
  };
}

export interface ShellIpcHandlerContextDependencies {
  showFileDialog: (...args: any[]) => unknown;
  revealPathInFileManager: (...args: any[]) => unknown;
  captureDesktopScreenshot?: (...args: any[]) => unknown;
  reportRendererDiagnostic: (...args: any[]) => unknown;
  openLogViewerWindow?: (...args: any[]) => unknown;
  issueAgentPlatformAccessToken?: (...args: any[]) => unknown;
  desktopLogStreamSubscriptions?: LogStreamSubscriptionRegistry;
  setGlobalSearchOverlayVisible?: (visible: boolean) => void;
}

export function createShellIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: ShellIpcHandlerContextDependencies
): any {
  return {
    platform: context.platform,
    app: context.app,
    mainWindow: context.state.mainWindow,
    showFileDialog: dependencies.showFileDialog,
    revealPathInFileManager: dependencies.revealPathInFileManager,
    captureDesktopScreenshot: dependencies.captureDesktopScreenshot,
    reportRendererDiagnostic: dependencies.reportRendererDiagnostic,
    openLogViewerWindow: dependencies.openLogViewerWindow,
    issueAgentPlatformAccessToken: dependencies.issueAgentPlatformAccessToken,
    desktopLogStreamSubscriptions: dependencies.desktopLogStreamSubscriptions,
    setGlobalSearchOverlayVisible: dependencies.setGlobalSearchOverlayVisible
  };
}

export interface AssistantIpcHandlerContextDependencies {
  assistantBridge: unknown;
  desktopActionOptions: unknown;
  reportRendererDiagnostic: (...args: any[]) => unknown;
  showFileDialog: (...args: any[]) => unknown;
  callAgentPlatform: (...args: any[]) => unknown;
  handleDesktopActionRequest: (...args: any[]) => unknown;
  DESKTOP_ACTION_DEFINITIONS: unknown;
  emitAssistantAttachmentProgress: (...args: any[]) => unknown;
  getAssistantSettings: (...args: any[]) => unknown;
  saveAssistantSettings: (...args: any[]) => unknown;
  getAgentPlatformMinimaxSettingsPublic: (...args: any[]) => unknown;
  resolveAssistantAttachmentPath: (...args: any[]) => unknown;
  createAssistantAttachmentFromPastedImage: (...args: any[]) => unknown;
  cancelAssistantAttachmentTask: (...args: any[]) => unknown;
  createAssistantAttachmentsFromFiles: (...args: any[]) => unknown;
  captureAssistantScreenshot: (...args: any[]) => unknown;
  openDesktopActionWorkbenchWindow: (...args: any[]) => unknown;
  closeDesktopActionWorkbenchWindow: (...args: any[]) => unknown;
}

export function createAssistantIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: AssistantIpcHandlerContextDependencies
): any {
  return {
    assistantBridge: dependencies.assistantBridge,
    assistantNavigationStatusClient: context.state.assistantNavigationStatusClient,
    desktopActionRendererRequests: context.state.desktopActionRendererRequests,
    desktopActionConfirmationRequests: context.state.desktopActionConfirmationRequests,
    desktopActionOptions: dependencies.desktopActionOptions,
    app: context.app,
    mainWindow: context.state.mainWindow,
    shell: context.shell,
    showFileDialog: dependencies.showFileDialog,
    callAgentPlatform: dependencies.callAgentPlatform,
    handleDesktopActionRequest: dependencies.handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS: dependencies.DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress: dependencies.emitAssistantAttachmentProgress,
    getAssistantSettings: dependencies.getAssistantSettings,
    saveAssistantSettings: dependencies.saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic: dependencies.getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath: dependencies.resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage: dependencies.createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask: dependencies.cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles: dependencies.createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot: dependencies.captureAssistantScreenshot,
    openDesktopActionWorkbenchWindow: dependencies.openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow: dependencies.closeDesktopActionWorkbenchWindow,
    platform: context.platform,
    getCurrentPageSnapshot: () => context.state.currentPageSnapshot,
    setCurrentPageSnapshot: (snapshot: unknown) => {
      context.state.currentPageSnapshot = snapshot as any;
    },
    getCopilotDevToolsTarget: () => context.state.copilotDevToolsTarget,
    setCopilotDevToolsTarget: (target: unknown) => {
      context.state.copilotDevToolsTarget = target as any;
    },
    getWebContentsById: (id: number) => context.webContents?.fromId(id),
    reportRendererDiagnostic: dependencies.reportRendererDiagnostic
  };
}

export interface ServicesIpcHandlerContextDependencies {
  listServices: (...args: any[]) => unknown;
  getServiceState: (...args: any[]) => unknown;
  getResponsiveServiceState?: (...args: any[]) => unknown;
  installBuiltinService: (...args: any[]) => unknown;
  initializeService: (...args: any[]) => unknown;
  startService: (...args: any[]) => unknown;
  stopService: (...args: any[]) => unknown;
  restartService: (...args: any[]) => unknown;
  readPluginSettings: (...args: any[]) => unknown;
  writePluginSettings: (...args: any[]) => unknown;
  openPluginSettingsPage: (...args: any[]) => unknown;
  refreshPluginGlobalShortcuts?: (...args: any[]) => unknown;
  readServiceConfig: (...args: any[]) => unknown;
  writeServiceConfig: (...args: any[]) => unknown;
  importServiceFile: (...args: any[]) => unknown;
  getServiceLogsMeta: (...args: any[]) => unknown;
  watchServiceLog: (...args: any[]) => unknown;
  readServiceLog: (...args: any[]) => unknown;
  runServiceMutation: (...args: any[]) => unknown;
  handleServiceStart: (...args: any[]) => unknown;
  showFileDialog: (...args: any[]) => unknown;
  showMessageBox?: (...args: any[]) => unknown;
  showArchiveDialog: (...args: any[]) => unknown;
  openLogViewerWindow: (...args: any[]) => unknown;
  closeLogViewerWindow: (...args: any[]) => unknown;
  minimizeLogViewerWindow: (...args: any[]) => unknown;
  maximizeLogViewerWindow: (...args: any[]) => unknown;
  openAgentPlatformMonitorWindow: (...args: any[]) => unknown;
  issueAgentPlatformAccessToken: (...args: any[]) => unknown;
  revealPathInFileManager: (...args: any[]) => unknown;
  getServiceWebviewPreloadPath: (...args: any[]) => unknown;
  getServiceWebviewPreloadUrl: (...args: any[]) => unknown;
  startupRestoreController: unknown;
  importEnvZipToRuntime?: (...args: any[]) => unknown;
  applyDesktopInitBootstrap?: (...args: any[]) => unknown;
  refreshDesktopRuntimeConfigFromCanonicalFiles?: (...args: any[]) => unknown;
  loadBuiltinServices?: (...args: any[]) => unknown;
  loadInstalledPlugins?: (...args: any[]) => unknown;
  notifyServicesChanged?: (...args: any[]) => unknown;
  runStartupPreparation?: (...args: any[]) => unknown;
  logStreamSubscriptions: LogStreamSubscriptionRegistry;
  oldRootDecisionRef?: { current: "migrate" | "keep" | "cancel" | undefined };
  generateBackupDirName?: (...args: any[]) => unknown;
  migrateOldRootToBackup?: (...args: any[]) => unknown;
  shouldPromptEnvRootConflict?: (...args: any[]) => unknown;
  isFirstDesktopInstall?: boolean;
  bundledEnvZipExistsAtStartup?: boolean;
  runtimeRootExistedAtStartup?: boolean;
  runtimeRootAtProcessStart?: string;
}

export function createServicesIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: ServicesIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    shell: context.shell,
    platform: context.platform,
    listServices: dependencies.listServices,
    getServiceState: dependencies.getServiceState,
    getResponsiveServiceState: dependencies.getResponsiveServiceState,
    installBuiltinService: dependencies.installBuiltinService,
    initializeService: dependencies.initializeService,
    startService: dependencies.startService,
    stopService: dependencies.stopService,
    restartService: dependencies.restartService,
    readPluginSettings: dependencies.readPluginSettings,
    writePluginSettings: dependencies.writePluginSettings,
    openPluginSettingsPage: dependencies.openPluginSettingsPage,
    refreshPluginGlobalShortcuts: dependencies.refreshPluginGlobalShortcuts,
    readServiceConfig: dependencies.readServiceConfig,
    writeServiceConfig: dependencies.writeServiceConfig,
    importServiceFile: dependencies.importServiceFile,
    getServiceLogsMeta: dependencies.getServiceLogsMeta,
    watchServiceLog: dependencies.watchServiceLog,
    readServiceLog: dependencies.readServiceLog,
    runServiceMutation: dependencies.runServiceMutation,
    handleServiceStart: dependencies.handleServiceStart,
    showFileDialog: dependencies.showFileDialog,
    showMessageBox: dependencies.showMessageBox,
    showArchiveDialog: dependencies.showArchiveDialog,
    openLogViewerWindow: dependencies.openLogViewerWindow,
    closeLogViewerWindow: dependencies.closeLogViewerWindow,
    minimizeLogViewerWindow: dependencies.minimizeLogViewerWindow,
    maximizeLogViewerWindow: dependencies.maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow: dependencies.openAgentPlatformMonitorWindow,
    issueAgentPlatformAccessToken: dependencies.issueAgentPlatformAccessToken,
    revealPathInFileManager: dependencies.revealPathInFileManager,
    getServiceWebviewPreloadPath: dependencies.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: dependencies.getServiceWebviewPreloadUrl,
    logStreamSubscriptions: dependencies.logStreamSubscriptions,
    startupRestoreController: dependencies.startupRestoreController,
    importEnvZipToRuntime: dependencies.importEnvZipToRuntime,
    applyDesktopInitBootstrap: dependencies.applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles: dependencies.refreshDesktopRuntimeConfigFromCanonicalFiles,
    loadBuiltinServices: dependencies.loadBuiltinServices,
    loadInstalledPlugins: dependencies.loadInstalledPlugins,
    notifyServicesChanged: dependencies.notifyServicesChanged,
    runStartupPreparation: dependencies.runStartupPreparation,
    oldRootDecisionRef: dependencies.oldRootDecisionRef,
    generateBackupDirName: dependencies.generateBackupDirName,
    migrateOldRootToBackup: dependencies.migrateOldRootToBackup,
    shouldPromptEnvRootConflict: dependencies.shouldPromptEnvRootConflict,
    isFirstDesktopInstall: dependencies.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: dependencies.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: dependencies.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: dependencies.runtimeRootAtProcessStart,
    clearSessionCache: () => (context.session as any).defaultSession.clearCache()
  };
}

export interface MarketplaceIpcHandlerContextDependencies {
  t: (...args: any[]) => unknown;
  runServiceMutation: (...args: any[]) => unknown;
  showArchiveDialog: (...args: any[]) => unknown;
  showFileDialog: (...args: any[]) => unknown;
  showSaveDialog: (...args: any[]) => unknown;
  installPluginFromArchive: (...args: any[]) => unknown;
  handlePluginUninstall: (...args: any[]) => unknown;
  getMarketSettings: (...args: any[]) => unknown;
  saveMarketSettings: (...args: any[]) => unknown;
  listMarketItems: (...args: any[]) => unknown;
  refreshMarketCatalog: (...args: any[]) => unknown;
  toggleMarketFavorite: (...args: any[]) => unknown;
  installMarketItem: (...args: any[]) => unknown;
  updateMarketItem: (...args: any[]) => unknown;
  uninstallMarketItem: (...args: any[]) => unknown;
  buildSandboxImage: (...args: any[]) => unknown;
  deleteSandboxImage: (...args: any[]) => unknown;
  exportSandboxImageToPath: (...args: any[]) => unknown;
  importSandboxImageFromPath: (...args: any[]) => unknown;
  importSkillFromPath: (...args: any[]) => unknown;
  importSkillFromCommand: (...args: any[]) => unknown;
  onMarketCommandResult?: (...args: any[]) => unknown;
}

export function createMarketplaceIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: MarketplaceIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    platform: context.platform,
    mainWindow: context.state.mainWindow,
    t: dependencies.t,
    runServiceMutation: dependencies.runServiceMutation,
    showArchiveDialog: dependencies.showArchiveDialog,
    showFileDialog: dependencies.showFileDialog,
    showSaveDialog: dependencies.showSaveDialog,
    clearSessionCache: () => (context.session as any).defaultSession.clearCache(),
    installPluginFromArchive: dependencies.installPluginFromArchive,
    handlePluginUninstall: dependencies.handlePluginUninstall,
    getMarketSettings: dependencies.getMarketSettings,
    saveMarketSettings: dependencies.saveMarketSettings,
    listMarketItems: dependencies.listMarketItems,
    refreshMarketCatalog: dependencies.refreshMarketCatalog,
    toggleMarketFavorite: dependencies.toggleMarketFavorite,
    installMarketItem: dependencies.installMarketItem,
    updateMarketItem: dependencies.updateMarketItem,
    uninstallMarketItem: dependencies.uninstallMarketItem,
    buildSandboxImage: dependencies.buildSandboxImage,
    deleteSandboxImage: dependencies.deleteSandboxImage,
    exportSandboxImageToPath: dependencies.exportSandboxImageToPath,
    importSandboxImageFromPath: dependencies.importSandboxImageFromPath,
    importSkillFromPath: dependencies.importSkillFromPath,
    importSkillFromCommand: dependencies.importSkillFromCommand,
    onMarketCommandResult: dependencies.onMarketCommandResult
  };
}

export interface SsoIpcHandlerContextDependencies {
  desktopSsoController: unknown;
  getDesktopSsoStatus: (...args: any[]) => unknown;
  startDesktopSsoLogin: (...args: any[]) => unknown;
  startDesktopSsoSiteTokenBridge: (...args: any[]) => unknown;
  logoutDesktopSso: (...args: any[]) => unknown;
  failDesktopSsoFlow: (...args: any[]) => unknown;
  cancelDesktopSsoLogin: (...args: any[]) => unknown;
  issueAgentAccessToken: (...args: any[]) => unknown;
  refreshKanbanConnection?: (...args: any[]) => unknown;
  stopTunnelHubRuntime?: (...args: any[]) => unknown;
  refreshEnterpriseChat?: (...args: any[]) => unknown;
  stopEnterpriseChat?: (...args: any[]) => unknown;
}

export function createSsoIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: SsoIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    desktopSsoController: dependencies.desktopSsoController,
    getDesktopSsoStatus: dependencies.getDesktopSsoStatus,
    startDesktopSsoLogin: dependencies.startDesktopSsoLogin,
    startDesktopSsoSiteTokenBridge: dependencies.startDesktopSsoSiteTokenBridge,
    logoutDesktopSso: dependencies.logoutDesktopSso,
    failDesktopSsoFlow: dependencies.failDesktopSsoFlow,
    cancelDesktopSsoLogin: dependencies.cancelDesktopSsoLogin,
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    refreshKanbanConnection: dependencies.refreshKanbanConnection,
    stopTunnelHubRuntime: dependencies.stopTunnelHubRuntime,
    refreshEnterpriseChat: dependencies.refreshEnterpriseChat,
    stopEnterpriseChat: dependencies.stopEnterpriseChat
  };
}

export interface KanbanIpcHandlerContextDependencies {
  listKanbanIssues: (...args: any[]) => unknown;
  resyncKanbanCloud: (...args: any[]) => unknown;
  getKanbanSettings: (...args: any[]) => unknown;
  saveKanbanSettings: (...args: any[]) => unknown;
  createKanbanIssue: (...args: any[]) => unknown;
  updateKanbanIssue: (...args: any[]) => unknown;
  deleteKanbanIssueWithAutomation: (...args: any[]) => unknown;
  moveKanbanIssue: (...args: any[]) => unknown;
  syncKanbanIssueAutomation: (...args: any[]) => unknown;
  callAgentPlatform: (...args: any[]) => unknown;
  getKanbanCloudConfig: (...args: any[]) => unknown;
  saveKanbanCloudConfig: (...args: any[]) => unknown;
}

export function createKanbanIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: KanbanIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    listKanbanIssues: dependencies.listKanbanIssues,
    resyncKanbanCloud: dependencies.resyncKanbanCloud,
    getKanbanSettings: dependencies.getKanbanSettings,
    saveKanbanSettings: dependencies.saveKanbanSettings,
    getKanbanCloudConfig: dependencies.getKanbanCloudConfig,
    saveKanbanCloudConfig: dependencies.saveKanbanCloudConfig,
    createKanbanIssue: dependencies.createKanbanIssue,
    updateKanbanIssue: dependencies.updateKanbanIssue,
    deleteKanbanIssueWithAutomation: dependencies.deleteKanbanIssueWithAutomation,
    moveKanbanIssue: dependencies.moveKanbanIssue,
    syncKanbanIssueAutomation: dependencies.syncKanbanIssueAutomation,
    callAgentPlatform: dependencies.callAgentPlatform
  };
}

export interface DesktopPetIpcHandlerContextDependencies {
  clearActiveRuns: (...args: any[]) => unknown;
  showWindow: (...args: any[]) => unknown;
  hideWindow: (...args: any[]) => unknown;
  openAssistant: (...args: any[]) => unknown;
  openTaskChat: (...args: any[]) => unknown;
  moveWindowBy: (...args: any[]) => unknown;
  beginDrag: (...args: any[]) => unknown;
  endDrag: (...args: any[]) => unknown;
  setPreviewExpanded: (...args: any[]) => unknown;
  dismissPreview: (...args: any[]) => unknown;
  setMouseInteractive: (...args: any[]) => unknown;
  setWindowMode: (...args: any[]) => unknown;
  scheduleStatusRefresh: (...args: any[]) => unknown;
  refreshState: (...args: any[]) => unknown;
  replyMessage: (...args: any[]) => unknown;
  dismissMessage: (...args: any[]) => unknown;
}

export function createDesktopPetIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: DesktopPetIpcHandlerContextDependencies
): any {
  return {
    platform: context.platform,
    app: context.app,
    getSettings: () => context.state.desktopPetSettings,
    saveSettingsInState: (settings: unknown) => {
      context.state.desktopPetSettings = settings as any;
    },
    setAgentStatus: (status: unknown) => {
      context.state.desktopPetAgentStatus = status as any;
    },
    clearActiveRuns: dependencies.clearActiveRuns,
    showWindow: dependencies.showWindow,
    hideWindow: dependencies.hideWindow,
    openAssistant: dependencies.openAssistant,
    openTaskChat: dependencies.openTaskChat,
    moveWindowBy: dependencies.moveWindowBy,
    beginDrag: dependencies.beginDrag,
    endDrag: dependencies.endDrag,
    setPreviewExpanded: dependencies.setPreviewExpanded,
    dismissPreview: dependencies.dismissPreview,
    setMouseInteractive: dependencies.setMouseInteractive,
    setWindowMode: dependencies.setWindowMode,
    scheduleStatusRefresh: dependencies.scheduleStatusRefresh,
    refreshState: dependencies.refreshState,
    replyMessage: dependencies.replyMessage,
    dismissMessage: dependencies.dismissMessage,
    getWindow: () => context.state.desktopPetWindow,
    getPanelWindow: () => context.state.desktopPetPanelWindow
  };
}

export interface SettingsIpcHandlerContextDependencies {
  getDataRoot: (...args: any[]) => unknown;
  resetRuntimeEnv: (...args: any[]) => unknown;
  initializeMainI18n: (...args: any[]) => unknown;
  isSupportedLocale: (...args: any[]) => unknown;
  setMainLocale: (...args: any[]) => unknown;
  getAppInfo?: (...args: any[]) => unknown;
  buildApplicationMenu: (...args: any[]) => unknown;
  refreshTrayContextMenu: (...args: any[]) => unknown;
  refreshMainWindowAppearance?: (...args: any[]) => unknown;
  emitLocaleChanged: (...args: any[]) => unknown;
  createAppPairingPayload?: (...args: any[]) => unknown;
  onGeneralSettingsChanged?: (...args: any[]) => unknown;
  getDesktopWsServerRuntimeState?: (...args: any[]) => unknown;
  startDesktopWsServer?: (...args: any[]) => unknown;
  stopDesktopWsServer?: (...args: any[]) => unknown;
  applyTunnelHubSettings?: (...args: any[]) => unknown;
  getTunnelHubRuntimeStatus?: (...args: any[]) => unknown;
}

export function createSettingsIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: SettingsIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    platform: context.platform,
    nativeTheme: context.nativeTheme,
    getDataRoot: dependencies.getDataRoot,
    resetRuntimeEnv: dependencies.resetRuntimeEnv,
    initializeMainI18n: dependencies.initializeMainI18n,
    isSupportedLocale: dependencies.isSupportedLocale,
    setMainLocale: dependencies.setMainLocale,
    getAppInfo: dependencies.getAppInfo ?? (() => ({
      productName: "",
      version: "",
      buildTime: ""
    })),
    buildApplicationMenu: dependencies.buildApplicationMenu,
    refreshTrayContextMenu: dependencies.refreshTrayContextMenu,
    refreshMainWindowAppearance: dependencies.refreshMainWindowAppearance,
    emitLocaleChanged: dependencies.emitLocaleChanged,
    createAppPairingPayload: dependencies.createAppPairingPayload,
    onGeneralSettingsChanged: dependencies.onGeneralSettingsChanged,
    getDesktopWsServerRuntimeState: dependencies.getDesktopWsServerRuntimeState,
    startDesktopWsServer: dependencies.startDesktopWsServer,
    stopDesktopWsServer: dependencies.stopDesktopWsServer,
    applyTunnelHubSettings: dependencies.applyTunnelHubSettings,
    getTunnelHubRuntimeStatus: dependencies.getTunnelHubRuntimeStatus
  };
}
