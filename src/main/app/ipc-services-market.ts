import type { MarketListResult } from "../../shared/contracts";
import { getDesktopSsoAccessToken, isDesktopSsoCredentialRuntimeReady } from "../modules/identity";
import { loadBuiltinServices } from "../modules/services";
import { importEnvZipIntoExistingRuntime } from "../modules/services";
import {
  emitPluginBridgeHook,
  getPluginGlobalShortcutStatuses,
  createPluginLifecycle,
  invokePluginDesktopAction,
  loadInstalledPlugins
} from "../modules/plugins";
import { handlePluginUninstall } from "../modules/plugins";
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
  mergeMcpRuntimeStatuses,
  refreshMarketCatalog,
  saveMarketSettings,
  toggleMarketFavorite,
  uninstallMarketItem,
  updateMarketItem
} from "../modules/marketplace";
import { ContainerHubClient } from "../modules/assistant";
import { applyDesktopInitBootstrap, applyDesktopInitVersionUpgrade } from "./bootstrap/desktop-init";
import {
  generateBackupDirName,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  runtimeEnvExists,
  shouldPromptEnvRootConflict
} from "../infrastructure/filesystem/runtime-environment";
import { openPluginSettingsPage, readPluginSettingsSnapshot, writePluginSettingsValues } from "../modules/plugins";
import { t } from "../support/i18n/main-i18n";
import { registerMarketplaceIpcHandlers } from "../modules/marketplace";
import { registerServicesIpcHandlers } from "../modules/services";
import { MainIpcRegistrationOptions } from "./ipc-registration-contracts";

export function registerServiceMarketIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
    logsRuntime,
    petRuntime
  } = options;
  const services = options.servicesFacade;
  const plugins = createPluginLifecycle(services, options.websFacade.webappManager);
  const { assistantBridge } = assistantBridgeRuntime;
  const withMarketplacePorts = (marketOptions: Record<string, unknown> = {}) => ({
    ...marketOptions,
    createContainerHubClient: (config: ConstructorParameters<typeof ContainerHubClient>[0]) =>
      new ContainerHubClient(config),
    webs: options.websFacade,
    plugins
  });

  async function mergeMarketMcpStatuses(result: MarketListResult): Promise<MarketListResult> {
    if (!result.items.some((item) => item.type === "mcp" && item.installPath)) {
      return result;
    }
    try {
      return {
        ...result,
        items: mergeMcpRuntimeStatuses(result.items, await assistantBridge.listMcpRuntimeStatuses())
      };
    } catch {
      return {
        ...result,
        items: result.items.map((item) => item.type === "mcp" && item.installPath
          ? {
            ...item,
            mcpRuntimeStatus: "unavailable" as const,
            mcpRuntimeMessage: t("market.main.platformMcpStatusUnavailable")
          }
          : item)
      };
    }
  }

  registerServicesIpcHandlers(ipcMain, {
    app,
    shell: options.shell,
    getMainWindow: options.getMainWindow,
    openBrowserExternal: url => options.shell.openExternal(url),
    platform: options.platform,
    listServices: services.listServices,
    getServiceState: services.getServiceState,
    getResponsiveServiceState: services.getResponsiveServiceState,
    installBuiltinService: services.installBuiltinService,
    initializeService: services.initializeService,
    startService: services.startService,
    stopService: services.stopService,
    restartService: services.restartService,
    readPluginSettings: readPluginSettingsSnapshot,
    writePluginSettings: writePluginSettingsValues,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts: options.refreshPluginDesktopGlobalShortcuts,
    emitPluginBridgeHook,
    getPluginGlobalShortcutStatuses,
    invokePluginDesktopAction,
    readServiceConfig: services.readServiceConfig,
    writeServiceConfig: services.writeServiceConfig,
    importServiceFile: services.importServiceFile,
    getServiceLogsMeta: services.getServiceLogsMeta,
    watchServiceLog: services.watchServiceLog,
    readServiceLog: services.readServiceLog,
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
    issueAgentPlatformAccessToken: options.issueAgentAccessToken,
    revealPathInFileManager: options.revealPathInFileManager,
    getServiceWebviewPreloadPath: options.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: options.getServiceWebviewPreloadUrl,
    startupRestoreController: options.startupRestoreController,
    importEnvZipToRuntime: importEnvZipToRuntime as any,
    importEnvZipIntoExistingRuntime: (targetApp, zipPath, desktopVersion, platform) =>
      importEnvZipIntoExistingRuntime(
        targetApp,
        zipPath,
        desktopVersion,
        platform,
        applyDesktopInitVersionUpgrade
      ),
    runtimeEnvExists,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged: options.notifyServicesChanged,
    onStartupPreparationSucceeded: options.onStartupPreparationSucceeded,
    onStartupPreparationBlocked: options.onStartupPreparationBlocked,
    runStartupPreparation: (targetApp, callbacks) => services.runStartupPreparation(targetApp, {
      ...callbacks,
      applyDesktopConfiguration: applyDesktopInitVersionUpgrade
    }),
    desktopVersion: options.desktopAppInfo.version,
    logStreamSubscriptions: logsRuntime.getServiceLogSubscriptions(),
    applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles: options.refreshDesktopRuntimeConfigFromCanonicalFiles,
    oldRootDecisionRef: options.oldRootDecisionRef,
    generateBackupDirName: generateBackupDirName as any,
    migrateOldRootToBackup: migrateOldRootToBackup as any,
    shouldPromptEnvRootConflict: shouldPromptEnvRootConflict as any,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: options.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: options.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: options.runtimeRootAtProcessStart,
    clearSessionCache: () => options.session.defaultSession.clearCache()
  });

  registerMarketplaceIpcHandlers(ipcMain, {
    app,
    platform: options.platform,
    mainWindow: options.getMainWindow(),
    getMainWindow: options.getMainWindow,
    t,
    runServiceMutation: options.runServiceMutation,
    showArchiveDialog: options.showArchiveDialog,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    clearSessionCache: () => options.session.defaultSession.clearCache(),
    installPluginFromArchive: plugins.installFromArchive,
    handlePluginUninstall: (targetApp, serviceId, ownerWindow, dialogOptions) =>
      handlePluginUninstall(targetApp, serviceId, ownerWindow, { ...dialogOptions, uninstall: plugins.uninstall }),
    getMarketSettings,
    saveMarketSettings,
    listMarketItems: async (marketApp, listOptions) => {
      const result = await listMarketItems(marketApp, withMarketplacePorts(listOptions));
      return mergeMarketMcpStatuses(result);
    },
    refreshMarketCatalog: async (marketApp, listOptions) => {
      const result = await refreshMarketCatalog(marketApp, withMarketplacePorts(listOptions));
      return mergeMarketMcpStatuses(result);
    },
    toggleMarketFavorite: (marketApp, input) => toggleMarketFavorite(marketApp, input, {
      issueAgentAccessToken: async (_app, reason) => {
        let token = isDesktopSsoCredentialRuntimeReady()
          ? getDesktopSsoAccessToken() || ""
          : "";
        if (reason === "unauthorized" || !token) {
          token = await options.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded?.(true) || "";
        }
        return {
          ok: Boolean(token),
          token,
          message: token ? "Desktop SSO access token ready." : "Sign in before using Market favorites."
        };
      }
    }),
    installMarketItem: (marketApp, itemId) => installMarketItem(marketApp, itemId, withMarketplacePorts()),
    updateMarketItem: (marketApp, itemId) => updateMarketItem(marketApp, itemId, withMarketplacePorts()),
    uninstallMarketItem: (marketApp, itemId) =>
      uninstallMarketItem(marketApp, itemId, withMarketplacePorts()),
    buildSandboxImage: (marketApp, itemId) => buildSandboxImage(marketApp, itemId, withMarketplacePorts()),
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
  });

}
