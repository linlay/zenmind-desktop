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
  prepareWorkPanelLocalFileClaim?: (input: {
    ownerChatId: string;
    rendererWebContentsId: number;
    filePath: string;
    workspaceRelativePath: string;
  }) => { claimId: string } | null;
  discardWorkPanelLocalFileClaim?: (claimId: string) => boolean;
  confirmRendererAction?: (request: DesktopActionConfirmationRequest) => Promise<DesktopActionConfirmationResponse>;
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

export const AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS = new Set([
  "desktop.workpanel.openWeb",
  "desktop.workpanel.openLocalFile",
  "desktop.workpanel.refreshWeb"
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
