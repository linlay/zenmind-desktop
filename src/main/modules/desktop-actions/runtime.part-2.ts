import http from "node:http";

import fs from "node:fs";

import path from "node:path";

import { randomUUID } from "node:crypto";

import type { AddressInfo } from "node:net";

import type { App, BrowserWindow, OpenDialogOptions, SaveDialogOptions, WebContents } from "electron";

import { clipboard, dialog, Notification, shell, systemPreferences, webContents } from "electron";

import type {
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

import { createWebappImportDiagnostic, listWebEntries } from "../webs";

import {
  addWebsiteItem,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "../webs";

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

import { AgentPlatformFetchOptions, CONFIRMATION_ARG_MAX_ARRAY_ITEMS, CONFIRMATION_ARG_MAX_KEYS, CONFIRMATION_ARG_MAX_NESTED_KEYS, CONFIRMATION_ARG_SUMMARY_MAX_CHARS, CONFIRMATION_ARG_VALUE_MAX_CHARS, CONFIRMATION_COMPACT_VALUE_MAX_CHARS, DesktopActionBridgeOptions, PAGE_CONTROL_HIGH_RISK_PATTERN, PAGE_CONTROL_LOW_RISK_INTERACTIONS, PageControlConfirmationDecision, PageControlGrantScope, actionError, agentPlatformAuthFailureMessage, asRecord, isUnauthorizedPayload, pageControlGrantStore, readAgentPlatformResponse, readString, unwrapPlatformResponse } from "./runtime.part-1";

export async function fetchAgentPlatformWithAuth<T>(
  baseUrl: string,
  pathOrUrl: string,
  options: AgentPlatformFetchOptions
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestUrl = new URL(pathOrUrl, baseUrl).toString();
  if (options.body !== undefined && options.rawBody !== undefined) {
    throw new Error("agent-platform request cannot contain both JSON and raw bodies");
  }
  let requestBody: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    const body = new ArrayBuffer(options.rawBody.byteLength);
    new Uint8Array(body).set(options.rawBody);
    requestBody = body;
  } else if (options.body !== undefined) {
    requestBody = JSON.stringify(options.body);
  }
  const contentType = options.rawBody !== undefined
    ? options.contentType?.trim() || "application/octet-stream"
    : options.body === undefined ? "" : "application/json";

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
        ...(requestBody === undefined ? {} : { "Content-Type": contentType })
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
  options: {
    method?: string;
    body?: unknown;
    rawBody?: Uint8Array;
    contentType?: string;
    issueAgentAccessToken: DesktopActionBridgeOptions["issueAgentAccessToken"];
  }
): Promise<T> {
  const state = await getResponsiveServiceState(app, "agent-platform");
  const baseUrl = state.status === "running"
    ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
    : "";
  if (!baseUrl) {
    throw new Error("agent-platform is not running");
  }
  const token = await options.issueAgentAccessToken(app, "missing");
  if (!token.ok) {
    throw new Error(token.message || "agent-platform token unavailable");
  }
  return fetchAgentPlatformWithAuth<T>(baseUrl, pathOrUrl, {
    ...options,
    issueToken: async (reason) => (reason === "missing" ? token : options.issueAgentAccessToken(app, reason))
  });
}

export function truncateConfirmationText(value: string, maxChars: number) {
  const chars = Array.from(value.replace(/\s+/gu, " ").trim());
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}...`;
}

export function isSensitiveConfirmationKey(key: string) {
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

export function sanitizeConfirmationUrl(value: string) {
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

export function sanitizeConfirmationUrlText(value: string) {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, (match) => sanitizeConfirmationUrl(match));
}

export function sanitizeConfirmationValue(value: unknown, key = "", depth = 0): unknown {
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
  const entries = Object.entries(record).slice(0, CONFIRMATION_ARG_MAX_NESTED_KEYS);
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries) {
    output[entryKey] = sanitizeConfirmationValue(entryValue, entryKey, depth + 1);
  }
  const hiddenCount = Object.keys(record).length - entries.length;
  if (hiddenCount > 0) {
    output["..."] = t("desktopAction.confirmDetailMore", { count: hiddenCount });
  }
  return output;
}

export function stringifyConfirmationArgValue(key: string, value: unknown) {
  const sanitized = sanitizeConfirmationValue(value, key);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return truncateConfirmationText(text ?? "", CONFIRMATION_ARG_VALUE_MAX_CHARS);
}

export function summarizeConfirmationArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args);
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

export function summarizeConfirmationSource(source: DesktopActionSource | undefined) {
  return [
    `runId=${source?.runId?.trim() || "-"}`,
    `chatId=${source?.chatId?.trim() || "-"}`,
    `agentKey=${source?.agentKey?.trim() || "-"}`,
    `teamId=${source?.teamId?.trim() || "-"}`
  ].join(", ");
}

export function describeDesktopActionSnapshotTarget(snapshot: DesktopPageContextSnapshot | null) {
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

export function buildDesktopActionConfirmationDetail(
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

export function compactConfirmationValue(value: string) {
  return truncateConfirmationText(value, CONFIRMATION_COMPACT_VALUE_MAX_CHARS);
}

export function getConfirmationRequestId(request: DesktopActionCallRequest) {
  return request.requestId?.trim() || randomUUID();
}

export function buildNativeConfirmationDetail(payload: DesktopActionConfirmationRequest) {
  return [
    payload.description,
    "",
    ...payload.fields.map((field) => `${field.label}: ${field.value}`)
  ].filter((line) => line !== undefined).join("\n");
}

export function findConfirmationButtonIndex(
  payload: DesktopActionConfirmationRequest,
  decision: DesktopActionConfirmationDecision
) {
  const index = payload.buttons.findIndex((button) => button.decision === decision);
  return index === -1 ? 0 : index;
}

export function normalizeConfirmationDecision(
  value: unknown,
  fallback: DesktopActionConfirmationDecision
): DesktopActionConfirmationDecision {
  return value === "confirm" || value === "grant" || value === "once" || value === "cancel"
    ? value
    : fallback;
}

export async function requestDesktopActionConfirmation(
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

export function buildMutatingActionConfirmationRequest(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  snapshot: DesktopPageContextSnapshot | null
): DesktopActionConfirmationRequest {
  const action = request.action;
  const summary = t("desktopAction.confirmSummary", { action });
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

export function buildSensitiveReadConfirmationRequest(
  request: DesktopActionCallRequest
): DesktopActionConfirmationRequest {
  const categories = t("desktopAction.sensitiveReadCategories");
  return {
    requestId: getConfirmationRequestId(request),
    kind: "action",
    title: t("desktopAction.sensitiveReadTitle"),
    summary: t("desktopAction.sensitiveReadSummary"),
    description: t("desktopAction.sensitiveReadDescription"),
    fields: [
      { label: t("desktopAction.sensitiveReadFieldCategories"), value: categories }
    ],
    details: t("desktopAction.sensitiveReadDetail", { categories }),
    buttons: [
      { decision: "cancel", label: t("common.cancel"), variant: "cancel" },
      { decision: "confirm", label: t("desktopAction.sensitiveReadConfirm"), variant: "primary" }
    ],
    defaultDecision: "confirm",
    cancelDecision: "cancel"
  };
}

export async function confirmMutatingAction(
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

export function buildPageControlActionConfirmationRequest(
  scope: PageControlGrantScope,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>
): DesktopActionConfirmationRequest {
  const summary = t("desktopAction.pageControlSummary", { origin: scope.origin });
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

export async function confirmPageControlAction(
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

export function normalizePermissionMode(value: unknown) {
  return value === "full_access" || value === "page_control" || value === "default"
    ? value
    : "";
}

export function readRequestPermissionMode(request: DesktopActionCallRequest, args: Record<string, unknown>) {
  return normalizePermissionMode(request.permissionMode) || normalizePermissionMode(args.permissionMode) || "default";
}

export function readSnapshotUrl(snapshot: DesktopPageContextSnapshot) {
  const browserTarget = snapshot.pageContext?.browserTarget;
  if (browserTarget?.kind === "webview" && browserTarget.currentUrl) {
    return browserTarget.currentUrl;
  }
  return snapshot.pageContext?.url || "";
}

export function readUrlOrigin(rawUrl: string) {
  try {
    const origin = new URL(rawUrl).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

export async function resolvePageControlGrantScope(
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

export function collectStringValues(value: unknown, output: string[]) {
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
  for (const key of ["selector", "elementSelector", "label", "text", "title", "name", "id", "className", "value", "href"]) {
    collectStringValues(record[key], output);
  }
}

export function collectElementRiskText(element: CurrentPageCdpElementSnapshot | null) {
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

export function isHighRiskPageActionText(text: string) {
  return PAGE_CONTROL_HIGH_RISK_PATTERN.test(text.replace(/\s+/gu, " ").trim());
}

export async function isLowRiskPageControlAction(
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

export async function confirmDesktopActionIfNeeded(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  confirmationPolicy?: DesktopActionConfirmationPolicy
): Promise<DesktopActionCallResponse | null> {
  if (!readDesktopProfileFromRoot(getDesktopConfigRoot(options.app)).general.desktopActionConfirmationEnabled) {
    return null;
  }
  const action = request.action;
  const permissionMode = readRequestPermissionMode(request, args);
  if (permissionMode === "full_access") {
    return null;
  }
  if (confirmationPolicy === "sensitive-read") {
    const decision = await requestDesktopActionConfirmation(
      options,
      buildSensitiveReadConfirmationRequest(request),
      options.getMainWindow()
    );
    if (decision === "confirm") {
      return null;
    }
    return {
      ok: false,
      action,
      requiresConfirmation: true,
      error: actionError("user_cancelled", t("desktopAction.userCancelled"))
    };
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

export const DESKTOP_WEB_POST_STATE_ACTIONS = new Set([
  "desktop.web.navigate",
  "desktop.web.reload",
  "desktop.web.goBack",
  "desktop.web.openTab",
  "desktop.web.closeTab",
  "desktop.web.switchTab"
]);

export const DESKTOP_WORKPANEL_MUTATION_ACTIONS = new Set([
  "desktop.workpanel.openTab",
  "desktop.workpanel.openWeb",
  "desktop.workpanel.openLocalFile",
  "desktop.workpanel.refreshWeb",
  "desktop.workpanel.activateTab",
  "desktop.workpanel.closeTab",
  "desktop.workpanel.closeWorkpanel"
]);

export function projectDesktopWebActionSurface(
  value: unknown,
  missingFields: string[]
): DesktopWebActionSurfaceSummary | null {
  if (value === null) {
    return null;
  }
  const surface = asRecord(value);
  const surfaceId = typeof surface.surfaceId === "string" ? surface.surfaceId : "";
  const surfaceRole = isSurfaceRole(surface.surfaceRole) ? surface.surfaceRole : null;
  const surfaceLevel = surface.surfaceLevel === "root" || surface.surfaceLevel === "child" || surface.surfaceLevel === "utility"
    ? surface.surfaceLevel
    : null;
  const interaction = surface.interaction === "interactive" || surface.interaction === "read-only" || surface.interaction === "none"
    ? surface.interaction
    : null;
  const kind = surface.kind === "website" || surface.kind === "webapp" || surface.kind === "browser" || surface.kind === "service"
    ? surface.kind
    : null;
  for (const [key, valid] of [
    ["surface.surfaceId", Boolean(surfaceId)],
    ["surface.surfaceRole", Boolean(surfaceRole)],
    ["surface.surfaceLevel", Boolean(surfaceLevel)],
    ["surface.interaction", Boolean(interaction)],
    ["surface.kind", Boolean(kind)],
    ["surface.label", typeof surface.label === "string"],
    ["surface.url", typeof surface.url === "string"],
    ["surface.route", typeof surface.route === "string"],
    ["surface.open", typeof surface.open === "boolean"],
    ["surface.active", typeof surface.active === "boolean"]
  ] as const) {
    if (!valid) missingFields.push(key);
  }
  if (!surfaceId || !surfaceRole || !surfaceLevel || !interaction || !kind ||
    typeof surface.label !== "string" || typeof surface.url !== "string" || typeof surface.route !== "string" ||
    typeof surface.open !== "boolean" || typeof surface.active !== "boolean") {
    return null;
  }
  return {
    surfaceId,
    surfaceRole,
    surfaceLevel,
    ...(typeof surface.parentSurfaceId === "string" && surface.parentSurfaceId
      ? { parentSurfaceId: surface.parentSurfaceId }
      : {}),
    ...(typeof surface.ownerChatId === "string" && surface.ownerChatId
      ? { ownerChatId: surface.ownerChatId }
      : {}),
    interaction,
    kind,
    label: surface.label,
    url: surface.url,
    route: surface.route,
    open: surface.open,
    active: surface.active
  };
}
