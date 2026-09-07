import type { SiteCdpScope } from "../web-surfaces";
import http from "node:http";

import fs from "node:fs";

import path from "node:path";

import { randomUUID } from "node:crypto";

import type { AddressInfo } from "node:net";

import type { App, BrowserWindow, OpenDialogOptions, SaveDialogOptions, WebContents } from "electron";

import { clipboard, dialog, Notification, shell, systemPreferences, webContents } from "electron";

import type {
  AgentAuthIssueResult,
  AssistantAttachment,
  DesktopActionConfirmationDecision,
  DesktopActionConfirmationRequest,
  DesktopActionConfirmationResponse,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse,
  DesktopAppInfo,
  DesktopPageContextSnapshot,
  DesktopPetState,
  DesktopRuntimeDiagnostics,
  DesktopWebappChangedReason,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueUpdateInput,
  MarketListOptions,
  ServiceId,
  ServiceLogTarget,
  ServiceOpenLogViewerRequest,
  WebappCommandResult,
  WebappEntry,
  WebappPublishResult,
  WebappRuntimeState,
  WorkPanelWorkspace
} from "../../../shared/contracts";

import {
  WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES,
  WEBAPP_BRIDGE_RESERVED_CAPABILITIES,
  WEBAPP_BRIDGE_VERSION,
  type WebappBridgeCapabilitiesResult,
  type WebappBridgePermissionStatus
} from "../../../shared/webapp-bridge";

import {
  WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS,
  WEBAPP_ID_PATTERN
} from "../../../shared/webapp-manifest";

import {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  isDesktopActionMutating,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionConfirmationPolicy,
  type DesktopActionError,
  type DesktopActionSource,
  type DesktopCopilotPreferenceResult,
  type DesktopKanbanDeleteResult,
  type DesktopKanbanIssueResult,
  type DesktopPetListResult,
  type DesktopPetSetResult,
  type DesktopPetStateResult,
  type DesktopPetVisibilityResult,
  type DesktopWebActionStateResult,
  type DesktopWebActionSurfaceSummary,
  type DesktopWebActionTabSummary,
  type DesktopWebCloseTabResult,
  type DesktopWebExportArtifactResult,
  type DesktopWebNavigateResult,
  type DesktopWebOpenTabResult,
  type DesktopWebTargetTabResult,
  type DesktopWebappInstallDiagnostic,
  type DesktopWebappInstallFailureDetails,
  type DesktopWebappInstallResult,
  type DesktopWebappInvalidResultDetails,
  type DesktopWebappOpenResult,
  type DesktopWebappPreferenceFailureDetails,
  type DesktopWebappPreferenceResult,
  type DesktopWebappPublishFailureDetails,
  type DesktopWebappPublishResult,
  type DesktopWebappRuntimeFailureDetails,
  type DesktopWebappRuntimeMutationResult,
  type DesktopWebappSummary,
  type DesktopWebappToolingResult,
  type DesktopWebappUninstallResult,
  type DesktopWebappUnpublishResult,
  type DesktopWorkPanelCloseResult,
  type DesktopWorkPanelCloseTabResult,
  type DesktopWorkPanelWorkspaceResult,
  type DesktopWebsiteItemResult,
  type DesktopWebsiteRemoveResult
} from "../../../shared/desktop-actions";

import { isDesktopCopilotPageKey } from "../../../shared/assistant-settings";

import { isSurfaceRole } from "../../../shared/surface-identity";

import { ActionBridgeTimeContractError, normalizeActionBridgeTimePayload } from "./time-normalizer";

import { AGENT_WEBCLIENT_ROUTE_DEFINITIONS } from "../../../shared/agent-webclient-routes";

import { DESKTOP_CDP_PUBLIC_METHODS } from "../../../shared/embedded-cdp";

import type { EmbeddedCdpCommandRequest } from "../web-surfaces";


import type {
  AgentPlatformAssistantBridge,
  AgentPlatformImageOperation
} from "../agent-platform";

import {
  getServiceLogsMeta,
  getResponsiveServiceState,
  getServiceState,
  initializeService,
  installBuiltinService,
  listServices,
  readServiceLog,
  restartService,
  startService,
  stopService
} from "../services";
import type { ServicesFacade } from "../services";

import { createWebappImportDiagnostic, listWebEntries } from "../webs";

import {
  addWebsiteItem,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "../webs";
import type { WebsFacade } from "../webs";

import {
  executeWebappToolingInWorker,
  resolveExistingWorkspacePath,
  webappManager,
  WebappToolingError,
  type WebappToolingTask,
  WebappRuntimeRequiredError
} from "../webs";

import { consumeWebappImageUpload } from "../webs";

import { webappWindowManager } from "../webs";

import {
  getWebappPublishStatus,
  publishWebapp,
  unpublishWebapp
} from "../webs";

import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
  uninstallMarketItem,
  updateMarketItem
} from "../marketplace";

import { normalizeMarketApiBaseUrl } from "../marketplace";

import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  isDesktopCdpTimeoutError,
  readDesktopCdpErrorDetails
} from "../web-surfaces";

import {
  inspectCurrentPageCdpElement,
  readCurrentPageCdpLocation,
  type CurrentPageCdpElementSnapshot
} from "../web-surfaces";

import type { KanbanRuntime } from "../kanban";

import { t } from "../../support/i18n/main-i18n";

import { getConfiguredDesktopActionBridgePort } from "./settings";

import { getDesktopDeviceInfo } from "../identity";

import { authorizeWebappActionToken } from "../webs";

import {
  getAvailableFilePath,
  getDesktopDownloadDefaultPath,
  sanitizeDownloadFilename
} from "../../infrastructure/filesystem/download-paths";

import {
  resolveWorkPanelLocalFileFromWorkspace,
  type WorkPanelLocalFilePathResolution,
} from "../work-panel";
export const desktopActionServerState = {
  activeServer: null as http.Server | null,
  activeServerPort: 0
};


export type DesktopActionBridgeOptions = {
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
  executeCdpCommand: (request: EmbeddedCdpCommandRequest, scope?: SiteCdpScope) => Promise<{
    targetId?: string;
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
  | { kind: "webappPage"; webappId: string }
  | { kind: "webappBackend"; webappId: string };

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
  "desktop.webapp.manifest.init",
  "desktop.webapp.manifest.validate",
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
  targetId?: string;
  sessionId?: string;
  surfaceId?: string;
  source?: DesktopActionSource;
};

export type DesktopCdpCallResponse = {
  ok: boolean;
  method: string;
  result?: unknown;
  targetId?: string;
  surfaceId?: string;
  error?: DesktopActionError;
};

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export const MAX_BODY_BYTES = 256 * 1024;

export const MAX_WEBAPP_EXTERNAL_URL_CHARS = 8_192;

export const MAX_WEBAPP_CLIPBOARD_BYTES = 1024 * 1024;

export const MAX_WEBAPP_NOTIFICATION_TITLE_CHARS = 120;

export const MAX_WEBAPP_NOTIFICATION_BODY_CHARS = 1_000;

export const WEBAPP_NATIVE_RATE_WINDOW_MS = 60_000;

export const WEBAPP_EXTERNAL_RATE_LIMIT = 5;

export const WEBAPP_NOTIFICATION_RATE_LIMIT = 5;

export const WEBAPP_PAGE_ONLY_ACTIONS = new Set([
  "desktop.capabilities.list",
  "desktop.native.browser.openExternal",
  "desktop.native.dialog.selectFiles",
  "desktop.native.dialog.selectDirectory",
  "desktop.native.dialog.selectSavePath",
  "desktop.native.microphone.getPermission",
  "desktop.native.microphone.requestAccess",
  "desktop.native.clipboard.writeText",
  "desktop.native.notification.show"
]);

export const PAGE_CONTROL_GRANT_TTL_MS = 10 * 60 * 1000;

export const PAGE_CONTROL_LOW_RISK_INTERACTIONS = new Set(["fill", "scroll", "focus", "select"]);

export const PAGE_CONTROL_HIGH_RISK_PATTERN =
  /(\u63d0\u4ea4|\u5220\u9664|\u79fb\u9664|\u6e05\u7a7a|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u4e0b\u5355|\u8ba2\u5355|\u786e\u8ba4\u8ba2\u5355|\u9000\u6b3e|\u8f6c\u8d26|\u6388\u6743|\u786e\u8ba4\u6388\u6743|\u540c\u610f\u6388\u6743|\u5b89\u88c5|\u5378\u8f7d|\u542f\u52a8|\u505c\u6b62|\u91cd\u542f|\u53d1\u5e03|\u53d1\u9001|\u4fdd\u5b58|\u767b\u5f55|\u6ce8\u518c|submit|delete|remove|clear|pay|payment|purchase|buy|checkout|order|refund|transfer|authorize|approve|install|uninstall|start|stop|restart|deploy|publish|send|save|login|sign\s*in|sign\s*up)/iu;

export const CURRENT_PAGE_WEB_ACTIONS = new Set([
  "desktop.web.interactElement",
  "desktop.web.executeScript",
  "desktop.web.exportArtifact"
]);

export const DESKTOP_WEB_EXPORT_FORMATS = ["png", "html", "project", "pdf"] as const;

export type DesktopWebExportFormat = typeof DESKTOP_WEB_EXPORT_FORMATS[number];

export const DESKTOP_WEB_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export const DESKTOP_WEB_EXPORT_PROVIDER_VERSION = 1;

export const DESKTOP_WEB_EXPORT_SPEC: Record<DesktopWebExportFormat, {
  mimeType: string;
  encoding: "base64" | "utf8";
  extension: string;
}> = {
  png: { mimeType: "image/png", encoding: "base64", extension: ".png" },
  html: { mimeType: "text/html", encoding: "utf8", extension: ".html" },
  project: { mimeType: "application/json", encoding: "utf8", extension: ".poster-v2.json" },
  pdf: { mimeType: "application/pdf", encoding: "base64", extension: ".pdf" }
};

export const CONFIRMATION_ARG_MAX_KEYS = 8;

export const CONFIRMATION_ARG_MAX_NESTED_KEYS = 6;

export const CONFIRMATION_ARG_MAX_ARRAY_ITEMS = 4;

export const CONFIRMATION_ARG_VALUE_MAX_CHARS = 160;

export const CONFIRMATION_ARG_SUMMARY_MAX_CHARS = 1200;

export class WebappActionRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  take(key: string, limit: number, now = Date.now()) {
    const cutoff = now - WEBAPP_NATIVE_RATE_WINDOW_MS;
    const current = (this.attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (current.length >= limit) {
      this.attempts.set(key, current);
      return false;
    }
    current.push(now);
    this.attempts.set(key, current);
    return true;
  }

  clear() {
    this.attempts.clear();
  }
}

export const webappActionRateLimiter = new WebappActionRateLimiter();

export const CONFIRMATION_COMPACT_VALUE_MAX_CHARS = 280;

export const MAX_ASSISTANT_PROMPT_CHARS = WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS;

export const WEBAPP_IMAGE_PROMPT_MAX_CHARS = 4_000;

export const WEBAPP_IMAGE_MAX_PIXELS = 100_000_000;

export const WEBAPP_IMAGE_OPERATIONS = new Set([
  "generate",
  "imageToImage",
  "inpaint",
  "outpaint",
  "removeObject",
  "replaceBackground",
  "removeBackground",
  "enhance",
  "repairSelection"
]);

export const WEBAPP_IMAGE_PROMPT_REQUIRED = new Set([
  "generate",
  "imageToImage",
  "inpaint",
  "outpaint",
  "replaceBackground"
]);

export const WEBAPP_IMAGE_MASK_REQUIRED = new Set(["inpaint", "removeObject", "repairSelection"]);

export const activeWebappImageRuns = new Map<string, string>();

export function agentPlatformAuthFailureMessage() {
  return t("desktopAction.agentPlatformAuthFailed");
}

export function webappImageRunKey(webappId: string, requestId: string) {
  return `${webappId}:${requestId}`;
}

export function normalizeWebappImageRequest(args: Record<string, unknown>) {
  const allowed = new Set([
    "requestId", "uploadId", "operation", "prompt", "negativePrompt", "width", "height",
    "count", "strength", "seed", "preserveComposition", "edgeMode"
  ]);
  const rejected = Object.keys(args).filter((key) => !allowed.has(key));
  if (rejected.length > 0) throw new Error(`unsupported image request fields: ${rejected.join(", ")}`);
  const requestId = readString(args, "requestId");
  const uploadId = readString(args, "uploadId");
  const operation = readString(args, "operation");
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const negativePrompt = typeof args.negativePrompt === "string" ? args.negativePrompt.trim() : "";
  const width = Number(args.width);
  const height = Number(args.height);
  const count = Number(args.count);
  const strength = Number(args.strength);
  const seed = Number(args.seed);
  const preserveComposition = args.preserveComposition;
  const edgeMode = args.edgeMode;
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId)) throw new Error("requestId is invalid");
  if (!WEBAPP_IMAGE_OPERATIONS.has(operation)) throw new Error("image operation is unsupported");
  if (prompt.length > WEBAPP_IMAGE_PROMPT_MAX_CHARS || negativePrompt.length > WEBAPP_IMAGE_PROMPT_MAX_CHARS) {
    throw new Error("image prompt is too long");
  }
  if (WEBAPP_IMAGE_PROMPT_REQUIRED.has(operation) && !prompt) throw new Error("prompt is required for this image operation");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 ||
    width > 16_384 || height > 16_384 || width * height > WEBAPP_IMAGE_MAX_PIXELS) {
    throw new Error("image output dimensions are invalid");
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("image output width and height must be divisible by 16");
  }
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("image count must be between 1 and 4");
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("image strength must be between 0 and 1");
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error("image seed is invalid");
  if (typeof preserveComposition !== "boolean") throw new Error("preserveComposition must be boolean");
  if (edgeMode !== "strict" && edgeMode !== "soft") throw new Error("edgeMode must be strict or soft");
  if (operation !== "generate" && !/^webimg_[0-9a-f-]{36}$/iu.test(uploadId)) throw new Error("source image upload is required");
  return {
    requestId,
    uploadId,
    operation,
    prompt,
    negativePrompt,
    width,
    height,
    count,
    strength,
    seed,
    preserveComposition,
    edgeMode
  };
}

export function resolveAgentWebclientHelpRoute(topic: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((route) =>
    route.key === topic ||
    route.routePath === topic ||
    route.routePath.slice(1) === topic
  )?.routePath ?? null;
}

export const HELP_TOPIC_ROUTES = new Map([
  ["help", "/help"],
  ["settings", "/settings"],
  ["market", "/market"],
  ["control-center", "/control-center"],
  ["controlCenter", "/control-center"]
]);

export function isAllowedHelpRoute(route: string) {
  return [...HELP_TOPIC_ROUTES.values()].includes(route) ||
    AGENT_WEBCLIENT_ROUTE_DEFINITIONS.some((definition) => definition.routePath === route);
}

export function resolveHelpOpenRoute(args: Record<string, unknown>) {
  const route = readString(args, "route");
  if (route) {
    return isAllowedHelpRoute(route) ? route : "";
  }
  const topic = readString(args, "topic") || readString(args, "id");
  if (!topic) {
    return "/help";
  }
  return HELP_TOPIC_ROUTES.get(topic) ?? resolveAgentWebclientHelpRoute(topic) ?? "";
}

export type PageControlGrantScope = {
  chatId: string;
  agentKey: string;
  webContentsId: number;
  origin: string;
  surfaceLabel?: string;
  pageTitle?: string;
};

export type PageControlConfirmationDecision = Extract<DesktopActionConfirmationDecision, "grant" | "once" | "cancel">;

export class PageControlGrantStore {
  private readonly grants = new Map<string, number>();

  has(scope: PageControlGrantScope, now = Date.now()) {
    this.prune(now);
    const expiresAt = this.grants.get(this.key(scope));
    return typeof expiresAt === "number" && expiresAt > now;
  }

  grant(scope: PageControlGrantScope, now = Date.now()) {
    this.prune(now);
    this.grants.set(this.key(scope), now + PAGE_CONTROL_GRANT_TTL_MS);
  }

  private key(scope: PageControlGrantScope) {
    return [
      scope.chatId,
      scope.agentKey,
      scope.webContentsId,
      scope.origin
    ].join("\u0000");
  }

  private prune(now = Date.now()) {
    for (const [key, expiresAt] of this.grants) {
      if (expiresAt <= now) {
        this.grants.delete(key);
      }
    }
  }
}

export const pageControlGrantStore = new PageControlGrantStore();

export function actionError(code: string, message: string, details?: unknown): DesktopActionError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}

export function ok(action: string, result?: unknown): DesktopActionCallResponse {
  return { ok: true, action, result };
}

export function preview(action: string, value: unknown): DesktopActionCallResponse {
  return { ok: true, action, preview: value };
}

export function fail(action: string, code: string, message: string, details?: unknown): DesktopActionCallResponse {
  return { ok: false, action, error: actionError(code, message, details) };
}

export function cdpFail(method: string, code: string, message: string, details?: unknown): DesktopCdpCallResponse {
  return { ok: false, method, error: actionError(code, message, details) };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readString(args: Record<string, unknown>, key: string) {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

export function hasObjectKeys(value: Record<string, unknown>) {
  return Object.keys(value).length > 0;
}

export function readServiceId(args: Record<string, unknown>) {
  const serviceId = readString(args, "serviceId");
  if (!serviceId) {
    throw new Error("serviceId is required");
  }
  return serviceId as ServiceId;
}

export function readWebappId(args: Record<string, unknown>) {
  const raw = typeof args.webappId === "string"
    ? args.webappId
    : typeof args.id === "string" ? args.id : "";
  if (!WEBAPP_ID_PATTERN.test(raw)) {
    throw new Error("webappId must be present and already valid");
  }
  return raw;
}

export function readWebsiteId(args: Record<string, unknown>) {
  const websiteId = readString(args, "websiteId") || readString(args, "id");
  if (!websiteId) {
    throw new Error("website id is required");
  }
  return websiteId;
}

export function readItemId(args: Record<string, unknown>) {
  const itemId = readString(args, "itemId");
  if (!itemId) {
    throw new Error("itemId is required");
  }
  return itemId;
}

export function readActionInput(args: Record<string, unknown>) {
  const input = asRecord(args.input);
  const patch = asRecord(args.patch);
  return hasObjectKeys(input) ? input : hasObjectKeys(patch) ? patch : args;
}

export function firstRecordItem(value: unknown) {
  return Array.isArray(value) ? asRecord(value[0]) : {};
}

export function hasWebsiteInputFields(value: Record<string, unknown>) {
  return ["id", "url", "label", "name", "copilotAgentKey", "agentKey"].some((field) => field in value);
}

export function normalizeWebsiteInputAliases(input: Record<string, unknown>) {
  const normalized = { ...input };
  if (typeof normalized.label !== "string" && typeof normalized.name === "string") {
    normalized.label = normalized.name;
  }
  if (
    (typeof normalized.copilotAgentKey !== "string" || !normalized.copilotAgentKey.trim()) &&
    typeof normalized.agentKey === "string"
  ) {
    normalized.copilotAgentKey = normalized.agentKey;
  }
  delete normalized.agentKey;
  return normalized;
}

export function selectWebsiteInputCandidate(value: Record<string, unknown>) {
  if (hasWebsiteInputFields(value)) {
    return value;
  }
  const item = asRecord(value.item);
  if (hasObjectKeys(item)) {
    return item;
  }
  const website = asRecord(value.website);
  if (hasObjectKeys(website)) {
    return website;
  }
  const firstItem = firstRecordItem(value.items);
  if (hasObjectKeys(firstItem)) {
    return firstItem;
  }
  return value;
}

export function readWebsiteActionInput(args: Record<string, unknown>) {
  const input = asRecord(args.input);
  if (hasObjectKeys(input)) {
    return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(input));
  }
  const patch = asRecord(args.patch);
  if (hasObjectKeys(patch)) {
    return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(patch));
  }
  return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(args));
}

export function readKanbanIssueId(args: Record<string, unknown>) {
  return readString(args, "id");
}

export function readKanbanInput(args: Record<string, unknown>) {
  const input = args.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

export function readKanbanMoveInput(args: Record<string, unknown>): KanbanIssueMoveInput | null {
  const id = readKanbanIssueId(args);
  const status = readString(args, "status");
  const position = typeof args.position === "number" ? args.position : Number.NaN;
  if (!id || !status || !Number.isFinite(position)) {
    return null;
  }
  return {
    id,
    status: status as KanbanIssueMoveInput["status"],
    position,
    ...(typeof args.baseIssueRevision === "number" ? { baseIssueRevision: args.baseIssueRevision } : {})
  };
}

export function isMarketSection(value: unknown): value is NonNullable<MarketListOptions["sections"]>[number] {
  return value === "plugins" ||
    value === "skills" ||
    value === "agents" ||
    value === "sandboxImages" ||
    value === "pets" ||
    value === "cli" ||
    value === "websiteApps";
}

export function readMarketListOptions(args: Record<string, unknown>): MarketListOptions {
  const rawOptions = asRecord(args.options);
  const rawSections = Array.isArray(args.sections)
    ? args.sections
    : Array.isArray(rawOptions.sections)
      ? rawOptions.sections
      : [];
  const sections = rawSections.filter(isMarketSection);
  return sections.length > 0 ? { sections } : {};
}

export function validateMarketSettings(input: Record<string, unknown>) {
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    return {
      valid: false,
      issues: [{
        field: "enabled",
        message: "market.enabled must be boolean"
      }]
    };
  }
  try {
    const settings = saveMarketSettingsPreview(input, {
      enabled: false,
      apiBaseUrl: ""
    });
    return {
      valid: true,
      issues: [],
      normalized: settings
    };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        field: "apiBaseUrl",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

export function saveMarketSettingsPreview(
  input: Record<string, unknown>,
  current: { enabled: boolean; apiBaseUrl: string }
) {
  const hasApiBaseUrlPatch = "apiBaseUrl" in input;
  const rawMarketUrl = typeof input.apiBaseUrl === "string" ? input.apiBaseUrl.trim() : "";
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    throw new Error("market.enabled must be boolean");
  }
  if ("apiBaseUrl" in input && typeof input.apiBaseUrl !== "string") {
    throw new Error("market.apiBaseUrl must be string");
  }
  const requestedEnabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const apiBaseUrl = normalizeMarketApiBaseUrl(hasApiBaseUrlPatch ? rawMarketUrl : current.apiBaseUrl);
  return {
    enabled: requestedEnabled && Boolean(apiBaseUrl),
    apiBaseUrl
  };
}

export async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writeJSON(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

export function unwrapPlatformResponse<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const response = payload as PlatformResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isUnauthorizedPayload(payload: unknown) {
  const record = readObject(payload);
  return typeof record.error === "string" && record.error.trim().toLowerCase() === "unauthorized";
}

export async function readAgentPlatformResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return { text, payload: null };
  }
  try {
    return { text, payload: JSON.parse(text) as unknown };
  } catch {
    return { text, payload: null };
  }
}
