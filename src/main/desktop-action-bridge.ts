import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { App, BrowserWindow } from "electron";
import { dialog } from "electron";
import type {
  DesktopActionRendererRequest,
  DesktopActionRendererResponse,
  DesktopPageContextSnapshot,
  MarketListOptions,
  ServiceId,
  ServiceLogTarget,
  ServiceOpenLogViewerRequest
} from "../shared/contracts";
import {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_BRIDGE_PORT,
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  isDesktopActionMutating,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionError,
  type DesktopActionSource
} from "../shared/desktop-actions";
import { AGENT_WEBCLIENT_ROUTE_DEFINITIONS } from "../shared/agent-webclient-routes";
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
import {
  StaticSiteHostError,
  staticSiteHostManager
} from "./static-site-host-manager";
import { listWebEntries } from "./ipc/web-handlers";
import { webappRuntime } from "./webs/webapps/runtime";
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
import {
  readTunnelHubSettings,
  validateTunnelHubSettingsInput
} from "./tunnel-hub-settings";
import {
  applyTunnelHubSettings,
  getTunnelHubRuntimeStatus,
  readTunnelHubRuntimeLog,
  restartTunnelHubRuntime,
  startTunnelHubRuntime,
  stopTunnelHubRuntime
} from "./tunnel-hub-runtime";
import {
  executeCurrentPageCdpAction,
  inspectCurrentPageCdpElement,
  readCurrentPageCdpLocation,
  type CurrentPageCdpElementSnapshot
} from "./current-page-cdp-executor";
import { t } from "./i18n/main-i18n";

type DesktopActionBridgeOptions = {
  app: App;
  assistantBridge: AgentPlatformAssistantBridge;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
  navigate: (targetPath: string) => void;
  openLogViewer: (request: ServiceOpenLogViewerRequest) => Promise<{ ok: boolean }>;
  callRendererAction: (request: DesktopActionRendererRequest) => Promise<DesktopActionRendererResponse>;
  executeCdpCommand: (request: EmbeddedCdpCommandRequest) => Promise<{ targetId: string; surfaceId: string; result: unknown }>;
};

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
  surfaceId?: string;
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
const PAGE_CONTROL_GRANT_TTL_MS = 10 * 60 * 1000;
const PAGE_CONTROL_LOW_RISK_INTERACTIONS = new Set(["fill", "scroll", "focus", "select"]);
const PAGE_CONTROL_HIGH_RISK_PATTERN =
  /(\u63d0\u4ea4|\u5220\u9664|\u79fb\u9664|\u6e05\u7a7a|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u4e0b\u5355|\u8ba2\u5355|\u786e\u8ba4\u8ba2\u5355|\u9000\u6b3e|\u8f6c\u8d26|\u6388\u6743|\u786e\u8ba4\u6388\u6743|\u540c\u610f\u6388\u6743|\u5b89\u88c5|\u5378\u8f7d|\u542f\u52a8|\u505c\u6b62|\u91cd\u542f|\u53d1\u5e03|\u53d1\u9001|\u4fdd\u5b58|\u767b\u5f55|\u6ce8\u518c|submit|delete|remove|clear|pay|payment|purchase|buy|checkout|order|refund|transfer|authorize|approve|install|uninstall|start|stop|restart|deploy|publish|send|save|login|sign\s*in|sign\s*up)/iu;
let activeServer: http.Server | null = null;

function agentPlatformAuthFailureMessage() {
  return t("desktopAction.agentPlatformAuthFailed");
}

const agentWebclientHelpTopicTitles = new Map([
  ["agents", "nav.agents"],
  ["schedules", "nav.schedules"],
  ["memory", "nav.memory"],
  ["copilot", "service.display.agentWebclient"]
]);

function createAgentWebclientHelpTopics() {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.map((route) => ({
    id: route.key,
    title: t((agentWebclientHelpTopicTitles.get(route.key) ?? route.key) as any),
    route: route.routePath
  }));
}

function resolveAgentWebclientHelpRoute(topic: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((route) =>
    route.key === topic ||
    route.routePath === topic ||
    route.routePath.slice(1) === topic
  )?.routePath ?? null;
}

type PageControlGrantScope = {
  chatId: string;
  agentKey: string;
  webContentsId: number;
  origin: string;
  surfaceLabel?: string;
  pageTitle?: string;
};

type PageControlConfirmationDecision = "grant" | "once" | "cancel";

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

function readTunnelHubSettingsInput(args: Record<string, unknown>) {
  const settings = asRecord(args.settings);
  const patch = asRecord(args.patch);
  const source = hasObjectKeys(settings) ? settings : hasObjectKeys(patch) ? patch : args;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : undefined,
    relayUrl: typeof source.relayUrl === "string" ? source.relayUrl : undefined,
    deviceId: typeof source.deviceId === "string" ? source.deviceId : undefined,
    relayToken: typeof source.relayToken === "string" ? source.relayToken : undefined,
    clearRelayToken: source.clearRelayToken === true,
    registrationToken: typeof source.registrationToken === "string" ? source.registrationToken : undefined,
    clearRegistrationToken: source.clearRegistrationToken === true,
    rotateRelayToken: source.rotateRelayToken === true,
    tlsInsecureSkipVerify: source.tlsInsecureSkipVerify === true,
    reconnectSeconds: typeof source.reconnectSeconds === "number"
      ? source.reconnectSeconds
      : typeof source.reconnectSeconds === "string" && source.reconnectSeconds.trim()
        ? Number(source.reconnectSeconds)
        : undefined
  };
}


function readServiceId(args: Record<string, unknown>) {
  const serviceId = readString(args, "serviceId");
  if (!serviceId) {
    throw new Error("serviceId is required");
  }
  return serviceId as ServiceId;
}

function readStaticSiteId(args: Record<string, unknown>) {
  const siteId = readString(args, "siteId");
  if (!siteId) {
    throw new StaticSiteHostError("invalid_args", "siteId is required.");
  }
  return siteId;
}

function readWebappId(args: Record<string, unknown>) {
  const webappId = readString(args, "webappId") || readString(args, "id");
  if (!webappId) {
    throw new Error("webappId is required");
  }
  return webappId;
}

function readItemId(args: Record<string, unknown>) {
  const itemId = readString(args, "itemId");
  if (!itemId) {
    throw new Error("itemId is required");
  }
  return itemId;
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

function readAutomationId(args: Record<string, unknown>) {
  const id = readString(args, "id") || readString(args, "automationId") || readString(args, "scheduleId");
  if (!id) {
    throw new Error("automation id is required");
  }
  return id;
}

function readAgentKey(args: Record<string, unknown>) {
  const key = readString(args, "key") || readString(args, "agentKey");
  if (!key) {
    throw new Error("agent key is required");
  }
  return key;
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

function validateAgentConfig(args: Record<string, unknown>) {
  const definition = asRecord(args.definition);
  const key = readString(args, "key") || (typeof definition.key === "string" ? definition.key.trim() : "");
  const issues = [];
  if (!key) {
    issues.push({ field: "key", message: "agent key is required" });
  }
  if (key.includes("/") || key.includes("\\") || key.includes("..")) {
    issues.push({ field: "key", message: "agent key must not contain path separators or traversal" });
  }
  if (definition.key && definition.key !== key) {
    issues.push({ field: "definition.key", message: "definition.key must match key" });
  }
  if (!definition.name) {
    issues.push({ field: "definition.name", message: "agent name is recommended" });
  }
  return {
    valid: issues.length === 0,
    issues,
    key,
    definition
  };
}

function validateAutomation(args: Record<string, unknown>) {
  const issues = [];
  if (!readString(args, "name") && !readString(args, "id")) {
    issues.push({ field: "name", message: "automation name is required for create, id is required for update" });
  }
  if (!readString(args, "cron")) {
    issues.push({ field: "cron", message: "cron is required" });
  }
  const query = asRecord(args.query);
  if (!readString(query, "message")) {
    issues.push({ field: "query.message", message: "query.message is required" });
  }
  return {
    valid: issues.length === 0,
    issues
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

async function confirmMutatingAction(action: string, args: Record<string, unknown>, owner: BrowserWindow | null) {
  const providedSummary = typeof args.confirmationSummary === "string" && args.confirmationSummary.trim()
    ? args.confirmationSummary.trim()
    : "";
  const summary = providedSummary || buildStaticServerConfirmationSummary(action, args) || t("desktopAction.confirmSummary", { action });
  const dialogOptions = {
    type: "question" as const,
    buttons: [t("desktopAction.confirmExecute"), t("common.cancel")],
    defaultId: 1,
    cancelId: 1,
    title: t("desktopAction.confirmActionTitle"),
    message: summary,
    detail: t("desktopAction.confirmActionDetail")
  };
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return result.response === 0;
}

function buildStaticServerConfirmationSummary(action: string, args: Record<string, unknown>) {
  if (action === "desktop.staticServer.start") {
    const rootDir = readString(args, "rootDir") || t("desktopAction.missingValue");
    const rawPort = args.port === undefined || args.port === null || args.port === "" ? "" : String(args.port);
    const target = rawPort ? `http://127.0.0.1:${rawPort}/` : "http://127.0.0.1:<auto>/";
    return t("desktopAction.staticServerStartSummary", { rootDir, target });
  }
  if (action === "desktop.staticServer.stop" || action === "desktop.staticServer.restart") {
    const siteId = readString(args, "siteId");
    const state = staticSiteHostManager.list().find((item) => item.siteId === siteId);
    const verb = action.endsWith(".restart") ? t("desktopAction.staticServerRestart") : t("desktopAction.staticServerStop");
    const rootDir = state?.rootDir || t("desktopAction.unknownValue");
    const target = state?.webUrl || (state?.requestedPort ? `http://127.0.0.1:${state.requestedPort}/` : t("desktopAction.notRunningValue"));
    return t("desktopAction.staticServerControlSummary", {
      verb,
      siteId: siteId || t("desktopAction.missingValue"),
      rootDir,
      target
    });
  }
  return "";
}

async function confirmPageControlAction(
  scope: PageControlGrantScope,
  args: Record<string, unknown>,
  owner: BrowserWindow | null
): Promise<PageControlConfirmationDecision> {
  const summary = typeof args.confirmationSummary === "string" && args.confirmationSummary.trim()
    ? args.confirmationSummary.trim()
    : t("desktopAction.pageControlSummary", { origin: scope.origin });
  const targetLabel = [scope.surfaceLabel, scope.pageTitle].filter(Boolean).join(" · ") || scope.origin;
  const dialogOptions = {
    type: "question" as const,
    buttons: [t("desktopAction.pageControlGrant"), t("desktopAction.pageControlOnce"), t("common.cancel")],
    defaultId: 1,
    cancelId: 2,
    title: t("desktopAction.pageControlTitle"),
    message: summary,
    detail: [
      t("desktopAction.pageControlTarget", { target: targetLabel }),
      t("desktopAction.pageControlGrantDetail"),
      t("desktopAction.pageControlHighRiskDetail")
    ].join("\n")
  };
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  if (result.response === 0) {
    return "grant";
  }
  if (result.response === 1) {
    return "once";
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
  if (action === "desktop.page.fillForm") {
    return true;
  }
  if (action !== "desktop.page.interact") {
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
      const decision = await confirmPageControlAction(scope, args, options.getMainWindow());
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
  const confirmed = await confirmMutatingAction(action, args, options.getMainWindow());
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

async function callRendererPageAction(
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

async function executeStaticServerAction(action: string, args: Record<string, unknown>) {
  try {
    if (action === "desktop.staticServer.start") {
      return ok(action, await staticSiteHostManager.start(args));
    }
    if (action === "desktop.staticServer.stop") {
      return ok(action, await staticSiteHostManager.stop(readStaticSiteId(args)));
    }
    if (action === "desktop.staticServer.restart") {
      return ok(action, await staticSiteHostManager.restart(readStaticSiteId(args)));
    }
    return ok(action, staticSiteHostManager.list());
  } catch (error) {
    if (error instanceof StaticSiteHostError) {
      return fail(action, error.code, error.message, error.details);
    }
    throw error;
  }
}

async function executeWebsAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  if (action === "desktop.webs.list") {
    return ok(action, listWebEntries(options.app));
  }
  if (action === "desktop.webs.webapps.getStatus") {
    return ok(action, webappRuntime.getStatus(options.app, readWebappId(args)));
  }
  if (action === "desktop.webs.webapps.start") {
    return ok(action, await webappRuntime.start(options.app, readWebappId(args)));
  }
  if (action === "desktop.webs.webapps.stop") {
    return ok(action, await webappRuntime.stop(options.app, readWebappId(args)));
  }
  return ok(action, await webappRuntime.restart(options.app, readWebappId(args)));
}

async function executeAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const args = asRecord(request.args);

  switch (action) {
    case "desktop.page.getContext":
      if (options.getCurrentPageSnapshot()) {
        return ok(action, {
          source: "desktop",
          ...options.getCurrentPageSnapshot()
        });
      }
      return callRendererPageAction(options, request, args);
    case "desktop.page.readCurrent":
    case "desktop.page.extractStructured":
    case "desktop.page.interact":
    case "desktop.page.fillForm":
    case "desktop.page.submitForm": {
      const cdpResponse = await executeCurrentPageCdpAction(options.getCurrentPageSnapshot(), request);
      if (cdpResponse) {
        return cdpResponse;
      }
      return callRendererPageAction(options, request, args);
    }
    case "desktop.page.getFormState":
    case "desktop.page.validateForm":
    case "desktop.page.previewPatch":
    case "desktop.page.applyPatch":
    case "desktop.settings.getState":
    case "desktop.settings.validatePatch":
    case "desktop.settings.previewPatch":
    case "desktop.settings.applyPatch":
    case "desktop.embeddedWeb.listSurfaces":
    case "desktop.embeddedWeb.getActiveSurface":
    case "desktop.embeddedWeb.activateSurface":
    case "desktop.embeddedWeb.getPageContext":
    case "desktop.embeddedWeb.navigate":
    case "desktop.embeddedWeb.reload":
    case "desktop.embeddedWeb.goBack":
    case "desktop.embeddedWeb.openTab":
    case "desktop.embeddedWeb.closeTab":
    case "desktop.embeddedWeb.switchTab":
    case "desktop.embeddedWeb.readPageData":
    case "desktop.embeddedWeb.extractStructured":
    case "desktop.embeddedWeb.interactElement":
    case "desktop.embeddedWeb.executeScript":
      return callRendererPageAction(options, request, args);
    case "desktop.navigate.toRoute": {
      const route = readString(args, "route") || readString(args, "path");
      if (!route.startsWith("/")) {
        return fail(action, "invalid_args", "route must start with /");
      }
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.tunnelHub.getSettings":
      return ok(action, readTunnelHubSettings(options.app));
    case "desktop.tunnelHub.validateSettings": {
      const validation = validateTunnelHubSettingsInput(readTunnelHubSettingsInput(args));
      return ok(action, {
        valid: validation.valid,
        issues: validation.issues,
        settings: validation.settings
      });
    }
    case "desktop.tunnelHub.applySettings": {
      return ok(action, await applyTunnelHubSettings(readTunnelHubSettingsInput(args)));
    }
    case "desktop.tunnelHub.getStatus":
      return ok(action, getTunnelHubRuntimeStatus());
    case "desktop.tunnelHub.start":
      return ok(action, await startTunnelHubRuntime());
    case "desktop.tunnelHub.stop":
      return ok(action, await stopTunnelHubRuntime());
    case "desktop.tunnelHub.restart":
      return ok(action, await restartTunnelHubRuntime());
    case "desktop.tunnelHub.readLog": {
      return ok(action, readTunnelHubRuntimeLog({
        limitBytes: typeof args.limitBytes === "number" ? args.limitBytes : undefined,
        beforeOffset: typeof args.beforeOffset === "number" ? args.beforeOffset : undefined
      }));
    }


    case "desktop.controlCenter.listServices":
      return ok(action, await listServices(options.app));
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
    case "desktop.staticServer.list":
    case "desktop.staticServer.start":
    case "desktop.staticServer.stop":
    case "desktop.staticServer.restart":
      return executeStaticServerAction(action, args);
    case "desktop.webs.list":
    case "desktop.webs.webapps.getStatus":
    case "desktop.webs.webapps.start":
    case "desktop.webs.webapps.stop":
    case "desktop.webs.webapps.restart":
      return executeWebsAction(options, action, args);
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
    case "desktop.help.getCurrentTopic":
    case "desktop.help.explainCurrentPage": {
      const response = await callRendererPageAction(options, { ...request, action: "desktop.page.getContext" }, args);
      return { ...response, action };
    }
    case "desktop.help.searchTopics":
      return ok(action, {
        query: readString(args, "query"),
        topics: [
          { id: "control-center", title: t("desktopAction.helpControlCenter"), route: "/control-center" },
          { id: "market", title: t("desktopAction.helpMarket"), route: "/market" },
          ...createAgentWebclientHelpTopics(),
          { id: "settings", title: t("desktopAction.helpSettings"), route: "/settings" },
          { id: "help", title: t("desktopAction.helpHelp"), route: "/help" }
        ]
      });
    case "desktop.help.openTopic":
    case "desktop.help.navigateToRelatedPage": {
      const topic = readString(args, "topic") || readString(args, "id");
      const route = topic === "control-center" ? "/control-center"
        : topic === "market" ? "/market"
          : (resolveAgentWebclientHelpRoute(topic) ?? (topic === "settings" ? "/settings" : "/help"));
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.help.suggestNextAction":
      return ok(action, {
        suggestions: [
          t("desktopAction.suggestionCurrentPage"),
          t("desktopAction.suggestionSettings"),
          t("desktopAction.suggestionRelatedPage")
        ]
      });
    case "desktop.agents.listAgents":
      return ok(action, await options.assistantBridge.listAgents());
    case "desktop.agents.getAgentDetail":
      return ok(action, await callAgentPlatform(options.app, `/api/agent?agentKey=${encodeURIComponent(readAgentKey(args))}`));
    case "desktop.agents.validateAgentConfig":
      return ok(action, validateAgentConfig(args));
    case "desktop.agents.previewAgentConfigPatch":
      return preview(action, { key: readAgentKey(args), patch: asRecord(args.patch), warning: t("desktopAction.previewPatchWarning") });
    case "desktop.agents.applyAgentConfigPatch":
      return fail(action, "unsupported_action", t("desktopAction.updateAgentRequired"));
    case "desktop.agents.createAgentDraft":
      return preview(action, {
        key: readString(args, "key"),
        definition: asRecord(args.definition),
        soulPrompt: typeof args.soulPrompt === "string" ? args.soulPrompt : "",
        agentsPrompt: typeof args.agentsPrompt === "string" ? args.agentsPrompt : ""
      });
    case "desktop.agents.createAgent":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/agents/create", { method: "POST", body: args }));
    case "desktop.agents.updateAgent":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/agents/update", { method: "POST", body: args }));
    case "desktop.agents.deleteAgent":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/agents/delete", { method: "POST", body: { key: readAgentKey(args) } }));
    case "desktop.agents.cloneAgent":
    case "desktop.agents.disableAgent":
    case "desktop.agents.reloadAgents":
      return fail(action, "unsupported_action", `${action} is reserved but not implemented in Desktop v1.`);
    case "desktop.automations.listAutomations":
      return ok(action, await callAgentPlatform(options.app, "/api/automations", { method: "POST", body: {} }));
    case "desktop.automations.getAutomationDetail":
      return ok(action, await callAgentPlatform(options.app, "/api/automation", { method: "POST", body: { id: readAutomationId(args) } }));
    case "desktop.automations.validateAutomation":
      return ok(action, validateAutomation(args));
    case "desktop.automations.previewAutomation":
      return preview(action, { automation: args, validation: validateAutomation(args) });
    case "desktop.automations.createAutomation":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/automations/create", { method: "POST", body: args }));
    case "desktop.automations.updateAutomation":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/automations/update", { method: "POST", body: args }));
    case "desktop.automations.pauseAutomation":
    case "desktop.automations.resumeAutomation":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/automations/toggle", {
        method: "POST",
        body: { id: readAutomationId(args), enabled: action === "desktop.automations.resumeAutomation" }
      }));
    case "desktop.automations.deleteAutomation":
      return ok(action, await callAgentPlatform(options.app, "/api/admin/automations/delete", { method: "POST", body: { id: readAutomationId(args) } }));
    case "desktop.automations.explainNextRun": {
      const id = readAutomationId(args);
      const detail = await callAgentPlatform<Record<string, unknown>>(options.app, "/api/automation", { method: "POST", body: { id } });
      return ok(action, { id, nextFireTime: detail.nextFireTime ?? null, detail });
    }
    default:
      return fail(action, "unknown_action", `unknown action: ${action}`);
  }
}

async function handleActionCall(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
): Promise<DesktopActionCallResponse> {
  const action = typeof request.action === "string" ? request.action.trim() : "";
  if (!action || !getDesktopActionDefinition(action)) {
    return fail(action || "unknown", "unknown_action", `unknown action: ${action || "(empty)"}`);
  }
  const normalizedRequest = { ...request, action };
  const args = asRecord(request.args);
  if (action.startsWith("desktop.page.")) {
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
  if (isDesktopActionMutating(action)) {
    const confirmationResponse = await confirmDesktopActionIfNeeded(options, normalizedRequest, args);
    if (confirmationResponse) {
      return confirmationResponse;
    }
  }
  try {
    return await executeAction(options, normalizedRequest);
  } catch (error) {
    return fail(action, "action_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function handleDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request);
}

export async function handleDesktopCdpRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopCdpCallRequest
): Promise<DesktopCdpCallResponse> {
  const method = typeof request.method === "string" ? request.method.trim() : "";
  if (!method) {
    return cdpFail("unknown", "invalid_args", "method is required");
  }
  try {
    const response = await options.executeCdpCommand({
      method,
      params: asRecord(request.params),
      targetId: typeof request.targetId === "string" ? request.targetId.trim() : "",
      surfaceId: typeof request.surfaceId === "string" ? request.surfaceId.trim() : ""
    });
    return {
      ok: true,
      method,
      result: response.result,
      targetId: response.targetId,
      surfaceId: response.surfaceId
    };
  } catch (error) {
    return cdpFail(method, "cdp_failed", error instanceof Error ? error.message : String(error));
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

export function startDesktopActionBridge(options: DesktopActionBridgeOptions) {
  if (activeServer) {
    return activeServer;
  }

  const server = http.createServer(async (req, res) => {
    if (!isLocalhostRequest(req)) {
      writeJSON(res, 403, fail("unknown", "forbidden", "Desktop Action Bridge only accepts localhost requests."));
      return;
    }

    const url = new URL(req.url || "/", `http://${DESKTOP_ACTION_BRIDGE_HOST}:${DESKTOP_ACTION_BRIDGE_PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJSON(res, 200, { ok: true, host: DESKTOP_ACTION_BRIDGE_HOST, port: (server.address() as AddressInfo | null)?.port ?? DESKTOP_ACTION_BRIDGE_PORT });
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

  server.listen(DESKTOP_ACTION_BRIDGE_PORT, DESKTOP_ACTION_BRIDGE_HOST, () => {
    console.log(`[desktop-action-bridge] listening on ${DESKTOP_ACTION_BRIDGE_HOST}:${DESKTOP_ACTION_BRIDGE_PORT}`);
  });
  server.on("error", (error) => {
    console.warn(`[desktop-action-bridge] failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  activeServer = server;
  return server;
}

export function stopDesktopActionBridge() {
  const server = activeServer;
  activeServer = null;
  server?.close();
}

export const __testInternals = {
  fetchAgentPlatformWithAuth
};
