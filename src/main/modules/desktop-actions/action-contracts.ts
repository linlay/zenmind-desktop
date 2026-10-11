import type { DesktopPetImportResult, WorkPanelDocumentSource } from "../../../shared/contracts";
import type { DesktopAppearancePort } from "./appearance-port";
import { type App, type BrowserWindow, type WebContents, type OpenDialogOptions, type SaveDialogOptions } from "electron";
import {
  type AgentAuthIssueResult,
  type DesktopAppInfo,
  type DesktopRuntimeDiagnostics,
  type DesktopPageContextSnapshot,
  type ServiceOpenLogViewerRequest,
  type DesktopActionRendererRequest,
  type DesktopActionRendererResponse,
  type DesktopActionConfirmationRequest,
  type DesktopActionConfirmationResponse,
  type DesktopWebappChangedReason,
  type DesktopPetState
} from "../../../shared/contracts";
import { type AgentPlatformAssistantBridge } from "../agent-platform";
import { type ServicesFacade } from "../services";
import { type WebsFacade, publishWebapp, unpublishWebapp } from "../webs";
import { type EmbeddedCdpCommandRequest, type SiteControlScope } from "../web-surfaces";
import { type KanbanRuntime } from "../kanban";
import type { LocalDocumentActiveFile } from "../work-panel";
import { type DesktopActionSource, type DesktopActionError } from "../../../shared/desktop-actions";

export type DesktopActionBridgeOptions = {
  appearanceRuntime?: DesktopAppearancePort;
  app: App;
  issueAgentAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
  getAssistantSettings: (app: App) => { desktopHelperAgentKey: string };
  createContainerHubClient: (config: {
    baseURL: string;
    authToken?: string;
    timeoutMs?: number;
    defaultEnvironmentName?: string;
  }) => any;
  platform?: NodeJS.Platform;
  assistantBridge: AgentPlatformAssistantBridge;
  getDesktopAppInfo: () => DesktopAppInfo;
  getDesktopRuntimeDiagnostics: () => Promise<DesktopRuntimeDiagnostics>;
  services: Pick<
    ServicesFacade,
    | "resolveDesktopCapability"
    | "getResponsiveServiceState"
    | "getServiceLogsMeta"
    | "getServiceState"
    | "initializeService"
    | "installBuiltinService"
    | "listServices"
    | "readServiceLog"
    | "restartService"
    | "startService"
    | "stopService"
  >;
  webs: WebsFacade;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
  getWebContentsById?: (webContentsId: number) => WebContents | null;
  navigate: (targetPath: string) => void;
  getHelpUrl?: () => string;
  openLogViewer: (request: ServiceOpenLogViewerRequest) => Promise<{ ok: boolean }>;
  showFileDialog?: (
    options: OpenDialogOptions,
    ownerWindow?: BrowserWindow | null
  ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog?: (
    options: SaveDialogOptions,
    ownerWindow?: BrowserWindow | null
  ) => Promise<{ canceled: boolean; filePath?: string }>;
  openExternal?: (url: string) => Promise<unknown>;
  writeClipboardText?: (text: string) => void;
  getMicrophonePermission?: () => string;
  requestMicrophoneAccess?: () => Promise<boolean>;
  showNotification?: (input: {
    title: string;
    body: string;
    onClick: () => void;
  }) => boolean;
  callRendererAction: (request: DesktopActionRendererRequest) => Promise<DesktopActionRendererResponse>;
  resolveWorkPanelActiveFile?: (
    request: { chatId: string; agentKey: string; documentId: string },
    isSelectionCurrent: () => Promise<boolean>,
  ) => Promise<LocalDocumentActiveFile | null>;
  waitForWorkPanelFilePresentation?: (input: { chatId: string; agentKey: string }) => Promise<void>;
  prepareWorkPanelLocalFileClaim?: (input: {
    ownerChatId: string;
    rendererWebContentsId: number;
    filePath: string;
    workspaceRelativePath: string;
  }) => { claimId: string } | null;
  discardWorkPanelLocalFileClaim?: (claimId: string) => boolean;
  // The native HTML/image preview that the Agent WebClient bridge also uses.
  openWorkPanelDocument?: (input: {
    ownerChatId: string;
    document: { source: WorkPanelDocumentSource; title?: string };
  }) => Promise<{ ok: true; workspaceId: string; itemId: string } | { ok: false; error: { code: string; message: string } }>;
  actionSignal?: AbortSignal;
  actionDeadlineAt?: number;
  confirmRendererAction?: (request: DesktopActionConfirmationRequest, context?: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number }) => Promise<DesktopActionConfirmationResponse>;
  resolveWebSurface?: (request: EmbeddedCdpCommandRequest) => Promise<{
    surfaceId: string; containerId: string; surfaceKind: string; contents: WebContents; validate(): Promise<void>;
  }>;
  executeCdpCommand: (request: EmbeddedCdpCommandRequest, scope?: SiteControlScope, signal?: AbortSignal) => Promise<{
    surfaceId?: string;
    result: unknown;
  }>;
  getKanbanRuntime?: () => KanbanRuntime | null;
  publishWebapp?: typeof publishWebapp;
  unpublishWebapp?: typeof unpublishWebapp;
  webappToolingWorkerPath?: string;
  emitWebappChanged?: (reason: DesktopWebappChangedReason, webappId: string) => void;
  desktopPet?: {
    importPackage?: (filePath: string) => Promise<DesktopPetImportResult>;
    refreshState: () => DesktopPetState | Promise<DesktopPetState>;
    saveSettings: (input: { enabled?: boolean; appearanceId?: string }) => DesktopPetState | Promise<DesktopPetState>;
    show: () => DesktopPetState | Promise<DesktopPetState>;
    hide: () => DesktopPetState | Promise<DesktopPetState>;
  };
};

export type DesktopActionInvocationContext =
  | { kind: "desktop" }
  | { kind: "agentPlatform" }
  | { kind: "agentWebclientWorkPanel" }
  | { kind: "webappPage"; webappId: string; signal?: AbortSignal }
  | { kind: "webappBackend"; webappId: string; signal?: AbortSignal };

export type AgentWebclientWorkPanelAction = "openItem" | "activateItem" | "closeItem";

export const AGENT_WEBCLIENT_WORKPANEL_ACTIONS = new Set<string>([
  "openItem",
  "activateItem",
  "closeItem"
]);

export const AGENT_WEBCLIENT_WORKPANEL_DESKTOP_ACTIONS: Record<AgentWebclientWorkPanelAction, string> = {
  openItem: "desktop.workpanel.openTab",
  activateItem: "desktop.workpanel.activateTab",
  closeItem: "desktop.workpanel.closeTab"
};

// Only the trusted Agent Platform invocation context uses this list.
// Webpage actions also have a namespace exemption in action-handlers.ts.
// Keep action definitions and public Desktop confirmation intact.
// Platform owns any review/auto-approval policy.
export const AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS = new Set([
  // Trusted WorkPanel navigation and lifecycle.
  "desktop.workpanel.openTab",
  "desktop.workpanel.activateTab",
  "desktop.workpanel.closeTab",
  "desktop.workpanel.closeWorkpanel",
  "desktop.workpanel.openWeb",
  "desktop.workpanel.openLocalFile",
  "desktop.workpanel.refreshWeb",
  // Appearance and preferences.
  "desktop.theme.set",
  "desktop.locale.set",
  "desktop.skin.import",
  "desktop.skin.set",
  "desktop.skin.remove",
  "desktop.pet.show",
  "desktop.pet.hide",
  "desktop.pet.set",
  "desktop.pet.import",
  "desktop.copilot.setPagePreference",
  // Website entries and Kanban.
  "desktop.website.add",
  "desktop.website.update",
  "desktop.website.remove",
  "desktop.kanban.createIssue",
  "desktop.kanban.updateIssue",
  "desktop.kanban.deleteIssue",
  "desktop.kanban.moveIssue",
  // Individual WebApp operation and exports.
  "desktop.webapp.start",
  "desktop.webapp.stop",
  "desktop.webapp.restart",
  "desktop.webapp.open",
  "desktop.webapp.updatePreferences",
  "desktop.webapp.unpublish",
  "desktop.web.exportArtifact",
  // Navigation, catalog refresh, and diagnostic review.
  "desktop.navigate.toRoute",
  "desktop.help.openTopic",
  "desktop.agent.open",
  "desktop.agent.update",
  "desktop.skill.open",
  "desktop.skill.update",
  "desktop.assistant.chat",
  "desktop.website.open",
  "desktop.controlCenter.openService",
  "desktop.controlCenter.openLogViewer",
  "desktop.market.openItem",
  "desktop.market.refresh",
  "desktop.runtime.diagnostics",
]);

export const AGENT_PLATFORM_ONLY_ACTIONS = new Set([
  "desktop.workpanel.openLocalFile",
  "desktop.webapp.package.init",
  "desktop.webapp.package.validate",
  "desktop.webapp.package.build"
]);

export const ARGUMENT_FREE_RUNTIME_ACTIONS = new Set([
  "desktop.runtime.info",
  "desktop.runtime.diagnostics"
]);

export type PlatformResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

export type AgentPlatformTokenIssueReason = "missing" | "unauthorized";

export type AgentPlatformTokenIssueResult = {
  ok?: boolean;
  token?: string;
  message?: string;
};

export type AgentPlatformFetchOptions = {
  method?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  issueToken: (reason: AgentPlatformTokenIssueReason) => Promise<AgentPlatformTokenIssueResult>;
  fetchImpl?: typeof fetch;
};

export type DesktopCdpCallRequest = {
  requestId?: string;
  method?: string;
  params?: Record<string, unknown>;
  surfaceId?: string;
  source?: DesktopActionSource;
};

export type DesktopCdpCallResponse = {
  ok: boolean;
  method: string;
  result?: unknown;
  surfaceId?: string;
  error?: DesktopActionError;
};
