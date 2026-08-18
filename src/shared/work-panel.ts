import type {
  AgentWebclientBridgeErrorCode,
  WorkPanelBridgeResult,
  WorkPanelContext,
  WorkPanelItem,
  WorkPanelItemDescriptor,
  WorkPanelWebclientModule,
  WorkPanelWorkspace,
} from "./contracts/agent-webclient-bridge";
import { isRegisteredWorkPanelNativeSurface } from "./work-panel-native-registry";

export type WorkPanelState = {
  workspaces: WorkPanelWorkspace[];
  visibleOwnerChatIds: string[];
};

export type WorkPanelCommand =
  | { type: "openItem"; ownerChatId: string; descriptor: WorkPanelItemDescriptor }
  | { type: "activateItem"; ownerChatId: string; itemId: string }
  | { type: "closeItem"; ownerChatId: string; itemId: string }
  | { type: "closeOtherItems"; ownerChatId: string; itemId: string }
  | { type: "showWorkspace"; ownerChatId: string }
  | { type: "hideWorkspace"; ownerChatId: string }
  | { type: "closeWorkspace"; ownerChatId: string; force?: boolean };

export type WorkPanelCommandResult = WorkPanelBridgeResult & {
  nextState: WorkPanelState;
};

export const EMPTY_WORK_PANEL_STATE: WorkPanelState = {
  workspaces: [],
  visibleOwnerChatIds: [],
};

function withVisibleWorkspace(state: WorkPanelState, ownerChatId: string) {
  return state.visibleOwnerChatIds.includes(ownerChatId)
    ? state.visibleOwnerChatIds
    : [...state.visibleOwnerChatIds, ownerChatId];
}

function withoutVisibleWorkspace(state: WorkPanelState, ownerChatId: string) {
  return state.visibleOwnerChatIds.filter((chatId) => chatId !== ownerChatId);
}

function fail(
  state: WorkPanelState,
  code: AgentWebclientBridgeErrorCode,
  message: string,
): WorkPanelCommandResult {
  return { ok: false, error: { code, message }, nextState: state };
}

export function stableWorkPanelHash(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function cleanIdentity(value: unknown, max = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max ? text : "";
}

function normalizeRelativePath(value: unknown) {
  const raw = cleanIdentity(value, 2_048).replace(/\\/gu, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:\//iu.test(raw) || raw.startsWith("//")) {
    return "";
  }
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    return "";
  }
  return parts.join("/");
}

function normalizeFileRequestPath(value: unknown) {
  const requestedPath = typeof value === "string" ? value : "";
  if (
    !requestedPath.trim() ||
    requestedPath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(requestedPath)
  ) return "";
  return requestedPath.replace(/\\/gu, "/");
}

function normalizeContext(
  input: unknown,
  module: WorkPanelWebclientModule,
): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const allowed = new Set(module === "planning" ? [
    "chatId", "planningId", "agentKey",
  ] : [
    "chatId", "runId", "agentKey", "artifactId", "referenceId", "planningId",
    "publishId", "sourceId", "btwId", "path",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key) || /token|event|absolute|preload/iu.test(key))) {
    return null;
  }
  const context: Record<string, string> = {};
  for (const key of [
    "chatId", "runId", "agentKey", "artifactId", "referenceId", "planningId",
    "publishId", "sourceId", "btwId",
  ] as const) {
    const value = cleanIdentity(record[key]);
    if (record[key] !== undefined && !value) return null;
    if (value) context[key] = value;
  }
  if (record.path !== undefined) {
    const path = module === "file"
      ? normalizeFileRequestPath(record.path)
      : normalizeRelativePath(record.path);
    if (!path) return null;
    context.path = path;
  }
  if (module === "planning") {
    return {
      ...(context.chatId ? { chatId: context.chatId } : {}),
      ...(context.planningId ? { planningId: context.planningId } : {}),
    };
  }
  return context;
}

export function normalizeWorkPanelWebUrl(value: unknown) {
  const raw = cleanIdentity(value, 8_192);
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeDescriptor(
  descriptor: WorkPanelItemDescriptor,
): { descriptor: WorkPanelItemDescriptor; stableKey: string; title: string } | null {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const keys = Object.keys(descriptor);
  const title = cleanIdentity(descriptor.title, 160);
  if (descriptor.kind === "native") return null;
  if (descriptor.kind === "web") {
    if (keys.some((key) => !["kind", "url", "title", "pinned", "closable"].includes(key))) return null;
    const url = normalizeWorkPanelWebUrl(descriptor.url);
    if (!url) return null;
    const sanitized: WorkPanelItemDescriptor = {
      kind: "web",
      url,
      ...(title ? { title } : {}),
      ...(descriptor.pinned === true ? { pinned: true } : {}),
      ...(descriptor.closable === false ? { closable: false } : {}),
    };
    return {
      descriptor: sanitized,
      stableKey: `web:${url}`,
      title: title || new URL(url).hostname,
    };
  }
  if (descriptor.kind !== "webclient") return null;
  if (keys.some((key) => !["kind", "module", "route", "context", "title", "pinned", "closable"].includes(key))) return null;
  const context = normalizeContext(descriptor.context, descriptor.module);
  const route = cleanIdentity(descriptor.route, 2_048);
  if (!context || !route || !route.startsWith("/") || route.startsWith("//") || route.includes("://")) return null;
  let stableKey = "";
  switch (descriptor.module) {
    case "overview":
      stableKey = context.agentKey && context.chatId ? `overview:${context.agentKey}:${context.chatId}` : "";
      break;
    case "debug":
      stableKey = context.agentKey && context.chatId ? `debug:${context.agentKey}:${context.chatId}` : "";
      break;
    case "btw":
      stableKey = context.agentKey && context.chatId
        ? `btw:${context.agentKey}:${context.chatId}:${context.btwId || "current"}`
        : "";
      break;
    case "source":
      stableKey = context.agentKey && context.chatId && context.publishId && context.sourceId
        ? `source:${context.agentKey}:${context.chatId}:${context.btwId || "main"}:${context.publishId}:${context.sourceId}`
        : "";
      break;
    case "project":
      stableKey = context.agentKey && (!context.runId || context.chatId)
        ? `project:${context.agentKey}:${context.chatId || "workspace"}:${context.runId || "all"}:${context.path || "root"}`
        : "";
      break;
    case "file-diff":
      stableKey = context.agentKey && context.chatId && context.runId && context.path
        ? `file-diff:${context.agentKey}:${context.chatId}:${context.runId}:${context.path}`
        : "";
      break;
    case "artifact":
      stableKey = context.agentKey && context.chatId && context.artifactId
        ? `artifact:${context.agentKey}:${context.chatId}:${context.artifactId}`
        : "";
      break;
    case "reference":
      stableKey = context.agentKey && context.chatId && context.referenceId
        ? `reference:${context.agentKey}:${context.chatId}:${context.referenceId}`
        : "";
      break;
    case "file":
      stableKey = context.agentKey && context.path
        ? `file:${context.agentKey}:${context.path}`
        : "";
      break;
    case "planning":
      stableKey = context.chatId && context.planningId
        ? `planning:${context.chatId}:${context.planningId}`
        : "";
      break;
    case "agent":
    case "copilot":
      stableKey = context.agentKey
        ? `${descriptor.module}:${context.agentKey}:${context.chatId || "global"}`
        : "";
      break;
  }
  if (!stableKey) return null;
  const isOverview = descriptor.module === "overview";
  const sanitized = {
    kind: "webclient",
    module: descriptor.module,
    route,
    context,
    ...(title ? { title } : {}),
    ...(isOverview || descriptor.pinned === true ? { pinned: true } : {}),
    ...(isOverview || descriptor.closable === false ? { closable: false } : {}),
  } as WorkPanelItemDescriptor;
  return {
    descriptor: sanitized,
    stableKey,
    title: title || descriptor.module,
  };
}

function workspaceId(ownerChatId: string) {
  return `workpanel:${stableWorkPanelHash(ownerChatId)}`;
}

function isOverviewItem(item: WorkPanelItem) {
  return item.descriptor.kind === "webclient" && item.descriptor.module === "overview";
}

export function reduceWorkPanelCommand(
  state: WorkPanelState,
  command: WorkPanelCommand,
): WorkPanelCommandResult {
  const ownerChatId = cleanIdentity(command.ownerChatId);
  if (!ownerChatId) return fail(state, "invalid_request", "trusted owner chat is required");
  const index = state.workspaces.findIndex((workspace) => workspace.ownerChatId === ownerChatId);
  const current = index >= 0 ? state.workspaces[index] : null;
  if (command.type === "hideWorkspace") {
    if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
    if (!state.visibleOwnerChatIds.includes(ownerChatId)) {
      return { ok: true, workspaceId: current.workspaceId, state: current, nextState: state };
    }
    return {
      ok: true,
      workspaceId: current.workspaceId,
      state: current,
      nextState: { ...state, visibleOwnerChatIds: withoutVisibleWorkspace(state, ownerChatId) },
    };
  }
  if (command.type === "showWorkspace") {
    if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
    if (state.visibleOwnerChatIds.includes(ownerChatId)) {
      return { ok: true, workspaceId: current.workspaceId, state: current, nextState: state };
    }
    return {
      ok: true,
      workspaceId: current.workspaceId,
      state: current,
      nextState: { ...state, visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId) },
    };
  }
  if (command.type === "closeWorkspace") {
    if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
    if (!command.force && current.items.some((item) => !isOverviewItem(item) && (item.pinned || !item.closable))) {
      return fail(state, "capability_denied", "workspace contains pinned or non-closable items");
    }
    const nextState = {
      workspaces: state.workspaces.filter((_, itemIndex) => itemIndex !== index),
      visibleOwnerChatIds: withoutVisibleWorkspace(state, ownerChatId),
    };
    return { ok: true, workspaceId: current.workspaceId, nextState };
  }
  if (command.type === "openItem") {
    if (command.descriptor.kind === "native") {
      if (!isRegisteredWorkPanelNativeSurface(command.descriptor.surfaceKey)) {
        return fail(state, "unsupported_native_surface", "no native WorkPanel surface is registered");
      }
      return fail(state, "unsupported_native_surface", "registered native WorkPanel host is not implemented");
    }
    let trustedDescriptor = command.descriptor;
    if (trustedDescriptor.kind === "webclient") {
      const descriptorChatId = cleanIdentity(
        (trustedDescriptor.context as { chatId?: unknown })?.chatId,
      );
      if (descriptorChatId && descriptorChatId !== ownerChatId) {
        return fail(state, "capability_denied", "WorkPanel item chat does not match its trusted workspace");
      }
      if ((trustedDescriptor.module === "overview" || trustedDescriptor.module === "debug") && !descriptorChatId) {
        trustedDescriptor = {
          ...trustedDescriptor,
          context: { ...trustedDescriptor.context, chatId: ownerChatId },
        };
      }
    }
    const normalized = normalizeDescriptor(trustedDescriptor);
    if (!normalized) return fail(state, "invalid_request", "invalid WorkPanel item descriptor");
    const workspace: WorkPanelWorkspace = current ?? {
      workspaceId: workspaceId(ownerChatId),
      ownerChatId,
      items: [],
      activeItemId: null,
    };
    const existing = workspace.items.find((item) => item.stableKey === normalized.stableKey);
    const isOverview = normalized.descriptor.kind === "webclient" &&
      normalized.descriptor.module === "overview";
    const item: WorkPanelItem = existing
      ? isOverview
        ? {
            ...existing,
            descriptor: normalized.descriptor,
            title: normalized.title,
            closable: false,
            pinned: true,
          }
        : existing
      : {
          itemId: `item:${stableWorkPanelHash(normalized.stableKey)}`,
          stableKey: normalized.stableKey,
          descriptor: normalized.descriptor,
          title: normalized.title,
          closable: normalized.descriptor.closable !== false,
          pinned: normalized.descriptor.pinned === true,
          createdAt: Date.now(),
        };
    const items = existing
      ? workspace.items.map((currentItem) => currentItem.itemId === item.itemId ? item : currentItem)
      : [...workspace.items, item];
    const nextWorkspace = {
      ...workspace,
      items: isOverview ? [item, ...items.filter((currentItem) => currentItem.itemId !== item.itemId)] : items,
      activeItemId: item.itemId,
    };
    const workspaces = [...state.workspaces];
    if (index >= 0) workspaces[index] = nextWorkspace;
    else workspaces.push(nextWorkspace);
    const nextState = {
      workspaces,
      visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId),
    };
    return { ok: true, workspaceId: nextWorkspace.workspaceId, item, state: nextWorkspace, nextState };
  }
  if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
  const itemIndex = current.items.findIndex((item) => item.itemId === cleanIdentity(command.itemId));
  if (itemIndex < 0) return fail(state, "target_unavailable", "WorkPanel item is unavailable");
  const item = current.items[itemIndex];
  if (command.type === "activateItem") {
    const nextWorkspace = { ...current, activeItemId: item.itemId };
    const workspaces = state.workspaces.map((workspace, nextIndex) => nextIndex === index ? nextWorkspace : workspace);
    return {
      ok: true,
      workspaceId: current.workspaceId,
      item,
      state: nextWorkspace,
      nextState: {
        workspaces,
        visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId),
      },
    };
  }
  if (command.type === "closeOtherItems") {
    const items = current.items.filter((candidate) =>
      candidate.itemId === item.itemId || candidate.pinned || !candidate.closable,
    );
    const nextWorkspace = { ...current, items, activeItemId: item.itemId };
    const workspaces = state.workspaces.map((workspace, nextIndex) =>
      nextIndex === index ? nextWorkspace : workspace,
    );
    return {
      ok: true,
      workspaceId: current.workspaceId,
      item,
      state: nextWorkspace,
      nextState: {
        workspaces,
        visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId),
      },
    };
  }
  if (item.pinned || !item.closable) {
    return fail(state, "capability_denied", "pinned or non-closable WorkPanel item cannot be closed");
  }
  const items = current.items.filter((_, nextIndex) => nextIndex !== itemIndex);
  if (items.length === 0) {
    const nextState = {
      workspaces: state.workspaces.filter((_, nextIndex) => nextIndex !== index),
      visibleOwnerChatIds: withoutVisibleWorkspace(state, ownerChatId),
    };
    return { ok: true, workspaceId: current.workspaceId, item, nextState };
  }
  const activeItemId = current.activeItemId === item.itemId
    ? items[Math.min(itemIndex, items.length - 1)].itemId
    : current.activeItemId;
  const nextWorkspace = { ...current, items, activeItemId };
  const workspaces = state.workspaces.map((workspace, nextIndex) => nextIndex === index ? nextWorkspace : workspace);
  return {
    ok: true,
    workspaceId: current.workspaceId,
    item,
    state: nextWorkspace,
    nextState: {
      workspaces,
      visibleOwnerChatIds: state.visibleOwnerChatIds,
    },
  };
}
