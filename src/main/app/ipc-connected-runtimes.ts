import { createAppPairingPayload } from "../modules/identity";
import {
  cancelDesktopSsoLogin,
  failDesktopSsoFlow,
  getDesktopSsoStatus,
  logoutDesktopSso,
  startDesktopSsoLogin
} from "../modules/identity";
import { callAgentPlatform } from "../modules/desktop-actions";
import { resetBundledRuntimeEnv } from "../infrastructure/filesystem/runtime-environment";
import { getDataRoot } from "../infrastructure/filesystem/user-paths";
import { t, initializeMainI18n, setMainLocale } from "../support/i18n/main-i18n";
import { isSupportedLocale } from "../../shared/i18n";
import { applyTunnelHubSettings, getTunnelHubRuntimeStatus, stopTunnelHubRuntime } from "../modules/tunnel";
import { registerDesktopPetIpcHandlers } from "../modules/pet";
import { registerAppearanceIpcHandlers, registerSettingsIpcHandlers } from "../modules/settings";
import { registerSsoIpcHandlers } from "../modules/identity";
import { registerKanbanIpcHandlers } from "../modules/kanban";
import { registerTunnelHubIpcHandlers } from "../modules/tunnel";
import { registerWebIpcHandlers } from "../modules/webs";
import { registerEnterpriseChatIpcHandlers } from "../modules/enterprise-chat";
import { MainIpcRegistrationOptions } from "./ipc-registration-contracts";

export function registerConnectedRuntimeIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
    assistantRunWakeLock,
    petRuntime
  } = options;
  const { assistantBridge } = assistantBridgeRuntime;
  registerSsoIpcHandlers(ipcMain, {
    app,
    desktopSsoController: options.desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken: options.issueAgentAccessToken,
    refreshKanbanConnection: assistantBridgeRuntime.refreshKanbanDeviceInfo,
    stopTunnelHubRuntime,
    refreshEnterpriseChat: () => options.enterpriseChatRuntime.refresh(),
    stopEnterpriseChat: () => options.enterpriseChatRuntime.handleSignedOut()
  });

  registerEnterpriseChatIpcHandlers(
    ipcMain,
    options.enterpriseChatRuntime,
    assistantBridge
  );

  registerTunnelHubIpcHandlers(ipcMain);

  registerKanbanIpcHandlers(ipcMain, {
    app,
    listKanbanIssues: () => assistantBridgeRuntime.getKanbanRuntime()?.listIssues() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    resyncKanbanCloud: () => assistantBridgeRuntime.getKanbanRuntime()?.resyncCloudBoard() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: [],
      connectionState: "disabled"
    },
    saveLocalWorkflows: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.saveLocalWorkflows(input) ?? { ok: false, message: t("kanban.runtime.uninitialized"), issues: [] },
    getKanbanSettings: () => assistantBridgeRuntime.getKanbanRuntime()?.getSettings() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    saveKanbanSettings: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.saveSettings(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      settings: {
        enabled: false,
        cloud: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    getKanbanCloudConfig: () => assistantBridgeRuntime.getKanbanRuntime()?.getCloudConfig() ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    saveKanbanCloudConfig: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.saveCloudConfig(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      config: { serverUrl: "", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    createKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.createIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    updateKanbanIssue: (_app: any, issueId: string, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.updateIssue(issueId, input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    deleteKanbanIssueWithAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      assistantBridgeRuntime.getKanbanRuntime()?.deleteIssueWithAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    moveKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.moveIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    claimKanbanIssue: (_app: any, issueId: string) => assistantBridgeRuntime.getKanbanRuntime()?.claimIssue(issueId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    runKanbanIssue: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.runIssue(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized"),
      issues: []
    },
    bindKanbanHumanReferenceChat: (_app: any, input: any) => assistantBridgeRuntime.getKanbanRuntime()?.bindHumanReferenceChat(input) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    unbindKanbanHumanReferenceChat: (_app: any, issueChatId: string) => assistantBridgeRuntime.getKanbanRuntime()?.unbindHumanReferenceChat(issueChatId) ?? {
      ok: false,
      message: t("kanban.runtime.uninitialized")
    },
    syncKanbanIssueAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      assistantBridgeRuntime.getKanbanRuntime()?.syncIssueAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: t("kanban.runtime.uninitialized"),
        issues: []
      },
    callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
      ...requestOptions,
      issueAgentAccessToken: options.issueAgentAccessToken
    })
  });

  registerWebIpcHandlers(ipcMain, {
    app,
    websFacade: options.websFacade,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    getDataRoot,
    emitWebappChanged: assistantBridgeRuntime.emitWebappChanged
  });

  registerDesktopPetIpcHandlers(ipcMain, {
    platform: options.platform,
    app,
    getSettings: petRuntime.getSettings,
    saveSettingsInState: petRuntime.saveSettings,
    getWindow: petRuntime.getWindow,
    getPanelWindow: petRuntime.getPanelWindow,
    showWindow: () => petRuntime.showWindow(),
    hideWindow: () => petRuntime.hideWindow(),
    openAssistant: () => petRuntime.openAssistant(),
    openTaskChat: (input: any) => petRuntime.openTaskChat(input),
    moveWindowBy: (delta: any) => petRuntime.moveWindowBy(delta),
    beginDrag: (point: any) => petRuntime.beginDrag(point),
    endDrag: () => petRuntime.endDrag(),
    setPreviewExpanded: (expanded: boolean) => petRuntime.setPreviewExpanded(expanded),
    dismissPreview: () => petRuntime.dismissPreview(),
    setMouseInteractive: (interactive: boolean) => petRuntime.setMouseInteractive(Boolean(interactive)),
    setWindowMode: (mode: unknown) => petRuntime.setWindowMode(mode),
    refreshState: () => petRuntime.refreshState(),
    replyMessage: (input: any) => petRuntime.replyMessage(assistantBridge, input),
    dismissMessage: (input: any) => petRuntime.dismissMessage(assistantBridge, input)
  });

  registerAppearanceIpcHandlers(ipcMain, { app, platform: options.platform, getMainWindow: options.getMainWindow });

  registerSettingsIpcHandlers(ipcMain, {
    app,
    platform: options.platform,
    nativeTheme: options.nativeTheme,
    getDataRoot,
    resetRuntimeEnv: resetBundledRuntimeEnv as any,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo: () => options.desktopAppInfo,
    buildApplicationMenu: options.buildApplicationMenu,
    refreshTrayContextMenu: options.refreshTrayContextMenu,
    refreshMainWindowAppearance: options.refreshMainWindowAppearance,
    emitLocaleChanged: options.emitLocaleChanged,
    createAppPairingPayload: (targetApp, pairingOptions) =>
      createAppPairingPayload(targetApp, { ...pairingOptions, issueAccessToken: options.issueAgentAccessToken }),
    onGeneralSettingsChanged: () => {
      assistantRunWakeLock.sync();
      assistantBridgeRuntime.refreshKanbanDeviceInfo();
    },
    onEnterpriseImSettingsChanged: (settings) => {
      void options.enterpriseChatRuntime.reloadConfiguration(settings.enabled);
    },
    getDesktopWsServerRuntimeState: assistantBridgeRuntime.getDesktopWsServerRuntimeStateForSettings,
    startDesktopWsServer: assistantBridgeRuntime.startDesktopWsServerForSettings,
    stopDesktopWsServer: assistantBridgeRuntime.stopDesktopWsServerForSettings,
    applyTunnelHubSettings,
    getTunnelHubRuntimeStatus
  });

}
