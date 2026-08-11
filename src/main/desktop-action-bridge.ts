import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { App, BrowserWindow, OpenDialogOptions, SaveDialogOptions } from "electron";
import { clipboard, dialog, Notification, shell, systemPreferences } from "electron";
import type {
  DesktopActionConfirmationDecision,
  DesktopActionConfirmationRequest,
  DesktopActionConfirmationResponse,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse,
  DesktopPageContextSnapshot,
  DesktopPetState,
  DesktopWebappChangedReason,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueUpdateInput,
  MarketListOptions,
  ServiceId,
  ServiceLogTarget,
  ServiceOpenLogViewerRequest
} from "../shared/contracts";
import {
  WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES,
  WEBAPP_BRIDGE_RESERVED_CAPABILITIES,
  WEBAPP_BRIDGE_VERSION,
  type WebappBridgeCapabilitiesResult,
  type WebappBridgePermissionStatus
} from "../shared/webapp-bridge";
import {
  WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS,
  WEBAPP_ID_PATTERN,
  getWebappAssistantChatConfig
} from "../shared/webapp-manifest";
import {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  isDesktopActionMutating,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionError,
  type DesktopActionSource
} from "../shared/desktop-actions";
import { ActionBridgeTimeContractError, normalizeActionBridgeTimePayload } from "./action-bridge-time-normalizer";
import { AGENT_WEBCLIENT_ROUTE_DEFINITIONS } from "../shared/agent-webclient-routes";
import { DESKTOP_CDP_PUBLIC_METHODS } from "../shared/embedded-cdp";
import type { EmbeddedCdpCommandRequest } from "./embedded-cdp-gateway";
import { issueAgentAccessToken } from "./agent-auth";
import type { AgentPlatformAssistantBridge } from "./assistant/core/agent-platform-bridge";
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
} from "./services/manager";
import { listWebEntries } from "./ipc/web-handlers";
import {
  addWebsiteItem,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "./webs/websites/actions";
import {
  webappManager,
  WebappInstallPolicyError,
  WebappSystemRuntimeRequiredError
} from "./webs/webapps/manager";
import { webappWindowManager } from "./webs/webapps/window-manager";
import {
  getWebappPublishStatus,
  publishWebapp,
  unpublishWebapp
} from "./webs/webapps/publisher";
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
} from "./marketplace";
import { normalizeMarketApiBaseUrl } from "./marketplace/common";
import { readDesktopProfileFromRoot } from "./desktop-profile-store";
import { getDesktopConfigRoot } from "./user-paths";
import {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  isDesktopCdpTimeoutError,
  readDesktopCdpErrorDetails
} from "./desktop-cdp-debugger";
import {
  inspectCurrentPageCdpElement,
  readCurrentPageCdpLocation,
  type CurrentPageCdpElementSnapshot
} from "./current-page-cdp-inspector";
import type { KanbanRuntime } from "./kanban-runtime";
import { t } from "./i18n/main-i18n";
import { getConfiguredDesktopActionBridgePort } from "./desktop-action-bridge-settings";
import { getAssistantSettings } from "./assistant/core/settings-store";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { authorizeWebappActionToken } from "./webs/webapps/action-tokens";

type DesktopActionBridgeOptions = {
  app: App;
  assistantBridge: AgentPlatformAssistantBridge;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
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
  confirmRendererAction?: (request: DesktopActionConfirmationRequest) => Promise<DesktopActionConfirmationResponse>;
  executeCdpCommand: (request: EmbeddedCdpCommandRequest) => Promise<{
    targetId?: string;
    surfaceId?: string;
    result: unknown;
  }>;
  getKanbanRuntime?: () => KanbanRuntime | null;
  emitWebappChanged?: (reason: DesktopWebappChangedReason, webappId: string) => void;
  desktopPet?: {
    refreshState: () => DesktopPetState | Promise<DesktopPetState>;
    saveSettings: (input: { enabled?: boolean; appearanceId?: string }) => DesktopPetState | Promise<DesktopPetState>;
    show: () => DesktopPetState | Promise<DesktopPetState>;
    hide: () => DesktopPetState | Promise<DesktopPetState>;
  };
};

type DesktopActionInvocationContext =
  | { kind: "desktop" }
  | { kind: "webappPage"; webappId: string }
  | { kind: "webappBackend"; webappId: string };

type PlatformResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type AgentPlatformTokenIssueReason = "missing" | "unauthorized";
type AgentPlatformTokenIssueResult = {
  ok?: boolean;
  token?: string;
  message?: string;
};
type AgentPlatformFetchOptions = {
  method?: string;
  body?: unknown;
  issueToken: (reason: AgentPlatformTokenIssueReason) => Promise<AgentPlatformTokenIssueResult>;
  fetchImpl?: typeof fetch;
};

type DesktopCdpCallRequest = {
  requestId?: string;
  method?: string;
  params?: Record<string, unknown>;
  targetId?: string;
  sessionId?: string;
  source?: DesktopActionSource;
};

type DesktopCdpCallResponse = {
  ok: boolean;
  method: string;
  result?: unknown;
  targetId?: string;
  surfaceId?: string;
  error?: DesktopActionError;
};

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_WEBAPP_EXTERNAL_URL_CHARS = 8_192;
const MAX_WEBAPP_CLIPBOARD_BYTES = 1024 * 1024;
const MAX_WEBAPP_NOTIFICATION_TITLE_CHARS = 120;
const MAX_WEBAPP_NOTIFICATION_BODY_CHARS = 1_000;
const WEBAPP_NATIVE_RATE_WINDOW_MS = 60_000;
const WEBAPP_EXTERNAL_RATE_LIMIT = 5;
const WEBAPP_NOTIFICATION_RATE_LIMIT = 5;
const WEBAPP_PAGE_ONLY_ACTIONS = new Set([
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
const PAGE_CONTROL_GRANT_TTL_MS = 10 * 60 * 1000;
const PAGE_CONTROL_LOW_RISK_INTERACTIONS = new Set(["fill", "scroll", "focus", "select"]);
const PAGE_CONTROL_HIGH_RISK_PATTERN =
  /(\u63d0\u4ea4|\u5220\u9664|\u79fb\u9664|\u6e05\u7a7a|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u4e0b\u5355|\u8ba2\u5355|\u786e\u8ba4\u8ba2\u5355|\u9000\u6b3e|\u8f6c\u8d26|\u6388\u6743|\u786e\u8ba4\u6388\u6743|\u540c\u610f\u6388\u6743|\u5b89\u88c5|\u5378\u8f7d|\u542f\u52a8|\u505c\u6b62|\u91cd\u542f|\u53d1\u5e03|\u53d1\u9001|\u4fdd\u5b58|\u767b\u5f55|\u6ce8\u518c|submit|delete|remove|clear|pay|payment|purchase|buy|checkout|order|refund|transfer|authorize|approve|install|uninstall|start|stop|restart|deploy|publish|send|save|login|sign\s*in|sign\s*up)/iu;
const CURRENT_PAGE_WEB_ACTIONS = new Set([
  "desktop.web.interactElement",
  "desktop.web.executeScript"
]);
const CONFIRMATION_ARG_MAX_KEYS = 8;
const CONFIRMATION_ARG_MAX_NESTED_KEYS = 6;
const CONFIRMATION_ARG_MAX_ARRAY_ITEMS = 4;
const CONFIRMATION_ARG_VALUE_MAX_CHARS = 160;
const CONFIRMATION_ARG_SUMMARY_MAX_CHARS = 1200;

class WebappActionRateLimiter {
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

const webappActionRateLimiter = new WebappActionRateLimiter();
const CONFIRMATION_COMPACT_VALUE_MAX_CHARS = 280;
const MAX_ASSISTANT_PROMPT_CHARS = WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS;
let activeServer: http.Server | null = null;
let activeServerPort = 0;

function agentPlatformAuthFailureMessage() {
  return t("desktopAction.agentPlatformAuthFailed");
}

function resolveAgentWebclientHelpRoute(topic: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((route) =>
    route.key === topic ||
    route.routePath === topic ||
    route.routePath.slice(1) === topic
  )?.routePath ?? null;
}

const HELP_TOPIC_ROUTES = new Map([
  ["help", "/help"],
  ["settings", "/settings"],
  ["market", "/market"],
  ["control-center", "/control-center"],
  ["controlCenter", "/control-center"]
]);

function isAllowedHelpRoute(route: string) {
  return [...HELP_TOPIC_ROUTES.values()].includes(route) ||
    AGENT_WEBCLIENT_ROUTE_DEFINITIONS.some((definition) => definition.routePath === route);
}

function resolveHelpOpenRoute(args: Record<string, unknown>) {
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

type PageControlGrantScope = {
  chatId: string;
  agentKey: string;
  webContentsId: number;
  origin: string;
  surfaceLabel?: string;
  pageTitle?: string;
};

type PageControlConfirmationDecision = Extract<DesktopActionConfirmationDecision, "grant" | "once" | "cancel">;

class PageControlGrantStore {
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

const pageControlGrantStore = new PageControlGrantStore();

function actionError(code: string, message: string, details?: unknown): DesktopActionError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}

function ok(action: string, result?: unknown): DesktopActionCallResponse {
  return { ok: true, action, result };
}

function preview(action: string, value: unknown): DesktopActionCallResponse {
  return { ok: true, action, preview: value };
}

function fail(action: string, code: string, message: string, details?: unknown): DesktopActionCallResponse {
  return { ok: false, action, error: actionError(code, message, details) };
}

function cdpFail(method: string, code: string, message: string, details?: unknown): DesktopCdpCallResponse {
  return { ok: false, method, error: actionError(code, message, details) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(args: Record<string, unknown>, key: string) {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

function hasObjectKeys(value: Record<string, unknown>) {
  return Object.keys(value).length > 0;
}

function readServiceId(args: Record<string, unknown>) {
  const serviceId = readString(args, "serviceId");
  if (!serviceId) {
    throw new Error("serviceId is required");
  }
  return serviceId as ServiceId;
}

function readWebappId(args: Record<string, unknown>) {
  const raw = typeof args.webappId === "string"
    ? args.webappId
    : typeof args.id === "string" ? args.id : "";
  if (!WEBAPP_ID_PATTERN.test(raw)) {
    throw new Error("webappId must be present and already valid");
  }
  return raw;
}

function readWebsiteId(args: Record<string, unknown>) {
  const websiteId = readString(args, "websiteId") || readString(args, "id");
  if (!websiteId) {
    throw new Error("website id is required");
  }
  return websiteId;
}

function readItemId(args: Record<string, unknown>) {
  const itemId = readString(args, "itemId");
  if (!itemId) {
    throw new Error("itemId is required");
  }
  return itemId;
}

function readActionInput(args: Record<string, unknown>) {
  const input = asRecord(args.input);
  const patch = asRecord(args.patch);
  return hasObjectKeys(input) ? input : hasObjectKeys(patch) ? patch : args;
}

function firstRecordItem(value: unknown) {
  return Array.isArray(value) ? asRecord(value[0]) : {};
}

function hasWebsiteInputFields(value: Record<string, unknown>) {
  return ["id", "url", "label", "name", "copilotAgentKey", "agentKey"].some((field) => field in value);
}

function normalizeWebsiteInputAliases(input: Record<string, unknown>) {
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

function selectWebsiteInputCandidate(value: Record<string, unknown>) {
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

function readWebsiteActionInput(args: Record<string, unknown>) {
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

function readKanbanIssueId(args: Record<string, unknown>) {
  return readString(args, "id");
}

function readKanbanInput(args: Record<string, unknown>) {
  const input = args.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

function readKanbanMoveInput(args: Record<string, unknown>): KanbanIssueMoveInput | null {
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

function isMarketSection(value: unknown): value is NonNullable<MarketListOptions["sections"]>[number] {
  return value === "plugins" ||
    value === "skills" ||
    value === "agents" ||
    value === "sandboxImages" ||
    value === "pets" ||
    value === "cli" ||
    value === "websiteApps";
}

function readMarketListOptions(args: Record<string, unknown>): MarketListOptions {
  const rawOptions = asRecord(args.options);
  const rawSections = Array.isArray(args.sections)
    ? args.sections
    : Array.isArray(rawOptions.sections)
      ? rawOptions.sections
      : [];
  const sections = rawSections.filter(isMarketSection);
  return sections.length > 0 ? { sections } : {};
}

function validateMarketSettings(input: Record<string, unknown>) {
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

function saveMarketSettingsPreview(
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

async function readBody(req: http.IncomingMessage) {
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

function writeJSON(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function unwrapPlatformResponse<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const response = payload as PlatformResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isUnauthorizedPayload(payload: unknown) {
  const record = readObject(payload);
  return typeof record.error === "string" && record.error.trim().toLowerCase() === "unauthorized";
}

async function readAgentPlatformResponse(response: Response) {
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

async function fetchAgentPlatformWithAuth<T>(
  baseUrl: string,
  pathOrUrl: string,
  options: AgentPlatformFetchOptions
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestUrl = new URL(pathOrUrl, baseUrl).toString();
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);

  for (const reason of ["missing", "unauthorized"] as const) {
    const token = await options.issueToken(reason);
    if (!token.ok || !token.token?.trim()) {
      throw new Error(token.message || "agent-platform token unavailable");
    }

    const response = await fetchImpl(requestUrl, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.token.trim()}`,
        ...(requestBody === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(requestBody === undefined ? {} : { body: requestBody })
    });
    const { text, payload } = await readAgentPlatformResponse(response);
    const unauthorized = response.status === 401 || isUnauthorizedPayload(payload);
    if (unauthorized) {
      if (reason === "missing") {
        continue;
      }
      throw new Error(agentPlatformAuthFailureMessage());
    }
    if (!response.ok) {
      throw new Error(text || `agent-platform returned HTTP ${response.status}`);
    }
    return unwrapPlatformResponse<T>(payload);
  }

  throw new Error(agentPlatformAuthFailureMessage());
}

export async function callAgentPlatform<T>(
  app: App,
  pathOrUrl: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const state = await getResponsiveServiceState(app, "agent-platform");
  const baseUrl = state.status === "running"
    ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
    : "";
  if (!baseUrl) {
    throw new Error("agent-platform is not running");
  }
  const token = await issueAgentAccessToken(app, "missing");
  if (!token.ok) {
    throw new Error(token.message || "agent-platform token unavailable");
  }
  return fetchAgentPlatformWithAuth<T>(baseUrl, pathOrUrl, {
    ...options,
    issueToken: async (reason) => (reason === "missing" ? token : issueAgentAccessToken(app, reason))
  });
}

function truncateConfirmationText(value: string, maxChars: number) {
  const chars = Array.from(value.replace(/\s+/gu, " ").trim());
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}...`;
}

function isSensitiveConfirmationKey(key: string) {
  const normalized = key.replace(/[\s._-]+/gu, "").toLowerCase();
  return normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("desktopauthcontext");
}

function sanitizeConfirmationUrl(value: string) {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return value;
  }
  try {
    const url = new URL(trimmed);
    if (url.origin && url.origin !== "null") {
      return `${url.origin}${url.pathname}`;
    }
    if (url.protocol === "file:") {
      return `file://${url.host}${url.pathname}`;
    }
    if (url.host) {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    return `${url.protocol}${url.pathname}`;
  } catch {
    return value;
  }
}

function sanitizeConfirmationUrlText(value: string) {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, (match) => sanitizeConfirmationUrl(match));
}

function sanitizeConfirmationValue(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveConfirmationKey(key)) {
    return t("desktopAction.confirmDetailRedacted");
  }
  if (typeof value === "string") {
    return sanitizeConfirmationUrlText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, CONFIRMATION_ARG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeConfirmationValue(item, key, depth + 1));
    return value.length > CONFIRMATION_ARG_MAX_ARRAY_ITEMS ? [...items, "..."] : items;
  }
  if (!value || typeof value !== "object") {
    return String(value);
  }
  if (depth >= 2) {
    return "[object]";
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([entryKey]) => entryKey !== "confirmationSummary")
    .slice(0, CONFIRMATION_ARG_MAX_NESTED_KEYS);
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries) {
    output[entryKey] = sanitizeConfirmationValue(entryValue, entryKey, depth + 1);
  }
  const hiddenCount = Object.keys(record).filter((entryKey) => entryKey !== "confirmationSummary").length - entries.length;
  if (hiddenCount > 0) {
    output["..."] = t("desktopAction.confirmDetailMore", { count: hiddenCount });
  }
  return output;
}

function stringifyConfirmationArgValue(key: string, value: unknown) {
  const sanitized = sanitizeConfirmationValue(value, key);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return truncateConfirmationText(text ?? "", CONFIRMATION_ARG_VALUE_MAX_CHARS);
}

function summarizeConfirmationArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args).filter(([key]) => key !== "confirmationSummary");
  if (entries.length === 0) {
    return t("desktopAction.confirmDetailArgsEmpty");
  }
  const displayedEntries = entries.slice(0, CONFIRMATION_ARG_MAX_KEYS);
  const lines = displayedEntries.map(([key, value]) => `${key}=${stringifyConfirmationArgValue(key, value)}`);
  const hiddenCount = entries.length - displayedEntries.length;
  if (hiddenCount > 0) {
    lines.push(t("desktopAction.confirmDetailMore", { count: hiddenCount }));
  }
  const summary = lines.join("\n");
  return Array.from(summary).length > CONFIRMATION_ARG_SUMMARY_MAX_CHARS
    ? truncateConfirmationText(summary, CONFIRMATION_ARG_SUMMARY_MAX_CHARS)
    : summary;
}

function summarizeConfirmationSource(source: DesktopActionSource | undefined) {
  return [
    `runId=${source?.runId?.trim() || "-"}`,
    `chatId=${source?.chatId?.trim() || "-"}`,
    `agentKey=${source?.agentKey?.trim() || "-"}`
  ].join(", ");
}

function describeDesktopActionSnapshotTarget(snapshot: DesktopPageContextSnapshot | null) {
  if (!snapshot) {
    return "-";
  }
  const url = readSnapshotUrl(snapshot);
  const safeUrl = url ? sanitizeConfirmationUrl(url) : "";
  return [
    snapshot.pageKind,
    snapshot.surfaceLabel,
    snapshot.pageContext?.title,
    safeUrl
  ].filter(Boolean).join(" | ") || "-";
}

function buildDesktopActionConfirmationDetail(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  options: { permissionMode?: string; target?: string; prefixLines?: string[] } = {}
) {
  const action = request.action || "unknown";
  const permissionMode = options.permissionMode || readRequestPermissionMode(request, args);
  return [
    ...(options.prefixLines?.filter(Boolean) ?? []),
    ...(options.prefixLines?.length ? [""] : []),
    t("desktopAction.confirmDetailIntro"),
    t("desktopAction.confirmDetailAction", { action, permissionMode }),
    t("desktopAction.confirmDetailRequest", { requestId: request.requestId?.trim() || "-" }),
    t("desktopAction.confirmDetailSource", { source: summarizeConfirmationSource(request.source) }),
    t("desktopAction.confirmDetailTarget", { target: sanitizeConfirmationUrlText(options.target?.trim() || "-") }),
    t("desktopAction.confirmDetailArgs", { args: summarizeConfirmationArgs(args) }),
    t("desktopAction.confirmDetailFooter")
  ].join("\n");
}

function compactConfirmationValue(value: string) {
  return truncateConfirmationText(value, CONFIRMATION_COMPACT_VALUE_MAX_CHARS);
}

function getConfirmationRequestId(request: DesktopActionCallRequest) {
  return request.requestId?.trim() || randomUUID();
}

function buildNativeConfirmationDetail(payload: DesktopActionConfirmationRequest) {
  return [
    payload.description,
    "",
    ...payload.fields.map((field) => `${field.label}: ${field.value}`)
  ].filter((line) => line !== undefined).join("\n");
}

function findConfirmationButtonIndex(
  payload: DesktopActionConfirmationRequest,
  decision: DesktopActionConfirmationDecision
) {
  const index = payload.buttons.findIndex((button) => button.decision === decision);
  return index === -1 ? 0 : index;
}

function normalizeConfirmationDecision(
  value: unknown,
  fallback: DesktopActionConfirmationDecision
): DesktopActionConfirmationDecision {
  return value === "confirm" || value === "grant" || value === "once" || value === "cancel"
    ? value
    : fallback;
}

async function requestDesktopActionConfirmation(
  options: DesktopActionBridgeOptions,
  payload: DesktopActionConfirmationRequest,
  owner: BrowserWindow | null
): Promise<DesktopActionConfirmationDecision> {
  if (options.confirmRendererAction && owner && !owner.isDestroyed()) {
    const response = await options.confirmRendererAction(payload);
    return normalizeConfirmationDecision(response.decision, payload.cancelDecision);
  }

  const buttons = payload.buttons.map((button) => button.label);
  const dialogOptions = {
    type: "question" as const,
    buttons,
    defaultId: findConfirmationButtonIndex(payload, payload.defaultDecision),
    cancelId: findConfirmationButtonIndex(payload, payload.cancelDecision),
    title: payload.title,
    message: payload.summary,
    detail: buildNativeConfirmationDetail(payload)
  };
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return payload.buttons[result.response]?.decision ?? payload.cancelDecision;
}

function buildMutatingActionConfirmationRequest(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null
): DesktopActionConfirmationRequest {
  const action = request.action;
  const providedSummary = typeof args.confirmationSummary === "string" && args.confirmationSummary.trim()
    ? args.confirmationSummary.trim()
    : "";
  const summary = providedSummary || t("desktopAction.confirmSummary", { action });
  const permissionMode = readRequestPermissionMode(request, args);
  const target = describeDesktopActionSnapshotTarget(snapshot);
  const argsSummary = summarizeConfirmationArgs(args);
  return {
    requestId: getConfirmationRequestId(request),
    kind: "action",
    title: t("desktopAction.confirmActionTitle"),
    summary,
    description: t("desktopAction.confirmActionDetail"),
    fields: [
      { label: t("desktopAction.confirmFieldAction"), value: action || "unknown" },
      { label: t("desktopAction.confirmFieldTarget"), value: compactConfirmationValue(sanitizeConfirmationUrlText(target)) },
      { label: t("desktopAction.confirmFieldPermission"), value: permissionMode },
      { label: t("desktopAction.confirmFieldArgs"), value: compactConfirmationValue(argsSummary) }
    ],
    details: buildDesktopActionConfirmationDetail(request, args, {
      permissionMode,
      target
    }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.confirmExecute"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

async function confirmMutatingAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null,
  owner: BrowserWindow | null
) {
  const decision = await requestDesktopActionConfirmation(
    options,
    buildMutatingActionConfirmationRequest(request, args, snapshot),
    owner
  );
  return decision === "confirm";
}

function buildPageControlActionConfirmationRequest(
  scope: PageControlGrantScope,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>
): DesktopActionConfirmationRequest {
  const summary = typeof args.confirmationSummary === "string" && args.confirmationSummary.trim()
    ? args.confirmationSummary.trim()
    : t("desktopAction.pageControlSummary", { origin: scope.origin });
  const targetLabel = [scope.surfaceLabel, scope.pageTitle].filter(Boolean).join(" · ") || scope.origin;
  const permissionMode = readRequestPermissionMode(request, args);
  return {
    requestId: getConfirmationRequestId(request),
    kind: "page_control",
    title: t("desktopAction.pageControlTitle"),
    summary,
    description: t("desktopAction.pageControlCompactDescription"),
    fields: [
      { label: t("desktopAction.confirmFieldTarget"), value: compactConfirmationValue(sanitizeConfirmationUrlText(targetLabel)) },
      { label: t("desktopAction.confirmFieldPermission"), value: permissionMode },
      { label: t("desktopAction.confirmFieldArgs"), value: compactConfirmationValue(summarizeConfirmationArgs(args)) }
    ],
    details: buildDesktopActionConfirmationDetail(request, args, {
      permissionMode,
      target: targetLabel,
      prefixLines: [
        t("desktopAction.pageControlTarget", { target: targetLabel }),
        t("desktopAction.pageControlGrantDetail"),
        t("desktopAction.pageControlHighRiskDetail")
      ]
    }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "once", label: t("desktopAction.pageControlOnce"), variant: "secondary" },
      { decision: "grant", label: t("desktopAction.pageControlGrant"), variant: "primary" }
    ],
    defaultDecision: "once",
    cancelDecision: "cancel"
  };
}

async function confirmPageControlAction(
  options: DesktopActionBridgeOptions,
  scope: PageControlGrantScope,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  owner: BrowserWindow | null
): Promise<PageControlConfirmationDecision> {
  const decision = await requestDesktopActionConfirmation(
    options,
    buildPageControlActionConfirmationRequest(scope, request, args),
    owner
  );
  if (decision === "grant" || decision === "once") {
    return decision;
  }
  return "cancel";
}

function normalizePermissionMode(value: unknown) {
  return value === "full_access" || value === "page_control" || value === "default"
    ? value
    : "";
}

function readRequestPermissionMode(request: DesktopActionCallRequest, args: Record<string, unknown>) {
  return normalizePermissionMode(request.permissionMode) || normalizePermissionMode(args.permissionMode) || "default";
}

function readSnapshotUrl(snapshot: DesktopPageContextSnapshot) {
  const browserTarget = snapshot.pageContext?.browserTarget;
  if (browserTarget?.kind === "webview" && browserTarget.currentUrl) {
    return browserTarget.currentUrl;
  }
  return snapshot.pageContext?.url || "";
}

function readUrlOrigin(rawUrl: string) {
  try {
    const origin = new URL(rawUrl).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

async function resolvePageControlGrantScope(
  snapshot: DesktopPageContextSnapshot | null,
  request: DesktopActionCallRequest
): Promise<PageControlGrantScope | null> {
  if (!snapshot || snapshot.pageKind !== "webview" || typeof snapshot.webContentsId !== "number") {
    return null;
  }
  const chatId = request.source?.chatId?.trim() || "";
  const agentKey = request.source?.agentKey?.trim() || "";
  if (!chatId || !agentKey) {
    return null;
  }
  const liveUrl = await readCurrentPageCdpLocation(snapshot).catch(() => "");
  const origin = readUrlOrigin(liveUrl || readSnapshotUrl(snapshot));
  if (!origin) {
    return null;
  }
  return {
    chatId,
    agentKey,
    webContentsId: snapshot.webContentsId,
    origin,
    ...(snapshot.surfaceLabel ? { surfaceLabel: snapshot.surfaceLabel } : {}),
    ...(snapshot.pageContext?.title ? { pageTitle: snapshot.pageContext.title } : {})
  };
}

function collectStringValues(value: unknown, output: string[]) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["selector", "elementSelector", "label", "text", "title", "name", "id", "className", "value", "href", "confirmationSummary"]) {
    collectStringValues(record[key], output);
  }
}

function collectElementRiskText(element: CurrentPageCdpElementSnapshot | null) {
  if (!element) {
    return "";
  }
  return [
    element.text,
    element.ariaLabel,
    element.title,
    element.value,
    element.role,
    element.type,
    element.name,
    element.id,
    element.className,
    element.href
  ].filter(Boolean).join(" ");
}

function isHighRiskPageActionText(text: string) {
  return PAGE_CONTROL_HIGH_RISK_PATTERN.test(text.replace(/\s+/gu, " ").trim());
}

async function isLowRiskPageControlAction(
  action: string,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null
) {
  if (!snapshot || snapshot.pageKind !== "webview") {
    return false;
  }
  if (action !== "desktop.web.interactElement") {
    return false;
  }
  const interaction = readString(args, "action").toLowerCase();
  if (PAGE_CONTROL_LOW_RISK_INTERACTIONS.has(interaction)) {
    return true;
  }
  if (interaction !== "click") {
    return false;
  }
  const riskValues: string[] = [];
  collectStringValues(args, riskValues);
  const element = await inspectCurrentPageCdpElement(snapshot, args).catch(() => null);
  const riskText = [...riskValues, collectElementRiskText(element)].filter(Boolean).join(" ");
  if (!riskText.trim()) {
    return false;
  }
  return !isHighRiskPageActionText(riskText);
}

async function confirmDesktopActionIfNeeded(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>
): Promise<DesktopActionCallResponse | null> {
  if (!readDesktopProfileFromRoot(getDesktopConfigRoot(options.app)).general.desktopActionConfirmationEnabled) {
    return null;
  }
  const action = request.action;
  const permissionMode = readRequestPermissionMode(request, args);
  if (permissionMode === "full_access") {
    return null;
  }
  const snapshot = options.getCurrentPageSnapshot();
  if (permissionMode === "page_control" && await isLowRiskPageControlAction(action, args, snapshot)) {
    const scope = await resolvePageControlGrantScope(snapshot, request);
    if (scope && pageControlGrantStore.has(scope)) {
      return null;
    }
    if (scope) {
      const decision = await confirmPageControlAction(options, scope, request, args, options.getMainWindow());
      if (decision === "grant") {
        pageControlGrantStore.grant(scope);
        return null;
      }
      if (decision === "once") {
        return null;
      }
      return {
        ok: false,
        action,
        requiresConfirmation: true,
        error: actionError("user_cancelled", t("desktopAction.userCancelledAuth"))
      };
    }
  }
  const confirmed = await confirmMutatingAction(options, request, args, snapshot, options.getMainWindow());
  if (confirmed) {
    return null;
  }
  return {
    ok: false,
    action,
    requiresConfirmation: true,
    error: actionError("user_cancelled", t("desktopAction.userCancelled"))
  };
}

async function callRendererAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>
) {
  const response = await options.callRendererAction({
    requestId: request.requestId || randomUUID(),
    action: request.action,
    args,
    source: request.source
  });
  return {
    ok: response.ok,
    action: request.action,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.preview === undefined ? {} : { preview: response.preview }),
    ...(response.requiresConfirmation === undefined ? {} : { requiresConfirmation: response.requiresConfirmation }),
    ...(response.error === undefined ? {} : { error: response.error })
  } satisfies DesktopActionCallResponse;
}

function webappRoute(webappId: string) {
  return `/webs/webapp:${webappId}`;
}

function websiteRoute(websiteId: string) {
  return `/webs/website:${websiteId.trim()}`;
}

function notifyWebsChanged(options: DesktopActionBridgeOptions) {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("webs.changed", { changedAt: new Date().toISOString() });
}

async function openWebapp(options: DesktopActionBridgeOptions, action: string, webappId: string, installResult?: unknown) {
  const command = await webappManager.runtime.start(options.app, webappId);
  if (!command.ok || !command.state) {
    return fail(action, "webapp_open_failed", command.message, command);
  }
  const route = webappRoute(webappId);
  options.navigate(route);
  return ok(action, {
    ...(installResult === undefined ? {} : { install: installResult }),
    command,
    state: command.state,
    route
  });
}

async function installWebapp(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const archivePath = readString(args, "archivePath");
  const hasExpectedId = Object.hasOwn(args, "expectedId");
  const expectedId = hasExpectedId && typeof args.expectedId === "string" ? args.expectedId : "";
  if (Object.prototype.hasOwnProperty.call(args, "itemId")) {
    return fail(action, "invalid_args", "itemId is not supported; install market items with desktop.market.installItem.");
  }
  if (!archivePath) {
    return fail(action, "invalid_args", "archivePath is required.");
  }
  if (hasExpectedId && !WEBAPP_ID_PATTERN.test(expectedId)) {
    return fail(action, "invalid_args", "expectedId must already be a valid WebApp id; it is never normalized.");
  }
  const previousItemIds = new Set(
    listWebEntries(options.app).items
      .filter((item) => item.kind === "webapp")
      .map((item) => item.id)
  );
  const installOptions = { ...(expectedId ? { expectedId } : {}) };
  let installResult;
  try {
    installResult = await webappManager.installArchive(options.app, archivePath, installOptions);
  } catch (error) {
    if (error instanceof WebappInstallPolicyError) {
      return fail(action, error.code, error.message, error.details);
    }
    if (!(error instanceof WebappSystemRuntimeRequiredError)) {
      throw error;
    }
    const dialogOptions: OpenDialogOptions = {
      title: `Select ${error.executable} executable for ${error.webappId}`,
      properties: ["openFile"]
    };
    const owner = options.getMainWindow();
    const selection = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const executablePath = selection.canceled ? "" : String(selection.filePaths[0] || "").trim();
    if (!executablePath || !path.isAbsolute(executablePath)) {
      return fail(action, error.code, error.message, {
        webappId: error.webappId,
        executable: error.executable
      });
    }
    webappManager.bindSystemExecutable(
      options.app,
      error.webappId,
      error.executable,
      executablePath
    );
    try {
      installResult = await webappManager.installArchive(options.app, archivePath, installOptions);
    } catch (retryError) {
      if (retryError instanceof WebappInstallPolicyError) {
        return fail(action, retryError.code, retryError.message, retryError.details);
      }
      if (retryError instanceof WebappSystemRuntimeRequiredError) {
        return fail(action, retryError.code, retryError.message, {
          webappId: retryError.webappId,
          executable: retryError.executable,
          selectedPath: executablePath
        });
      }
      throw retryError;
    }
  }
  const webappId = typeof installResult.itemId === "string" ? installResult.itemId.trim() : "";
  if (!installResult.ok || !webappId) {
    return fail(action, "webapp_install_failed", installResult.message, installResult);
  }
  const installedItem = listWebEntries(options.app).items.find((item) =>
    item.kind === "webapp" && item.id === webappId
  );
  if (!installedItem) {
    return fail(action, "webapp_install_not_visible", "The installed WebApp is not visible in the Desktop sidebar.", installResult);
  }
  notifyWebsChanged(options);
  const operation = previousItemIds.has(webappId) ? "updated" : "installed";
  options.emitWebappChanged?.(operation, webappId);
  return ok(action, {
    itemId: webappId,
    operation,
    item: installedItem,
    message: installResult.message
  });
}

async function executeWebAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  if (action === "desktop.site.list") {
    return ok(action, listWebEntries(options.app));
  }
  if (action === "desktop.website.list") {
    return ok(action, listWebsiteItems(options.app));
  }
  if (action === "desktop.website.add") {
    return ok(action, addWebsiteItem(options.app, readWebsiteActionInput(args) as any));
  }
  if (action === "desktop.website.update") {
    return ok(action, updateWebsiteItem(options.app, readWebsiteId(args), readWebsiteActionInput(args) as any));
  }
  if (action === "desktop.website.remove") {
    return ok(action, removeWebsiteItem(options.app, readWebsiteId(args)));
  }
  if (action === "desktop.website.open") {
    const websiteId = readWebsiteId(args);
    const item = listWebsiteItems(options.app).items.find((entry) => entry.id === websiteId);
    if (!item) {
      return fail(action, "website_not_found", "The website entry was not found.");
    }
    const route = websiteRoute(websiteId);
    options.navigate(route);
    return ok(action, { item, route });
  }
  if (action === "desktop.webapp.getStatus") {
    return ok(action, webappManager.runtime.getStatus(options.app, readWebappId(args)));
  }
  if (action === "desktop.webapp.checkRuntime") {
    const webappId = readWebappId(args);
    if (!webappManager.list(options.app).some((item) => item.id === webappId)) {
      return fail(action, "webapp_not_found", t("webapp.notFound"), { webappId });
    }
    return ok(action, webappManager.runtime.checkRuntime(options.app, webappId));
  }
  if (action === "desktop.webapp.start") {
    return ok(action, await webappManager.runtime.start(options.app, readWebappId(args)));
  }
  if (action === "desktop.webapp.stop") {
    return ok(action, await webappManager.runtime.stop(options.app, readWebappId(args)));
  }
  if (action === "desktop.webapp.restart") {
    return ok(action, await webappManager.runtime.restart(options.app, readWebappId(args)));
  }
  if (action === "desktop.webapp.open") {
    return openWebapp(options, action, readWebappId(args));
  }
  if (action === "desktop.webapp.updatePreferences") {
    const webappId = readWebappId(args);
    const patch = asRecord(args.patch ?? args.input ?? args);
    const result = webappManager.update(options.app, webappId, {
      ...(typeof patch.label === "string" ? { label: patch.label } : {}),
      ...(typeof patch.copilotAgentKey === "string" ? { copilotAgentKey: patch.copilotAgentKey } : {}),
      ...(patch.openMode === "workspace" || patch.openMode === "dialog" ? { openMode: patch.openMode } : {})
    });
    if (result.ok) {
      notifyWebsChanged(options);
      options.emitWebappChanged?.("updated", webappId);
    }
    return result.ok ? ok(action, result) : fail(action, "webapp_update_failed", result.message, result);
  }
  if (action === "desktop.webapp.getPublishStatus") {
    const webappId = readWebappId(args);
    if (!webappManager.list(options.app).some((item) => item.id === webappId)) {
      return fail(action, "webapp_not_found", t("webapp.notFound"), { webappId });
    }
    return ok(action, await getWebappPublishStatus(options.app, webappId));
  }
  if (action === "desktop.webapp.publish") {
    const webappId = readWebappId(args);
    const runtimeState = webappManager.runtime.getStatus(options.app, webappId);
    if (!runtimeState) {
      return fail(action, "webapp_not_found", t("webapp.notFound"), { webappId });
    }
    if (runtimeState.status !== "running" || !runtimeState.webUrl) {
      return fail(action, "webapp_not_running", "Start the WebApp before publishing.", { webappId, status: runtimeState.status });
    }
    const result = await publishWebapp(options.app, webappId, runtimeState);
    options.emitWebappChanged?.(result.ok ? "published" : "publish-failed", webappId);
    return result.ok
      ? ok(action, result)
      : fail(action, "webapp_publish_failed", result.message, result);
  }
  if (action === "desktop.webapp.unpublish") {
    const webappId = readWebappId(args);
    const result = await unpublishWebapp(options.app, webappId);
    options.emitWebappChanged?.(result.ok ? "unpublished" : "publish-failed", webappId);
    return result.ok
      ? ok(action, result)
      : fail(action, "webapp_unpublish_failed", result.message, result);
  }
  if (action === "desktop.webapp.install") {
    return installWebapp(options, action, args);
  }
  if (action === "desktop.webapp.uninstall") {
    const webappId = readWebappId(args);
    const result = await webappManager.remove(options.app, webappId);
    if (!result.ok) {
      return fail(action, "webapp_uninstall_failed", result.message, result);
    }
    notifyWebsChanged(options);
    return ok(action, result);
  }
  return fail(action, "unknown_action", `unknown WebApp action: ${action}`);
}

function webappPathResult(selectedPath: string) {
  return {
    path: selectedPath,
    name: path.basename(selectedPath) || selectedPath
  };
}

function readWebappDialogFilters(value: unknown) {
  if (value === undefined) {
    return { ok: true as const, filters: undefined };
  }
  if (!Array.isArray(value) || value.length > 10) {
    return { ok: false as const, message: "filters must be an array with at most 10 items." };
  }
  const filters: NonNullable<OpenDialogOptions["filters"]> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = readString(record, "name");
    const extensions = Array.isArray(record.extensions)
      ? record.extensions.map((extension) => typeof extension === "string" ? extension.trim() : "")
      : [];
    if (
      !name ||
      name.length > 80 ||
      extensions.length === 0 ||
      extensions.length > 20 ||
      extensions.some((extension) => !/^[A-Za-z0-9*][A-Za-z0-9._+-]{0,31}$/u.test(extension))
    ) {
      return { ok: false as const, message: "each filter requires a name and 1-20 safe extensions." };
    }
    filters.push({ name, extensions });
  }
  return { ok: true as const, filters };
}

function normalizeMicrophonePermission(value: string): WebappBridgePermissionStatus {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  if (value === "restricted") return "restricted";
  if (value === "not-determined" || value === "unknown") return "prompt";
  return "unavailable";
}

function getMicrophonePermission(options: DesktopActionBridgeOptions) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return "unavailable" as const;
  }
  try {
    const raw = options.getMicrophonePermission
      ? options.getMicrophonePermission()
      : systemPreferences.getMediaAccessStatus("microphone");
    return normalizeMicrophonePermission(raw);
  } catch {
    return "unavailable" as const;
  }
}

function getWebappBridgeCapabilities(
  options: DesktopActionBridgeOptions,
  webappId: string
): WebappBridgeCapabilitiesResult | null {
  const item = webappManager.list(options.app).find((candidate) => candidate.id === webappId) ?? null;
  if (!item || item.schemaVersion !== 1) {
    return null;
  }
  const declared = new Set(Object.keys(item.desktopBridge?.capabilities ?? {}));
  const microphonePermission = getMicrophonePermission(options);
  const notificationAvailable = options.showNotification ? true : Notification.isSupported();
  return {
    bridgeVersion: WEBAPP_BRIDGE_VERSION,
    capabilities: [
      ...WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES.map((id) => {
        const status = id === "native.microphone" && microphonePermission === "unavailable"
          ? "unavailable" as const
          : id === "native.notification" && !notificationAvailable
            ? "unavailable" as const
            : "available" as const;
        return {
          id,
          status,
          declared: declared.has(id),
          permission: id === "native.microphone"
            ? microphonePermission
            : id === "native.notification" && !notificationAvailable
              ? "unavailable" as const
              : "not_required" as const
        };
      }),
      ...WEBAPP_BRIDGE_RESERVED_CAPABILITIES.map((id) => ({
        id,
        status: "reserved" as const,
        declared: false,
        permission: "unavailable" as const
      }))
    ]
  };
}

function getWebappDialogOwner(options: DesktopActionBridgeOptions, webappId: string) {
  return webappWindowManager.getWindow(webappId) ?? options.getMainWindow();
}

async function executeNativeWebappAction(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  if (action === "desktop.capabilities.list") {
    const result = getWebappBridgeCapabilities(options, webappId);
    return result
      ? ok(action, result)
      : fail(action, "unsupported_schema", "Desktop Bridge v1 requires WebApp manifest schema v1.");
  }

  const owner = getWebappDialogOwner(options, webappId);
  if (action === "desktop.native.browser.openExternal") {
    const rawUrl = readString(args, "url");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return fail(action, "invalid_args", "url must be a valid HTTP(S) URL.");
    }
    if (
      !rawUrl ||
      rawUrl.length > MAX_WEBAPP_EXTERNAL_URL_CHARS ||
      (target.protocol !== "http:" && target.protocol !== "https:")
    ) {
      return fail(action, "invalid_args", "url must be an HTTP(S) URL with at most 8192 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:openExternal`, WEBAPP_EXTERNAL_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp opened too many external URLs.");
    }
    await (options.openExternal ?? shell.openExternal)(target.toString());
    return ok(action, { opened: true, url: target.toString() });
  }

  if (action === "desktop.native.dialog.selectFiles") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const dialogOptions: OpenDialogOptions = {
      title: "Select files",
      properties: args.multiple === true ? ["openFile", "multiSelections"] : ["openFile"],
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    return ok(action, {
      canceled: result.canceled,
      files: result.canceled ? [] : result.filePaths.map(webappPathResult)
    });
  }

  if (action === "desktop.native.dialog.selectDirectory") {
    const dialogOptions: OpenDialogOptions = {
      title: "Select directory",
      defaultPath: options.app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"]
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePaths[0] || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.dialog.selectSavePath") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const suggestedName = readString(args, "suggestedName");
    if (suggestedName.length > 255 || (suggestedName && path.basename(suggestedName) !== suggestedName)) {
      return fail(action, "invalid_args", "suggestedName must be a filename with at most 255 characters.");
    }
    const dialogOptions: SaveDialogOptions = {
      title: "Select save path",
      ...(suggestedName ? { defaultPath: path.join(options.app.getPath("documents"), suggestedName) } : {}),
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showSaveDialog
      ? await options.showSaveDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePath || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.microphone.getPermission") {
    return ok(action, { permission: getMicrophonePermission(options) });
  }

  if (action === "desktop.native.microphone.requestAccess") {
    if (process.platform === "darwin") {
      const granted = await (options.requestMicrophoneAccess
        ? options.requestMicrophoneAccess()
        : systemPreferences.askForMediaAccess("microphone"));
      return granted
        ? ok(action, { permission: "granted" })
        : fail(action, "permission_denied", "Microphone permission was denied.", { permission: "denied" });
    }
    if (process.platform === "win32") {
      const permission = getMicrophonePermission(options);
      return permission === "denied" || permission === "restricted"
        ? fail(action, "permission_denied", "Microphone permission is unavailable.", { permission })
        : ok(action, { permission });
    }
    return fail(action, "unsupported_platform", "Microphone access is unavailable on this platform.");
  }

  if (action === "desktop.native.clipboard.writeText") {
    const text = typeof args.text === "string" ? args.text : "";
    if (Buffer.byteLength(text, "utf8") > MAX_WEBAPP_CLIPBOARD_BYTES) {
      return fail(action, "invalid_args", "text must be at most 1 MiB when encoded as UTF-8.");
    }
    (options.writeClipboardText ?? ((value: string) => clipboard.writeText(value)))(text);
    return ok(action, { written: true });
  }

  if (action === "desktop.native.notification.show") {
    const title = readString(args, "title");
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!title || title.length > MAX_WEBAPP_NOTIFICATION_TITLE_CHARS || body.length > MAX_WEBAPP_NOTIFICATION_BODY_CHARS) {
      return fail(action, "invalid_args", "title is required (max 120 characters); body is limited to 1000 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:notification`, WEBAPP_NOTIFICATION_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp showed too many notifications.");
    }
    const focus = () => webappWindowManager.focus(webappId, options.getMainWindow());
    const shown = options.showNotification
      ? options.showNotification({ title, body, onClick: focus })
      : Notification.isSupported()
        ? (() => {
            const notification = new Notification({ title, body });
            notification.once("click", focus);
            notification.show();
            return true;
          })()
        : false;
    return shown
      ? ok(action, { shown: true })
      : fail(action, "unavailable", "System notifications are unavailable.");
  }

  return fail(action, "unknown_action", `unknown WebApp native action: ${action}`);
}

async function executeKanbanAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const runtime = options.getKanbanRuntime?.() ?? null;
  if (!runtime) {
    return fail(action, "kanban_unavailable", "Kanban runtime is not initialized.");
  }
  if (action === "desktop.kanban.listIssues") {
    return ok(action, runtime.listIssues());
  }
  if (action === "desktop.kanban.getIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    const list = runtime.listIssues();
    const issue = list.issues.find((candidate) => candidate.id === id);
    return issue
      ? ok(action, { ok: true, message: "Kanban issue loaded.", issue, issues: list.issues })
      : fail(action, "not_found", `Kanban issue not found: ${id}`, { id });
  }
  if (action === "desktop.kanban.createIssue") {
    const input = readKanbanInput(args);
    if (!input) {
      return fail(action, "invalid_args", "input object is required.");
    }
    return ok(action, await runtime.createIssue(input as unknown as KanbanIssueInput));
  }
  if (action === "desktop.kanban.updateIssue") {
    const id = readKanbanIssueId(args);
    const input = readKanbanInput(args);
    if (!id || !input) {
      return fail(action, "invalid_args", "id and input object are required.");
    }
    return ok(action, await runtime.updateIssue(id, input as unknown as KanbanIssueUpdateInput));
  }
  if (action === "desktop.kanban.deleteIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    return ok(action, await runtime.deleteIssueWithAutomation(id));
  }
  const input = readKanbanMoveInput(args);
  if (!input) {
    return fail(action, "invalid_args", "id, status, and numeric position are required.");
  }
  return ok(action, await runtime.moveIssue(input));
}

async function executePetAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const desktopPet = options.desktopPet;
  if (!desktopPet) {
    return fail(action, "pet_action_unavailable", "Desktop pet action is unavailable.");
  }
  const state = await desktopPet.refreshState();
  if (action === "desktop.pet.state") {
    return ok(action, state);
  }
  if (action === "desktop.pet.list") {
    return ok(action, {
      appearanceId: state.appearanceId,
      appearances: state.appearanceOptions
    });
  }
  if (action === "desktop.pet.show") {
    if (!state.supported) {
      return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"), state);
    }
    const nextState = await desktopPet.show();
    if (!nextState.enabled) {
      return fail(action, "pet_enable_failed", "Desktop pet could not be shown.", nextState);
    }
    return ok(action, nextState);
  }
  if (action === "desktop.pet.hide") {
    return ok(action, await desktopPet.hide());
  }
  if (action !== "desktop.pet.set") {
    return fail(action, "unknown_action", `unknown action: ${action}`);
  }
  const appearanceId = readString(args, "appearanceId") || readString(args, "id");
  if (!appearanceId) {
    return fail(action, "invalid_args", "id or appearanceId is required.");
  }
  if (!state.supported) {
    return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"), state);
  }
  const appearance = state.appearanceOptions.find((candidate) => candidate.id === appearanceId);
  if (!appearance) {
    return fail(action, "pet_appearance_not_found", t("settings.desktopPet.enableUnavailable"), {
      appearanceId,
      appearances: state.appearanceOptions
    });
  }
  return ok(action, await desktopPet.saveSettings({ appearanceId }));
}

async function executeAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const args = asRecord(request.args);

  if (WEBAPP_PAGE_ONLY_ACTIONS.has(action)) {
    return invocation.kind === "webappPage"
      ? executeNativeWebappAction(options, action, args, invocation.webappId)
      : fail(action, "forbidden", "This native action is available only to an authorized local WebApp page.");
  }

  switch (action) {
    case "desktop.assistant.chat": {
      const isWebappInvocation = invocation.kind === "webappPage" || invocation.kind === "webappBackend";
      const allowedWebappArgs = new Set(["message"]);
      if (isWebappInvocation) {
        const rejectedKeys = Object.keys(args).filter((key) => !allowedWebappArgs.has(key));
        if (rejectedKeys.length > 0) {
          return fail(
            action,
            "invalid_args",
            `WebApp assistant calls only accept message; rejected: ${rejectedKeys.join(", ")}.`
          );
        }
      }
      const message = typeof args.message === "string" ? args.message : "";
      if (!message.trim()) {
        return fail(action, "invalid_args", "message is required");
      }
      const settings = getAssistantSettings(options.app);
      let agentKey = settings.desktopHelperAgentKey;
      let assistantMessage = message;
      if (isWebappInvocation) {
        const item = webappManager.list(options.app).find((candidate) => candidate.id === invocation.webappId) ?? null;
        const assistantConfig = item ? getWebappAssistantChatConfig(item) : null;
        if (!assistantConfig) {
          return fail(action, "forbidden", "assistant.chat is not declared by this WebApp.");
        }
        if (assistantConfig.agentKey) {
          let agents: Awaited<ReturnType<AgentPlatformAssistantBridge["listAgents"]>> = [];
          try {
            agents = await options.assistantBridge.listAgents();
          } catch {
            agents = [];
          }
          if (!agents.some((candidate) => candidate.agentKey === assistantConfig.agentKey)) {
            return fail(
              action,
              "assistant_agent_unavailable",
              `assistant agent is unavailable: ${assistantConfig.agentKey}`
            );
          }
          agentKey = assistantConfig.agentKey;
        }
        if (assistantConfig.instruction) {
          assistantMessage = [
            "[WebApp instruction]",
            assistantConfig.instruction,
            "",
            "[User input]",
            message
          ].join("\n");
        }
      }
      if (assistantMessage.length > MAX_ASSISTANT_PROMPT_CHARS) {
        return fail(
          action,
          "assistant_message_too_long",
          `combined assistant input must be at most ${MAX_ASSISTANT_PROMPT_CHARS} characters`
        );
      }
      const completion = await options.assistantBridge.completeText({
        agentKey,
        source: "copilot",
        action: "chat",
        message: assistantMessage
      });
      if (!completion.ok) {
        return fail(action, "assistant_failed", completion.message, {
          runId: completion.runId,
          chatId: completion.chatId
        });
      }
      const text = completion.text.trim();
      if (!text) {
        return fail(action, "assistant_empty", "Desktop assistant returned an empty response", {
          runId: completion.runId,
          chatId: completion.chatId
        });
      }
      return ok(action, {
        text,
        ...(isWebappInvocation ? { agentKey } : {}),
        runId: completion.runId,
        chatId: completion.chatId
      });
    }
    case "desktop.theme.get":
    case "desktop.theme.set":
    case "desktop.locale.get":
    case "desktop.locale.set":
    case "desktop.copilot.getPagePreferences":
    case "desktop.copilot.setPagePreference":
    case "desktop.web.listSurfaces":
    case "desktop.web.getSurfaceState":
    case "desktop.web.activateSurface":
    case "desktop.web.navigate":
    case "desktop.web.reload":
    case "desktop.web.refreshSurface":
    case "desktop.web.goBack":
    case "desktop.web.openTab":
    case "desktop.web.closeTab":
    case "desktop.web.switchTab":
    case "desktop.web.interactElement":
    case "desktop.web.executeScript":
    case "desktop.chatWorkPanel.getState":
    case "desktop.chatWorkPanel.open":
    case "desktop.chatWorkPanel.close":
    case "desktop.chatWorkPanel.openTab":
    case "desktop.chatWorkPanel.activateTab":
    case "desktop.chatWorkPanel.closeTab":
      return callRendererAction(options, request, args);
    case "desktop.general.deviceName": {
      const deviceInfo = getDesktopDeviceInfo(options.app);
      return ok(action, {
        deviceName: deviceInfo.deviceName,
        configuredDeviceName: deviceInfo.configuredDeviceName
      });
    }
    case "desktop.navigate.toRoute": {
      const route = readString(args, "route") || readString(args, "path");
      if (!route.startsWith("/")) {
        return fail(action, "invalid_args", "route must start with /");
      }
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.controlCenter.listServices":
      return ok(action, await listServices(options.app));
    case "desktop.controlCenter.openService": {
      const serviceId = readServiceId(args);
      const services = await listServices(options.app);
      if (!services.some((service) => service.id === serviceId)) {
        return fail(action, "service_not_found", "The Desktop service was not found.");
      }
      const route = `/settings/control?serviceId=${encodeURIComponent(serviceId)}`;
      options.navigate(route);
      return ok(action, { serviceId, route });
    }
    case "desktop.controlCenter.getServiceStatus":
    case "desktop.controlCenter.getServiceDetail":
      return ok(action, await getResponsiveServiceState(options.app, readServiceId(args)));
    case "desktop.controlCenter.getServiceLogsMeta":
      return ok(action, await getServiceLogsMeta(options.app, readServiceId(args)));
    case "desktop.controlCenter.readServiceLog": {
      const target = readString(args, "target") === "error" ? "error" : "main";
      return ok(action, await readServiceLog(options.app, readServiceId(args), target as ServiceLogTarget, {
        limitBytes: typeof args.limitBytes === "number" ? args.limitBytes : undefined,
        beforeOffset: typeof args.beforeOffset === "number" ? args.beforeOffset : undefined
      }));
    }
    case "desktop.controlCenter.openLogViewer":
      return ok(action, await options.openLogViewer({
        serviceId: readServiceId(args),
        target: readString(args, "target") === "error" ? "error" : "main",
        title: readString(args, "title") || t("service.logFile")
      }));
    case "desktop.controlCenter.installService": {
      await installBuiltinService(options.app, readServiceId(args));
      return ok(action, await getServiceState(options.app, readServiceId(args)));
    }
    case "desktop.controlCenter.initializeService":
      return ok(action, await initializeService(options.app, readServiceId(args)));
    case "desktop.controlCenter.startService":
      return ok(action, await startService(options.app, readServiceId(args)));
    case "desktop.controlCenter.stopService":
      return ok(action, await stopService(options.app, readServiceId(args)));
    case "desktop.controlCenter.restartService":
      return ok(action, await restartService(options.app, readServiceId(args)));
    case "desktop.site.list":
    case "desktop.website.list":
    case "desktop.website.add":
    case "desktop.website.update":
    case "desktop.website.remove":
    case "desktop.website.open":
    case "desktop.webapp.getStatus":
    case "desktop.webapp.start":
    case "desktop.webapp.stop":
    case "desktop.webapp.restart":
    case "desktop.webapp.open":
    case "desktop.webapp.updatePreferences":
    case "desktop.webapp.checkRuntime":
    case "desktop.webapp.install":
    case "desktop.webapp.uninstall":
    case "desktop.webapp.getPublishStatus":
    case "desktop.webapp.publish":
    case "desktop.webapp.unpublish":
      return executeWebAction(options, action, args);
    case "desktop.market.getSettings":
      return ok(action, getMarketSettings(options.app));
    case "desktop.market.validateSettings":
      return ok(action, validateMarketSettings(args));
    case "desktop.market.previewSettingsPatch": {
      const patch = asRecord(args.patch);
      const current = getMarketSettings(options.app);
      const next = saveMarketSettingsPreview(patch, current);
      return preview(action, {
        changes: [
          {
            field: "enabled",
            from: current.enabled,
            to: next.enabled
          },
          {
            field: "apiBaseUrl",
            from: current.apiBaseUrl,
            to: next.apiBaseUrl
          }
        ].filter((change) => change.from !== change.to)
      });
    }
    case "desktop.market.applySettingsPatch":
      return ok(action, saveMarketSettings(options.app, saveMarketSettingsPreview(asRecord(args.patch), getMarketSettings(options.app))));
    case "desktop.market.listItems":
      return ok(action, await listMarketItems(options.app, readMarketListOptions(args)));
    case "desktop.market.refresh":
      return ok(action, await refreshMarketCatalog(options.app, readMarketListOptions(args)));
    case "desktop.market.getItemDetail": {
      const itemId = readItemId(args);
      const market = await listMarketItems(options.app, readMarketListOptions(args));
      const item = market.items.find((candidate) => candidate.id === itemId);
      return item ? ok(action, item) : fail(action, "not_found", `market item not found: ${itemId}`);
    }
    case "desktop.market.installItem":
      return ok(action, await installMarketItem(options.app, readItemId(args)));
    case "desktop.market.updateItem":
      return ok(action, await updateMarketItem(options.app, readItemId(args)));
    case "desktop.market.uninstallItem":
      return ok(action, await uninstallMarketItem(options.app, readItemId(args)));
    case "desktop.market.openItem": {
      const itemId = readItemId(args);
      const route = `/market?itemId=${encodeURIComponent(itemId)}`;
      options.navigate(route);
      return ok(action, { itemId, route });
    }
    case "desktop.market.importSkill":
      return fail(action, "interactive_file_picker_required", t("desktopAction.marketImportRequiresPicker"));
    case "desktop.market.importSandboxImage":
      return fail(action, "interactive_file_picker_required", t("desktopAction.sandboxImportRequiresPicker"));
    case "desktop.market.exportSandboxImage": {
      const targetPath = readString(args, "targetPath");
      if (!targetPath) {
        return fail(action, "target_path_required", t("desktopAction.sandboxExportTargetRequired"));
      }
      return ok(action, await exportSandboxImageToPath(options.app, readItemId(args), targetPath));
    }
    case "desktop.market.deleteSandboxImage":
      return ok(action, await deleteSandboxImage(options.app, readItemId(args)));
    case "desktop.market.buildSandboxImage":
      return ok(action, await buildSandboxImage(options.app, readItemId(args)));
    case "desktop.help.openTopic": {
      const route = resolveHelpOpenRoute(args);
      if (!route) {
        return fail(action, "invalid_args", "route, topic, or id must resolve to an allowed Help route.");
      }
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.agent.open": {
      const agentKey = readString(args, "agentKey") || readString(args, "id");
      if (!agentKey) {
        return fail(action, "invalid_args", "agentKey is required.");
      }
      const route = `/agents/${encodeURIComponent(agentKey)}`;
      options.navigate(route);
      return ok(action, { agentKey, route });
    }
    case "desktop.skill.open": {
      const skillKey = readString(args, "skillKey") || readString(args, "id");
      if (!skillKey) {
        return fail(action, "invalid_args", "skillKey is required.");
      }
      const route = `/skills/${encodeURIComponent(skillKey)}`;
      options.navigate(route);
      return ok(action, { skillKey, route });
    }
    case "desktop.agent.update": {
      const agentKey = readString(args, "agentKey") || readString(args, "id");
      if (!agentKey) {
        return fail(action, "invalid_args", "agentKey is required.");
      }
      const definition = asRecord(args.definition);
      const response = await callAgentPlatform(options.app, "/api/admin/agents/update", {
        method: "POST",
        body: {
          agentKey,
          ...(Object.keys(definition).length > 0 ? { definition } : {}),
          ...(typeof args.soulPrompt === "string" ? { soulPrompt: args.soulPrompt.slice(0, 100_000) } : {}),
          ...(typeof args.agentsPrompt === "string" ? { agentsPrompt: args.agentsPrompt.slice(0, 100_000) } : {})
        }
      });
      return ok(action, response);
    }
    case "desktop.skill.update": {
      const skillKey = readString(args, "skillKey") || readString(args, "id");
      const filePath = readString(args, "path") || "SKILL.md";
      if (!skillKey) {
        return fail(action, "invalid_args", "skillKey is required.");
      }
      if (typeof args.content !== "string") {
        return fail(action, "invalid_args", "content is required.");
      }
      if (args.content.length > 1024 * 1024) {
        return fail(action, "invalid_args", "content exceeds the 1 MiB editable text limit.");
      }
      const response = await callAgentPlatform(options.app, "/api/admin/skills/file", {
        method: "PUT",
        body: {
          key: skillKey,
          path: filePath,
          content: args.content,
          ...(typeof args.baseSha256 === "string" && args.baseSha256.trim()
            ? { baseSha256: args.baseSha256.trim() }
            : {})
        }
      });
      return ok(action, response);
    }
    case "desktop.kanban.listIssues":
    case "desktop.kanban.getIssue":
    case "desktop.kanban.createIssue":
    case "desktop.kanban.updateIssue":
    case "desktop.kanban.deleteIssue":
    case "desktop.kanban.moveIssue":
      return executeKanbanAction(options, action, args);
    case "desktop.pet.state":
    case "desktop.pet.show":
    case "desktop.pet.hide":
    case "desktop.pet.list":
    case "desktop.pet.set":
      return executePetAction(options, action, args);
    default:
      return fail(action, "unknown_action", `unknown action: ${action}`);
  }
}

async function handleActionCallRaw(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  const action = typeof request.action === "string" ? request.action.trim() : "";
  if (!action || !getDesktopActionDefinition(action)) {
    return fail(action || "unknown", "unknown_action", `unknown action: ${action || "(empty)"}`);
  }
  const normalizedRequest = { ...request, action };
  const args = asRecord(request.args);
  if (CURRENT_PAGE_WEB_ACTIONS.has(action)) {
    const snapshot = options.getCurrentPageSnapshot();
    if (
      request.expectedPageKey &&
      snapshot?.pageKey &&
      request.expectedPageKey !== snapshot.pageKey
    ) {
      return fail(action, "stale_page_target", t("desktopAction.stalePageTarget"), {
        expectedPageKey: request.expectedPageKey,
        currentPageKey: snapshot.pageKey
      });
    }
  }
  if (isDesktopActionMutating(action) && invocation.kind === "desktop") {
    const confirmationResponse = await confirmDesktopActionIfNeeded(options, normalizedRequest, args);
    if (confirmationResponse) {
      return confirmationResponse;
    }
  }
  try {
    return await executeAction(options, normalizedRequest, invocation);
  } catch (error) {
    return fail(action, "action_failed", error instanceof Error ? error.message : String(error));
  }
}

function normalizeActionResponseTimePayload(
  response: DesktopActionCallResponse
): DesktopActionCallResponse {
  if (response.result === undefined) return response;
  const schema = getDesktopActionDefinition(response.action)?.outputSchema;
  if (!schema) return response;
  try {
    return {
      ...response,
      result: normalizeActionBridgeTimePayload(
        response.result,
        schema,
        `desktop.action.${response.action}.result`
      )
    };
  } catch (error) {
    if (!(error instanceof ActionBridgeTimeContractError)) throw error;
    return {
      ok: false,
      action: response.action,
      error: {
        code: "time_contract_violation",
        message: "time contract violation",
        details: {
          code: "time_contract_violation",
          field: error.field,
          location: error.location,
          expected: "epoch_ms_int64"
        }
      }
    };
  }
}

async function handleActionCall(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  return normalizeActionResponseTimePayload(
    await handleActionCallRaw(options, request, invocation)
  );
}

export async function handleDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request);
}

export async function handleWebappPageActionRequest(
  options: DesktopActionBridgeOptions,
  webappId: string,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, {
    ...request,
    source: { webappId }
  }, { kind: "webappPage", webappId });
}

export async function handleDesktopCdpRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopCdpCallRequest
): Promise<DesktopCdpCallResponse> {
  const method = typeof request.method === "string" ? request.method.trim() : "";
  if (!method) {
    return cdpFail("unknown", "invalid_args", "method is required");
  }
  if (!DESKTOP_CDP_PUBLIC_METHODS.some((candidate) => candidate === method)) {
    return cdpFail(method, "method_not_allowed", "This CDP method is not exposed by Desktop.");
  }
  const params = { ...asRecord(request.params) };
  let targetId = typeof request.targetId === "string" ? request.targetId.trim() : "";
  if (method === "Target.closeTarget") {
    const paramsTargetId = typeof params.targetId === "string" ? params.targetId.trim() : "";
    if (targetId && paramsTargetId && targetId !== paramsTargetId) {
      return cdpFail(method, "invalid_args", "targetId conflicts with params.targetId.");
    }
    targetId ||= paramsTargetId;
    const extraParamKeys = Object.keys(params).filter((key) => key !== "targetId");
    if (extraParamKeys.length > 0) {
      return cdpFail(method, "invalid_args", "Target.closeTarget only accepts targetId.");
    }
    if (!targetId) {
      return cdpFail(method, "target_required", "targetId is required for this CDP method.");
    }
    delete params.targetId;
  }
  try {
    const response = await options.executeCdpCommand({
      method,
      params,
      targetId,
      ...(request.source?.chatId ? { source: { chatId: request.source.chatId } } : {})
    });
    return {
      ok: true,
      method,
      result: response.result,
      ...(response.targetId ? { targetId: response.targetId } : {}),
      ...(response.surfaceId ? { surfaceId: response.surfaceId } : {})
    };
  } catch (error) {
    if (isDesktopCdpTimeoutError(error)) {
      return cdpFail(method, DESKTOP_CDP_TARGET_TIMEOUT_CODE, error.message, readDesktopCdpErrorDetails(error));
    }
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "cdp_failed";
    return cdpFail(method, errorCode, error instanceof Error ? error.message : String(error));
  }
}

function isLocalhostRequest(req: http.IncomingMessage) {
  return req.socket.remoteAddress === DESKTOP_ACTION_BRIDGE_HOST ||
    req.socket.remoteAddress === "::ffff:127.0.0.1";
}

function hasJsonContentType(req: http.IncomingMessage) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.split(";")[0].trim() === "application/json";
}

function readBearerToken(req: http.IncomingMessage) {
  const authorization = String(req.headers.authorization || "").trim();
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
}

export function startDesktopActionBridge(options: DesktopActionBridgeOptions) {
  const bridgePort = getConfiguredDesktopActionBridgePort(options.app);
  if (activeServer) {
    if (activeServerPort === bridgePort) {
      return activeServer;
    }
    const previousServer = activeServer;
    activeServer = null;
    activeServerPort = 0;
    previousServer.close();
  }

  const server = http.createServer(async (req, res) => {
    if (!isLocalhostRequest(req)) {
      writeJSON(res, 403, fail("unknown", "forbidden", "Desktop Action Bridge only accepts localhost requests."));
      return;
    }

    const url = new URL(req.url || "/", `http://${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJSON(res, 200, {
        ok: true,
        host: DESKTOP_ACTION_BRIDGE_HOST,
        port: (server.address() as AddressInfo | null)?.port ?? bridgePort
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/actions") {
      writeJSON(res, 200, { ok: true, actions: DESKTOP_ACTION_DEFINITIONS });
      return;
    }
    if (req.method === "POST" && url.pathname === "/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const response = await handleActionCall(options, parsed);
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "backendActionToken"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp action token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappBackend", webappId: authorization.webappId }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/pages/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "localPageGateway"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp page token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappPage", webappId: authorization.webappId }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/cdp/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, cdpFail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopCdpCallRequest;
        const response = await handleDesktopCdpRequest(options, parsed);
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, cdpFail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    writeJSON(res, 404, fail("unknown", "not_found", "Desktop Action Bridge route not found."));
  });

  server.listen(bridgePort, DESKTOP_ACTION_BRIDGE_HOST, () => {
    console.log(`[desktop-action-bridge] listening on ${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
  });
  server.on("error", (error) => {
    console.warn(`[desktop-action-bridge] failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  activeServer = server;
  activeServerPort = bridgePort;
  return server;
}

export function stopDesktopActionBridge() {
  const server = activeServer;
  activeServer = null;
  activeServerPort = 0;
  server?.close();
}

export const __testInternals = {
  buildDesktopActionConfirmationDetail,
  buildMutatingActionConfirmationRequest,
  buildPageControlActionConfirmationRequest,
  normalizeActionResponseTimePayload,
  sanitizeConfirmationUrl,
  summarizeConfirmationArgs,
  fetchAgentPlatformWithAuth,
  clearWebappActionRateLimits: () => webappActionRateLimiter.clear()
};
