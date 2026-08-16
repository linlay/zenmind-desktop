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
  type AgentWebclientRealtimeMessage,
  type AgentWebclientRealtimeRequest,
  type AgentWebclientRealtimeSubscription,
  type AgentWebclientSurfaceCapability,
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
  subscriptionId: string;
  chatId: string;
  runId: string;
  bindingEpoch: number;
  events: Array<Record<string, unknown>>;
  bytes: number;
  lastSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
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
  "agent-summary": ["run.attach", "run.visible.read", "push.subscribe", "workpanel.activate", "workpanel.close"],
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

function sendMessage(sender: WebContents, message: AgentWebclientRealtimeMessage) {
  if (!sender.isDestroyed()) sender.send(AGENT_WEBCLIENT_REALTIME_MESSAGE_CHANNEL, message);
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
  const operations = new Map<string, number>();
  const batchQueues = new Map<string, BatchQueue>();
  const installedCleanup = new Set<number>();
  const connectionUnsubscribers = new Map<number, () => void>();
  let bindingEpoch = 0;

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
    for (const [key, ownerId] of operations) {
      if (ownerId === senderId) operations.delete(key);
    }
    options.realtimeBroker.cleanupConsumer(`agent-webclient-surface:${senderId}`);
    connectionUnsubscribers.get(senderId)?.();
    connectionUnsubscribers.delete(senderId);
    options.realtimeBroker.clearVisibleBinding(`surface:${senderId}`);
    installedCleanup.delete(senderId);
  };

  const installCleanup = (sender: WebContents) => {
    if (installedCleanup.has(sender.id)) return;
    installedCleanup.add(sender.id);
    connectionUnsubscribers.set(sender.id, options.realtimeBroker.subscribeConnection({
      consumerId: `agent-webclient-surface:${sender.id}`,
      onState: (state) => sendMessage(sender, {
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
    sendMessage(queue.sender, {
      version: AGENT_WEBCLIENT_BRIDGE_VERSION,
      kind: "run.batch",
      subscriptionId: queue.subscriptionId,
      bindingEpoch: queue.bindingEpoch,
      chatId: queue.chatId,
      runId: queue.runId,
      events,
      lastSeq: queue.lastSeq,
    });
  };

  const enqueue = (
    sender: WebContents,
    subscriptionId: string,
    chatId: string,
    runId: string,
    event: Record<string, unknown>,
    epoch: number,
  ) => {
    const key = `${sender.id}:${subscriptionId}`;
    const queue = batchQueues.get(key) ?? {
      sender, subscriptionId, chatId, runId, bindingEpoch: epoch,
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

  ipcMain.handle(AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL, async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    installCleanup(context.sender);
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
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
      const capabilityFailure = requireCapability(context, input.kind);
      if (capabilityFailure) return capabilityFailure;
      if (!context.target.active) {
        return failure("unsupported_in_current_view", "Run control is available only from the active trusted surface");
      }
      const sourceFailure = ensureSourceChat(context, input.chatId);
      if (sourceFailure) return sourceFailure;
      const operationId = input.operationId?.trim() || "";
      const operationKey = `${event.sender.id}:${operationId}`;
      if (!operationId) return failure("invalid_request", "operationId is required");
      if (operations.has(operationKey)) return failure("duplicate_id", "operationId is already active");
      operations.set(operationKey, event.sender.id);
      try {
        const platform = await availability();
        if (input.kind === "run.query") {
          let epoch = ++bindingEpoch;
          const handle = options.realtimeBroker.query({
            ...platform,
            id: operationId,
            runId: input.runId,
            chatId: input.chatId,
            agentKey: input.owner?.kind === "agent" ? input.owner.agentKey : undefined,
            payload: input.payload,
            onEvent: (runEvent) => enqueue(event.sender, `operation:${operationId}`, input.chatId, input.runId, runEvent, epoch),
          });
          void handle.accepted.then((accepted) => {
            if (context.kind === "agent-chat" || context.kind === "agent-copilot") {
              try {
                const binding = options.realtimeBroker.bindVisibleRun({
                  chatId: input.chatId,
                  runId: input.runId,
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
            sendMessage(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.accepted",
              operationId,
              chatId: input.chatId,
              runId: input.runId,
              agentKey: accepted.agentKey,
            });
          }).catch((error) => sendMessage(event.sender, {
            version: AGENT_WEBCLIENT_BRIDGE_VERSION,
            kind: "error",
            operationId,
            error: { code: errorCode(error), message: messageOf(error) },
          }));
          void handle.completed.then((completed) => {
            operations.delete(operationKey);
            flushBatch(`${event.sender.id}:operation:${operationId}`);
            sendMessage(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.completed",
              operationId,
              chatId: input.chatId,
              runId: input.runId,
              reason: completed.reason,
              ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
            });
          }).catch((error) => {
            operations.delete(operationKey);
            sendMessage(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "error",
              operationId,
              error: { code: errorCode(error), message: messageOf(error) },
            });
          });
          return { ok: true, operationId };
        }
        const route = input.control === "interrupt"
          ? "/api/interrupt"
          : input.control === "submitAwaiting" || input.control === "submitTool"
            ? "/api/submit"
            : "";
        if (!route) {
          operations.delete(operationKey);
          return failure("unsupported_in_current_view", `${input.control} is not supported by Desktop bridge v1`);
        }
        await new Promise<void>((resolve, reject) => {
          void options.realtimeBroker.forwardRequest({
            ...platform,
            localId: operationId,
            consumerId: `agent-webclient-surface:${event.sender.id}`,
            type: route,
            payload: { ...input.payload, chatId: input.chatId, runId: input.runId },
            onFrame: (frame) => {
              if (frame.frame === "error") reject(new Error(String(frame.msg || frame.type || "control failed")));
              else resolve();
            },
            onError: reject,
          }).catch(reject);
        });
        operations.delete(operationKey);
        return { ok: true, operationId };
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
            onPush: (frame) => sendMessage(event.sender, {
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
      const sourceFailure = ensureSourceChat(context, input.chatId);
      if (sourceFailure) return sourceFailure;
      if (input.role === "primary" && context.kind !== "agent-chat" && context.kind !== "agent-copilot") {
        return failure("capability_denied", `${context.kind} cannot become a primary Run surface`);
      }
      if (input.role === "primary" && !context.target.active) {
        return failure("unsupported_in_current_view", "A hidden surface cannot become the primary Run surface");
      }
      const subscriptionId = `surface-run-${randomUUID()}`;
      let epoch = options.realtimeBroker.getVisibleBinding()?.epoch ?? ++bindingEpoch;
      try {
        const subscription = options.realtimeBroker.subscribeRun({
          ...platform,
          runId: input.runId,
          chatId: input.chatId,
          lastSeq: input.lastSeq,
          agentKey: input.owner?.kind === "agent" ? input.owner.agentKey : undefined,
          kind: "surface",
          consumerId: `agent-webclient-surface:${event.sender.id}`,
          onEvent: (runEvent) => enqueue(event.sender, subscriptionId, input.chatId, input.runId, runEvent, epoch),
          onComplete: (completed) => {
            flushBatch(`${event.sender.id}:${subscriptionId}`);
            sendMessage(event.sender, {
              version: AGENT_WEBCLIENT_BRIDGE_VERSION,
              kind: "run.completed",
              subscriptionId,
              chatId: input.chatId,
              runId: input.runId,
              reason: completed.reason,
              ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
            });
          },
          onError: (error) => sendMessage(event.sender, {
            version: AGENT_WEBCLIENT_BRIDGE_VERSION,
            kind: "error",
            subscriptionId,
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
    if (method === "unsubscribe") {
      const subscriptionId = typeof record.subscriptionId === "string" ? record.subscriptionId.trim() : "";
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription || subscription.senderId !== event.sender.id) {
        return failure("target_unavailable", "subscription is unavailable for this surface");
      }
      subscription.unsubscribe();
      subscriptions.delete(subscriptionId);
      const key = `${event.sender.id}:${subscriptionId}`;
      flushBatch(key);
      batchQueues.delete(key);
      return { ok: true, subscriptionId };
    }
    return failure("invalid_request", "unknown realtime bridge method");
  });

  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    installCleanup(context.sender);
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId) return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
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
    }),
  };
}
