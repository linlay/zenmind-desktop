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
  private readonly pendingRequestIds = new Set<string>();
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
    if (this.pendingRequestIds.has(id)) {
      sendAgentPlatformError(this.connection, id, "duplicate_id", 409, "request id is already active");
      return;
    }

    try {
      const availability = await this.resolveAvailability(this.options.agentPlatformBridge);
      await this.ensurePushSubscription(availability.baseUrl, availability.token);
      this.pendingRequestIds.add(id);
      await this.broker.forwardRequest({
        baseUrl: availability.baseUrl,
        token: availability.token,
        localId: id,
        consumerId: this.consumerId,
        type,
        payload: asRecord(req.payload),
        stream: type === "/api/query" || type === "/api/attach",
        onFrame: (frame) => {
          const frameKind = readText(frame.frame);
          const terminalStream = frameKind === "stream" && Boolean(readText(frame.reason));
          if (frameKind === "response" || frameKind === "error" || terminalStream) {
            this.pendingRequestIds.delete(id);
          }
          const namespaced = withAgentPlatformNamespace(frame);
          if (namespaced) {
            sendJson(this.connection, namespaced);
          }
        },
        onError: (error) => {
          this.pendingRequestIds.delete(id);
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
      this.pendingRequestIds.delete(id);
      sendAgentPlatformError(
        this.connection,
        id,
        "agent_platform_unavailable",
        503,
        errorMessage(error)
      );
    }
  }

  close() {
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    this.broker.cleanupConsumer(this.consumerId);
    this.pendingRequestIds.clear();
    if (this.ownsBroker) {
      this.broker.dispose();
    }
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
