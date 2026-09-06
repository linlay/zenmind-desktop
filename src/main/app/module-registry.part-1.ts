import type { App, BrowserWindow, WebContents } from "electron";

import path from "node:path";

import type {
  CopilotDevToolsTarget,
  DesktopPageContextSnapshot,
  MarketListResult
} from "../../shared/contracts";

import { createAppPairingPayload } from "../modules/identity";


import {
  cancelDesktopSsoLogin,
  failDesktopSsoFlow,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  logoutDesktopSso,
  startDesktopSsoLogin
} from "../modules/identity";

import { loadBuiltinServices } from "../modules/services";

import {
  getServiceLogsMeta,
  readServiceLog,
  watchServiceLog,
  getServiceState,
  getResponsiveServiceState,
  initializeService,
  importEnvZipIntoExistingRuntime,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  runStartupPreparation,
  startService,
  stopService,
  writeServiceConfig
} from "../modules/services";

import {
  emitPluginBridgeHook,
  getPluginGlobalShortcutStatuses,
  installPluginFromArchive,
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

import { getAgentPlatformMinimaxSettingsPublic } from "../modules/agent-platform";

import {
  ContainerHubClient,
  getAssistantSettings,
  saveAssistantSettings
} from "../modules/assistant";

import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "../modules/assistant";

import {
  callAgentPlatform,
  handleAgentWebclientWorkPanelActionRequest,
  handleDesktopActionRequest
} from "../modules/desktop-actions";

import {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade
} from "./bootstrap/desktop-init";

import {
  generateBackupDirName,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  runtimeEnvExists,
  shouldPromptEnvRootConflict
} from "../infrastructure/filesystem/runtime-environment";

import { getDataRoot } from "../infrastructure/filesystem/user-paths";

import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues
} from "../modules/plugins";

import { t, initializeMainI18n, setMainLocale } from "../support/i18n/main-i18n";

import { isSupportedLocale } from "../../shared/i18n";

import { DESKTOP_ACTION_DEFINITIONS } from "../../shared/desktop-actions";

import { applyTunnelHubSettings, getTunnelHubRuntimeStatus, stopTunnelHubRuntime } from "../modules/tunnel";

import type { AssistantBridgeRuntime } from "../modules/assistant";

import type { AssistantRunWakeLock } from "../modules/assistant";

import type { DesktopPetRuntime } from "../modules/pet";

import type { LogsRuntime } from "../support/logging/runtime";

import { registerAssistantIpcHandlers } from "../modules/assistant";

import { registerDesktopPetIpcHandlers } from "../modules/pet";

import { registerMarketplaceIpcHandlers } from "../modules/marketplace";

import { registerServicesIpcHandlers } from "../modules/services";
import type { ServicesFacade } from "../modules/services";

import { registerSettingsIpcHandlers } from "../modules/settings";

import { registerShellIpcHandlers } from "../modules/shell";

import { registerSsoIpcHandlers } from "../modules/identity";

import { registerKanbanIpcHandlers } from "../modules/kanban";

import { registerTunnelHubIpcHandlers } from "../modules/tunnel";

import { registerWebIpcHandlers } from "../modules/webs";
import type { WebsFacade } from "../modules/webs";

import { registerEmbeddedCdpIpcHandlers } from "../modules/web-surfaces";

import { registerAgentWebclientBridgeIpcHandlers } from "../modules/agent-platform";

import { registerCanonicalChatSyncIpc } from "../modules/agent-platform";

import type { BrowserSurfaceRegistry } from "../modules/web-surfaces";

import type { EnterpriseChatRuntime } from "../modules/enterprise-chat";

import { registerEnterpriseChatIpcHandlers } from "../modules/enterprise-chat";

import { registerHelpIpcHandlers } from "../modules/settings";

import { registerSidebarContextMenuIpcHandlers } from "../modules/web-surfaces";

import { registerChatWorkPanelTabContextMenuIpcHandlers } from "../modules/work-panel";

import {
  normalizeChatWorkPanelOpenLocalResourceRequest,
  registerChatWorkPanelLocalFileIpcHandlers,
  resolveWorkPanelLocalFileFromWorkspace,
} from "../modules/work-panel";

import {
  registerChatWorkPanelDocumentHtmlIpcHandlers,
  workPanelDocumentHtmlRegistry,
} from "../modules/work-panel";

import {
  registerChatWorkPanelResourceImageIpcHandlers,
  workPanelResourceImageRegistry,
} from "../modules/work-panel";

import { requireEpochMillis } from "../../shared/time-contract";

import type { AgentRealtimeDebugTarget } from "../../shared/contracts";
import type { ConversationShareFacade } from "../modules/conversation-share";

export const PLATFORM_DOCUMENT_REVISION_HEADER = "X-Document-Revision";

export type MainIpcRegistrationOptions = {
  app: App;
  issueAgentAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<any>;
  servicesFacade: ServicesFacade;
  websFacade: WebsFacade;
  conversationShareFacade: ConversationShareFacade;
  ipcMain: any;
  platform: NodeJS.Platform;
  shell: any;
  session: any;
  nativeTheme: any;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
  setCurrentPageSnapshot: (snapshot: DesktopPageContextSnapshot | null) => void;
  getCopilotDevToolsTarget: () => CopilotDevToolsTarget | null;
  setCopilotDevToolsTarget: (target: CopilotDevToolsTarget | null) => void;
  getWebContentsById: (id: number) => WebContents | undefined;
  setWorkPanelFullscreenActive: (active: boolean) => void;
  assistantBridgeRuntime: AssistantBridgeRuntime;
  assistantRunWakeLock: AssistantRunWakeLock;
  logsRuntime: LogsRuntime;
  petRuntime: DesktopPetRuntime;
  browserSurfaces: BrowserSurfaceRegistry;
  isTrustedAgentWebclientSession: (sender: WebContents) => boolean;
  enterpriseChatRuntime: EnterpriseChatRuntime;
  desktopSsoController: any;
  startupRestoreController: any;
  desktopAppInfo: any;
  oldRootDecisionRef: { current: "migrate" | "keep" | "cancel" | undefined };
  isFirstDesktopInstall: boolean;
  bundledEnvZipExistsAtStartup: boolean;
  runtimeRootExistedAtStartup: boolean;
  runtimeRootAtProcessStart: string;
  showFileDialog: (...args: any[]) => Promise<any>;
  showSaveDialog: (...args: any[]) => Promise<any>;
  showMessageBox: (...args: any[]) => Promise<any>;
  showArchiveDialog: (...args: any[]) => Promise<any>;
  openLogViewerWindow: (...args: any[]) => Promise<any>;
  closeLogViewerWindow: (...args: any[]) => unknown;
  minimizeLogViewerWindow: (...args: any[]) => unknown;
  maximizeLogViewerWindow: (...args: any[]) => unknown;
  openAgentPlatformMonitorWindow: (...args: any[]) => Promise<any>;
  openAgentRealtimeInspectorWindow: (...args: any[]) => Promise<any>;
  openDesktopActionWorkbenchWindow: (...args: any[]) => Promise<any> | any;
  closeDesktopActionWorkbenchWindow: (...args: any[]) => Promise<any> | any;
  revealPathInFileManager: (...args: any[]) => Promise<any>;
  getServiceWebviewPreloadPath: () => string;
  getServiceWebviewPreloadUrl: () => string;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  handleServiceStart: (serviceId: any) => Promise<any>;
  refreshPluginDesktopGlobalShortcuts: () => unknown;
  notifyServicesChanged: () => void;
  onStartupPreparationSucceeded: () => void;
  onStartupPreparationBlocked: () => void;
  refreshDesktopRuntimeConfigFromCanonicalFiles: (reason: string) => void;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  refreshMainWindowAppearance: () => void;
  setGlobalSearchOverlayVisible: (visible: boolean) => void;
  setWebviewModalOverlayVisible: (sourceId: string, visible: boolean) => void;
  emitLocaleChanged: (...args: any[]) => unknown;
  captureDesktopScreenshotForWebview: () => Promise<any> | any;
  reportRendererDiagnostic: (...args: any[]) => unknown;
  emitAssistantAttachmentProgress: (...args: any[]) => unknown;
  captureAssistantScreenshot: (...args: any[]) => unknown;
  consumeFirstInstallBootstrapNavigation: () => { shouldOpen: boolean };
};

export function sanitizeRealtimeDiagnosticUrl(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "file:") return "file:///(redacted)";
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return `${parsed.protocol}(redacted)`;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 512);
  } catch {
    return normalized.split(/[?#]/u, 1)[0].slice(0, 512);
  }
}

export function createAgentRealtimeRuntimeDiagnostics(
  app: App,
  browserSurfaces: BrowserSurfaceRegistry,
) {
  const webContentsSnapshots = browserSurfaces.listWebContentsDiagnostics();
  const webContentsById = new Map(webContentsSnapshots.map((contents) => [contents.webContentsId, contents]));
  const claimedWebContentsIds = new Set<number>();
  const surfaces = browserSurfaces.listDiagnosticSurfaces();
  const targets: AgentRealtimeDebugTarget[] = surfaces.flatMap((surface): AgentRealtimeDebugTarget[] => {
    if (surface.tabs.length === 0) {
      return [{
        targetId: `surface:${surface.registrationId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        url: sanitizeRealtimeDiagnosticUrl(surface.pageRoute || surface.url),
        title: surface.label,
        active: surface.active,
        loading: false,
        crashed: false,
        devToolsOpened: false,
        backgroundThrottling: true,
        orphaned: false,
      }];
    }
    return surface.tabs.map((tab) => {
      claimedWebContentsIds.add(tab.webContentsId);
      const contents = webContentsById.get(tab.webContentsId);
      return {
        targetId: `surface:${surface.registrationId}:${tab.tabId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.tabs.length > 1 ? tab.title || surface.label : surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        webContentsId: tab.webContentsId,
        ...(contents ? { webContentsType: contents.type, pid: contents.osProcessId } : {}),
        url: sanitizeRealtimeDiagnosticUrl(tab.currentUrl || surface.pageRoute || surface.url),
        title: tab.title || surface.label,
        active: surface.active && surface.activeTabId === tab.tabId,
        loading: contents?.loading ?? tab.isLoading,
        crashed: contents?.crashed ?? false,
        devToolsOpened: contents?.devToolsOpened ?? false,
        backgroundThrottling: contents?.backgroundThrottling ?? true,
        orphaned: false,
      };
    });
  });
  for (const contents of webContentsSnapshots) {
    if (claimedWebContentsIds.has(contents.webContentsId)) continue;
    const orphaned = contents.type === "webview";
    targets.push({
      targetId: `webcontents:${contents.webContentsId}`,
      label: contents.title || `${contents.type} ${contents.webContentsId}`,
      webContentsId: contents.webContentsId,
      webContentsType: contents.type,
      pid: contents.osProcessId,
      url: sanitizeRealtimeDiagnosticUrl(contents.url),
      title: contents.title,
      active: false,
      loading: contents.loading,
      crashed: contents.crashed,
      devToolsOpened: contents.devToolsOpened,
      backgroundThrottling: contents.backgroundThrottling,
      orphaned,
    });
  }
  const targetCountByPid = new Map<number, number>();
  for (const target of targets) {
    if (typeof target.pid !== "number" || target.pid <= 0) continue;
    targetCountByPid.set(target.pid, (targetCountByPid.get(target.pid) || 0) + 1);
  }
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    ...(metric.name ? { name: metric.name } : {}),
    ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
    cpuPercent: metric.cpu.percentCPUUsage,
    creationTime: metric.creationTime,
    ...(typeof metric.sandboxed === "boolean" ? { sandboxed: metric.sandboxed } : {}),
    workingSetBytes: metric.memory.workingSetSize * 1024,
    peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
    ...(typeof metric.memory.privateBytes === "number"
      ? { privateBytes: metric.memory.privateBytes * 1024 }
      : {}),
    targetCount: targetCountByPid.get(metric.pid) || 0,
  }));
  return {
    surfaceCount: new Set(surfaces.map((surface) => surface.surfaceId)).size,
    webviewCount: webContentsSnapshots.filter((contents) => contents.type === "webview").length,
    orphanWebviewCount: targets.filter((target) => target.orphaned).length,
    totalWorkingSetBytes: processes.reduce((total, item) => total + item.workingSetBytes, 0),
    processes,
    targets,
  };
}
