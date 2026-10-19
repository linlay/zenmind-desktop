import { RealtimeBroker, AGENT_PLATFORM_KNOWN_PUSH_TYPES } from "../agent-platform";
import { type DesktopWsServerOptions, type DesktopWsConnection, type DesktopWsRequestFrame, type AgentPlatformBridgeOptions } from "./ws-contracts";
import { readText, asRecord, errorMessage } from "./ws-values";
import { sendAgentPlatformError, withAgentPlatformNamespace, sendJson } from "./ws-wire";

export const AGENT_PLATFORM_SERVICE_ID = "agent-platform";

export const AGENT_PLATFORM_CONTROL_PUSH_TYPES = new Set(["connected", "heartbeat", "auth.expiring"]);

export class AgentPlatformWsBridge {
  private readonly broker: RealtimeBroker;
  private readonly ownsBroker: boolean;
  private readonly consumerId: string;
  private readonly pendingRequests = new Map<string, () => void>();
  private unsubscribePush: (() => void) | null = null;

  constructor(
    private readonly options: DesktopWsServerOptions,
    private readonly connection: DesktopWsConnection,
    private readonly logger: Pick<typeof console, "log" | "warn" | "error">
  ) {
    const bridgeOptions = options.agentPlatformBridge;
    this.consumerId = `desktop-ws-ap:${connection.id}`;
    this.ownsBroker = !bridgeOptions?.realtimeBroker;
    this.broker = bridgeOptions?.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: bridgeOptions?.issueAccessToken ?? (async () => ({
        ok: false,
        token: "",
        message: "agent-platform bridge is not configured",
      })),
      getDesktopDeviceId: () => "desktop-main",
      createWebSocket: bridgeOptions?.WebSocketConstructor
        ? (url) => new bridgeOptions.WebSocketConstructor!(url)
        : undefined,
      onDiagnostic: (message) => this.logger.warn?.(`[desktop-ws] ${message}`),
    });
  }

  async forwardRequest(req: DesktopWsRequestFrame) {
    const id = readText(req.id);
    const type = readText(req.type);
    if (!id || !type) {
      sendAgentPlatformError(this.connection, id || undefined, "invalid_request", 400, "request type and id are required");
      return;
    }
    if (req.frame !== "request") {
      sendAgentPlatformError(this.connection, id || undefined, "invalid_request", 400, "only request frames are accepted");
      return;
    }
    if (!this.options.agentPlatformBridge) {
      sendAgentPlatformError(this.connection, id, "agent_platform_unavailable", 503, "agent-platform bridge is not configured");
      return;
    }
    if (this.pendingRequests.has(id)) {
      sendAgentPlatformError(this.connection, id, "duplicate_id", 409, "request id is already active");
      return;
    }

    const controller = new AbortController();
    this.pendingRequests.set(id, () => controller.abort());
    try {
      const availability = await this.resolveAvailability(this.options.agentPlatformBridge);
      if (controller.signal.aborted) return;
      await this.ensurePushSubscription(availability.baseUrl, availability.token);
      if (controller.signal.aborted) return;
      const payload = asRecord(req.payload);
      if (type === "/api/query" && payload.detached !== true) {
        this.forwardQuery(id, payload, availability, controller);
        return;
      }
      if (type === "/api/detach") {
        const streamRequestId = readText(payload.streamRequestId);
        if (!streamRequestId || streamRequestId === id) {
          this.sendRunFrame(id, { frame: "error", type: "invalid_request", code: 400, msg: "streamRequestId is required" });
          return;
        }
        const release = this.pendingRequests.get(streamRequestId);
        if (release) {
          this.sendRunFrame(streamRequestId, { frame: "stream", reason: "detached" });
          release();
        }
        sendJson(this.connection, { ns: "ap", frame: "response", type, id, code: 0, msg: "success", data: {
          accepted: Boolean(release), status: release ? "detached" : "not_observing", streamRequestId,
        } });
        this.pendingRequests.delete(id);
        return;
      }
      if (type === "/api/attach") {
        await this.forwardAttach(id, payload, availability, controller.signal);
        return;
      }
      await this.broker.forwardRequest({
        baseUrl: availability.baseUrl,
        token: availability.token,
        localId: id,
        consumerId: this.consumerId,
        type,
        payload: asRecord(req.payload),
        onFrame: (frame) => {
          const frameKind = readText(frame.frame);
          const terminalStream = frameKind === "stream" && Boolean(readText(frame.reason));
          if (frameKind === "response" || frameKind === "error" || terminalStream) {
            this.pendingRequests.delete(id);
          }
          const namespaced = withAgentPlatformNamespace(frame);
          if (namespaced) {
            sendJson(this.connection, namespaced);
          }
        },
        onError: (error) => {
          this.pendingRequests.delete(id);
          sendAgentPlatformError(
            this.connection,
            id,
            error.name || "connection_unavailable",
            503,
            error.message,
          );
        },
      });
    } catch (error) {
      this.sendRunError(id, error);
    }
  }

  close() {
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    this.broker.cleanupConsumer(this.consumerId);
    for (const release of this.pendingRequests.values()) release();
    this.pendingRequests.clear();
    if (this.ownsBroker) {
      this.broker.dispose();
    }
  }

  private sendRunFrame(id: string, frame: Record<string, unknown>) {
    if (!this.pendingRequests.has(id)) return;
    const event = asRecord(frame.event);
    const namespaced = withAgentPlatformNamespace({ ...frame, id,
      ...(frame.frame === "stream" && readText(event.runId) ? { streamId: event.runId, lastSeq: event.seq } : {}),
    });
    if (namespaced) sendJson(this.connection, namespaced);
    if (frame.frame === "error" || (frame.frame === "stream" && frame.reason)) this.pendingRequests.delete(id);
  }

  private sendRunError(id: string, error: unknown) {
    const value = error as Error & { status?: number; platformErrorFrame?: Record<string, unknown> };
    this.sendRunFrame(id, value.platformErrorFrame ?? {
      frame: "error", type: value.name || "connection_unavailable", code: value.status || 503, msg: errorMessage(error),
    });
  }

  private forwardQuery(id: string, payload: Record<string, unknown>, availability: { baseUrl: string; token: string }, controller: AbortController) {
    let runId = "";
    const query = this.broker.query({
      ...availability, id, payload, consumerId: this.consumerId, signal: controller.signal,
      chatId: readText(payload.chatId),
      ...(readText(payload.agentKey) ? { owner: { kind: "agent" as const, agentKey: readText(payload.agentKey) } } : {}),
      onEvent: (event) => this.sendRunFrame(id, { frame: "stream", event }),
    });
    void query.accepted.then((identity) => { runId = identity.runId; }, () => {});
    void query.completed.then(
      (result) => this.sendRunFrame(id, { frame: "stream", streamId: runId, ...result }),
      (error) => this.sendRunError(id, error),
    );
  }

  private async forwardAttach(id: string, payload: Record<string, unknown>, availability: { baseUrl: string; token: string }, signal: AbortSignal) {
    const runId = readText(payload.runId);
    const chatId = readText(payload.chatId);
    const agentKey = readText(payload.agentKey);
    if (!chatId || !agentKey) throw Object.assign(new Error("attach requires Chat identity and root agentKey"), { name: "invalid_request", status: 400 });
    const subscription = this.broker.subscribeRun({
      ...availability, runId, chatId, owner: { kind: "agent", agentKey },
      lastSeq: typeof payload.lastSeq === "number" ? payload.lastSeq : 0,
      kind: "internal", consumerId: this.consumerId,
      onEvent: (event) => this.sendRunFrame(id, { frame: "stream", event }),
      onComplete: (result) => this.sendRunFrame(id, { frame: "stream", streamId: runId, ...result }),
      onError: (error) => this.sendRunError(id, error),
    });
    const release = () => { subscription.unsubscribe(); };
    if (signal.aborted) { release(); return; }
    signal.addEventListener("abort", release, { once: true });
    if (this.pendingRequests.has(id)) this.pendingRequests.set(id, () => { signal.removeEventListener("abort", release); release(); });
    await subscription.ready;
  }

  private async resolveAvailability(bridgeOptions: AgentPlatformBridgeOptions) {
    const serviceState = await bridgeOptions.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = serviceState.status === "running"
      ? serviceState.healthMeta.webUrl.trim() || (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
      : "";
    if (!baseUrl) {
      throw new Error(serviceState.message || "agent-platform is not running");
    }

    const tokenResult = await bridgeOptions.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      throw new Error(tokenResult.message || "agent-platform token unavailable");
    }
    return { baseUrl, token: tokenResult.token.trim() };
  }

  private async ensurePushSubscription(baseUrl: string, token: string) {
    await this.broker.ensureConnected(baseUrl, token);
    if (this.unsubscribePush) {
      return;
    }
    this.unsubscribePush = this.broker.subscribePush({
      types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES].filter((type) =>
        !AGENT_PLATFORM_CONTROL_PUSH_TYPES.has(type),
      ),
      kind: "desktop-ws",
      consumerId: this.consumerId,
      onPush: (frame) => {
        const namespaced = withAgentPlatformNamespace(frame);
        if (namespaced) {
          sendJson(this.connection, namespaced);
        }
      },
    });
  }
}
