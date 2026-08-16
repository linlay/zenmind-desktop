import type { App, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  AGENT_WEBCLIENT_BRIDGE_VERSION,
  AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL,
  AGENT_WEBCLIENT_REALTIME_MESSAGE_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
  isAgentWebclientBridgeVersion,
  isPlainBridgeRecord,
  type AgentWebclientBridgeErrorCode,
  type AgentWebclientBridgeFailure,
  type AgentWebclientBridgeHello,
  type AgentWebclientApiResponse,
  type AgentWebclientDeliveryTarget,
  type AgentWebclientRealtimeMessage,
  type AgentWebclientRealtimeRequest,
  type AgentWebclientRealtimeDetachInput,
  type AgentWebclientRealtimeSubscription,
  type AgentWebclientRunOwner,
  type AgentWebclientSurfaceCapability,
  type AgentWebclientSurfaceKind,
  type WorkPanelBridgeResult,
  type WorkPanelItemTargetInput,
  type WorkPanelOpenItemInput,
} from "../../shared/contracts";
import type { AgentAuthIssueResult, ServiceState } from "../../shared/contracts";
import { requireEpochMillis, type EpochMilliseconds } from "../../shared/time-contract";
import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../browser-surface-registry";
import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../realtime/realtime-broker";

const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const MAX_BATCH_EVENTS = 32;
const MAX_BATCH_BYTES = 64 * 1024;
const BATCH_DELAY_MS = 16;

type SurfaceContext = {
  sender: WebContents;
  target: RegisteredWebviewSurfaceTarget;
  kind: AgentWebclientSurfaceKind;
  capabilities: Set<AgentWebclientSurfaceCapability>;
};

type LocalSubscription = {
  senderId: number;
  consumerId: string;
  unsubscribe(): void;
};

type BatchQueue = {
  sender: WebContents;
  delivery: AgentWebclientDeliveryTarget;
  chatId: string;
  runId: string;
  bindingEpoch: number;
  events: Array<Record<string, unknown>>;
  bytes: number;
  lastSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type SurfaceDebugState = {
  surfaceId: string;
  webContentsId: number;
  kind: AgentWebclientSurfaceKind;
  active: boolean;
  ownerChatId?: string;
  route: string;
  updatedAt: EpochMilliseconds;
};

const CAPABILITIES: Record<AgentWebclientSurfaceKind, readonly AgentWebclientSurfaceCapability[]> = {
  "agent-chat": [
    "run.query", "run.attach", "run.control", "run.visible.read", "push.subscribe",
    "workpanel.open", "workpanel.activate", "workpanel.close", "inbound.action.owner",
  ],
  "agent-copilot": [
    "run.query", "run.attach", "run.control", "run.visible.read", "push.subscribe",
    "workpanel.open", "workpanel.activate", "workpanel.close", "inbound.action.owner",
  ],
  "agent-summary": [
    "run.attach", "run.visible.read", "push.subscribe",
    "workpanel.open", "workpanel.activate", "workpanel.close",
  ],
  "agent-debug": ["run.attach", "run.visible.read", "push.subscribe", "workpanel.activate", "workpanel.close"],
  "agent-project": ["push.subscribe", "workpanel.open", "workpanel.activate", "workpanel.close"],
};

function failure(code: AgentWebclientBridgeErrorCode, message: string): AgentWebclientBridgeFailure {
  return { ok: false, error: { code, message } };
}

function errorCode(error: unknown): AgentWebclientBridgeErrorCode {
  const candidate = error instanceof Error
    ? (error.name || error.message.split(":", 1)[0])
    : "protocol_error";
  return [
    "bridge_unavailable", "version_mismatch", "invalid_request", "duplicate_id",
    "connection_unavailable", "connection_lost_before_acceptance", "capability_denied",
    "surface_unavailable", "target_unavailable", "ambiguous_action_target",
    "unsupported_in_current_view", "unsupported_native_surface", "seq_expired",
    "replay_required", "protocol_error", "backpressure",
  ].includes(candidate) ? candidate as AgentWebclientBridgeErrorCode : "protocol_error";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function trustedKind(value: unknown): AgentWebclientSurfaceKind | null {
  return value === "agent-chat" ||
    value === "agent-copilot" ||
    value === "agent-summary" ||
    value === "agent-debug" ||
    value === "agent-project"
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
  return {
    sender,
    target,
    kind,
    capabilities: new Set(CAPABILITIES[kind]),
  };
}

function requireCapability(
  context: SurfaceContext,
  capability: AgentWebclientSurfaceCapability,
) {
  return context.capabilities.has(capability)
    ? null
    : failure("capability_denied", `${context.kind} does not have ${capability}`);
}

function validateVersion(input: unknown) {
  return isPlainBridgeRecord(input) && isAgentWebclientBridgeVersion(input.version)
    ? null
    : failure("version_mismatch", `Desktop bridge requires version ${AGENT_WEBCLIENT_BRIDGE_VERSION}`);
}

function ensureSourceChat(context: SurfaceContext, chatId: string) {
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  if (ownerChatId && ownerChatId !== chatId.trim()) {
    return failure("capability_denied", "Run chat does not match the trusted surface owner");
  }
  if ((context.kind === "agent-chat" || context.kind === "agent-summary" || context.kind === "agent-debug") && !ownerChatId) {
    return failure("target_unavailable", "trusted surface owner chat is unavailable");
  }
  return null;
}

function ensureQuerySourceChat(context: SurfaceContext, chatId: string | undefined) {
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  const requestedChatId = chatId?.trim() || "";
  if (ownerChatId) {
    return ownerChatId === requestedChatId
      ? null
      : failure("capability_denied", "Query chat does not match the trusted surface owner");
  }
  if (
    !requestedChatId &&
    context.target.active &&
    (context.kind === "agent-chat" || context.kind === "agent-copilot")
  ) {
    return null;
  }
  return failure("target_unavailable", "A new query requires an active ownerless Agent or Copilot surface");
}

function readOwner(value: unknown): AgentWebclientRunOwner | null {
  if (!isPlainBridgeRecord(value)) return null;
  if (value.kind === "agent" && typeof value.agentKey === "string" && value.agentKey.trim()) {
    return { kind: "agent", agentKey: value.agentKey.trim() };
  }
  if (value.kind === "team" && typeof value.teamId === "string" && value.teamId.trim()) {
    return { kind: "team", teamId: value.teamId.trim() };
  }
  return null;
}

function ownerPayload(owner: AgentWebclientRunOwner) {
  return owner.kind === "agent"
    ? { agentKey: owner.agentKey }
    : { teamId: owner.teamId };
}

function deliveryKey(target: AgentWebclientDeliveryTarget) {
  return target.kind === "operation"
    ? `operation:${target.operationId}`
    : `subscription:${target.subscriptionId}`;
}

function apiResponseFromFrame(frame: Record<string, unknown>): AgentWebclientApiResponse {
  const isError = frame.frame === "error";
  const frameCode = typeof frame.code === "number" && Number.isFinite(frame.code)
    ? Math.trunc(frame.code)
    : isError
      ? 500
      : 0;
  return {
    status: isError ? frameCode : 200,
    code: frameCode,
    msg: typeof frame.msg === "string" ? frame.msg : isError ? "request failed" : "success",
    ...(frame.data === undefined ? {} : { data: frame.data }),
  };
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
  const subscriptions = new Map<string, LocalSubscription>();
  const operations = new Map<string, { senderId: number; kind: "query" | "control" }>();
  const batchQueues = new Map<string, BatchQueue>();
  const installedCleanup = new Set<number>();
  const connectionUnsubscribers = new Map<number, () => void>();
  const surfaceDebugStates = new Map<number, SurfaceDebugState>();
  let bindingEpoch = 0;

  const rememberSurface = (context: SurfaceContext) => {
    surfaceDebugStates.set(context.sender.id, {
      surfaceId: context.target.surfaceId,
      webContentsId: context.sender.id,
      kind: context.kind,
      active: context.target.active,
      ...(context.target.ownerChatId ? { ownerChatId: context.target.ownerChatId } : {}),
      route: context.target.pageRoute || context.sender.getURL(),
      updatedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugSurface.updatedAt"),
    });
  };

  const recordSurfaceTrace = (
    context: SurfaceContext,
    direction: "surface-to-desktop" | "desktop-to-surface",
    data: unknown,
  ) => {
    rememberSurface(context);
    options.realtimeBroker.appendDebugTrace({
      layer: "surface-bridge",
      direction,
      data,
      surfaceId: context.target.surfaceId,
      webContentsId: context.sender.id,
      surfaceKind: context.kind,
      route: context.target.pageRoute || context.sender.getURL(),
    });
  };

  const sendToSurface = (sender: WebContents, message: AgentWebclientRealtimeMessage) => {
    if (sender.isDestroyed()) return;
    const target = options.browserSurfaces.resolveWebviewSurfaceTarget(sender.id);
    const kind = trustedKind(target?.surfaceType);
    if (target && kind) {
      recordSurfaceTrace({
        sender,
        target,
        kind,
        capabilities: new Set(CAPABILITIES[kind]),
      }, "desktop-to-surface", message);
    }
    sender.send(AGENT_WEBCLIENT_REALTIME_MESSAGE_CHANNEL, message);
  };

  const cleanupSender = (senderId: number) => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.senderId !== senderId) continue;
      subscription.unsubscribe();
      subscriptions.delete(id);
    }
    for (const [key, queue] of batchQueues) {
      if (queue.sender.id !== senderId) continue;
      if (queue.timer) clearTimeout(queue.timer);
      batchQueues.delete(key);
    }
    for (const [key, operation] of operations) {
      if (operation.senderId === senderId) operations.delete(key);
    }
    options.realtimeBroker.cleanupConsumer(`agent-webclient-surface:${senderId}`);
    connectionUnsubscribers.get(senderId)?.();
    connectionUnsubscribers.delete(senderId);
    options.realtimeBroker.clearVisibleBinding(`surface:${senderId}`);
    surfaceDebugStates.delete(senderId);
    installedCleanup.delete(senderId);
  };

  const installCleanup = (context: SurfaceContext) => {
    const sender = context.sender;
    rememberSurface(context);
    if (installedCleanup.has(sender.id)) return;
    installedCleanup.add(sender.id);
    connectionUnsubscribers.set(sender.id, options.realtimeBroker.subscribeConnection({
      consumerId: `agent-webclient-surface:${sender.id}`,
      onState: (state) => sendToSurface(sender, {
        version: AGENT_WEBCLIENT_BRIDGE_VERSION,
        kind: "connection",
        phase: state.phase,
        generation: state.generation,
      }),
    }));
    sender.once("did-start-loading", () => cleanupSender(sender.id));
    sender.once("destroyed", () => cleanupSender(sender.id));
    sender.once("render-process-gone", () => cleanupSender(sender.id));
  };

  const availability = async () => {
    const state = await options.getServiceState(options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = state.status === "running"
      ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
      : "";
    if (!baseUrl) throw Object.assign(new Error("Agent Platform is unavailable"), { name: "connection_unavailable" });
    const tokenResult = await options.issueAccessToken(options.app, "missing");
    const token = tokenResult.ok ? tokenResult.token.trim() : "";
    if (!token) throw Object.assign(new Error(tokenResult.message || "Agent Platform token is unavailable"), { name: "connection_unavailable" });
    return { baseUrl, token };
  };

  const flushBatch = (key: string) => {
    const queue = batchQueues.get(key);
    if (!queue || queue.events.length === 0) return;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    const events = queue.events.splice(0);
    queue.bytes = 0;
    sendToSurface(queue.sender, {
      version: AGENT_WEBCLIENT_BRIDGE_VERSION,
      kind: "run.batch",
      delivery: queue.delivery,
      bindingEpoch: queue.bindingEpoch,
      chatId: queue.chatId,
      runId: queue.runId,
      events,
      lastSeq: queue.lastSeq,
    });
  };

  const enqueue = (
    sender: WebContents,
    delivery: AgentWebclientDeliveryTarget,
    chatId: string,
    runId: string,
    event: Record<string, unknown>,
    epoch: number,
  ) => {
    const key = `${sender.id}:${deliveryKey(delivery)}`;
    const queue = batchQueues.get(key) ?? {
      sender, delivery, chatId, runId, bindingEpoch: epoch,
      events: [], bytes: 0, lastSeq: 0, timer: null,
    };
    queue.bindingEpoch = epoch;
    queue.events.push(event);
    queue.bytes += Buffer.byteLength(JSON.stringify(event));
    if (typeof event.seq === "number" && Number.isSafeInteger(event.seq)) queue.lastSeq = event.seq;
    batchQueues.set(key, queue);
    if (queue.events.length >= MAX_BATCH_EVENTS || queue.bytes >= MAX_BATCH_BYTES) {
      flushBatch(key);
    } else if (!queue.timer) {
      queue.timer = setTimeout(() => flushBatch(key), BATCH_DELAY_MS);
    }
  };

  const handleRealtimeInvoke = async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    installCleanup(context);
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    recordSurfaceTrace(context, "surface-to-desktop", {
      bridge: "realtime",
      method,
      ...(record.input === undefined ? {} : { input: record.input }),
    });
    if (method === "hello") {
      if (record.input !== undefined) {
        const versionFailure = validateVersion(record.input);
        if (versionFailure) return versionFailure;
      }
      return {
        version: AGENT_WEBCLIENT_BRIDGE_VERSION,
        surface: {
          kind: context.kind,
          capabilities: [...context.capabilities],
          ...(context.target.ownerChatId ? { ownerChatId: context.target.ownerChatId } : {}),
          route: context.target.pageRoute || context.sender.getURL(),
        },
        connection: {
          phase: options.realtimeBroker.getConnectionPhase(),
          generation: options.realtimeBroker.getConnectionState().generation,
        },
      } satisfies AgentWebclientBridgeHello;
    }
    if (method === "request") {
      const input = record.input as AgentWebclientRealtimeRequest;
      const versionFailure = validateVersion(input);
      if (versionFailure) return versionFailure;
      if (!input || (input.kind !== "run.query" && input.kind !== "run.control")) {
        return failure("invalid_request", "unsupported realtime request kind");
      }
      if (!isPlainBridgeRecord(input.payload)) {
        return failure("invalid_request", "request payload must be an object");
      }
      if (input.kind === "run.control" && (!readText(input.chatId) || !readText(input.runId))) {
        return failure("invalid_request", "control chatId and runId are required");
      }
      const capabilityFailure = requireCapability(context, input.kind);
      if (capabilityFailure) return capabilityFailure;
      if (!context.target.active) {
        return failure("unsupported_in_current_view", "Run control is available only from the active trusted surface");
      }
      const owner = readOwner(input.owner);
      if (!owner) return failure("invalid_request", "a canonical Run owner is required");
      const sourceFailure = input.kind === "run.query"
        ? ensureQuerySourceChat(context, input.chatId)
        : ensureSourceChat(context, input.chatId);
      if (sourceFailure) return sourceFailure;
      const operationId = input.operationId?.trim() || "";
      const operationKey = `${event.sender.id}:${operationId}`;
      if (!operationId) return failure("invalid_request", "operationId is required");
      if (operations.has(operationKey)) return failure("duplicate_id", "operationId is already active");
      operations.set(operationKey, { senderId: event.sender.id, kind: input.kind === "run.query" ? "query" : "control" });
      try {
        const platform = await availability();
        if (input.kind === "run.query") {
          if (readText(input.payload?.runId)) {
            operations.delete(operationKey);
            return failure("invalid_request", "Desktop Bridge v2 forbids guest-provided query runId");
          }
          const {
            runId: _runId,
            chatId: _payloadChatId,
            agentKey: _payloadAgentKey,
            teamId: _payloadTeamId,
            ...queryPayload
          } = input.payload;
          const requestedChatId = input.chatId?.trim() || "";
          const delivery = { kind: "operation", operationId } as const;
          let canonicalIdentity: { chatId: string; runId: string } | null = null;
          let epoch = ++bindingEpoch;
          const handle = options.realtimeBroker.query({
            ...platform,
            id: operationId,
            ...(requestedChatId ? { chatId: requestedChatId } : {}),
            owner,
            payload: {
              ...queryPayload,
              ...(requestedChatId ? { chatId: requestedChatId } : {}),
              ...ownerPayload(owner),
            },
            onEvent: (runEvent) => {
              if (!operations.has(operationKey)) return;
              const chatId = canonicalIdentity?.chatId || readText(runEvent.chatId);
              const runId = canonicalIdentity?.runId || readText(runEvent.runId);
              if (chatId && runId) enqueue(event.sender, delivery, chatId, runId, runEvent, epoch);
            },
          });
          void handle.accepted.then((accepted) => {
            canonicalIdentity = { chatId: accepted.chatId, runId: accepted.runId };
            if (!operations.has(operationKey)) return;
            if (context.kind === "agent-chat" || context.kind === "agent-copilot") {
              try {
                const binding = options.realtimeBroker.bindVisibleRun({
                  chatId: accepted.chatId,
                  runId: accepted.runId,
                  primarySurfaceId: `surface:${event.sender.id}`,
                });
                if (binding) {
                  bindingEpoch = Math.max(bindingEpoch, binding.epoch);
                  epoch = binding.epoch;
                }
              } catch {
                // The Run may have completed between acceptance and visibility binding.
              }
            }
            sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.accepted",
              operationId,
              chatId: accepted.chatId,
              runId: accepted.runId,
              owner: accepted.owner,
            });
          }).catch((error) => {
            if (!operations.has(operationKey)) return;
            operations.delete(operationKey);
            sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "error",
              delivery,
              error: { code: errorCode(error), message: messageOf(error) },
            });
          });
          void handle.completed.then((completed) => {
            if (!operations.has(operationKey)) return;
            operations.delete(operationKey);
            flushBatch(`${event.sender.id}:${deliveryKey(delivery)}`);
            if (!canonicalIdentity) return;
            sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.completed",
              delivery,
              chatId: canonicalIdentity.chatId,
              runId: canonicalIdentity.runId,
              reason: completed.reason,
              ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
            });
          }).catch((error) => {
            if (!operations.has(operationKey)) return;
            operations.delete(operationKey);
            sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "error",
              delivery,
              error: { code: errorCode(error), message: messageOf(error) },
            });
          });
          return { ok: true, operationId };
        }
        const route = input.control === "interrupt"
          ? "/api/interrupt"
          : input.control === "submitAwaiting" || input.control === "submitTool"
            ? "/api/submit"
            : input.control === "steer"
              ? "/api/steer"
              : input.control === "updateAccessLevel"
                ? "/api/access-level"
                : "";
        if (!route) throw Object.assign(new Error("unsupported Run control"), { name: "invalid_request" });
        const {
          chatId: _payloadChatId,
          runId: _payloadRunId,
          agentKey: _payloadAgentKey,
          teamId: _payloadTeamId,
          ...controlPayload
        } = input.payload;
        const response = await new Promise<AgentWebclientApiResponse>((resolve, reject) => {
          void options.realtimeBroker.forwardRequest({
            ...platform,
            localId: operationId,
            consumerId: `agent-webclient-surface:${event.sender.id}`,
            type: route,
            payload: {
              ...controlPayload,
              chatId: input.chatId,
              runId: input.runId,
              ...ownerPayload(owner),
            },
            onFrame: (frame) => resolve(apiResponseFromFrame(frame)),
            onError: reject,
          }).catch(reject);
        });
        operations.delete(operationKey);
        return { ok: true, operationId, response };
      } catch (error) {
        operations.delete(operationKey);
        return failure(errorCode(error), messageOf(error));
      }
    }
    if (method === "subscribe") {
      const input = record.input as AgentWebclientRealtimeSubscription;
      const versionFailure = validateVersion(input);
      if (versionFailure) return versionFailure;
      const platform = await availability().catch((error) => error);
      if (platform instanceof Error) return failure(errorCode(platform), platform.message);
      if (input.kind === "push") {
        const denied = requireCapability(context, "push.subscribe");
        if (denied) return denied;
        const subscriptionId = `surface-push-${randomUUID()}`;
        try {
          await options.realtimeBroker.ensureConnected(platform.baseUrl, platform.token);
          const unsubscribe = options.realtimeBroker.subscribePush({
            types: input.types.filter((type) => AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)),
            filter: input.filter,
            kind: "surface",
            consumerId: `agent-webclient-surface:${event.sender.id}`,
            onPush: (frame) => sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "push",
              subscriptionId,
              type: String(frame.type || ""),
              data: frame.data ?? frame.payload,
            }),
          });
          subscriptions.set(subscriptionId, { senderId: event.sender.id, consumerId: `agent-webclient-surface:${event.sender.id}`, unsubscribe });
          return { ok: true, subscriptionId };
        } catch (error) {
          return failure(errorCode(error), messageOf(error));
        }
      }
      if (input.kind !== "run") return failure("invalid_request", "unsupported subscription kind");
      const denied = requireCapability(context, "run.attach");
      if (denied) return denied;
      const owner = readOwner(input.owner);
      if (!owner) return failure("invalid_request", "a canonical Run owner is required");
      const sourceFailure = ensureSourceChat(context, input.chatId);
      if (sourceFailure) return sourceFailure;
      if (input.role === "primary" && context.kind !== "agent-chat" && context.kind !== "agent-copilot") {
        return failure("capability_denied", `${context.kind} cannot become a primary Run surface`);
      }
      if (input.role === "primary" && !context.target.active) {
        return failure("unsupported_in_current_view", "A hidden surface cannot become the primary Run surface");
      }
      const subscriptionId = `surface-run-${randomUUID()}`;
      const delivery = { kind: "subscription", subscriptionId } as const;
      let epoch = options.realtimeBroker.getVisibleBinding()?.epoch ?? ++bindingEpoch;
      try {
        const subscription = options.realtimeBroker.subscribeRun({
          ...platform,
          runId: input.runId,
          chatId: input.chatId,
          lastSeq: input.lastSeq,
          owner,
          kind: "surface",
          consumerId: `agent-webclient-surface:${event.sender.id}`,
          onEvent: (runEvent) => enqueue(event.sender, delivery, input.chatId, input.runId, runEvent, epoch),
          onComplete: (completed) => {
            flushBatch(`${event.sender.id}:${deliveryKey(delivery)}`);
            sendToSurface(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.completed",
              delivery,
              chatId: input.chatId,
              runId: input.runId,
              reason: completed.reason,
              ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
            });
          },
          onError: (error) => sendToSurface(event.sender, {
            version: AGENT_WEBCLIENT_BRIDGE_VERSION,
            kind: "error",
            delivery,
            error: { code: errorCode(error), message: error.message },
          }),
        });
        try {
          await subscription.ready;
        } catch (error) {
          subscription.unsubscribe();
          throw error;
        }
        if (input.role === "primary") {
          const binding = options.realtimeBroker.bindVisibleRun({
            chatId: input.chatId,
            runId: input.runId,
            primarySurfaceId: `surface:${event.sender.id}`,
          });
          if (binding) {
            epoch = binding.epoch;
            bindingEpoch = Math.max(bindingEpoch, binding.epoch);
          }
        }
        subscriptions.set(subscriptionId, {
          senderId: event.sender.id,
          consumerId: `agent-webclient-surface:${event.sender.id}`,
          unsubscribe: subscription.unsubscribe,
        });
        return { ok: true, subscriptionId };
      } catch (error) {
        return failure(errorCode(error), messageOf(error));
      }
    }
    if (method === "detach") {
      const input = record.input as AgentWebclientRealtimeDetachInput;
      const versionFailure = validateVersion(input);
      if (versionFailure) return versionFailure;
      const target: Record<string, unknown> = isPlainBridgeRecord(input?.target) ? input.target : {};
      if (target.kind === "operation") {
        const operationId = typeof target.operationId === "string" ? target.operationId.trim() : "";
        const operationKey = `${event.sender.id}:${operationId}`;
        const operation = operations.get(operationKey);
        if (!operation || operation.senderId !== event.sender.id || operation.kind !== "query") {
          return failure("target_unavailable", "query operation is unavailable for this surface");
        }
        operations.delete(operationKey);
        const delivery = { kind: "operation", operationId } as const;
        const key = `${event.sender.id}:${deliveryKey(delivery)}`;
        if (batchQueues.get(key)?.timer) clearTimeout(batchQueues.get(key)!.timer!);
        batchQueues.delete(key);
        return { ok: true, operationId };
      }
      if (target.kind === "subscription") {
        const subscriptionId = typeof target.subscriptionId === "string" ? target.subscriptionId.trim() : "";
        const subscription = subscriptions.get(subscriptionId);
        if (!subscription || subscription.senderId !== event.sender.id) {
          return failure("target_unavailable", "subscription is unavailable for this surface");
        }
        subscription.unsubscribe();
        subscriptions.delete(subscriptionId);
        const delivery = { kind: "subscription", subscriptionId } as const;
        const key = `${event.sender.id}:${deliveryKey(delivery)}`;
        if (batchQueues.get(key)?.timer) clearTimeout(batchQueues.get(key)!.timer!);
        batchQueues.delete(key);
        return { ok: true, subscriptionId };
      }
      return failure("invalid_request", "detach target is required");
    }
    return failure("invalid_request", "unknown realtime bridge method");
  };

  ipcMain.handle(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL, async (event: any, call: unknown) => {
    const result = await handleRealtimeInvoke(event, call);
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if (!("ok" in context)) {
      const record = isPlainBridgeRecord(call) ? call : {};
      recordSurfaceTrace(context, "desktop-to-surface", {
        bridge: "realtime",
        transport: "invoke-result",
        method: typeof record.method === "string" ? record.method : "",
        result,
      });
    }
    return result;
  });

  const handleWorkPanelInvoke = async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    installCleanup(context);
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId) return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    recordSurfaceTrace(context, "surface-to-desktop", {
      bridge: "workpanel",
      method,
      ...(record.input === undefined ? {} : { input: record.input }),
    });
    const capability = method === "openItem"
      ? "workpanel.open"
      : method === "activateItem"
        ? "workpanel.activate"
        : method === "closeItem"
          ? "workpanel.close"
          : null;
    if (!capability) return failure("invalid_request", "unknown WorkPanel bridge method");
    const denied = requireCapability(context, capability);
    if (denied) return denied;
    const input = record.input as WorkPanelOpenItemInput | WorkPanelItemTargetInput;
    const versionFailure = validateVersion(input);
    if (versionFailure) return versionFailure;
    const args = method === "openItem"
      ? { descriptor: (input as WorkPanelOpenItemInput).descriptor }
      : { itemId: (input as WorkPanelItemTargetInput).itemId };
    return options.dispatchWorkPanel({
      action: method as "openItem" | "activateItem" | "closeItem",
      ownerChatId,
      args,
    });
  };

  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, async (event: any, call: unknown) => {
    const result = await handleWorkPanelInvoke(event, call);
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if (!("ok" in context)) {
      const record = isPlainBridgeRecord(call) ? call : {};
      recordSurfaceTrace(context, "desktop-to-surface", {
        bridge: "workpanel",
        transport: "invoke-result",
        method: typeof record.method === "string" ? record.method : "",
        result,
      });
    }
    return result;
  });

  return {
    cleanupSender,
    getDiagnostics: () => ({
      registeredSenderCount: installedCleanup.size,
      connectionListenerCount: connectionUnsubscribers.size,
      subscriptionCount: subscriptions.size,
      pendingOperationCount: operations.size,
      batchQueueCount: batchQueues.size,
      bindingEpoch,
      surfaces: [...surfaceDebugStates.values()].map((surface) => ({
        ...surface,
        subscriptionCount: [...subscriptions.values()].filter((item) =>
          item.senderId === surface.webContentsId,
        ).length,
        pendingOperationCount: [...operations.values()].filter((item) =>
          item.senderId === surface.webContentsId,
        ).length,
        batchQueueCount: [...batchQueues.values()].filter((item) =>
          item.sender.id === surface.webContentsId,
        ).length,
      })),
    }),
  };
}
