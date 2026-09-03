import { clipboard, ipcMain, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "./browser-surface-registry";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../shared/service-webview-bridge";
import {
  WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION,
  WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION,
  WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL,
  WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION,
  type WebviewContextMenuActionId,
  type WebviewContextMenuExecuteCommand,
  type WebviewContextMenuSemanticCapability,
  type WebviewContextMenuSemanticTarget,
  type WebviewContextMenuSurfaceType
} from "../shared/webview-context-menu";
import {
  buildWebviewContextMenuPolicy,
  isDesktopTabUrl,
  isExternalApplicationUrl,
  isSafeMediaDownloadUrl,
  type WebviewContextMenuPolicyItem
} from "./webview-context-menu-policy";
import {
  AGENT_WEBCLIENT_SELECTION_ACTION,
  AGENT_WEBCLIENT_SELECTION_ACTION_VERSION,
  type AgentWebclientSelectionActionResult as SelectionActionResult,
} from "../shared/contracts/agent-webclient-bridge";
import {
  WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL,
  WEBVIEW_SELECTION_TOOLBAR_EXECUTE_CHANNEL,
  WEBVIEW_SELECTION_TOOLBAR_RESULT_CHANNEL,
  WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL,
  WEBVIEW_SELECTION_TOOLBAR_VERSION,
  isWebviewSelectionToolbarSurfaceAllowed,
  isWebviewSelectionToolbarTargetAllowed,
  validateWebviewSelectionToolbarChange,
  validateWebviewSelectionToolbarExecuteRequest,
  type WebviewSelectionToolbarExecuteResult,
  type WebviewSelectionToolbarPoint,
  type WebviewSelectionToolbarState
} from "../shared/webview-selection-toolbar";

const SEMANTIC_TIMEOUT_MS = 120;
const MAX_SEMANTIC_RESPONSE_BYTES = 32 * 1024;
const MAX_TARGET_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 256;
const SELECTION_ACTION_TIMEOUT_MS = 15_000;

const CAPABILITIES_BY_TARGET = {
  message: new Set<WebviewContextMenuSemanticCapability>(["content.copy"]),
  code: new Set<WebviewContextMenuSemanticCapability>(["code.copy"]),
  "web-link": new Set<WebviewContextMenuSemanticCapability>(["link.preview"]),
  "workspace-file": new Set<WebviewContextMenuSemanticCapability>([
    "workspace.preview",
    "workspace.copy-path"
  ]),
  "chat-resource": new Set<WebviewContextMenuSemanticCapability>([
    "resource.preview",
    "resource.download"
  ])
} as const;

const SEMANTIC_COMMAND_BY_ACTION: Partial<Record<
  WebviewContextMenuActionId,
  WebviewContextMenuExecuteCommand
>> = {
  "content.copy": "copy-content",
  "code.copy": "copy-code",
  "workspace.preview": "preview-workspace",
  "workspace.copy-path": "copy-workspace-path",
  "resource.preview": "preview-resource",
  "resource.download": "download-resource"
};

export type WebviewContextMenuContext = {
  webContentsId: number;
  surfaceId: string | null;
  tabId: string | null;
  registrationId: string | null;
  ownerWebContentsId: number;
  surfaceType: WebviewContextMenuSurfaceType;
  serviceId?: string;
  pageRoute?: string;
  pageURL: string;
  frameURL: string;
  x: number;
  y: number;
  selectionText: string;
  linkURL: string;
  mediaURL: string;
  mediaType: string;
  suggestedFilename: string;
  hasImageContents: boolean;
  isEditable: boolean;
  editFlags: ContextMenuParams["editFlags"];
  canGoBack: boolean;
  canGoForward: boolean;
  trustedAgentWebclient: boolean;
  semanticTarget: WebviewContextMenuSemanticTarget | null;
};

export type WebviewContextMenuControllerOptions = {
  platform: NodeJS.Platform;
  browserSurfaces: BrowserSurfaceRegistry;
  getMainWindow(): BrowserWindow | null;
  openBrowserUrl(input: { url: string; label?: string; requireOperableTarget?: boolean }): Promise<unknown>;
  openWorkPanelUrl(input: { sourceGuestId: number; url: string }): void;
  openExternal(url: string): Promise<unknown>;
  isTrustedAgentWebclient(
    contents: WebContents,
    target: RegisteredWebviewSurfaceTarget
  ): boolean | Promise<boolean>;
  t(key: any, values?: any): string;
  report(source: string, details: Record<string, unknown>): void;
  updateSelectionExplainWindow?(input:
    | { requestId: string; status: "pending" }
    | { requestId: string; status: "ready"; chatId: string; runId: string }
    | { requestId: string; status: "error"; code: string }
  ): void | Promise<void>;
};

type PendingSemanticRequest = {
  guestId: number;
  resolve(target: WebviewContextMenuSemanticTarget | null): void;
  timeout: NodeJS.Timeout;
};

type MenuSnapshot = {
  contents: WebContents;
  registeredTarget: RegisteredWebviewSurfaceTarget | null;
  context: WebviewContextMenuContext;
};

type SelectionToolbarVisibleRecord = {
  contents: WebContents;
  selectionId: string;
  guestId: number;
  registrationId: string;
  surfaceId: string;
  ownerWebContentsId: number;
  pageURL: string;
  target: WebviewContextMenuSemanticTarget;
  start: WebviewSelectionToolbarPoint;
  end: WebviewSelectionToolbarPoint;
};

type PendingSelectionAction = {
  guestId: number;
  resolve(result: SelectionActionResult | null): void;
  timeout: NodeJS.Timeout;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function validateWebviewContextMenuSemanticResponse(
  value: unknown,
  expectedRequestId: string
): WebviewContextMenuSemanticTarget | null | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SEMANTIC_RESPONSE_BYTES) return undefined;
  } catch {
    return undefined;
  }
  if (
    !hasOnlyKeys(value, ["version", "requestId", "target"]) ||
    value.version !== WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION ||
    value.requestId !== expectedRequestId
  ) {
    return undefined;
  }
  if (value.target === null) return null;
  if (!isPlainObject(value.target)) return undefined;
  const target = value.target;
  if (!hasOnlyKeys(target, ["version", "targetId", "kind", "capabilities", "url", "title", "name", "mediaType"])) {
    return undefined;
  }
  if (
    target.version !== WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION ||
    typeof target.targetId !== "string" ||
    !target.targetId.trim() ||
    target.targetId.length > MAX_TARGET_ID_LENGTH ||
    typeof target.kind !== "string" ||
    !(target.kind in CAPABILITIES_BY_TARGET) ||
    !Array.isArray(target.capabilities) ||
    target.capabilities.length > 4 ||
    new Set(target.capabilities).size !== target.capabilities.length
  ) {
    return undefined;
  }
  const allowedCapabilities = CAPABILITIES_BY_TARGET[target.kind as keyof typeof CAPABILITIES_BY_TARGET];
  if (!target.capabilities.every((capability) =>
    typeof capability === "string" && allowedCapabilities.has(capability as never)
  )) {
    return undefined;
  }
  for (const key of ["title", "name"] as const) {
    if (target[key] !== undefined && (typeof target[key] !== "string" || target[key].length > MAX_LABEL_LENGTH)) {
      return undefined;
    }
  }
  if (target.url !== undefined && (typeof target.url !== "string" || target.url.length > MAX_URL_LENGTH)) {
    return undefined;
  }
  if (
    target.kind === "web-link" &&
    (typeof target.url !== "string" || !isDesktopTabUrl(target.url))
  ) {
    return undefined;
  }
  if (
    target.mediaType !== undefined &&
    !["image", "audio", "video", "file"].includes(String(target.mediaType))
  ) {
    return undefined;
  }
  return target as WebviewContextMenuSemanticTarget;
}

export function getWebviewContextMenuAccelerator(
  platform: NodeJS.Platform,
  actionId: WebviewContextMenuActionId
) {
  const mac = platform === "darwin";
  const accelerators: Partial<Record<WebviewContextMenuActionId, string>> = mac
    ? {
        "edit.undo": "Command+Z",
        "edit.redo": "Shift+Command+Z",
        "edit.cut": "Command+X",
        "edit.copy": "Command+C",
        "edit.paste": "Command+V",
        "edit.select-all": "Command+A",
        "selection.copy": "Command+C"
      }
    : {
        "edit.undo": "Ctrl+Z",
        "edit.redo": "Ctrl+Y",
        "edit.cut": "Ctrl+X",
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
        "edit.select-all": "Ctrl+A",
        "selection.copy": "Ctrl+C"
      };
  return accelerators[actionId];
}

export function validateWebviewSelectionActionResult(
  value: unknown,
  expectedRequestId: string,
): SelectionActionResult | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["version", "requestId", "ok", "code", "handoff"]) ||
    value.version !== AGENT_WEBCLIENT_SELECTION_ACTION_VERSION ||
    value.requestId !== expectedRequestId ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  if (value.code !== undefined && ![
    "stale_selection",
    "chat_required",
    "selection_too_large",
    "surface_not_ready",
    "run_start_failed",
  ].includes(String(value.code))) {
    return null;
  }
  if ((value.ok && value.code !== undefined) || (!value.ok && value.code === undefined)) {
    return null;
  }
  let handoff: SelectionActionResult["handoff"];
  if (value.handoff !== undefined) {
    if (!value.ok) return null;
    if (
      !isPlainObject(value.handoff) ||
      !hasOnlyKeys(value.handoff, ["chatId", "runId"]) ||
      typeof value.handoff.chatId !== "string" ||
      !value.handoff.chatId.trim() ||
      value.handoff.chatId.length > 192 ||
      typeof value.handoff.runId !== "string" ||
      !value.handoff.runId.trim() ||
      value.handoff.runId.length > 192
    ) {
      return null;
    }
    handoff = {
      chatId: value.handoff.chatId,
      runId: value.handoff.runId,
    };
  }
  return {
    version: AGENT_WEBCLIENT_SELECTION_ACTION_VERSION,
    requestId: expectedRequestId,
    ok: value.ok,
    ...(value.code ? { code: value.code as NonNullable<SelectionActionResult["code"]> } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

export function createWebviewContextMenuController(options: WebviewContextMenuControllerOptions) {
  const attachedGuests = new WeakSet<WebContents>();
  const pendingRequests = new Map<string, PendingSemanticRequest>();
  const latestRequestByGuest = new Map<number, string>();
  const contextSequenceByGuest = new Map<number, number>();
  const selectionSequenceByGuest = new Map<number, number>();
  const visibleSelectionByGuest = new Map<number, SelectionToolbarVisibleRecord>();
  const pendingSelectionActions = new Map<string, PendingSelectionAction>();

  function finishPending(requestId: string, target: WebviewContextMenuSemanticTarget | null) {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    if (latestRequestByGuest.get(pending.guestId) === requestId) {
      latestRequestByGuest.delete(pending.guestId);
    }
    pending.resolve(target);
  }

  ipcMain.on(WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL, (event, payload: unknown) => {
    if (!isPlainObject(payload) || typeof payload.requestId !== "string") return;
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || event.sender.id !== pending.guestId) return;
    const validated = validateWebviewContextMenuSemanticResponse(payload, payload.requestId);
    if (validated === undefined) {
      finishPending(payload.requestId, null);
      return;
    }
    finishPending(payload.requestId, validated);
  });

  ipcMain.on(WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL, (event, payload: unknown) => {
    void handleSelectionToolbarChange(event.sender, payload).catch((error) => {
      options.report("webview selection toolbar failed", {
        guestId: event.sender.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  function finishSelectionAction(
    requestId: string,
    result: SelectionActionResult | null,
  ) {
    const pending = pendingSelectionActions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSelectionActions.delete(requestId);
    pending.resolve(result);
  }

  ipcMain.on(WEBVIEW_SELECTION_TOOLBAR_RESULT_CHANNEL, (event, payload: unknown) => {
    if (!isPlainObject(payload) || typeof payload.requestId !== "string") return;
    const pending = pendingSelectionActions.get(payload.requestId);
    if (!pending || pending.guestId !== event.sender.id) return;
    finishSelectionAction(
      payload.requestId,
      validateWebviewSelectionActionResult(payload, payload.requestId),
    );
  });

  ipcMain.removeHandler(WEBVIEW_SELECTION_TOOLBAR_EXECUTE_CHANNEL);
  ipcMain.handle(WEBVIEW_SELECTION_TOOLBAR_EXECUTE_CHANNEL, (event, payload: unknown) =>
    handleSelectionToolbarExecute(event.sender.id, payload)
  );

  function cancelGuestRequests(guestId: number) {
    const requestId = latestRequestByGuest.get(guestId);
    if (requestId) finishPending(requestId, null);
  }

  function resolveSemantic(contents: WebContents, x: number, y: number) {
    cancelGuestRequests(contents.id);
    const requestId = `webview-context-${contents.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<WebviewContextMenuSemanticTarget | null>((resolve) => {
      const timeout = setTimeout(() => finishPending(requestId, null), SEMANTIC_TIMEOUT_MS);
      pendingRequests.set(requestId, { guestId: contents.id, resolve, timeout });
      latestRequestByGuest.set(contents.id, requestId);
      try {
        contents.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
          action: WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION,
          version: WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION,
          requestId,
          x,
          y
        });
      } catch {
        finishPending(requestId, null);
      }
    });
  }

  function nextSelectionSequence(guestId: number) {
    const next = (selectionSequenceByGuest.get(guestId) ?? 0) + 1;
    selectionSequenceByGuest.set(guestId, next);
    return next;
  }

  function sendSelectionToolbarState(
    ownerWebContentsId: number,
    state: WebviewSelectionToolbarState
  ) {
    const mainWindow = options.getMainWindow();
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.id !== ownerWebContentsId
    ) {
      return false;
    }
    mainWindow.webContents.send(WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL, state);
    return true;
  }

  function clearSelectionToolbar(guestId: number, advanceSequence = true) {
    if (advanceSequence) nextSelectionSequence(guestId);
    const visible = visibleSelectionByGuest.get(guestId);
    if (!visible) return;
    visibleSelectionByGuest.delete(guestId);
    sendSelectionToolbarState(visible.ownerWebContentsId, {
      version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
      visible: false,
      selectionId: visible.selectionId,
      guestId: visible.guestId,
      registrationId: visible.registrationId,
      surfaceId: visible.surfaceId
    });
  }

  async function handleSelectionToolbarExecute(
    ownerWebContentsId: number,
    payload: unknown,
  ): Promise<WebviewSelectionToolbarExecuteResult> {
    const request = validateWebviewSelectionToolbarExecuteRequest(payload);
    if (!request) return { ok: false, code: "invalid_request" };
    const visible = [...visibleSelectionByGuest.values()].find(
      (candidate) => candidate.selectionId === request.selectionId,
    );
    const live = visible
      ? options.browserSurfaces.resolveWebviewSurfaceTarget(visible.guestId)
      : null;
    if (
      !visible ||
      !live ||
      visible.ownerWebContentsId !== ownerWebContentsId ||
      !liveSelectionRegistrationMatches(
        visible.contents,
        live,
        visible.pageURL,
      )
    ) {
      return { ok: false, code: "stale_selection" };
    }
    if (
      live.registrationId !== visible.registrationId ||
      live.surfaceId !== visible.surfaceId
    ) {
      return { ok: false, code: "stale_selection" };
    }

    const guestRequestId = `webview-selection-action-${visible.guestId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (request.action === "more-details") {
      void options.updateSelectionExplainWindow?.({
        requestId: guestRequestId,
        status: "pending",
      });
    }
    clearSelectionToolbar(visible.guestId);
    const resultPromise = new Promise<SelectionActionResult | null>((resolve) => {
      const timeout = setTimeout(
        () => finishSelectionAction(guestRequestId, null),
        SELECTION_ACTION_TIMEOUT_MS,
      );
      pendingSelectionActions.set(guestRequestId, {
        guestId: visible.guestId,
        resolve,
        timeout,
      });
    });
    try {
      visible.contents.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
        action: AGENT_WEBCLIENT_SELECTION_ACTION,
        version: AGENT_WEBCLIENT_SELECTION_ACTION_VERSION,
        requestId: guestRequestId,
        selectionId: visible.selectionId,
        operation: request.action,
        targetId: visible.target.targetId,
        targetKind: visible.target.kind,
        start: visible.start,
        end: visible.end,
      });
    } catch {
      finishSelectionAction(guestRequestId, null);
    }
    const result = await resultPromise;
    if (!result?.ok) {
      const code = result?.code || "timeout";
      if (request.action === "more-details") {
        await options.updateSelectionExplainWindow?.({
          requestId: guestRequestId,
          status: "error",
          code,
        });
      }
      return { ok: false, code };
    }
    if (request.action === "more-details") {
      if (!result.handoff) {
        await options.updateSelectionExplainWindow?.({
          requestId: guestRequestId,
          status: "error",
          code: "invalid_request",
        });
        return { ok: false, code: "invalid_request" };
      }
      await options.updateSelectionExplainWindow?.({
        requestId: guestRequestId,
        status: "ready",
        ...result.handoff,
      });
      return { ok: true, handoff: result.handoff };
    }
    return { ok: true };
  }

  function liveSelectionRegistrationMatches(
    contents: WebContents,
    registeredTarget: RegisteredWebviewSurfaceTarget,
    pageURL: string
  ) {
    const mainWindow = options.getMainWindow();
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.id !== registeredTarget.ownerWebContentsId ||
      contents.isDestroyed() ||
      contents.getType() !== "webview" ||
      contents.id !== registeredTarget.webContentsId ||
      contents.getURL() !== pageURL
    ) {
      return false;
    }
    const live = options.browserSurfaces.resolveWebviewSurfaceTarget(contents.id);
    return Boolean(
      live &&
      live.registrationId === registeredTarget.registrationId &&
      live.surfaceId === registeredTarget.surfaceId &&
      live.tabId === registeredTarget.tabId &&
      live.ownerWebContentsId === registeredTarget.ownerWebContentsId
    );
  }

  async function handleSelectionToolbarChange(contents: WebContents, payload: unknown) {
    if (contents.isDestroyed() || contents.getType() !== "webview") return;
    const guestId = contents.id;
    const selectionSequence = nextSelectionSequence(guestId);
    const change = validateWebviewSelectionToolbarChange(payload);
    if (!change || !change.visible) {
      clearSelectionToolbar(guestId, false);
      return;
    }
    const registeredTarget = options.browserSurfaces.resolveWebviewSurfaceTarget(guestId);
    if (
      !registeredTarget ||
      registeredTarget.serviceId !== "agent-webclient" ||
      !isWebviewSelectionToolbarSurfaceAllowed(registeredTarget.surfaceType)
    ) {
      clearSelectionToolbar(guestId, false);
      return;
    }
    const pageURL = contents.getURL();
    let trustedAgentWebclient = false;
    try {
      trustedAgentWebclient = Boolean(
        await options.isTrustedAgentWebclient(contents, registeredTarget)
      );
    } catch {
      trustedAgentWebclient = false;
    }
    if (selectionSequenceByGuest.get(guestId) !== selectionSequence) return;
    if (!trustedAgentWebclient) {
      clearSelectionToolbar(guestId, false);
      return;
    }
    const startTarget = await resolveSemantic(
      contents,
      change.start.x,
      change.start.y
    );
    if (selectionSequenceByGuest.get(guestId) !== selectionSequence) return;
    const endTarget = await resolveSemantic(
      contents,
      change.end.x,
      change.end.y,
    );
    if (selectionSequenceByGuest.get(guestId) !== selectionSequence) return;
    if (
      !startTarget ||
      !endTarget ||
      startTarget.targetId !== endTarget.targetId ||
      startTarget.kind !== endTarget.kind ||
      !isWebviewSelectionToolbarTargetAllowed(startTarget.kind) ||
      !liveSelectionRegistrationMatches(contents, registeredTarget, pageURL)
    ) {
      clearSelectionToolbar(guestId, false);
      return;
    }
    const previous = visibleSelectionByGuest.get(guestId);
    if (
      previous &&
      (previous.registrationId !== registeredTarget.registrationId ||
        previous.surfaceId !== registeredTarget.surfaceId)
    ) {
      clearSelectionToolbar(guestId, false);
    }
    const selectionId = `webview-selection-${guestId}-${Date.now()}-${selectionSequence}`;
    const visible: SelectionToolbarVisibleRecord = {
      contents,
      selectionId,
      guestId,
      registrationId: registeredTarget.registrationId,
      surfaceId: registeredTarget.surfaceId,
      ownerWebContentsId: registeredTarget.ownerWebContentsId,
      pageURL,
      target: startTarget,
      start: change.start,
      end: change.end,
    };
    visibleSelectionByGuest.set(guestId, visible);
    if (!sendSelectionToolbarState(registeredTarget.ownerWebContentsId, {
      version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
      visible: true,
      selectionId,
      guestId,
      registrationId: registeredTarget.registrationId,
      surfaceId: registeredTarget.surfaceId,
      rect: change.rect
    })) {
      visibleSelectionByGuest.delete(guestId);
    }
  }

  function readNavigationState(contents: WebContents) {
    try {
      return {
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward()
      };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  function liveRegistrationMatches(snapshot: MenuSnapshot) {
    const mainWindow = options.getMainWindow();
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.id !== snapshot.context.ownerWebContentsId
    ) {
      return false;
    }
    if (snapshot.contents.isDestroyed() || snapshot.contents.getType() !== "webview") return false;
    if (snapshot.contents.id !== snapshot.context.webContentsId) return false;
    if (snapshot.contents.getURL() !== snapshot.context.pageURL) return false;
    if (!snapshot.registeredTarget) return true;
    const live = options.browserSurfaces.resolveWebviewSurfaceTarget(snapshot.contents.id);
    return Boolean(
      live &&
      live.registrationId === snapshot.registeredTarget.registrationId &&
      live.surfaceId === snapshot.registeredTarget.surfaceId &&
      live.tabId === snapshot.registeredTarget.tabId &&
      live.ownerWebContentsId === snapshot.registeredTarget.ownerWebContentsId
    );
  }

  function semanticLinkURL(context: WebviewContextMenuContext) {
    return context.semanticTarget?.kind === "web-link" && context.semanticTarget.url
      ? context.semanticTarget.url
      : context.linkURL;
  }

  function executeSemantic(snapshot: MenuSnapshot, command: WebviewContextMenuExecuteCommand) {
    const target = snapshot.context.semanticTarget;
    if (!target || !liveRegistrationMatches(snapshot)) return;
    try {
      snapshot.contents.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
        action: WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION,
        version: WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION,
        requestId: `webview-context-execute-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        targetId: target.targetId,
        targetKind: target.kind,
        command,
        x: snapshot.context.x,
        y: snapshot.context.y
      });
    } catch {
      // The guest can be destroyed after validation and before delivery.
    }
  }

  function executeAction(snapshot: MenuSnapshot, actionId: WebviewContextMenuActionId) {
    if (!liveRegistrationMatches(snapshot)) return;
    const contents = snapshot.contents;
    const context = snapshot.context;
    const semanticCommand = SEMANTIC_COMMAND_BY_ACTION[actionId];
    if (semanticCommand) {
      executeSemantic(snapshot, semanticCommand);
      return;
    }
    switch (actionId) {
      case "edit.undo": contents.undo(); return;
      case "edit.redo": contents.redo(); return;
      case "edit.cut": contents.cut(); return;
      case "edit.copy": contents.copy(); return;
      case "edit.paste": contents.paste(); return;
      case "edit.select-all": contents.selectAll(); return;
      case "selection.copy": clipboard.writeText(context.selectionText); return;
      case "link.open-current": {
        const url = semanticLinkURL(context);
        if (!isDesktopTabUrl(url)) return;
        if (context.trustedAgentWebclient && context.semanticTarget?.kind === "web-link") {
          executeSemantic(snapshot, "preview-link");
          return;
        }
        if (["browser", "website", "webapp"].includes(context.surfaceType)) {
          void contents.loadURL(url);
        }
        return;
      }
      case "link.open-desktop-tab": {
        const url = semanticLinkURL(context);
        if (isDesktopTabUrl(url)) {
          void options.openBrowserUrl({ url, requireOperableTarget: false });
        }
        return;
      }
      case "link.open-work-panel-tab": {
        const url = semanticLinkURL(context);
        if (context.surfaceType === "chat-work-panel" && isDesktopTabUrl(url)) {
          options.openWorkPanelUrl({ sourceGuestId: contents.id, url });
        }
        return;
      }
      case "link.open-external": {
        const url = semanticLinkURL(context);
        if (isExternalApplicationUrl(url)) void options.openExternal(url);
        return;
      }
      case "link.copy": {
        const url = semanticLinkURL(context);
        if (isExternalApplicationUrl(url)) clipboard.writeText(url);
        return;
      }
      case "media.copy-image": contents.copyImageAt(context.x, context.y); return;
      case "media.save-as": {
        if (isSafeMediaDownloadUrl(context.mediaURL)) contents.downloadURL(context.mediaURL);
        return;
      }
      case "page.back": {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        return;
      }
      case "page.forward": {
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        return;
      }
      case "page.reload": contents.reload(); return;
      case "page.copy-url": {
        if (isDesktopTabUrl(contents.getURL())) clipboard.writeText(contents.getURL());
        return;
      }
      default: return;
    }
  }

  function labelFor(snapshot: MenuSnapshot, actionId: WebviewContextMenuActionId) {
    if (actionId === "link.open-current" && snapshot.context.trustedAgentWebclient) {
      return options.t("webviewContextMenu.linkPreview");
    }
    return options.t(`webviewContextMenu.${actionId}`);
  }

  function buildTemplate(snapshot: MenuSnapshot, policyItems: WebviewContextMenuPolicyItem[]) {
    const template: MenuItemConstructorOptions[] = [];
    let previousGroup: WebviewContextMenuPolicyItem["group"] | null = null;
    for (const item of policyItems) {
      if (previousGroup && previousGroup !== item.group) template.push({ type: "separator" });
      template.push({
        label: labelFor(snapshot, item.id),
        accelerator: getWebviewContextMenuAccelerator(options.platform, item.id),
        click: () => executeAction(snapshot, item.id)
      });
      previousGroup = item.group;
    }
    return template;
  }

  async function handleContextMenu(contents: WebContents, params: ContextMenuParams) {
    if (contents.isDestroyed()) return;
    clearSelectionToolbar(contents.id);
    const contextSequence = (contextSequenceByGuest.get(contents.id) ?? 0) + 1;
    contextSequenceByGuest.set(contents.id, contextSequence);
    const registeredTarget = options.browserSurfaces.resolveWebviewSurfaceTarget(contents.id);
    const navigation = readNavigationState(contents);
    const pageURL = contents.getURL();
    let trustedAgentWebclient = false;
    if (registeredTarget) {
      try {
        trustedAgentWebclient = Boolean(
          await options.isTrustedAgentWebclient(contents, registeredTarget)
        );
      } catch {
        trustedAgentWebclient = false;
      }
    }
    if (contextSequenceByGuest.get(contents.id) !== contextSequence) return;
    const semanticTarget = trustedAgentWebclient
      ? await resolveSemantic(contents, params.x, params.y)
      : null;
    if (contextSequenceByGuest.get(contents.id) !== contextSequence) return;
    const mainWindow = options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || contents.isDestroyed()) return;
    const snapshot: MenuSnapshot = {
      contents,
      registeredTarget,
      context: {
        webContentsId: contents.id,
        surfaceId: registeredTarget?.surfaceId ?? null,
        tabId: registeredTarget?.tabId ?? null,
        registrationId: registeredTarget?.registrationId ?? null,
        ownerWebContentsId: registeredTarget?.ownerWebContentsId ?? mainWindow.webContents.id,
        surfaceType: registeredTarget?.presentationScope === "workpanel"
          ? "chat-work-panel"
          : registeredTarget?.surfaceType ?? "service",
        ...(registeredTarget?.serviceId ? { serviceId: registeredTarget.serviceId } : {}),
        ...(registeredTarget?.pageRoute ? { pageRoute: registeredTarget.pageRoute } : {}),
        pageURL,
        frameURL: params.frameURL,
        x: params.x,
        y: params.y,
        selectionText: params.selectionText,
        linkURL: params.linkURL,
        mediaURL: params.srcURL,
        mediaType: params.mediaType,
        suggestedFilename: params.suggestedFilename,
        hasImageContents: params.hasImageContents,
        isEditable: params.isEditable,
        editFlags: params.editFlags,
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        trustedAgentWebclient,
        semanticTarget
      }
    };
    if (!liveRegistrationMatches(snapshot)) return;
    const policyItems = buildWebviewContextMenuPolicy(snapshot.context);
    if (policyItems.length === 0) return;
    Menu.buildFromTemplate(buildTemplate(snapshot, policyItems)).popup({ window: mainWindow });
  }

  function attach(contents: WebContents) {
    if (attachedGuests.has(contents)) return;
    attachedGuests.add(contents);
    contents.on("context-menu", (event, params) => {
      event.preventDefault();
      void handleContextMenu(contents, params).catch((error) => {
        options.report("webview context menu failed", {
          guestId: contents.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });
    contents.once("destroyed", () => {
      clearSelectionToolbar(contents.id);
      cancelGuestRequests(contents.id);
      for (const [requestId, pending] of pendingSelectionActions) {
        if (pending.guestId === contents.id) finishSelectionAction(requestId, null);
      }
      contextSequenceByGuest.delete(contents.id);
      selectionSequenceByGuest.delete(contents.id);
    });
    contents.on("did-start-navigation", () => clearSelectionToolbar(contents.id));
    contents.on("did-navigate-in-page", () => clearSelectionToolbar(contents.id));
    contents.on("render-process-gone", () => clearSelectionToolbar(contents.id));
  }

  return { attach };
}

export type WebviewContextMenuController = ReturnType<typeof createWebviewContextMenuController>;
