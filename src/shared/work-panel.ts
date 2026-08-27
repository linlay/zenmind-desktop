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
import {
  getWebviewBlobPopupHostname,
  normalizeWebviewBlobPopupUrl,
} from "./webview-popup";
import {
  EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE,
  WORK_PANEL_REVIEW_MAX_ANNOTATIONS,
  WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS,
  WORK_PANEL_REVIEW_VERSION,
  getWorkPanelReviewSession,
  hasWorkPanelReviewDraft,
  normalizeWorkPanelNormalizedRect,
  normalizeWorkPanelPixelRect,
  renumberWorkPanelReviewAnnotations,
  sanitizeWorkPanelReviewWebUrl,
  workPanelReviewSessionKey,
  type HtmlElementAnnotation,
  type ImageRegionAnnotation,
  type ReviewSourceRevision,
  type WorkPanelReviewKind,
  type WorkPanelReviewRuntimeState,
  type WorkPanelReviewSession,
} from "./work-panel-review";

export type WorkPanelState = {
  workspaces: WorkPanelWorkspace[];
  visibleOwnerChatIds: string[];
  webSessionKeysByItemId: Record<string, string>;
  review: WorkPanelReviewRuntimeState;
};

export type WorkPanelCommand =
  | { type: "openItem"; ownerChatId: string; descriptor: WorkPanelItemDescriptor }
  | { type: "openBlobPopup"; ownerChatId: string; sourceItemId: string; url: string }
  | { type: "activateItem"; ownerChatId: string; itemId: string }
  | { type: "closeItem"; ownerChatId: string; itemId: string; force?: boolean }
  | { type: "closeOtherItems"; ownerChatId: string; itemId: string; force?: boolean }
  | { type: "showWorkspace"; ownerChatId: string }
  | { type: "hideWorkspace"; ownerChatId: string }
  | { type: "closeWorkspace"; ownerChatId: string; force?: boolean }
  | {
      type: "startReview";
      ownerChatId: string;
      itemId: string;
      kind: WorkPanelReviewKind;
      source: ReviewSourceRevision;
    }
  | { type: "stopReview"; ownerChatId: string; itemId: string }
  | { type: "discardReview"; ownerChatId: string; itemId: string }
  | {
      type: "addImageReviewAnnotation";
      ownerChatId: string;
      itemId: string;
      annotation: Omit<ImageRegionAnnotation, "number" | "kind" | "requirement">;
    }
  | {
      type: "addHtmlReviewAnnotation";
      ownerChatId: string;
      itemId: string;
      annotation: Omit<HtmlElementAnnotation, "number" | "kind" | "requirement">;
    }
  | {
      type: "updateReviewAnnotation";
      ownerChatId: string;
      itemId: string;
      annotationId: string;
      requirement: string;
    }
  | {
      type: "removeReviewAnnotation";
      ownerChatId: string;
      itemId: string;
      annotationId: string;
    }
  | {
      type: "markReviewInvalid";
      ownerChatId: string;
      itemId: string;
      reason: string;
      annotationId?: string;
    };

export type WorkPanelCommandResult = WorkPanelBridgeResult & {
  nextState: WorkPanelState;
};

export const EMPTY_WORK_PANEL_STATE: WorkPanelState = {
  workspaces: [],
  visibleOwnerChatIds: [],
  webSessionKeysByItemId: {},
  review: EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE,
};

function workPanelWebSessionMapKey(workspaceId: string, itemId: string) {
  return `${workspaceId}\u0000${itemId}`;
}

export function resolveWorkPanelWebSessionKey(
  state: WorkPanelState,
  workspaceId: string,
  itemId: string,
) {
  return state.webSessionKeysByItemId[workPanelWebSessionMapKey(workspaceId, itemId)] || itemId;
}

function removeWorkPanelWebSessionKeys(
  state: WorkPanelState,
  workspaceId: string,
  itemIds: string[],
) {
  if (itemIds.length === 0) return state.webSessionKeysByItemId;
  const removed = new Set(itemIds.map((itemId) => workPanelWebSessionMapKey(workspaceId, itemId)));
  return Object.fromEntries(
    Object.entries(state.webSessionKeysByItemId).filter(([itemId]) => !removed.has(itemId)),
  );
}

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
  const allowed = new Set(
    module === "planning"
      ? ["chatId", "planningId", "agentKey"]
      : module === "skill"
        ? ["key"]
        : [
            "chatId", "runId", "agentKey", "artifactId", "referenceId", "planningId",
            "publishId", "sourceId", "btwId", "instanceId", "path",
          ],
  );
  if (Object.keys(record).some((key) => !allowed.has(key) || /token|event|absolute|preload/iu.test(key))) {
    return null;
  }
  const context: Record<string, string> = {};
  for (const key of [
    "chatId", "runId", "agentKey", "artifactId", "referenceId", "planningId",
    "publishId", "sourceId", "btwId", "instanceId", "key",
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
  const input = cleanIdentity(value, 8_192);
  const raw = input && !/^[a-z][a-z\d+.-]*:/iu.test(input) ? `https://${input}` : input;
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
  if (descriptor.kind === "native") {
    if (
      !isRegisteredWorkPanelNativeSurface(descriptor.surfaceKey) ||
      descriptor.surfaceKey !== "resource-image" ||
      keys.some((key) => !["kind", "surfaceKey", "context", "title", "pinned", "closable"].includes(key)) ||
      !descriptor.context || typeof descriptor.context !== "object" || Array.isArray(descriptor.context)
    ) return null;
    const context = descriptor.context;
    const allowedContextKeys = new Set([
      "handleId", "profile", "agentKey", "chatId", "resourceId", "relativePath", "fileName",
      "mimeType", "sizeBytes", "revision", "localOriginal",
    ]);
    if (Object.keys(context).some((key) => !allowedContextKeys.has(key))) return null;
    const handleId = cleanIdentity(context.handleId, 256);
    const profile = context.profile === "artifact" || context.profile === "reference" ? context.profile : "";
    const agentKey = cleanIdentity(context.agentKey);
    const chatId = cleanIdentity(context.chatId);
    const resourceId = cleanIdentity(context.resourceId, 1_024);
    const relativePath = normalizeRelativePath(context.relativePath);
    const fileName = cleanIdentity(context.fileName, 512);
    const mimeType = ["image/png", "image/jpeg", "image/webp"].includes(String(context.mimeType))
      ? String(context.mimeType)
      : "";
    const sizeBytes = typeof context.sizeBytes === "number" && Number.isSafeInteger(context.sizeBytes) && context.sizeBytes >= 0
      ? context.sizeBytes
      : -1;
    const revision = cleanIdentity(context.revision, 512);
    const localOriginal = context.localOriginal === true || context.localOriginal === false
      ? context.localOriginal
      : null;
    if (
      !handleId || !profile || !agentKey || !chatId || !resourceId || !relativePath || !fileName ||
      !mimeType || sizeBytes < 0 || !revision || localOriginal === null
    ) return null;
    const sanitized: WorkPanelItemDescriptor = {
      kind: "native",
      surfaceKey: "resource-image",
      context: {
        handleId,
        profile,
        agentKey,
        chatId,
        resourceId,
        relativePath,
        fileName,
        mimeType,
        sizeBytes,
        revision,
        localOriginal,
      },
      ...(title ? { title } : {}),
      ...(descriptor.pinned === true ? { pinned: true } : {}),
      ...(descriptor.closable === false ? { closable: false } : {}),
    };
    return {
      descriptor: sanitized,
      stableKey: `resource-image:${profile}:${agentKey}:${chatId}:${resourceId}`,
      title: title || fileName,
    };
  }
  if (descriptor.kind === "webapp-ref") {
    if (keys.some((key) => !["kind", "webappId", "title", "pinned", "closable"].includes(key))) return null;
    const webappId = cleanIdentity(descriptor.webappId, 256);
    if (!webappId || !title) return null;
    const sanitized: WorkPanelItemDescriptor = {
      kind: "webapp-ref",
      webappId,
      title,
      ...(descriptor.pinned === true ? { pinned: true } : {}),
      ...(descriptor.closable === false ? { closable: false } : {}),
    };
    return { descriptor: sanitized, stableKey: `webapp:${webappId}`, title };
  }
  if (descriptor.kind === "local-file") {
    if (keys.some((key) => ![
      "kind", "handleId", "fileName", "previewKind", "reviewKind", "workspaceRelativePath",
      "reviewRevision", "title", "pinned", "closable",
    ].includes(key))) return null;
    const handleId = cleanIdentity(descriptor.handleId, 256);
    const fileName = cleanIdentity(descriptor.fileName, 512);
    const previewKind = descriptor.previewKind;
    const reviewKind = descriptor.reviewKind;
    const workspaceRelativePath = descriptor.workspaceRelativePath === undefined
      ? ""
      : normalizeRelativePath(descriptor.workspaceRelativePath);
    const reviewRevision = descriptor.reviewRevision === undefined
      ? ""
      : cleanIdentity(descriptor.reviewRevision, 512);
    if (
      !handleId ||
      !fileName ||
      !["html", "pdf", "image", "text", "audio", "video", "unsupported"].includes(previewKind) ||
      (reviewKind !== undefined && reviewKind !== "html" && reviewKind !== "image") ||
      (reviewKind !== undefined && reviewKind !== previewKind) ||
      (descriptor.workspaceRelativePath !== undefined && !workspaceRelativePath) ||
      (descriptor.reviewRevision !== undefined && !reviewRevision) ||
      Boolean(reviewKind) !== Boolean(workspaceRelativePath && reviewRevision)
    ) return null;
    const sanitized: WorkPanelItemDescriptor = {
      kind: "local-file",
      handleId,
      fileName,
      previewKind,
      ...(reviewKind ? { reviewKind } : {}),
      ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
      ...(reviewRevision ? { reviewRevision } : {}),
      ...(title ? { title } : {}),
      ...(descriptor.pinned === true ? { pinned: true } : {}),
      ...(descriptor.closable === false ? { closable: false } : {}),
    };
    return { descriptor: sanitized, stableKey: `local-file:${handleId}`, title: title || fileName };
  }
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
        ? `btw:${context.agentKey}:${context.chatId}:${context.btwId || context.instanceId || "current"}`
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
    case "skill":
      stableKey = context.key ? `skill:${context.key}` : "";
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

function currentReviewState(state: WorkPanelState) {
  return state.review ?? EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE;
}

function withoutReviewSessions(
  review: WorkPanelReviewRuntimeState,
  ownerChatId: string,
  itemIds?: string[],
): WorkPanelReviewRuntimeState {
  const removedIds = itemIds ? new Set(itemIds) : null;
  const sessionsByKey = Object.fromEntries(
    Object.entries(review.sessionsByKey).filter(([, session]) =>
      session.ownerChatId !== ownerChatId || (removedIds !== null && !removedIds.has(session.itemId)),
    ),
  );
  const activeItemId = review.activeItemIdsByOwnerChatId[ownerChatId];
  const removeActive = Boolean(
    activeItemId && (removedIds === null || removedIds.has(activeItemId)),
  );
  if (sessionsByKey === review.sessionsByKey && !removeActive) return review;
  const activeItemIdsByOwnerChatId = { ...review.activeItemIdsByOwnerChatId };
  if (removeActive) delete activeItemIdsByOwnerChatId[ownerChatId];
  return { sessionsByKey, activeItemIdsByOwnerChatId };
}

function hasReviewDraftForItems(
  review: WorkPanelReviewRuntimeState,
  ownerChatId: string,
  itemIds: string[],
) {
  return itemIds.some((itemId) =>
    hasWorkPanelReviewDraft(getWorkPanelReviewSession(review, ownerChatId, itemId)),
  );
}

function normalizeReviewSource(source: ReviewSourceRevision) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceKind = source.sourceKind;
  const fileName = cleanIdentity(source.fileName, 512);
  const requestedRevision = cleanIdentity(source.revision, 512);
  const relativePath = source.relativePath === undefined
    ? ""
    : normalizeRelativePath(source.relativePath);
  const resourceId = source.resourceId === undefined
    ? ""
    : cleanIdentity(source.resourceId, 512);
  const normalizedUrl = source.url === undefined
    ? ""
    : normalizeWorkPanelWebUrl(source.url);
  const url = sourceKind === "web" && normalizedUrl
    ? sanitizeWorkPanelReviewWebUrl(normalizedUrl)
    : normalizedUrl;
  const revision = sourceKind === "web" ? url : requestedRevision;
  if (
    !["workspace-file", "artifact", "reference", "web"].includes(sourceKind) ||
    !fileName ||
    !revision ||
    (source.relativePath !== undefined && !relativePath) ||
    (source.resourceId !== undefined && !resourceId) ||
    (source.url !== undefined && !url)
  ) return null;
  if (sourceKind === "workspace-file" && !relativePath) return null;
  if ((sourceKind === "artifact" || sourceKind === "reference") && !resourceId) return null;
  if (sourceKind === "web" && !url) return null;
  return {
    sourceKind,
    fileName,
    revision,
    ...(relativePath ? { relativePath } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(url ? { url } : {}),
  } satisfies ReviewSourceRevision;
}

function itemAcceptsReview(
  item: WorkPanelItem,
  kind: WorkPanelReviewKind,
  source: ReviewSourceRevision,
) {
  if (item.descriptor.kind === "local-file") {
    return source.sourceKind === "workspace-file" && item.descriptor.reviewKind === kind;
  }
  if (item.descriptor.kind === "web") {
    return kind === "html" && source.sourceKind === "web" && Boolean(source.url);
  }
  return item.descriptor.kind === "webclient" &&
    (item.descriptor.module === "artifact" || item.descriptor.module === "reference") &&
    source.sourceKind === item.descriptor.module;
}

function replaceReviewSession(
  state: WorkPanelState,
  session: WorkPanelReviewSession,
  activate: boolean,
): WorkPanelState {
  const review = currentReviewState(state);
  const key = workPanelReviewSessionKey(session.ownerChatId, session.itemId);
  return {
    ...state,
    review: {
      sessionsByKey: { ...review.sessionsByKey, [key]: session },
      activeItemIdsByOwnerChatId: activate
        ? { ...review.activeItemIdsByOwnerChatId, [session.ownerChatId]: session.itemId }
        : review.activeItemIdsByOwnerChatId,
    },
  };
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
    if (
      !command.force &&
      hasReviewDraftForItems(
        currentReviewState(state),
        ownerChatId,
        current.items.map((item) => item.itemId),
      )
    ) {
      return fail(state, "capability_denied", "workspace contains unsent review annotations");
    }
    const nextState = {
      workspaces: state.workspaces.filter((_, itemIndex) => itemIndex !== index),
      visibleOwnerChatIds: withoutVisibleWorkspace(state, ownerChatId),
      webSessionKeysByItemId: removeWorkPanelWebSessionKeys(
        state,
        current.workspaceId,
        current.items.map((item) => item.itemId),
      ),
      review: withoutReviewSessions(currentReviewState(state), ownerChatId),
    };
    return { ok: true, workspaceId: current.workspaceId, nextState };
  }
  if (command.type === "openBlobPopup") {
    if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
    const sourceItemId = cleanIdentity(command.sourceItemId);
    const sourceItem = current.items.find((item) => item.itemId === sourceItemId);
    if (!sourceItem || sourceItem.descriptor.kind !== "web") {
      return fail(state, "target_unavailable", "WorkPanel popup source is unavailable");
    }
    const url = normalizeWebviewBlobPopupUrl(command.url);
    if (!url) return fail(state, "invalid_request", "invalid WorkPanel Blob popup URL");
    const sessionKey = resolveWorkPanelWebSessionKey(state, current.workspaceId, sourceItem.itemId);
    const stableKey = `blob:${sessionKey}:${url}`;
    const existing = current.items.find((item) => item.stableKey === stableKey);
    const item: WorkPanelItem = existing ?? {
      itemId: `item:${stableWorkPanelHash(stableKey)}`,
      stableKey,
      descriptor: { kind: "web", url },
      title: getWebviewBlobPopupHostname(url) || sourceItem.title,
      closable: true,
      pinned: false,
      createdAt: Date.now(),
    };
    const nextWorkspace = {
      ...current,
      items: existing ? current.items : [...current.items, item],
      activeItemId: item.itemId,
    };
    const workspaces = state.workspaces.map((workspace, nextIndex) =>
      nextIndex === index ? nextWorkspace : workspace,
    );
    const nextState = {
      workspaces,
      visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId),
      webSessionKeysByItemId: {
        ...state.webSessionKeysByItemId,
        [workPanelWebSessionMapKey(current.workspaceId, item.itemId)]: sessionKey,
      },
      review: currentReviewState(state),
    };
    return { ok: true, workspaceId: nextWorkspace.workspaceId, item, state: nextWorkspace, nextState };
  }
  if (command.type === "openItem") {
    if (command.descriptor.kind === "native") {
      if (!isRegisteredWorkPanelNativeSurface(command.descriptor.surfaceKey)) {
        return fail(state, "unsupported_native_surface", "no native WorkPanel surface is registered");
      }
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
      ? isOverview || normalized.descriptor.kind === "local-file" || normalized.descriptor.kind === "native"
        ? {
            ...existing,
            descriptor: normalized.descriptor,
            title: normalized.title,
            closable: isOverview ? false : normalized.descriptor.closable !== false,
            pinned: isOverview ? true : normalized.descriptor.pinned === true,
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
    let review = currentReviewState(state);
    if (
      existing?.descriptor.kind === "local-file" &&
      item.descriptor.kind === "local-file" &&
      existing.descriptor.reviewRevision &&
      item.descriptor.reviewRevision &&
      existing.descriptor.reviewRevision !== item.descriptor.reviewRevision
    ) {
      const key = workPanelReviewSessionKey(ownerChatId, item.itemId);
      const session = review.sessionsByKey[key];
      if (session) {
        review = {
          ...review,
          sessionsByKey: {
            ...review.sessionsByKey,
            [key]: {
              ...session,
              invalidReason: "source_revision_changed",
              updatedAt: Date.now(),
            },
          },
        };
      }
    }
    const nextState = {
      workspaces,
      visibleOwnerChatIds: withVisibleWorkspace(state, ownerChatId),
      webSessionKeysByItemId: state.webSessionKeysByItemId,
      review,
    };
    return { ok: true, workspaceId: nextWorkspace.workspaceId, item, state: nextWorkspace, nextState };
  }
  if (!current) return fail(state, "target_unavailable", "WorkPanel workspace is unavailable");
  const itemIndex = current.items.findIndex((item) => item.itemId === cleanIdentity(command.itemId));
  if (itemIndex < 0) return fail(state, "target_unavailable", "WorkPanel item is unavailable");
  const item = current.items[itemIndex];
  if (command.type === "startReview") {
    const source = normalizeReviewSource(command.source);
    if (!source || !itemAcceptsReview(item, command.kind, source)) {
      return fail(state, "capability_denied", "WorkPanel item is not reviewable");
    }
    const now = Date.now();
    const existing = getWorkPanelReviewSession(currentReviewState(state), ownerChatId, item.itemId);
    const session: WorkPanelReviewSession = existing && existing.kind === command.kind
      ? {
          ...existing,
          source,
          invalidReason: existing.source.revision === source.revision
            ? existing.invalidReason
            : "source_revision_changed",
          updatedAt: now,
        }
      : {
          version: WORK_PANEL_REVIEW_VERSION,
          ownerChatId,
          itemId: item.itemId,
          kind: command.kind,
          source,
          annotations: [],
          createdAt: now,
          updatedAt: now,
        };
    const nextState = replaceReviewSession(state, session, true);
    return { ok: true, workspaceId: current.workspaceId, item, state: current, nextState };
  }
  if (command.type === "stopReview") {
    const review = currentReviewState(state);
    if (review.activeItemIdsByOwnerChatId[ownerChatId] !== item.itemId) {
      return { ok: true, workspaceId: current.workspaceId, item, state: current, nextState: state };
    }
    const activeItemIdsByOwnerChatId = { ...review.activeItemIdsByOwnerChatId };
    delete activeItemIdsByOwnerChatId[ownerChatId];
    return {
      ok: true,
      workspaceId: current.workspaceId,
      item,
      state: current,
      nextState: { ...state, review: { ...review, activeItemIdsByOwnerChatId } },
    };
  }
  if (command.type === "discardReview") {
    const review = withoutReviewSessions(currentReviewState(state), ownerChatId, [item.itemId]);
    return {
      ok: true,
      workspaceId: current.workspaceId,
      item,
      state: current,
      nextState: { ...state, review },
    };
  }
  if (
    command.type === "addImageReviewAnnotation" ||
    command.type === "addHtmlReviewAnnotation" ||
    command.type === "updateReviewAnnotation" ||
    command.type === "removeReviewAnnotation" ||
    command.type === "markReviewInvalid"
  ) {
    const session = getWorkPanelReviewSession(currentReviewState(state), ownerChatId, item.itemId);
    if (!session) return fail(state, "target_unavailable", "WorkPanel review session is unavailable");
    if (
      (command.type === "addImageReviewAnnotation" || command.type === "addHtmlReviewAnnotation") &&
      currentReviewState(state).activeItemIdsByOwnerChatId[ownerChatId] !== item.itemId
    ) {
      return fail(state, "capability_denied", "WorkPanel review session is not active");
    }
    const now = Date.now();
    let nextSession = session;
    if (command.type === "addImageReviewAnnotation") {
      if (session.kind !== "image") return fail(state, "invalid_request", "review kind mismatch");
      if (session.annotations.length >= WORK_PANEL_REVIEW_MAX_ANNOTATIONS) {
        return fail(state, "capability_denied", "review annotation limit reached");
      }
      const id = cleanIdentity(command.annotation.id, 256);
      const rect = normalizeWorkPanelPixelRect(command.annotation.rect);
      const normalizedRect = normalizeWorkPanelNormalizedRect(command.annotation.normalizedRect);
      if (!id || !rect || !normalizedRect || session.annotations.some((annotation) => annotation.id === id)) {
        return fail(state, "invalid_request", "invalid review annotation id");
      }
      nextSession = {
        ...session,
        annotations: [
          ...session.annotations,
          {
            id,
            kind: "image-region",
            number: session.annotations.length + 1,
            rect,
            normalizedRect,
            requirement: "",
          },
        ],
        updatedAt: now,
      };
    } else if (command.type === "addHtmlReviewAnnotation") {
      if (session.kind !== "html") return fail(state, "invalid_request", "review kind mismatch");
      if (session.annotations.length >= WORK_PANEL_REVIEW_MAX_ANNOTATIONS) {
        return fail(state, "capability_denied", "review annotation limit reached");
      }
      const id = cleanIdentity(command.annotation.id, 256);
      const fullXPath = cleanIdentity(command.annotation.fullXPath, 2_048);
      const rect = normalizeWorkPanelPixelRect(command.annotation.rect);
      const cssSelector = cleanIdentity(command.annotation.cssSelector, 1_024);
      const tagName = cleanIdentity(command.annotation.tagName, 64).toLowerCase();
      const textExcerpt = cleanIdentity(command.annotation.textExcerpt, 240);
      const attributes = Object.fromEntries(
        Object.entries(command.annotation.attributes ?? {})
          .filter(([key, value]) =>
            /^[a-z_:][a-z\d:_.-]*$/iu.test(key) &&
            !/value|password|token|secret|authorization|cookie|href|src/iu.test(key) &&
            typeof value === "string",
          )
          .slice(0, 12)
          .map(([key, value]) => [key.slice(0, 64), String(value).slice(0, 160)]),
      );
      if (
        !id ||
        !/^\/html(?:\/|$)/u.test(fullXPath) ||
        !rect ||
        !/^[a-z][a-z\d-]*$/u.test(tagName) ||
        session.annotations.some((annotation) => annotation.id === id)
      ) {
        return fail(state, "invalid_request", "invalid HTML review annotation");
      }
      nextSession = {
        ...session,
        annotations: [
          ...session.annotations,
          {
            id,
            fullXPath,
            cssSelector,
            tagName,
            attributes,
            textExcerpt,
            rect,
            kind: "html-element",
            number: session.annotations.length + 1,
            requirement: "",
          },
        ],
        updatedAt: now,
      };
    } else if (command.type === "updateReviewAnnotation") {
      const annotationId = cleanIdentity(command.annotationId, 256);
      if (
        !annotationId ||
        typeof command.requirement !== "string" ||
        command.requirement.length > WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS
      ) {
        return fail(state, "invalid_request", "invalid review requirement");
      }
      let found = false;
      const annotations = session.annotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        found = true;
        return { ...annotation, requirement: command.requirement };
      });
      if (!found) return fail(state, "target_unavailable", "review annotation is unavailable");
      nextSession = { ...session, annotations, updatedAt: now };
    } else if (command.type === "removeReviewAnnotation") {
      const annotationId = cleanIdentity(command.annotationId, 256);
      const annotations = session.annotations.filter((annotation) => annotation.id !== annotationId);
      if (annotations.length === session.annotations.length) {
        return fail(state, "target_unavailable", "review annotation is unavailable");
      }
      nextSession = {
        ...session,
        annotations: renumberWorkPanelReviewAnnotations(annotations),
        updatedAt: now,
      };
    } else {
      const reason = cleanIdentity(command.reason, 512);
      const annotationId = cleanIdentity(command.annotationId, 256);
      if (!reason) return fail(state, "invalid_request", "review invalidation reason is required");
      if (annotationId) {
        let found = false;
        const annotations = session.annotations.map((annotation) => {
          if (annotation.id !== annotationId) return annotation;
          found = true;
          return { ...annotation, invalidReason: reason };
        });
        if (!found) return fail(state, "target_unavailable", "review annotation is unavailable");
        nextSession = { ...session, annotations, updatedAt: now };
      } else {
        nextSession = { ...session, invalidReason: reason, updatedAt: now };
      }
    }
    const nextState = replaceReviewSession(state, nextSession, false);
    return { ok: true, workspaceId: current.workspaceId, item, state: current, nextState };
  }
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
        webSessionKeysByItemId: state.webSessionKeysByItemId,
        review: currentReviewState(state),
      },
    };
  }
  if (command.type === "closeOtherItems") {
    const items = current.items.filter((candidate) =>
      candidate.itemId === item.itemId || candidate.pinned || !candidate.closable,
    );
    const removedItemIds = current.items
      .filter((candidate) => !items.some((remaining) => remaining.itemId === candidate.itemId))
      .map((candidate) => candidate.itemId);
    if (
      !command.force &&
      hasReviewDraftForItems(currentReviewState(state), ownerChatId, removedItemIds)
    ) {
      return fail(state, "capability_denied", "tabs contain unsent review annotations");
    }
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
        webSessionKeysByItemId: removeWorkPanelWebSessionKeys(
          state,
          current.workspaceId,
          removedItemIds,
        ),
        review: withoutReviewSessions(currentReviewState(state), ownerChatId, removedItemIds),
      },
    };
  }
  if (item.pinned || !item.closable) {
    return fail(state, "capability_denied", "pinned or non-closable WorkPanel item cannot be closed");
  }
  if (
    !command.force &&
    hasWorkPanelReviewDraft(
      getWorkPanelReviewSession(currentReviewState(state), ownerChatId, item.itemId),
    )
  ) {
    return fail(state, "capability_denied", "tab contains unsent review annotations");
  }
  const items = current.items.filter((_, nextIndex) => nextIndex !== itemIndex);
  if (items.length === 0) {
    const nextState = {
      workspaces: state.workspaces.filter((_, nextIndex) => nextIndex !== index),
      visibleOwnerChatIds: withoutVisibleWorkspace(state, ownerChatId),
      webSessionKeysByItemId: removeWorkPanelWebSessionKeys(
        state,
        current.workspaceId,
        [item.itemId],
      ),
      review: withoutReviewSessions(currentReviewState(state), ownerChatId, [item.itemId]),
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
      webSessionKeysByItemId: removeWorkPanelWebSessionKeys(
        state,
        current.workspaceId,
        [item.itemId],
      ),
      review: withoutReviewSessions(currentReviewState(state), ownerChatId, [item.itemId]),
    },
  };
}
