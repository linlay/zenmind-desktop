import {
  type DesktopWebActionSurfaceSummary,
  type DesktopWebActionTabSummary,
  type DesktopWebActionStateResult,
  type DesktopWebNavigateResult,
  type DesktopWebTargetTabResult,
  type DesktopWebOpenTabResult,
  type DesktopWebCloseTabResult,
  type DesktopWorkPanelCloseResult,
  type DesktopWorkPanelCloseTabResult,
  type DesktopWorkPanelWorkspaceResult,
  type DesktopCopilotPreferenceResult,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse
} from "../../../shared/desktop-actions";
import { asRecord, readString, fail, ok } from "./action-values";
import { isSurfaceRole } from "../../../shared/surface-identity";
import { type WorkPanelWorkspace, type WorkPanelItem, type WorkPanelBridgeResult } from "../../../shared/contracts";
import { isDesktopCopilotPageKey } from "../../../shared/assistant-settings";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { randomUUID } from "node:crypto";

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
    if (action === "desktop.workpanel.openWeb") {
      if (typeof source.surfaceId !== "string" || typeof source.containerId !== "string") {
        return { handled: true, missingFields: ["surfaceId", "containerId"] };
      }
      return { handled: true, result: { workspace, surfaceId: source.surfaceId, containerId: source.containerId, status: source.status } };
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
  args: Record<string, unknown>,
  resultContract: "desktop-action" | "workpanel-bridge" = "desktop-action"
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
    return { ...publicResponse, ...fail(request.action, response.error?.code || "renderer_action_failed", response.error?.message || "Renderer action failed.", response.error?.details) };
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
  if (resultContract === "workpanel-bridge") {
    const source = asRecord(response.result);
    const state = source.state === undefined ? undefined : readWorkPanelWorkspace(source.state);
    const workspaceId = readString(source, "workspaceId");
    if (source.ok !== true || !workspaceId || state === null ||
        (state && (state.workspaceId !== workspaceId || state.ownerChatId !== request.source?.chatId))) {
      return fail(request.action, "invalid_action_result", "WorkPanel renderer returned an invalid bridge result.");
    }
    // The WebClient bridge expects its own success envelope, not the public
    // Desktop Action projection ({ workspace }), which has no `ok` field.
    return ok(request.action, {
      ok: true,
      workspaceId,
      ...(source.item === undefined ? {} : { item: source.item as WorkPanelItem }),
      ...(state ? { state } : {}),
    } satisfies WorkPanelBridgeResult);
  }
  return ok(request.action, projection.result);
}
