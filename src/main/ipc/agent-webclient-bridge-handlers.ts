import type { App, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  AGENT_WEBCLIENT_BRIDGE_VERSION,
  AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
  isAgentWebclientBridgeVersion,
  isPlainBridgeRecord,
  type AgentPlatformRequestFrame,
  type AgentWebclientBridgeErrorCode,
  type AgentWebclientBridgeFailure,
  type AgentWebclientPlatformWsCloseInput,
  type AgentWebclientPlatformWsEvent,
  type AgentWebclientPlatformWsOpenInput,
  type AgentWebclientPlatformWsSendInput,
  type AgentWebclientRunOwner,
  type AgentWebclientSurfaceKind,
  type WorkPanelBridgeResult,
  type WorkPanelItemTargetInput,
  type WorkPanelOpenItemInput,
} from "../../shared/contracts";
import type { AgentAuthIssueResult, ServiceState } from "../../shared/contracts";
import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../browser-surface-registry";
import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../realtime/realtime-broker";
import {
  COPILOT_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "../../shared/surface-identity";

const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const MAX_SERIALIZED_FRAME_BYTES = 8 * 1024 * 1024;
const SURFACE_REGISTRATION_WAIT_MS = 1_500;

const LIVE_CHAT_SURFACE_IDS = new Set([
  MAIN_CHAT_SURFACE_ID,
  COPILOT_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
]);

const LIVE_REQUEST_TYPES = new Set([
  "/api/query",
  "/api/attach",
  "/api/btw",
]);

type SurfaceContext = {
  sender: WebContents;
  target: RegisteredWebviewSurfaceTarget;
  kind: AgentWebclientSurfaceKind;
};

type StreamBinding = {
  localId: string;
  type: "/api/query" | "/api/attach" | "/api/btw";
  chatId: string;
  runId: string;
  owner: AgentWebclientRunOwner | null;
  lastSeq: number;
  suppressed: boolean;
  detachSent: boolean;
  virtual: boolean;
  visibleRegistered: boolean;
  sourceId: string;
  unsubscribe: (() => void) | null;
};

type LogicalSocket = {
  key: string;
  socketId: string;
  sender: WebContents;
  consumerId: string;
  requestIds: Set<string>;
  streams: Map<string, StreamBinding>;
  detachBarrier: Promise<void>;
  unsubscribePush: (() => void) | null;
  retiring: boolean;
  closed: boolean;
};

function failure(code: AgentWebclientBridgeErrorCode, message: string): AgentWebclientBridgeFailure {
  return { ok: false, error: { code, message } };
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function trustedKind(value: unknown): AgentWebclientSurfaceKind | null {
  return value === "agent-chat" ||
    value === "agent-copilot" ||
    value === "agent-overview" ||
    value === "agent-debug" ||
    value === "agent-btw" ||
    value === "agent-project" ||
    value === "agent-management"
    ? value
    : null;
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function mayAwaitSurfaceRegistration(
  sender: WebContents,
  isTrustedSession: (sender: WebContents) => boolean,
) {
  return !sender.isDestroyed() &&
    sender.getType() === "webview" &&
    isTrustedSession(sender);
}

function authorizeSurface(
  sender: WebContents,
  browserSurfaces: BrowserSurfaceRegistry,
  isTrustedSession: (sender: WebContents) => boolean,
): SurfaceContext | AgentWebclientBridgeFailure {
  const target = browserSurfaces.resolveWebviewSurfaceTarget(sender.id);
  const kind = trustedKind(target?.surfaceType);
  if (
    !target ||
    target.webContentsId !== sender.id ||
    !kind ||
    target.serviceId !== "agent-webclient" ||
    !isTrustedSession(sender) ||
    sender.isDestroyed() ||
    sender.getType() !== "webview" ||
    !sameOrigin(sender.getURL(), target.currentUrl)
  ) {
    return failure("surface_unavailable", "sender is not a trusted Agent WebClient surface");
  }
  return { sender, target, kind };
}

function socketKey(senderId: number, socketId: string) {
  return `${senderId}:${socketId}`;
}

type PlatformFrameRecord = Record<string, unknown>;

type FrameErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
};

function frameError(
  id: string,
  code: AgentWebclientBridgeErrorCode,
  message: string,
  options: FrameErrorOptions = {},
): PlatformFrameRecord {
  const status = code === "capability_denied" ? 403
    : code === "duplicate_id" ? 409
      : code === "connection_unavailable" ? 503
        : 400;
  const structuredError = {
    code,
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.details ? { details: options.details } : {}),
  };
  const hasMetadata = options.retryable !== undefined || Boolean(options.details);
  return {
    frame: "error",
    id,
    type: code,
    code: status,
    status,
    msg: message,
    data: hasMetadata
      ? { ...structuredError, error: structuredError }
      : structuredError,
  };
}

function frameErrorOptions(error: unknown): FrameErrorOptions {
  if (!isPlainBridgeRecord(error)) return {};
  return {
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(isPlainBridgeRecord(error.details) ? { details: error.details } : {}),
  };
}

function bridgeErrorCode(error: unknown): AgentWebclientBridgeErrorCode {
  const candidate = error instanceof Error ? error.name : "protocol_error";
  return [
    "bridge_unavailable", "version_mismatch", "invalid_request", "duplicate_id",
    "connection_unavailable", "connection_lost_before_acceptance", "capability_denied",
    "surface_unavailable", "target_unavailable", "ambiguous_action_target",
    "unsupported_in_current_view", "unsupported_native_surface", "seq_expired",
    "replay_required", "protocol_error", "backpressure",
  ].includes(candidate) ? candidate as AgentWebclientBridgeErrorCode : "protocol_error";
}

function parseRequestFrame(serialized: string): AgentPlatformRequestFrame | null {
  if (!serialized || Buffer.byteLength(serialized) > MAX_SERIALIZED_FRAME_BYTES) return null;
  try {
    const frame = JSON.parse(serialized) as Record<string, unknown>;
    if (
      frame.frame !== "request" ||
      !readText(frame.id) ||
      !readText(frame.type) ||
      (frame.payload !== undefined && !isPlainBridgeRecord(frame.payload))
    ) {
      return null;
    }
    return {
      frame: "request",
      id: readText(frame.id),
      type: readText(frame.type),
      ...(frame.payload === undefined ? {} : { payload: frame.payload }),
    };
  } catch {
    return null;
  }
}

function readOwner(value: unknown): AgentWebclientRunOwner | null {
  if (!isPlainBridgeRecord(value)) return null;
  const agentKey = readText(value.agentKey);
  const teamId = readText(value.teamId);
  if (Boolean(agentKey) === Boolean(teamId)) return null;
  return agentKey ? { kind: "agent", agentKey } : { kind: "team", teamId };
}

function updateBindingFromFrame(binding: StreamBinding, frame: PlatformFrameRecord) {
  const event = isPlainBridgeRecord(frame.event) ? frame.event : null;
  if (event) {
    binding.chatId = readText(event.chatId) || binding.chatId;
    binding.runId = readText(event.runId) || binding.runId;
    binding.owner = readOwner(event) || binding.owner;
    const seq = Number(event.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) binding.lastSeq = Math.max(binding.lastSeq, seq);
  }
  const lastSeq = Number(frame.lastSeq);
  if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
    binding.lastSeq = Math.max(binding.lastSeq, lastSeq);
  }
}

export function registerAgentWebclientBridgeIpcHandlers(ipcMain: any, options: {
  app: App;
  browserSurfaces: BrowserSurfaceRegistry;
  isTrustedAgentWebclientSession(sender: WebContents): boolean;
  realtimeBroker: RealtimeBroker;
  getServiceState(app: App, serviceId: string): Promise<ServiceState>;
  issueAccessToken(app: App, reason: "missing" | "unauthorized"): Promise<AgentAuthIssueResult>;
  dispatchWorkPanel(input: {
    action: "openItem" | "activateItem" | "closeItem";
    ownerChatId: string;
    args: Record<string, unknown>;
  }): Promise<WorkPanelBridgeResult>;
}) {
  const sockets = new Map<string, LogicalSocket>();
  const senderSocketKeys = new Map<number, Set<string>>();
  const installedCleanup = new Set<number>();
  let activeLiveSocketKey: string | null = null;

  const availability = async () => {
    const state = await options.getServiceState(options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = state.status === "running"
      ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
      : "";
    if (!baseUrl) throw new Error("Agent Platform is unavailable");
    const tokenResult = await options.issueAccessToken(options.app, "missing");
    const token = tokenResult.ok ? tokenResult.token.trim() : "";
    if (!token) throw new Error(tokenResult.message || "Agent Platform token is unavailable");
    return { baseUrl, token };
  };

  const sendEvent = (socket: LogicalSocket, event: AgentWebclientPlatformWsEvent) => {
    if (socket.closed || socket.sender.isDestroyed()) return;
    socket.sender.send(AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL, event);
    const target = options.browserSurfaces.resolveWebviewSurfaceTarget(socket.sender.id);
    options.realtimeBroker.appendDebugTrace({
      layer: "surface-bridge",
      direction: "desktop-to-surface",
      data: event.type === "message" ? JSON.parse(event.data) : event,
      surfaceId: target?.surfaceId,
      webContentsId: socket.sender.id,
      surfaceKind: target?.surfaceType,
      surfaceRole: target?.surfaceRole,
      surfaceLevel: target?.surfaceLevel,
      parentSurfaceId: target?.parentSurfaceId,
      interaction: target?.interaction,
      route: target?.pageRoute || socket.sender.getURL(),
    });
  };

  const sendFrame = (socket: LogicalSocket, frame: PlatformFrameRecord) => {
    sendEvent(socket, { socketId: socket.socketId, type: "message", data: JSON.stringify(frame) });
  };

  const sendSocketError = (socket: LogicalSocket, message: string) => {
    sendEvent(socket, { socketId: socket.socketId, type: "error", message });
  };

  const closeSocket = (socket: LogicalSocket, code = 1000, reason = "logical socket closed") => {
    if (socket.closed) return;
    socket.closed = true;
    socket.unsubscribePush?.();
    socket.unsubscribePush = null;
    for (const binding of socket.streams.values()) {
      binding.unsubscribe?.();
      binding.unsubscribe = null;
      if (binding.visibleRegistered) options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
    }
    options.realtimeBroker.cleanupConsumer(socket.consumerId);
    sockets.delete(socket.key);
    const keys = senderSocketKeys.get(socket.sender.id);
    keys?.delete(socket.key);
    if (keys?.size === 0) senderSocketKeys.delete(socket.sender.id);
    if (activeLiveSocketKey === socket.key) activeLiveSocketKey = null;
    if (!socket.sender.isDestroyed()) {
      socket.sender.send(AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL, {
        socketId: socket.socketId,
        type: "close",
        code,
        reason,
      } satisfies AgentWebclientPlatformWsEvent);
    }
  };

  const detachBinding = async (socket: LogicalSocket, binding: StreamBinding) => {
    if (binding.detachSent) return;
    binding.detachSent = true;
    if (binding.virtual) {
      binding.unsubscribe?.();
      binding.unsubscribe = null;
      return;
    }
    if (binding.visibleRegistered) {
      options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
      binding.visibleRegistered = false;
    }
    if (!binding.runId || !binding.owner) return;
    const { baseUrl, token } = await availability();
    await options.realtimeBroker.forwardRequest({
      baseUrl,
      token,
      localId: `surface-detach-${randomUUID()}`,
      consumerId: `${socket.consumerId}:lease-detach`,
      type: "/api/detach",
      payload: {
        runId: binding.runId,
        ...(binding.owner.kind === "agent"
          ? { agentKey: binding.owner.agentKey }
          : { teamId: binding.owner.teamId }),
        reason: "surface_inactive",
      },
      onFrame: () => undefined,
      onError: () => undefined,
    });
  };

  const activateLiveSocket = async (socket: LogicalSocket) => {
    if (activeLiveSocketKey === socket.key) {
      await socket.detachBarrier;
      const pending = [...socket.streams.values()]
        .filter((binding) => binding.suppressed && !binding.detachSent && binding.runId && binding.owner)
        .map((binding) => detachBinding(socket, binding).catch(() => undefined));
      await Promise.all(pending);
      return;
    }
    const previous = activeLiveSocketKey ? sockets.get(activeLiveSocketKey) : null;
    activeLiveSocketKey = socket.key;
    if (!previous) return;
    await previous.detachBarrier;
    const pending: Promise<void>[] = [];
    for (const binding of previous.streams.values()) {
      binding.suppressed = true;
      if (binding.runId && binding.owner) {
        pending.push(detachBinding(previous, binding).catch(() => undefined));
      }
    }
    await Promise.all(pending);
  };

  const cleanupSender = (senderId: number) => {
    for (const key of [...(senderSocketKeys.get(senderId) ?? [])]) {
      const socket = sockets.get(key);
      if (socket) closeSocket(socket, 1001, "surface destroyed");
    }
    installedCleanup.delete(senderId);
  };

  const installSenderCleanup = (sender: WebContents) => {
    if (installedCleanup.has(sender.id)) return;
    installedCleanup.add(sender.id);
    sender.once("destroyed", () => cleanupSender(sender.id));
    sender.once("render-process-gone", () => cleanupSender(sender.id));
  };

  const finishRetiringSocket = (socket: LogicalSocket) => {
    if (!socket.retiring || socket.streams.size > 0) return;
    closeSocket(socket, 1000, "logical socket superseded");
  };

  const retireSocket = async (socket: LogicalSocket) => {
    if (socket.closed) return;
    socket.retiring = true;
    socket.unsubscribePush?.();
    socket.unsubscribePush = null;
    await socket.detachBarrier;
    const detachable = [...socket.streams.values()].filter((binding) => {
      binding.suppressed = true;
      return Boolean(binding.runId && binding.owner);
    });
    await Promise.all(detachable.map(async (binding) => {
      await detachBinding(socket, binding).catch(() => undefined);
      socket.requestIds.delete(binding.localId);
      socket.streams.delete(binding.localId);
    }));
    finishRetiringSocket(socket);
  };

  const resolveSocket = (sender: WebContents, socketId: string) =>
    sockets.get(socketKey(sender.id, socketId)) ?? null;

  const handleOpen = async (event: any, input: AgentWebclientPlatformWsOpenInput) => {
    const socketId = readText(input?.socketId);
    if (!socketId) return;
    const initialTarget = options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id);
    let context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if (
      "ok" in context &&
      !initialTarget &&
      mayAwaitSurfaceRegistration(event.sender, options.isTrustedAgentWebclientSession)
    ) {
      const abortController = new AbortController();
      const abortWait = () => abortController.abort();
      event.sender.once("destroyed", abortWait);
      event.sender.once("render-process-gone", abortWait);
      try {
        await options.browserSurfaces.waitForWebviewSurfaceTarget(
          event.sender.id,
          SURFACE_REGISTRATION_WAIT_MS,
          abortController.signal,
        );
      } finally {
        event.sender.removeListener("destroyed", abortWait);
        event.sender.removeListener("render-process-gone", abortWait);
      }
      context = authorizeSurface(
        event.sender,
        options.browserSurfaces,
        options.isTrustedAgentWebclientSession,
      );
    }
    if ("ok" in context) {
      if (event.sender.isDestroyed()) return;
      event.sender.send(AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL, {
        socketId,
        type: "error",
        message: context.error.message,
      } satisfies AgentWebclientPlatformWsEvent);
      event.sender.send(AGENT_WEBCLIENT_PLATFORM_WS_EVENT_CHANNEL, {
        socketId,
        type: "close",
        code: 1008,
        reason: context.error.code,
      } satisfies AgentWebclientPlatformWsEvent);
      return;
    }
    const key = socketKey(event.sender.id, socketId);
    const previousSockets = [...(senderSocketKeys.get(event.sender.id) ?? [])]
      .map((previousKey) => sockets.get(previousKey))
      .filter((previous): previous is LogicalSocket => Boolean(previous));
    await Promise.all(previousSockets.map(retireSocket));
    const socket: LogicalSocket = {
      key,
      socketId,
      sender: event.sender,
      consumerId: `agent-webclient-frame-port:${key}`,
      requestIds: new Set(),
      streams: new Map(),
      detachBarrier: Promise.resolve(),
      unsubscribePush: null,
      retiring: false,
      closed: false,
    };
    sockets.set(key, socket);
    const keys = senderSocketKeys.get(event.sender.id) ?? new Set<string>();
    keys.add(key);
    senderSocketKeys.set(event.sender.id, keys);
    installSenderCleanup(event.sender);
    try {
      const { baseUrl, token } = await availability();
      await options.realtimeBroker.ensureConnected(baseUrl, token);
      if (socket.closed) return;
      socket.unsubscribePush = options.realtimeBroker.subscribePush({
        types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES],
        kind: "surface",
        consumerId: socket.consumerId,
        onPush: (frame) => sendFrame(socket, frame),
      });
      sendEvent(socket, { socketId, type: "open" });
    } catch (error) {
      sendSocketError(socket, error instanceof Error ? error.message : String(error));
      closeSocket(socket, 1011, "Agent Platform unavailable");
    }
  };

  const handleSend = async (event: any, input: AgentWebclientPlatformWsSendInput) => {
    const socket = resolveSocket(event.sender, readText(input?.socketId));
    if (!socket || socket.closed) return;
    const frame = parseRequestFrame(typeof input?.data === "string" ? input.data : "");
    const fallbackId = (() => {
      try {
        return readText(JSON.parse(String(input?.data || "")).id);
      } catch {
        return "";
      }
    })();
    if (!frame) {
      sendFrame(socket, frameError(fallbackId, "invalid_request", "Platform request frame is invalid"));
      return;
    }
    if (socket.requestIds.has(frame.id)) {
      sendFrame(socket, frameError(frame.id, "duplicate_id", "request id is already active on this logical socket"));
      return;
    }
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) {
      sendFrame(socket, frameError(frame.id, "surface_unavailable", context.error.message));
      return;
    }
    // Trusted one-shot Platform requests share the broker without acquiring the live Run lease.
    // Only query/attach/BTW streams require the additional active-surface authorization below.
    const isLive = LIVE_REQUEST_TYPES.has(frame.type);
    const payload = isPlainBridgeRecord(frame.payload) ? frame.payload : {};
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    const isReadonlyVirtualAttach = frame.type === "/api/attach" &&
      (context.kind === "agent-overview" || context.kind === "agent-debug") &&
      context.target.surfaceRole === (context.kind === "agent-overview" ? "overview" : "debug") &&
      context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
      Boolean(ownerChatId);
    if (isLive) {
      const isLiveChat = LIVE_CHAT_SURFACE_IDS.has(context.target.surfaceId);
      const isBTW = context.kind === "agent-btw" &&
        context.target.surfaceRole === "btw" &&
        context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
        Boolean(context.target.ownerChatId);
      const allowedSurface = frame.type === "/api/query"
        ? isLiveChat
        : frame.type === "/api/btw" || frame.type === "/api/attach"
          ? isLiveChat || isBTW || isReadonlyVirtualAttach
          : false;
      if (!allowedSurface || !context.target.active) {
        sendFrame(socket, frameError(frame.id, "surface_unavailable", "only the active Chat or BTW surface may open this live Run stream"));
        return;
      }
      if (!isReadonlyVirtualAttach) await activateLiveSocket(socket);
    }
    if (frame.type === "/api/detach" && (context.kind === "agent-overview" || context.kind === "agent-debug")) {
      const runId = readText(payload.runId);
      const virtualBindings = [...socket.streams.values()].filter((candidate) =>
        candidate.virtual && candidate.runId === runId,
      );
      for (const candidate of virtualBindings) {
        candidate.detachSent = true;
        candidate.unsubscribe?.();
        candidate.unsubscribe = null;
        socket.requestIds.delete(candidate.localId);
        socket.streams.delete(candidate.localId);
      }
      sendFrame(socket, {
        frame: "response",
        id: frame.id,
        type: frame.type,
        code: 0,
        data: {},
      });
      return;
    }
    const explicitDetachBindings = frame.type === "/api/detach"
      ? [...socket.streams.values()].filter((candidate) =>
          !candidate.detachSent &&
          Boolean(readText(payload.runId)) &&
          candidate.runId === readText(payload.runId)
        )
      : [];
    let releaseDetachBarrier: (() => void) | null = null;
    if (explicitDetachBindings.length > 0) {
      const pendingWrite = new Promise<void>((resolve) => {
        releaseDetachBarrier = resolve;
      });
      socket.detachBarrier = socket.detachBarrier.then(() => pendingWrite);
      for (const candidate of explicitDetachBindings) {
        candidate.suppressed = true;
        candidate.detachSent = true;
        if (candidate.visibleRegistered) {
          options.realtimeBroker.releaseForwardedVisibleRun(candidate.sourceId);
          candidate.visibleRegistered = false;
        }
      }
    }
    const finishExplicitDetachWrite = (written: boolean) => {
      if (!written) {
        for (const candidate of explicitDetachBindings) {
          candidate.detachSent = false;
        }
      }
      releaseDetachBarrier?.();
      releaseDetachBarrier = null;
    };
    let connection: { baseUrl: string; token: string };
    try {
      connection = await availability();
    } catch (error) {
      finishExplicitDetachWrite(false);
      sendFrame(socket, frameError(
        frame.id,
        "connection_unavailable",
        error instanceof Error ? error.message : String(error),
      ));
      return;
    }
    const { baseUrl, token } = connection;
    socket.requestIds.add(frame.id);
    const binding: StreamBinding | null = isLive
      ? {
          localId: frame.id,
          type: frame.type as "/api/query" | "/api/attach" | "/api/btw",
          chatId: readText(payload.chatId) || ownerChatId,
          runId: readText(payload.runId),
          owner: readOwner(payload),
          lastSeq: Math.max(0, Number(payload.lastSeq) || 0),
          suppressed: false,
          detachSent: false,
          virtual: isReadonlyVirtualAttach,
          visibleRegistered: false,
          sourceId: `${socket.key}:${frame.id}`,
          unsubscribe: null,
        }
      : null;
    if (binding) socket.streams.set(frame.id, binding);
    options.realtimeBroker.appendDebugTrace({
      layer: "surface-bridge",
      direction: "surface-to-desktop",
      data: frame,
      surfaceId: context.target.surfaceId,
      webContentsId: event.sender.id,
      surfaceKind: context.kind,
      surfaceRole: context.target.surfaceRole,
      surfaceLevel: context.target.surfaceLevel,
      parentSurfaceId: context.target.parentSurfaceId,
      interaction: context.target.interaction,
      route: context.target.pageRoute || event.sender.getURL(),
    });
    if (binding?.virtual) {
      try {
        if (!binding.runId || !binding.chatId || !binding.owner) {
          throw Object.assign(new Error("visible Run identity is incomplete"), { name: "invalid_request" });
        }
        const subscription = options.realtimeBroker.subscribeVisibleRun({
          runId: binding.runId,
          chatId: binding.chatId,
          lastSeq: binding.lastSeq,
          owner: binding.owner,
          kind: "surface",
          consumerId: socket.consumerId,
          surfaceId: `surface:${event.sender.id}`,
          onEvent: (runEvent) => sendFrame(socket, {
            frame: "stream",
            id: binding.localId,
            event: runEvent,
          }),
          onComplete: (completed) => {
            binding.unsubscribe?.();
            binding.unsubscribe = null;
            sendFrame(socket, {
              frame: "stream",
              id: binding.localId,
              reason: completed.reason,
              ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
            });
            socket.requestIds.delete(binding.localId);
            socket.streams.delete(binding.localId);
          },
          onError: (error) => {
            binding.unsubscribe?.();
            binding.unsubscribe = null;
            sendFrame(socket, frameError(
              binding.localId,
              bridgeErrorCode(error),
              error.message,
              frameErrorOptions(error),
            ));
            socket.requestIds.delete(binding.localId);
            socket.streams.delete(binding.localId);
          },
        });
        binding.unsubscribe = subscription.unsubscribe;
        await subscription.ready;
      } catch (error) {
        socket.requestIds.delete(frame.id);
        socket.streams.delete(frame.id);
        sendFrame(socket, frameError(
          frame.id,
          bridgeErrorCode(error),
          error instanceof Error ? error.message : String(error),
          frameErrorOptions(error),
        ));
      }
      return;
    }
    if (
      binding?.type === "/api/attach" &&
      context.target.surfaceId === MAIN_CHAT_SURFACE_ID &&
      binding.chatId && binding.runId && binding.owner
    ) {
      try {
        options.realtimeBroker.beginForwardedVisibleRun({
          sourceId: binding.sourceId,
          chatId: binding.chatId,
          runId: binding.runId,
          owner: binding.owner,
          lastSeq: binding.lastSeq,
          primarySurfaceId: `surface:${event.sender.id}`,
        });
        binding.visibleRegistered = true;
      } catch {
        // Main Chat remains authoritative even when its read-only mirror cannot bind.
      }
    }
    try {
      await options.realtimeBroker.forwardRequest({
        baseUrl,
        token,
        localId: frame.id,
        consumerId: socket.consumerId,
        type: frame.type,
        payload,
        stream: isLive,
        onFrame: (upstreamFrame) => {
          if (binding) {
            const previousLastSeq = binding.lastSeq;
            updateBindingFromFrame(binding, upstreamFrame);
            const shouldMirrorVisibleRun =
              context.target.surfaceId === MAIN_CHAT_SURFACE_ID &&
              (binding.type === "/api/query" || binding.type === "/api/attach") &&
              Boolean(binding.chatId && binding.runId && binding.owner);
            if (shouldMirrorVisibleRun && !binding.visibleRegistered) {
              try {
                options.realtimeBroker.beginForwardedVisibleRun({
                  sourceId: binding.sourceId,
                  chatId: binding.chatId,
                  runId: binding.runId,
                  owner: binding.owner!,
                  lastSeq: previousLastSeq,
                  primarySurfaceId: `surface:${event.sender.id}`,
                });
                binding.visibleRegistered = true;
              } catch {
                // Main Chat remains authoritative even when its read-only mirror cannot bind.
              }
            }
            if (binding.visibleRegistered && isPlainBridgeRecord(upstreamFrame.event)) {
              try {
                options.realtimeBroker.appendForwardedVisibleRunEvent({
                  sourceId: binding.sourceId,
                  runId: binding.runId,
                  event: upstreamFrame.event,
                });
              } catch {
                options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
                binding.visibleRegistered = false;
              }
            }
            if (binding.suppressed && !binding.detachSent && binding.runId && binding.owner) {
              void detachBinding(socket, binding).catch(() => undefined).finally(() => {
                if (!socket.retiring) return;
                socket.requestIds.delete(binding.localId);
                socket.streams.delete(binding.localId);
                finishRetiringSocket(socket);
              });
            }
          }
          const frameKind = readText(upstreamFrame.frame);
          const terminal = frameKind === "error" ||
            frameKind === "response" ||
            (frameKind === "stream" && Boolean(readText(upstreamFrame.reason)));
          if (binding?.visibleRegistered && terminal) {
            if (frameKind === "stream" && readText(upstreamFrame.reason)) {
              options.realtimeBroker.completeForwardedVisibleRun({
                sourceId: binding.sourceId,
                runId: binding.runId,
                reason: readText(upstreamFrame.reason),
                ...(typeof upstreamFrame.lastSeq === "number" ? { lastSeq: upstreamFrame.lastSeq } : {}),
              });
            } else {
              options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
            }
            binding.visibleRegistered = false;
          }
          if (!binding?.suppressed || terminal) sendFrame(socket, upstreamFrame);
          if (terminal) {
            socket.requestIds.delete(frame.id);
            socket.streams.delete(frame.id);
            finishRetiringSocket(socket);
          }
        },
        onError: (error) => {
          if (binding?.visibleRegistered) {
            options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
            binding.visibleRegistered = false;
          }
          socket.requestIds.delete(frame.id);
          socket.streams.delete(frame.id);
          sendFrame(socket, frameError(frame.id, "connection_unavailable", error.message));
          finishRetiringSocket(socket);
        },
      });
      finishExplicitDetachWrite(true);
    } catch (error) {
      finishExplicitDetachWrite(false);
      socket.requestIds.delete(frame.id);
      socket.streams.delete(frame.id);
      sendFrame(socket, frameError(
        frame.id,
        "connection_unavailable",
        error instanceof Error ? error.message : String(error),
      ));
      finishRetiringSocket(socket);
    }
  };

  const handleClose = (event: any, input: AgentWebclientPlatformWsCloseInput) => {
    const socket = resolveSocket(event.sender, readText(input?.socketId));
    if (!socket) return;
    for (const binding of socket.streams.values()) {
      binding.suppressed = true;
      void detachBinding(socket, binding).catch(() => undefined);
    }
    closeSocket(
      socket,
      Number.isSafeInteger(input?.code) ? Number(input.code) : 1000,
      readText(input?.reason) || "logical socket closed",
    );
  };

  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_CHANNEL, (event: any, input: AgentWebclientPlatformWsOpenInput) => {
    void handleOpen(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_WS_SEND_CHANNEL, (event: any, input: AgentWebclientPlatformWsSendInput) => {
    void handleSend(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_CHANNEL, handleClose);

  const handleWorkPanelInvoke = async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId) return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    const capabilities = [
      ...(context.kind === "agent-chat" || context.kind === "agent-copilot" || context.kind === "agent-overview"
        ? ["workpanel.open" as const]
        : []),
      "workpanel.activate" as const,
      "workpanel.close" as const,
    ];
    if (method === "getCapabilities") return { ok: true, capabilities };
    const capabilityAllowed = method === "openItem"
      ? capabilities.includes("workpanel.open")
      : method === "activateItem" || method === "closeItem";
    if (!capabilityAllowed) return failure("capability_denied", `${context.kind} cannot call ${method}`);
    const input = record.input as WorkPanelOpenItemInput | WorkPanelItemTargetInput;
    if (!isPlainBridgeRecord(input) || !isAgentWebclientBridgeVersion(input.version)) {
      return failure("version_mismatch", `Desktop host bridge requires version ${AGENT_WEBCLIENT_BRIDGE_VERSION}`);
    }
    const args = method === "openItem"
      ? { descriptor: (input as WorkPanelOpenItemInput).descriptor }
      : { itemId: (input as WorkPanelItemTargetInput).itemId };
    return options.dispatchWorkPanel({
      action: method as "openItem" | "activateItem" | "closeItem",
      ownerChatId,
      args,
    });
  };

  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, handleWorkPanelInvoke);

  return {
    cleanupSender,
    getDiagnostics: () => ({
      registeredSenderCount: senderSocketKeys.size,
      logicalSocketCount: sockets.size,
      pendingRequestCount: [...sockets.values()].reduce((sum, socket) => sum + socket.requestIds.size, 0),
      activeStreamCount: [...sockets.values()].reduce((sum, socket) => sum + socket.streams.size, 0),
      activeLiveSurfaceCount: activeLiveSocketKey ? 1 : 0,
      activeLiveSocketKey,
      surfaces: [...sockets.values()].flatMap((socket) => {
        const target = options.browserSurfaces.resolveWebviewSurfaceTarget(socket.sender.id);
        if (!target) return [];
        return [{
          surfaceId: target.surfaceId,
          webContentsId: socket.sender.id,
          kind: trustedKind(target.surfaceType) || "agent-chat",
          surfaceRole: target.surfaceRole,
          surfaceLevel: target.surfaceLevel,
          parentSurfaceId: target.parentSurfaceId,
          interaction: target.interaction,
          active: Boolean(target.active),
          ownerChatId: target.ownerChatId,
          route: target.pageRoute || socket.sender.getURL(),
          socketId: socket.socketId,
          pendingRequestCount: socket.requestIds.size,
          activeStreamCount: socket.streams.size,
        }];
      }),
    }),
  };
}
