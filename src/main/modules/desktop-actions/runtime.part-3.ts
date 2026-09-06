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

import { DesktopActionBridgeOptions, asRecord, fail, ok, readString } from "./runtime.part-1";

import { DESKTOP_WEB_POST_STATE_ACTIONS, DESKTOP_WORKPANEL_MUTATION_ACTIONS, isSensitiveConfirmationKey, projectDesktopWebActionSurface, sanitizeConfirmationUrlText } from "./runtime.part-2";

export function projectDesktopWebActionTab(
  value: unknown,
  field: string,
  missingFields: string[]
): DesktopWebActionTabSummary | null {
  const tab = asRecord(value);
  for (const [key, valid] of [
    ["tabId", typeof tab.tabId === "string" && Boolean(tab.tabId)],
    ["title", typeof tab.title === "string"],
    ["currentUrl", typeof tab.currentUrl === "string"],
    ["active", typeof tab.active === "boolean"],
    ["isLoading", typeof tab.isLoading === "boolean"],
    ["canGoBack", typeof tab.canGoBack === "boolean"],
    ["canGoForward", typeof tab.canGoForward === "boolean"]
  ] as const) {
    if (!valid) missingFields.push(`${field}.${key}`);
  }
  if (typeof tab.tabId !== "string" || !tab.tabId || typeof tab.title !== "string" ||
    typeof tab.currentUrl !== "string" || typeof tab.active !== "boolean" ||
    typeof tab.isLoading !== "boolean" || typeof tab.canGoBack !== "boolean" ||
    typeof tab.canGoForward !== "boolean") {
    return null;
  }
  return {
    tabId: tab.tabId,
    title: tab.title,
    currentUrl: tab.currentUrl,
    ...(typeof tab.faviconUrl === "string" && tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    active: tab.active,
    isLoading: tab.isLoading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward
  };
}

export function projectDesktopWebActionState(value: unknown) {
  const result = asRecord(value);
  const missingFields: string[] = [];
  const surface = projectDesktopWebActionSurface(result.surface, missingFields);
  if (!Array.isArray(result.tabs)) {
    missingFields.push("tabs");
  }
  const tabs = Array.isArray(result.tabs)
    ? result.tabs.map((tab, index) => projectDesktopWebActionTab(tab, `tabs[${index}]`, missingFields))
    : [];
  let activeTab: DesktopWebActionTabSummary | null = null;
  if (result.activeTab !== null) {
    activeTab = projectDesktopWebActionTab(result.activeTab, "activeTab", missingFields);
  }
  if (result.activeTab === undefined) {
    missingFields.push("activeTab");
  }
  if (tabs.some((tab) => tab === null)) {
    return { state: null, missingFields };
  }
  return {
    state: { surface, tabs: tabs as DesktopWebActionTabSummary[], activeTab } satisfies DesktopWebActionStateResult,
    missingFields
  };
}

export function readWorkPanelWorkspace(value: unknown): WorkPanelWorkspace | null {
  const workspace = asRecord(value);
  if (!(typeof workspace.workspaceId === "string" && Boolean(workspace.workspaceId) &&
    typeof workspace.ownerChatId === "string" && Boolean(workspace.ownerChatId) &&
    Array.isArray(workspace.items) &&
    (typeof workspace.activeItemId === "string" || workspace.activeItemId === null))) {
    return null;
  }
  return {
    workspaceId: workspace.workspaceId,
    ownerChatId: workspace.ownerChatId,
    items: workspace.items as WorkPanelWorkspace["items"],
    activeItemId: workspace.activeItemId
  };
}

export function projectRendererActionResult(action: string, value: unknown): {
  handled: boolean;
  result?: unknown;
  missingFields?: string[];
} {
  const source = asRecord(value);
  if (DESKTOP_WEB_POST_STATE_ACTIONS.has(action)) {
    const { state, missingFields } = projectDesktopWebActionState(source);
    const missingPostState = state && action !== "desktop.web.closeTab"
      ? [
          ...(!state.surface ? ["surface"] : []),
          ...(state.tabs.length === 0 ? ["tabs"] : []),
          ...(!state.activeTab ? ["activeTab"] : [])
        ]
      : [];
    if (!state || missingFields.length > 0 || missingPostState.length > 0) {
      return {
        handled: true,
        missingFields: missingFields.length > 0 ? missingFields : missingPostState
      };
    }
    if (action === "desktop.web.navigate") {
      const targetTabId = typeof source.targetTabId === "string" ? source.targetTabId : "";
      const navigatedUrl = typeof source.navigatedUrl === "string" ? source.navigatedUrl : "";
      const missing = [
        ...(!targetTabId ? ["targetTabId"] : []),
        ...(!navigatedUrl ? ["navigatedUrl"] : [])
      ];
      return missing.length > 0
        ? { handled: true, missingFields: missing }
        : { handled: true, result: { ...state, targetTabId, navigatedUrl } satisfies DesktopWebNavigateResult };
    }
    if (action === "desktop.web.reload" || action === "desktop.web.goBack") {
      const targetTabId = typeof source.targetTabId === "string" ? source.targetTabId : "";
      return targetTabId
        ? { handled: true, result: { ...state, targetTabId } satisfies DesktopWebTargetTabResult }
        : { handled: true, missingFields: ["targetTabId"] };
    }
    if (action === "desktop.web.openTab") {
      const openedTabId = typeof source.openedTabId === "string" ? source.openedTabId : "";
      return openedTabId
        ? { handled: true, result: { ...state, openedTabId } satisfies DesktopWebOpenTabResult }
        : { handled: true, missingFields: ["openedTabId"] };
    }
    if (action === "desktop.web.closeTab") {
      const closedTabId = typeof source.closedTabId === "string" ? source.closedTabId : "";
      if (!closedTabId || typeof source.closedSurface !== "boolean") {
        return {
          handled: true,
          missingFields: [...(!closedTabId ? ["closedTabId"] : []), ...(typeof source.closedSurface !== "boolean" ? ["closedSurface"] : [])]
        };
      }
      if (source.closedSurface && (state.surface !== null || state.tabs.length > 0 || state.activeTab !== null)) {
        return { handled: true, missingFields: ["surface=null", "tabs=[]", "activeTab=null"] };
      }
      if (!source.closedSurface && (!state.surface || state.tabs.length === 0 || !state.activeTab)) {
        return {
          handled: true,
          missingFields: [
            ...(!state.surface ? ["surface"] : []),
            ...(state.tabs.length === 0 ? ["tabs"] : []),
            ...(!state.activeTab ? ["activeTab"] : [])
          ]
        };
      }
      return {
        handled: true,
        result: { ...state, closedTabId, closedSurface: source.closedSurface } satisfies DesktopWebCloseTabResult
      };
    }
    return { handled: true, result: state };
  }

  if (DESKTOP_WORKPANEL_MUTATION_ACTIONS.has(action)) {
    const workspaceId = typeof source.workspaceId === "string" ? source.workspaceId : "";
    if (action === "desktop.workpanel.closeWorkpanel") {
      return workspaceId
        ? { handled: true, result: { workspaceId, closed: true } satisfies DesktopWorkPanelCloseResult }
        : { handled: true, missingFields: ["workspaceId"] };
    }
    const workspace = source.state === undefined ? null : readWorkPanelWorkspace(source.state);
    if (action === "desktop.workpanel.closeTab") {
      const closedItemId = readString(asRecord(source.item), "itemId");
      if (!closedItemId || (source.state !== undefined && !workspace)) {
        return {
          handled: true,
          missingFields: [...(!closedItemId ? ["item.itemId"] : []), ...(source.state !== undefined && !workspace ? ["state"] : [])]
        };
      }
      return {
        handled: true,
        result: { closedItemId, workspace } satisfies DesktopWorkPanelCloseTabResult
      };
    }
    if (!workspace) {
      return { handled: true, missingFields: ["state"] };
    }
    return { handled: true, result: { workspace } satisfies DesktopWorkPanelWorkspaceResult };
  }

  if (action === "desktop.copilot.setPagePreference") {
    const pageKey = typeof source.pageKey === "string" ? source.pageKey : "";
    const preference = asRecord(source.preference);
    if (!isDesktopCopilotPageKey(pageKey) || typeof preference.enabled !== "boolean" || typeof preference.agentKey !== "string") {
      return {
        handled: true,
        missingFields: [
          ...(!isDesktopCopilotPageKey(pageKey) ? ["pageKey"] : []),
          ...(typeof preference.enabled !== "boolean" ? ["preference.enabled"] : []),
          ...(typeof preference.agentKey !== "string" ? ["preference.agentKey"] : [])
        ]
      };
    }
    return {
      handled: true,
      result: {
        pageKey,
        preference: { enabled: preference.enabled, agentKey: preference.agentKey }
      } satisfies DesktopCopilotPreferenceResult
    };
  }

  return { handled: false };
}

export async function callRendererAction(
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
  const publicResponse = {
    ok: response.ok,
    action: request.action,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.preview === undefined ? {} : { preview: response.preview }),
    ...(response.requiresConfirmation === undefined ? {} : { requiresConfirmation: response.requiresConfirmation }),
    ...(response.error === undefined ? {} : { error: response.error })
  } satisfies DesktopActionCallResponse;
  if (!response.ok) {
    return publicResponse;
  }
  const projection = projectRendererActionResult(request.action, response.result);
  if (!projection.handled) {
    return publicResponse;
  }
  if (projection.missingFields && projection.missingFields.length > 0) {
    return fail(
      request.action,
      "invalid_action_result",
      `${request.action} succeeded without the required public result fields.`,
      { missingFields: projection.missingFields }
    );
  }
  return ok(request.action, projection.result);
}

export function webappRoute(webappId: string) {
  return `/webs/webapp:${webappId}`;
}

export function compactWebappItem(item: WebappEntry | null | undefined): DesktopWebappSummary | undefined {
  if (!item) {
    return undefined;
  }
  return {
    id: item.id,
    label: item.label,
    version: item.version,
    target: item.target,
    openMode: item.openMode
  };
}

export function redactWorkspaceRootText(value: string, workspaceRoot = "") {
  const root = workspaceRoot.trim();
  if (!root) return value;
  const candidates = new Set([
    root,
    path.normalize(root),
    root.replace(/\\/gu, "/"),
    root.replace(/\//gu, "\\"),
  ]);
  let redacted = value;
  for (const candidate of [...candidates].filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(candidate).join("[WORKSPACE]");
  }
  return redacted;
}

export function sanitizeWebappErrorText(value: string, workspaceRoot = "") {
  return redactWorkspaceRootText(sanitizeConfirmationUrlText(value)
    .replace(
      /((?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|jwt|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]"
    )
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/\b(?:dk|th|sk)_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]"), workspaceRoot);
}

export function sanitizeWebappDiagnosticValue(value: unknown, key = "", depth = 0, workspaceRoot = ""): unknown {
  if (isSensitiveConfirmationKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeWebappErrorText(value, workspaceRoot);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeWebappDiagnosticValue(item, key, depth + 1, workspaceRoot));
  }
  if (!value || typeof value !== "object" || depth >= 8) {
    return "[object]";
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = entryKey.replace(/[\s._-]+/gu, "").toLowerCase();
    if (normalizedKey === "items" || normalizedKey === "webapps") {
      continue;
    }
    output[entryKey] = sanitizeWebappDiagnosticValue(entryValue, entryKey, depth + 1, workspaceRoot);
  }
  return output;
}

export function projectWebappRuntimeState(state: WebappRuntimeState): WebappRuntimeState {
  return {
    id: state.id,
    entryKey: state.entryKey,
    kind: state.kind,
    status: state.status,
    version: state.version,
    target: state.target,
    launcher: state.launcher,
    ownership: state.ownership,
    runtimeVersion: state.runtimeVersion,
    externalId: state.externalId,
    prerequisiteIssues: state.prerequisiteIssues.map((issue) => ({
      code: issue.code,
      message: sanitizeWebappErrorText(issue.message),
      ...(issue.required === undefined ? {} : { required: issue.required }),
      ...(issue.detected === undefined ? {} : { detected: issue.detected })
    })),
    webUrl: sanitizeWebappErrorText(state.webUrl),
    backendUrl: sanitizeWebappErrorText(state.backendUrl),
    frontendPort: state.frontendPort,
    backendPort: state.backendPort,
    pid: state.pid,
    message: sanitizeWebappErrorText(state.message),
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    updatedAt: state.updatedAt
  };
}

export function webappRuntimeFailureDetails(
  webappId: string,
  operation: DesktopWebappRuntimeFailureDetails["operation"],
  command: WebappCommandResult
): DesktopWebappRuntimeFailureDetails {
  const item = compactWebappItem(command.item);
  return {
    webappId,
    operation,
    ...(item ? { item } : {}),
    ...(command.state ? { state: projectWebappRuntimeState(command.state) } : {})
  };
}

export function webappPreferenceFailureDetails(
  webappId: string,
  item: WebappEntry | null | undefined
): DesktopWebappPreferenceFailureDetails {
  const summary = compactWebappItem(item);
  return { webappId, ...(summary ? { item: summary } : {}) };
}

export function projectWebappPublishFailureDetails(
  webappId: string,
  operation: DesktopWebappPublishFailureDetails["operation"],
  result: WebappPublishResult
): DesktopWebappPublishFailureDetails {
  return {
    webappId,
    operation,
    info: {
      provider: result.info.provider,
      configured: result.info.configured,
      signedIn: result.info.signedIn,
      tunnelEnabled: result.info.tunnelEnabled,
      tunnelConnected: result.info.tunnelConnected,
      deviceId: result.info.deviceId,
      relayUrl: sanitizeWebappErrorText(result.info.relayUrl)
    },
    state: {
      id: result.state.id,
      provider: result.state.provider,
      status: result.state.status,
      name: result.state.name,
      routeId: result.state.routeId,
      publicHost: result.state.publicHost,
      url: sanitizeWebappErrorText(result.state.url),
      targetUrl: sanitizeWebappErrorText(result.state.targetUrl),
      active: result.state.active,
      message: sanitizeWebappErrorText(result.state.message),
      updatedAt: result.state.updatedAt
    }
  };
}

export function invalidWebappActionResult(
  action: string,
  webappId: string,
  operation: DesktopWebappInvalidResultDetails["operation"],
  missingFields: string[]
) {
  return fail(
    action,
    "invalid_action_result",
    `${action} succeeded without the required public result fields.`,
    { webappId, operation, missingFields } satisfies DesktopWebappInvalidResultDetails
  );
}

export function isWebappRuntimeStateFor(
  state: WebappRuntimeState | null,
  webappId: string
): state is WebappRuntimeState {
  return Boolean(state && state.id === webappId && typeof state.status === "string");
}

export function installFailureDetails(input: {
  archivePath: string;
  expectedId?: string;
  webappId?: string;
  executable?: string;
  selectedPath?: string;
  installPath?: string;
  item?: WebappEntry | null;
  diagnostic?: DesktopWebappInstallDiagnostic;
  workspaceRoot?: string;
}): DesktopWebappInstallFailureDetails {
  const diagnosticDetails = input.diagnostic?.details
    ? sanitizeWebappDiagnosticValue(input.diagnostic.details, "", 0, input.workspaceRoot) as Record<string, unknown>
    : undefined;
  const diagnostic = input.diagnostic
    ? {
        stage: input.diagnostic.stage,
        code: input.diagnostic.code,
        message: sanitizeWebappErrorText(input.diagnostic.message, input.workspaceRoot),
        ...(input.diagnostic.suggestion ? { suggestion: sanitizeWebappErrorText(input.diagnostic.suggestion, input.workspaceRoot) } : {}),
        ...(diagnosticDetails ? { details: diagnosticDetails } : {})
      }
    : undefined;
  const item = compactWebappItem(input.item);
  return {
    ...(input.webappId || input.expectedId ? { webappId: input.webappId || input.expectedId } : {}),
    operation: "install",
    ...(input.executable ? { executable: input.executable } : {}),
    ...(input.selectedPath ? { selectedPath: input.selectedPath } : {}),
    path: input.archivePath,
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(item ? { item } : {}),
    ...(diagnostic ? { diagnostic } : {})
  };
}

export function websiteRoute(websiteId: string) {
  return `/webs/website:${websiteId.trim()}`;
}

export function notifyWebsChanged(options: DesktopActionBridgeOptions) {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("webs.changed", { changedAt: new Date().toISOString() });
}

export async function executeWebappRuntimeMutation(
  options: DesktopActionBridgeOptions,
  action: string,
  webappId: string,
  operation: "start" | "stop" | "restart"
) {
  const command = await options.webs.webappRuntime[operation](options.app, webappId);
  if (!command.ok) {
    return fail(
      action,
      `webapp_${operation}_failed`,
      sanitizeWebappErrorText(command.message),
      webappRuntimeFailureDetails(webappId, operation, command)
    );
  }
  if (!isWebappRuntimeStateFor(command.state, webappId)) {
    return invalidWebappActionResult(action, webappId, operation, ["state"]);
  }
  return ok(action, {
    webappId,
    status: command.state.status
  } satisfies DesktopWebappRuntimeMutationResult);
}

export async function openWebapp(options: DesktopActionBridgeOptions, action: string, webappId: string) {
  const command = await options.webs.webappRuntime.start(options.app, webappId);
  if (!command.ok) {
    return fail(
      action,
      "webapp_open_failed",
      sanitizeWebappErrorText(command.message),
      webappRuntimeFailureDetails(webappId, "open", command)
    );
  }
  if (!isWebappRuntimeStateFor(command.state, webappId)) {
    return invalidWebappActionResult(action, webappId, "open", ["state"]);
  }
  const route = webappRoute(webappId);
  options.navigate(route);
  return ok(action, {
    webappId,
    status: command.state.status,
    route
  } satisfies DesktopWebappOpenResult);
}

export function trustedWebappWorkspaceSource(
  action: string,
  request: DesktopActionCallRequest,
): { ok: true; workspaceRoot: string } | { ok: false; response: DesktopActionCallResponse } {
  const source = request.source;
  const runId = typeof source?.runId === "string" ? source.runId.trim() : "";
  const chatId = typeof source?.chatId === "string" ? source.chatId.trim() : "";
  const workspaceRoot = typeof source?.workspaceRoot === "string" ? source.workspaceRoot.trim() : "";
  if (!runId || !chatId || !workspaceRoot || Boolean(source?.agentKey && source?.teamId)) {
    return {
      ok: false,
      response: fail(action, "forbidden", "This action requires a trusted Agent Platform Run workspace."),
    };
  }
  return { ok: true, workspaceRoot };
}

export function rejectUnexpectedArgs(
  action: string,
  args: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const allowed = new Set(allowedKeys);
  const rejected = Object.keys(args).filter((key) => !allowed.has(key));
  return rejected.length > 0
    ? fail(action, "invalid_args", `${action} does not accept: ${rejected.join(", ")}.`)
    : null;
}

export async function executeWebappToolingAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const trusted = trustedWebappWorkspaceSource(action, request);
  if (!trusted.ok) return trusted.response;

  let task: WebappToolingTask;
  if (action === "desktop.webapp.manifest.init") {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "key", "label", "target"]);
    if (invalid) return invalid;
    const projectPath = readString(args, "projectPath");
    const key = readString(args, "key");
    const label = readString(args, "label");
    if (!projectPath || !key || !label || (args.target !== undefined && typeof args.target !== "string")) {
      return fail(action, "invalid_args", "projectPath, key, and label are required; target must be a string when provided.");
    }
    task = {
      operation: "manifest.init",
      workspaceRoot: trusted.workspaceRoot,
      projectPath,
      key,
      label,
      ...(readString(args, "target") ? { target: readString(args, "target") } : {}),
    };
  } else if (action === "desktop.webapp.manifest.validate") {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath"]);
    if (invalid) return invalid;
    const projectPath = readString(args, "projectPath");
    if (!projectPath) return fail(action, "invalid_args", "projectPath is required.");
    task = { operation: "manifest.validate", workspaceRoot: trusted.workspaceRoot, projectPath };
  } else if (action === "desktop.webapp.package.validate") {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "archivePath"]);
    if (invalid) return invalid;
    const hasProjectPath = Object.hasOwn(args, "projectPath");
    const hasArchivePath = Object.hasOwn(args, "archivePath");
    if (hasProjectPath === hasArchivePath) {
      return fail(action, "invalid_args", "Provide exactly one of projectPath or archivePath.");
    }
    const projectPath = readString(args, "projectPath");
    const archivePath = readString(args, "archivePath");
    if ((hasProjectPath && !projectPath) || (hasArchivePath && !archivePath)) {
      return fail(action, "invalid_args", "The selected projectPath or archivePath must be a non-empty string.");
    }
    task = projectPath
      ? { operation: "package.validate", workspaceRoot: trusted.workspaceRoot, projectPath }
      : { operation: "package.validate", workspaceRoot: trusted.workspaceRoot, archivePath };
  } else {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "outputPath"]);
    if (invalid) return invalid;
    const projectPath = readString(args, "projectPath");
    const outputPath = readString(args, "outputPath");
    if (!projectPath || !outputPath) {
      return fail(action, "invalid_args", "projectPath and outputPath are required.");
    }
    task = { operation: "package.build", workspaceRoot: trusted.workspaceRoot, projectPath, outputPath };
  }

  try {
    const result = await executeWebappToolingInWorker(task, {
      ...(options.webappToolingWorkerPath ? { workerPath: options.webappToolingWorkerPath } : {}),
    });
    return ok(action, result as DesktopWebappToolingResult);
  } catch (error) {
    if (error instanceof WebappToolingError) {
      const details = sanitizeWebappDiagnosticValue(error.details) as Record<string, unknown>;
      return fail(action, error.code, sanitizeWebappErrorText(error.message), {
        stage: error.stage,
        ...details,
      });
    }
    return fail(action, "tooling_failed", "Desktop WebApp Tooling failed.", { stage: "internal" });
  }
}
