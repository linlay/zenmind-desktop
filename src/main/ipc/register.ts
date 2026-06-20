import type { App } from "electron";
import { createAppPairingPayload } from "../app-pairing";
import { issueAgentAccessToken } from "../agent-auth";
import {
  cancelDesktopSsoLogin,
  failDesktopSsoFlow,
  getDesktopSsoStatus,
  logoutDesktopSso,
  startDesktopSsoLogin,
  startDesktopSsoSiteTokenBridge
} from "../oidc-sso";
import { loadBuiltinServices } from "../builtin-loader";
import {
  getServiceLogsMeta,
  readServiceLog,
  watchServiceLog,
  getServiceState,
  getResponsiveServiceState,
  initializeService,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  runStartupPreparation,
  startService,
  stopService,
  writeServiceConfig
} from "../services/manager";
import { loadInstalledPlugins, installPluginFromArchive } from "../plugin-loader";
import { handlePluginUninstall } from "../plugin-uninstall";
import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  importSandboxImageFromPath,
  importSkillFromCommand,
  importSkillFromPath,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
  toggleMarketFavorite,
  uninstallMarketItem,
  updateMarketItem
} from "../marketplace";
import { getAgentPlatformMinimaxSettingsPublic } from "../assistant/core/agent-platform-config";
import {
  getAssistantSettings,
  saveAssistantSettings
} from "../assistant/core/settings-store";
import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "../assistant/attachments/attachment-store";
import { callAgentPlatform, handleDesktopActionRequest } from "../desktop-action-bridge";
import { applyDesktopInitBootstrap } from "../desktop-init-bootstrap";
import {
  generateBackupDirName,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  shouldPromptEnvRootConflict
} from "../env-bootstrap";
import { getDataRoot } from "../user-paths";
import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues
} from "../plugin-settings";
import { t, initializeMainI18n, setMainLocale } from "../i18n/main-i18n";
import { isSupportedLocale } from "../../shared/i18n";
import { DESKTOP_ACTION_DEFINITIONS } from "../../shared/desktop-actions";
import { applyTunnelHubSettings, stopTunnelHubRuntime } from "../tunnel-hub-runtime";
import {
  createAssistantIpcHandlerOptions,
  createDesktopPetIpcHandlerOptions,
  createMarketplaceIpcHandlerOptions,
  createServicesIpcHandlerOptions,
  createSettingsIpcHandlerOptions,
  createShellIpcHandlerOptions,
  createSsoIpcHandlerOptions,
  createTaskBoardIpcHandlerOptions,
  type MainProcessContext
} from "../main-process-context";
import type { AssistantBridgeRuntime } from "../bridge/assistant-runtime";
import type { AssistantRunWakeLock } from "../bridge/assistant-wake-lock";
import type { DesktopPetRuntime } from "../assistant/pet/runtime";
import type { LogsRuntime } from "../logs/runtime";
import { registerAssistantIpcHandlers } from "./assistant-handlers";
import { registerDesktopPetIpcHandlers } from "./desktop-pet-handlers";
import { registerMarketplaceIpcHandlers } from "./marketplace-handlers";
import { registerQuickCopilotIpcHandlers } from "../assistant/quick/ipc";
import { registerServicesIpcHandlers } from "./services-handlers";
import { registerSettingsIpcHandlers } from "./settings-handlers";
import { registerShellIpcHandlers } from "./shell-handlers";
import { registerSsoIpcHandlers } from "./sso-handlers";
import { registerTaskBoardIpcHandlers } from "./task-board-handlers";
import { registerTunnelHubIpcHandlers } from "./tunnel-hub-handlers";
import { registerWebIpcHandlers } from "./web-handlers";

export type MainIpcRegistrationOptions = {
  app: App;
  ipcMain: any;
  context: MainProcessContext;
  assistantBridgeRuntime: AssistantBridgeRuntime;
  assistantRunWakeLock: AssistantRunWakeLock;
  logsRuntime: LogsRuntime;
  petRuntime: DesktopPetRuntime;
  quickCopilotWindowController: any;
  desktopSsoController: any;
  startupRestoreController: any;
  desktopAppInfo: any;
  oldRootDecisionRef: { current: "migrate" | "keep" | "cancel" | undefined };
  isFirstDesktopInstall: boolean;
  bundledEnvZipExistsAtStartup: boolean;
  runtimeRootExistedAtStartup: boolean;
  runtimeRootAtProcessStart: string;
  showFileDialog: (...args: any[]) => unknown;
  showSaveDialog: (...args: any[]) => unknown;
  showMessageBox: (...args: any[]) => unknown;
  showArchiveDialog: (...args: any[]) => unknown;
  openLogViewerWindow: (...args: any[]) => unknown;
  closeLogViewerWindow: (...args: any[]) => unknown;
  minimizeLogViewerWindow: (...args: any[]) => unknown;
  maximizeLogViewerWindow: (...args: any[]) => unknown;
  openAgentPlatformMonitorWindow: (...args: any[]) => unknown;
  revealPathInFileManager: (...args: any[]) => unknown;
  getServiceWebviewPreloadPath: () => string;
  getServiceWebviewPreloadUrl: () => string;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  handleServiceStart: (serviceId: any) => Promise<any>;
  refreshPluginDesktopGlobalShortcuts: () => unknown;
  notifyServicesChanged: () => void;
  refreshDesktopRuntimeConfigFromCanonicalFiles: (reason: string) => void;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  emitLocaleChanged: (...args: any[]) => unknown;
  captureDesktopScreenshotForWebview: () => unknown;
  reportRendererDiagnostic: (...args: any[]) => unknown;
  emitAssistantAttachmentProgress: (...args: any[]) => unknown;
  captureAssistantScreenshot: (...args: any[]) => unknown;
};

export function registerMainIpcHandlers(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    context,
    assistantBridgeRuntime,
    assistantRunWakeLock,
    logsRuntime,
    petRuntime
  } = options;
  const state = context.state;
  const { assistantBridge, desktopActionOptions } = assistantBridgeRuntime;

  registerShellIpcHandlers(ipcMain, createShellIpcHandlerOptions(context, {
    showFileDialog: options.showFileDialog,
    revealPathInFileManager: options.revealPathInFileManager,
    captureDesktopScreenshot: options.captureDesktopScreenshotForWebview,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    openLogViewerWindow: options.openLogViewerWindow,
    issueAgentPlatformAccessToken: issueAgentAccessToken,
    desktopLogStreamSubscriptions: logsRuntime.getDesktopLogSubscriptions()
  }));

  registerAssistantIpcHandlers(ipcMain, createAssistantIpcHandlerOptions(context, {
    assistantBridge,
    desktopActionOptions,
    showFileDialog: options.showFileDialog,
    callAgentPlatform,
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress: options.emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot: options.captureAssistantScreenshot as any
  }));

  registerQuickCopilotIpcHandlers(ipcMain, options.quickCopilotWindowController);

  registerServicesIpcHandlers(ipcMain, createServicesIpcHandlerOptions(context, {
    listServices,
    getServiceState,
    getResponsiveServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readPluginSettings: readPluginSettingsSnapshot,
    writePluginSettings: writePluginSettingsValues,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts: options.refreshPluginDesktopGlobalShortcuts,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation: options.runServiceMutation,
    handleServiceStart: options.handleServiceStart,
    showFileDialog: options.showFileDialog,
    showMessageBox: options.showMessageBox,
    showArchiveDialog: options.showArchiveDialog,
    openLogViewerWindow: options.openLogViewerWindow,
    closeLogViewerWindow: options.closeLogViewerWindow,
    minimizeLogViewerWindow: options.minimizeLogViewerWindow,
    maximizeLogViewerWindow: options.maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow: options.openAgentPlatformMonitorWindow,
    issueAgentPlatformAccessToken: issueAgentAccessToken,
    revealPathInFileManager: options.revealPathInFileManager,
    getServiceWebviewPreloadPath: options.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: options.getServiceWebviewPreloadUrl,
    startupRestoreController: options.startupRestoreController,
    importEnvZipToRuntime,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged: options.notifyServicesChanged,
    runStartupPreparation,
    logStreamSubscriptions: logsRuntime.getServiceLogSubscriptions(),
    applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles: options.refreshDesktopRuntimeConfigFromCanonicalFiles,
    oldRootDecisionRef: options.oldRootDecisionRef,
    generateBackupDirName,
    migrateOldRootToBackup,
    shouldPromptEnvRootConflict,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: options.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: options.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: options.runtimeRootAtProcessStart
  }));

  registerMarketplaceIpcHandlers(ipcMain, createMarketplaceIpcHandlerOptions(context, {
    t,
    runServiceMutation: options.runServiceMutation,
    showArchiveDialog: options.showArchiveDialog,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    installPluginFromArchive,
    handlePluginUninstall,
    getMarketSettings,
    saveMarketSettings,
    listMarketItems,
    refreshMarketCatalog,
    toggleMarketFavorite: (marketApp, input) => toggleMarketFavorite(marketApp, input, { issueAgentAccessToken }),
    installMarketItem,
    updateMarketItem,
    uninstallMarketItem,
    buildSandboxImage,
    deleteSandboxImage,
    exportSandboxImageToPath,
    importSandboxImageFromPath,
    importSkillFromPath,
    importSkillFromCommand,
    onMarketCommandResult: (result) => {
      if (result?.type === "pet") {
        petRuntime.refreshState();
      }
      if (result?.type === "website-app") {
        options.notifyServicesChanged();
      }
    }
  }));

  registerSsoIpcHandlers(ipcMain, createSsoIpcHandlerOptions(context, {
    desktopSsoController: options.desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    startDesktopSsoSiteTokenBridge,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken,
    refreshTaskBoardConnection: () => state.taskBoardRuntime?.refreshDeviceInfo(),
    stopTunnelHubRuntime
  }));
  registerTunnelHubIpcHandlers(ipcMain);
  registerTaskBoardIpcHandlers(ipcMain, createTaskBoardIpcHandlerOptions(context, {
    listTaskBoardIssues: () => state.taskBoardRuntime?.listIssues() ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      issues: []
    },
    listTaskBoardOnlineDevices: () => state.taskBoardRuntime?.listOnlineDevices() ?? {
      ok: false,
      online: false,
      deviceCount: 0,
      sessionCount: 0,
      agentCount: 0,
      devices: [],
      message: t("taskBoard.runtime.uninitialized")
    },
    getTaskBoardSettings: () => state.taskBoardRuntime?.getSettings() ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    saveTaskBoardSettings: (_app: any, input: any) => state.taskBoardRuntime?.saveSettings(input) ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    getTaskBoardCloudConfig: () => state.taskBoardRuntime?.getCloudConfig() ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      config: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    saveTaskBoardCloudConfig: (_app: any, input: any) => state.taskBoardRuntime?.saveCloudConfig(input) ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      config: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    createTaskBoardIssue: (_app: any, input: any) => state.taskBoardRuntime?.createIssue(input) ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      issues: []
    },
    updateTaskBoardIssue: (_app: any, issueId: string, input: any) => state.taskBoardRuntime?.updateIssue(issueId, input) ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      issues: []
    },
    deleteTaskBoardIssueWithAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.taskBoardRuntime?.deleteIssueWithAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("taskBoard.runtime.uninitialized"),
        issues: []
      },
    moveTaskBoardIssue: (_app: any, input: any) => state.taskBoardRuntime?.moveIssue(input) ?? {
      ok: false,
      message: t("taskBoard.runtime.uninitialized"),
      issues: []
    },
    syncTaskBoardIssueAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.taskBoardRuntime?.syncIssueAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("taskBoard.runtime.uninitialized"),
        issues: []
      },
    callAgentPlatform
  }));
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    getDataRoot
  });
  registerDesktopPetIpcHandlers(ipcMain, createDesktopPetIpcHandlerOptions(context, {
    clearActiveRuns: () => petRuntime.clearActiveRuns(),
    showWindow: () => petRuntime.showWindow(),
    hideWindow: (disable: boolean) => petRuntime.hideWindow(disable),
    openAssistant: () => petRuntime.openAssistant(),
    openTaskChat: (input: any) => petRuntime.openTaskChat(input),
    moveWindowBy: (delta: any) => petRuntime.moveWindowBy(delta),
    beginDrag: (point: any) => petRuntime.beginDrag(point),
    endDrag: () => petRuntime.endDrag(),
    setPreviewExpanded: (expanded: boolean) => petRuntime.setPreviewExpanded(expanded),
    dismissPreview: () => petRuntime.dismissPreview(),
    setMouseInteractive: (interactive: boolean) => petRuntime.setMouseInteractive(Boolean(interactive)),
    setWindowMode: (mode: unknown) => petRuntime.setWindowMode(mode),
    scheduleStatusRefresh: (delayMs: number) => petRuntime.scheduleStatusRefresh(delayMs),
    refreshState: () => petRuntime.refreshState(),
    replyMessage: (input: any) => petRuntime.replyMessage(assistantBridge, input),
    dismissMessage: (input: any) => petRuntime.dismissMessage(input)
  }));
  registerSettingsIpcHandlers(ipcMain, createSettingsIpcHandlerOptions(context, {
    getDataRoot,
    resetRuntimeEnv: resetBundledRuntimeEnv,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo: () => options.desktopAppInfo,
    buildApplicationMenu: options.buildApplicationMenu,
    refreshTrayContextMenu: options.refreshTrayContextMenu,
    emitLocaleChanged: options.emitLocaleChanged,
    createAppPairingPayload,
    onGeneralSettingsChanged: () => {
      assistantRunWakeLock.sync();
      state.taskBoardRuntime?.refreshDeviceInfo();
    },
    getDesktopWsServerRuntimeState: assistantBridgeRuntime.getDesktopWsServerRuntimeStateForSettings,
    startDesktopWsServer: assistantBridgeRuntime.startDesktopWsServerForSettings,
    stopDesktopWsServer: assistantBridgeRuntime.stopDesktopWsServerForSettings,
    applyTunnelHubSettings
  }));
}
