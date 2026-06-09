import type { MainAppState } from "./app-state";

export interface MainProcessContext {
  state: MainAppState;
  app: unknown;
  ipcMain: unknown;
  platform: NodeJS.Platform;
  shell: unknown;
  session: unknown;
  nativeTheme: unknown;
}

export function createMainProcessContext(options: MainProcessContext): MainProcessContext {
  return options;
}

export interface DesktopActionContextDependencies {
  assistantBridge: unknown;
  navigate: (...args: any[]) => unknown;
  openLogViewer: (...args: any[]) => unknown;
  callRendererAction: (...args: any[]) => unknown;
  cdpIntegration: any;
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
    callRendererAction: dependencies.callRendererAction,
    executeCdpCommand: async (request: unknown) => {
      const gateway = dependencies.cdpIntegration.start();
      return gateway.executeCommand(request);
    }
  };
}

export interface ShellIpcHandlerContextDependencies {
  showFileDialog: (...args: any[]) => unknown;
  revealPathInFileManager: (...args: any[]) => unknown;
  reportRendererDiagnostic: (...args: any[]) => unknown;
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
    reportRendererDiagnostic: dependencies.reportRendererDiagnostic
  };
}

export interface AssistantIpcHandlerContextDependencies {
  assistantBridge: unknown;
  desktopActionOptions: unknown;
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
}

export function createAssistantIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: AssistantIpcHandlerContextDependencies
): any {
  return {
    assistantBridge: dependencies.assistantBridge,
    assistantNavigationStatusClient: context.state.assistantNavigationStatusClient,
    desktopActionRendererRequests: context.state.desktopActionRendererRequests,
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
    platform: context.platform,
    getCurrentPageSnapshot: () => context.state.currentPageSnapshot,
    setCurrentPageSnapshot: (snapshot: unknown) => {
      context.state.currentPageSnapshot = snapshot as any;
    }
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
  loadBuiltinServices?: (...args: any[]) => unknown;
  loadInstalledPlugins?: (...args: any[]) => unknown;
  notifyServicesChanged?: (...args: any[]) => unknown;
  runStartupPreparation?: (...args: any[]) => unknown;
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
    logStreamSubscriptions: context.state.logStreamSubscriptions,
    startupRestoreController: dependencies.startupRestoreController,
    importEnvZipToRuntime: dependencies.importEnvZipToRuntime,
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
  installMarketItem: (...args: any[]) => unknown;
  updateMarketItem: (...args: any[]) => unknown;
  uninstallMarketItem: (...args: any[]) => unknown;
  buildSandboxImage: (...args: any[]) => unknown;
  deleteSandboxImage: (...args: any[]) => unknown;
  exportSandboxImageToPath: (...args: any[]) => unknown;
  importSandboxImageFromPath: (...args: any[]) => unknown;
  importSkillFromPath: (...args: any[]) => unknown;
  importSkillFromCommand: (...args: any[]) => unknown;
  getPanAuthStatus: (...args: any[]) => unknown;
  importPanPrivateKey: (...args: any[]) => unknown;
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
    installMarketItem: dependencies.installMarketItem,
    updateMarketItem: dependencies.updateMarketItem,
    uninstallMarketItem: dependencies.uninstallMarketItem,
    buildSandboxImage: dependencies.buildSandboxImage,
    deleteSandboxImage: dependencies.deleteSandboxImage,
    exportSandboxImageToPath: dependencies.exportSandboxImageToPath,
    importSandboxImageFromPath: dependencies.importSandboxImageFromPath,
    importSkillFromPath: dependencies.importSkillFromPath,
    importSkillFromCommand: dependencies.importSkillFromCommand,
    getPanAuthStatus: dependencies.getPanAuthStatus,
    importPanPrivateKey: dependencies.importPanPrivateKey
  };
}

export interface SsoIpcHandlerContextDependencies {
  desktopSsoController: unknown;
  getDesktopSsoStatus: (...args: any[]) => unknown;
  startDesktopSsoLogin: (...args: any[]) => unknown;
  logoutDesktopSso: (...args: any[]) => unknown;
  failDesktopSsoFlow: (...args: any[]) => unknown;
  issueAgentAccessToken: (...args: any[]) => unknown;
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
    logoutDesktopSso: dependencies.logoutDesktopSso,
    failDesktopSsoFlow: dependencies.failDesktopSsoFlow,
    issueAgentAccessToken: dependencies.issueAgentAccessToken
  };
}

export interface TaskBoardIpcHandlerContextDependencies {
  listTaskBoardIssues: (...args: any[]) => unknown;
  listTaskBoardOnlineDevices: (...args: any[]) => unknown;
  createTaskBoardIssue: (...args: any[]) => unknown;
  updateTaskBoardIssue: (...args: any[]) => unknown;
  deleteTaskBoardIssueWithAutomation: (...args: any[]) => unknown;
  moveTaskBoardIssue: (...args: any[]) => unknown;
  syncTaskBoardIssueAutomation: (...args: any[]) => unknown;
  callAgentPlatform: (...args: any[]) => unknown;
  listCustomSidebarItems: (...args: any[]) => unknown;
  addCustomSidebarItem: (...args: any[]) => unknown;
  updateCustomSidebarItem: (...args: any[]) => unknown;
  removeCustomSidebarItem: (...args: any[]) => unknown;
  importCustomSidebarItems: (...args: any[]) => unknown;
  exportCustomSidebarItems: (...args: any[]) => unknown;
  showFileDialog: (...args: any[]) => unknown;
  showSaveDialog: (...args: any[]) => unknown;
  getDataRoot: (...args: any[]) => unknown;
  getTaskBoardCloudConfig: (...args: any[]) => unknown;
  saveTaskBoardCloudConfig: (...args: any[]) => unknown;
}

export function createTaskBoardIpcHandlerOptions(
  context: MainProcessContext,
  dependencies: TaskBoardIpcHandlerContextDependencies
): any {
  return {
    app: context.app,
    listTaskBoardIssues: dependencies.listTaskBoardIssues,
    listTaskBoardOnlineDevices: dependencies.listTaskBoardOnlineDevices,
    getTaskBoardCloudConfig: dependencies.getTaskBoardCloudConfig,
    saveTaskBoardCloudConfig: dependencies.saveTaskBoardCloudConfig,
    createTaskBoardIssue: dependencies.createTaskBoardIssue,
    updateTaskBoardIssue: dependencies.updateTaskBoardIssue,
    deleteTaskBoardIssueWithAutomation: dependencies.deleteTaskBoardIssueWithAutomation,
    moveTaskBoardIssue: dependencies.moveTaskBoardIssue,
    syncTaskBoardIssueAutomation: dependencies.syncTaskBoardIssueAutomation,
    callAgentPlatform: dependencies.callAgentPlatform,
    listCustomSidebarItems: () => dependencies.listCustomSidebarItems(context.app),
    addCustomSidebarItem: dependencies.addCustomSidebarItem,
    updateCustomSidebarItem: dependencies.updateCustomSidebarItem,
    removeCustomSidebarItem: dependencies.removeCustomSidebarItem,
    importCustomSidebarItems: dependencies.importCustomSidebarItems,
    exportCustomSidebarItems: dependencies.exportCustomSidebarItems,
    showFileDialog: dependencies.showFileDialog,
    showSaveDialog: dependencies.showSaveDialog,
    getDataRoot: dependencies.getDataRoot
  };
}

export interface DesktopPetIpcHandlerContextDependencies {
  clearActiveRuns: (...args: any[]) => unknown;
  showWindow: (...args: any[]) => unknown;
  hideWindow: (...args: any[]) => unknown;
  openAssistant: (...args: any[]) => unknown;
  moveWindowBy: (...args: any[]) => unknown;
  beginDrag: (...args: any[]) => unknown;
  endDrag: (...args: any[]) => unknown;
  setPreviewExpanded: (...args: any[]) => unknown;
  dismissPreview: (...args: any[]) => unknown;
  setMouseInteractive: (...args: any[]) => unknown;
  scheduleStatusRefresh: (...args: any[]) => unknown;
  refreshState: (...args: any[]) => unknown;
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
    moveWindowBy: dependencies.moveWindowBy,
    beginDrag: dependencies.beginDrag,
    endDrag: dependencies.endDrag,
    setPreviewExpanded: dependencies.setPreviewExpanded,
    dismissPreview: dependencies.dismissPreview,
    setMouseInteractive: dependencies.setMouseInteractive,
    scheduleStatusRefresh: dependencies.scheduleStatusRefresh,
    refreshState: dependencies.refreshState,
    getWindow: () => context.state.desktopPetWindow
  };
}

export interface SettingsIpcHandlerContextDependencies {
  getDataRoot: (...args: any[]) => unknown;
  initializeMainI18n: (...args: any[]) => unknown;
  isSupportedLocale: (...args: any[]) => unknown;
  setMainLocale: (...args: any[]) => unknown;
  buildApplicationMenu: (...args: any[]) => unknown;
  refreshTrayContextMenu: (...args: any[]) => unknown;
  emitLocaleChanged: (...args: any[]) => unknown;
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
    initializeMainI18n: dependencies.initializeMainI18n,
    isSupportedLocale: dependencies.isSupportedLocale,
    setMainLocale: dependencies.setMainLocale,
    buildApplicationMenu: dependencies.buildApplicationMenu,
    refreshTrayContextMenu: dependencies.refreshTrayContextMenu,
    emitLocaleChanged: dependencies.emitLocaleChanged
  };
}
