import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
} from "../../shared/contracts";
import { getDesktopDeviceId } from "../device-identity";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const PLATFORM_WS_PROTOCOL_VERSION = 2;
const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_HEARTBEAT_INTERVAL_MS = 120_000;
const MAX_SILENCE_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  (timer as T & { unref?: () => void }).unref?.();
  return timer;
}

export type AgentPlatformRealtimeFrame = Record<string, unknown>;

export type AgentPlatformRealtimeSocket = {
  readonly readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type AgentPlatformRealtimeSocketFactory =
  (url: string) => AgentPlatformRealtimeSocket;

export type RealtimeConnectionKey = {
  endpoint: string;
  identitySessionId: string;
};

export type RealtimeIdentityRotationReason =
  | "explicit_identity_invalidation"
  | "endpoint_changed"
  | "identity_session_changed";

export type AgentPlatformRealtimeConnectionState = {
  phase: AgentWebclientConnectionPhase;
  generation: number;
  physicalConnectionCount: 0 | 1;
  reconnectCount: number;
  key: RealtimeConnectionKey | null;
  physicalSessionId?: string;
  lastInboundAt?: number;
  lastHeartbeatAt?: number;
  closeReason?: string;
  lastError?: string;
};

type AgentPlatformHandshake = {
  sessionId: string;
  heartbeatIntervalMs: number;
  silenceTimeoutMs: number;
};

type InternalPending = {
  resolve(frame: AgentPlatformRealtimeFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createAgentPlatformIdentitySessionId(token: string, deviceId: string) {
  const claims = decodeJwtClaims(token);
  const identity = [
    readText(claims.iss),
    readText(claims.sub),
    readText(claims.sid),
    deviceId.trim(),
  ].join("\0");
  return createHash("sha256").update(identity).digest("hex");
}

export function normalizeAgentPlatformRealtimeEndpoint(baseUrl: string) {
  const parsed = new URL(baseUrl);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed.toString().replace(/\/$/u, "");
}

export function createAgentPlatformRealtimeUrl(
  baseUrl: string,
  token: string,
  deviceId: string,
) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("source", "desktop-main");
  url.searchParams.set("deviceId", deviceId);
  return url.toString();
}

function defaultSocketFactory(url: string): AgentPlatformRealtimeSocket {
  const Constructor = globalThis.WebSocket as unknown as
    | (new (target: string) => AgentPlatformRealtimeSocket)
    | undefined;
  if (!Constructor) {
    throw new Error("WebSocket is unavailable in the Electron main process");
  }
  return new Constructor(url);
}

async function readFrameText(value: unknown, maxBytes: number): Promise<string> {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maxBytes) {
      throw new Error("protocol_error: Agent Platform WebSocket frame is too large");
    }
    return value;
  }
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (value.size > maxBytes) {
      throw new Error("protocol_error: Agent Platform WebSocket frame is too large");
    }
    return value.text();
  } else {
    throw new Error("protocol_error: unsupported Agent Platform WebSocket payload");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error("protocol_error: Agent Platform WebSocket frame is too large");
  }
  return new TextDecoder().decode(bytes);
}

function frameError(frame: AgentPlatformRealtimeFrame) {
  const code = readText(frame.type) || "protocol_error";
  const message = readText(frame.msg) || readText(frame.message) || code;
  return new Error(`${code}: ${message}`);
}

function readSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validateConnectedHandshake(frame: AgentPlatformRealtimeFrame): AgentPlatformHandshake {
  const data = frame.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: connected.data must be an object");
  }
  const payload = data as Record<string, unknown>;
  if (payload.protocolVersion !== PLATFORM_WS_PROTOCOL_VERSION) {
    throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: Agent Platform WebSocket protocol v2 is required");
  }
  const sessionId = readText(payload.sessionId);
  const serverTime = readSafeInteger(payload.serverTime);
  const liveness = payload.liveness;
  if (!sessionId || serverTime === null || !liveness || typeof liveness !== "object" || Array.isArray(liveness)) {
    throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: connected handshake fields are invalid");
  }
  const policy = liveness as Record<string, unknown>;
  const heartbeatIntervalMs = readSafeInteger(policy.heartbeatIntervalMs);
  const silenceTimeoutMs = readSafeInteger(policy.silenceTimeoutMs);
  if (
    heartbeatIntervalMs === null ||
    heartbeatIntervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
    heartbeatIntervalMs > MAX_HEARTBEAT_INTERVAL_MS ||
    silenceTimeoutMs === null ||
    silenceTimeoutMs < (2 * heartbeatIntervalMs) + 10_000 ||
    silenceTimeoutMs > MAX_SILENCE_TIMEOUT_MS
  ) {
    throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: connected liveness policy is invalid");
  }
  return { sessionId, heartbeatIntervalMs, silenceTimeoutMs };
}

export class AgentPlatformRealtimeClient {
  private socket: AgentPlatformRealtimeSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private currentToken = "";
  private currentBaseUrl = "";
  private currentKey: RealtimeConnectionKey | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private reconnectCount = 0;
  private physicalSessionId = "";
  private lastPhysicalSessionId = "";
  private negotiatedSilenceTimeoutMs = 0;
  private lastInboundAt = 0;
  private lastHeartbeatAt = 0;
  private lastHeartbeatSequence = 0;
  private lastCloseReason = "";
  private disposed = false;
  private intentionallyClosing = false;
  private refreshPromise: Promise<void> | null = null;
  private readonly internalPending = new Map<string, InternalPending>();
  private state: AgentPlatformRealtimeConnectionState = {
    phase: "idle",
    generation: 0,
    physicalConnectionCount: 0,
    reconnectCount: 0,
    key: null,
  };

  constructor(private readonly options: {
    app: App;
    issueAccessToken: (
      app: App,
      reason: "missing" | "unauthorized",
    ) => Promise<AgentAuthIssueResult>;
    createWebSocket?: AgentPlatformRealtimeSocketFactory;
    connectTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    maxFrameBytes?: number;
    random?: () => number;
    onFrame(frame: AgentPlatformRealtimeFrame, generation: number): void;
    onStaleFrame?(): void;
    onState?(state: AgentPlatformRealtimeConnectionState): void;
    onDiagnostic?(message: string): void;
    onTrace?(direction: "in" | "out", frame: AgentPlatformRealtimeFrame): void;
  }) {}

  getState() {
    return { ...this.state, key: this.state.key ? { ...this.state.key } : null };
  }

  getRotationReason(baseUrl: string, token: string): RealtimeIdentityRotationReason | null {
    if (!this.currentKey) return null;
    const nextKey = {
      endpoint: normalizeAgentPlatformRealtimeEndpoint(baseUrl),
      identitySessionId: createAgentPlatformIdentitySessionId(
        token,
        getDesktopDeviceId(this.options.app),
      ),
    };
    if (this.currentKey.endpoint !== nextKey.endpoint) {
      return "endpoint_changed";
    }
    if (this.currentKey.identitySessionId !== nextKey.identitySessionId) {
      return "identity_session_changed";
    }
    return null;
  }

  async ensureConnected(baseUrl: string, token: string) {
    if (this.disposed) {
      throw new Error("connection_unavailable: realtime client is disposed");
    }
    const normalizedBaseUrl = normalizeAgentPlatformRealtimeEndpoint(baseUrl);
    const deviceId = getDesktopDeviceId(this.options.app);
    const nextKey = {
      endpoint: normalizedBaseUrl,
      identitySessionId: createAgentPlatformIdentitySessionId(token, deviceId),
    };
    if (this.currentKey) {
      if (this.currentKey.endpoint !== nextKey.endpoint) {
        this.rotateConnection("endpoint changed");
      } else if (this.currentKey.identitySessionId !== nextKey.identitySessionId) {
        this.rotateConnection("identity changed");
      }
    }
    this.currentKey = nextKey;
    this.currentBaseUrl = normalizedBaseUrl;
    if (this.socket && this.state.phase === "connected") {
      if (token !== this.currentToken) {
        await this.refreshAuthorizationWithToken(token);
      }
      return;
    }
    this.currentToken = token;
    if (this.connectPromise) {
      return this.connectPromise;
    }
    // An explicit consumer operation supersedes a scheduled reconnect. Leaving
    // the timer armed would create a second physical socket after this open.
    this.clearReconnectTimer();
    return this.open(false);
  }

  send(frame: AgentPlatformRealtimeFrame) {
    const socket = this.socket;
    if (!socket || this.state.phase !== "connected") {
      throw new Error("connection_unavailable: Agent Platform realtime connection is not open");
    }
    socket.send(JSON.stringify(frame));
    this.options.onTrace?.("out", frame);
  }

  rotateIdentity() {
    this.currentKey = null;
    this.currentBaseUrl = "";
    this.currentToken = "";
    this.rotateConnection("identity invalidated");
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.intentionallyClosing = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.rejectConnect?.(new Error("connection_unavailable: realtime client disposed"));
    this.rejectConnect = null;
    this.rejectInternalPending(new Error("connection_unavailable: realtime client disposed"));
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "desktop realtime disposed");
    } catch {
      // Local ownership is already cleared.
    }
    this.lastCloseReason = "app_shutdown";
    this.publishState("closed", 0);
  }

  private publishState(
    phase: AgentWebclientConnectionPhase,
    physicalConnectionCount: 0 | 1,
    lastError?: string,
  ) {
    this.state = {
      phase,
      generation: this.generation,
      physicalConnectionCount,
      reconnectCount: this.reconnectCount,
      key: this.currentKey ? { ...this.currentKey } : null,
      ...(this.physicalSessionId || this.lastPhysicalSessionId
        ? { physicalSessionId: this.physicalSessionId || this.lastPhysicalSessionId }
        : {}),
      ...(this.lastInboundAt ? { lastInboundAt: this.lastInboundAt } : {}),
      ...(this.lastHeartbeatAt ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
      ...(this.lastCloseReason ? { closeReason: this.lastCloseReason } : {}),
      ...(lastError ? { lastError } : {}),
    };
    this.options.onState?.(this.getState());
  }

  private rotateConnection(reason: string) {
    this.intentionallyClosing = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.lastHeartbeatSequence = 0;
    this.rejectConnect?.(new Error(`connection_unavailable: ${reason}`));
    this.rejectConnect = null;
    this.connectPromise = null;
    this.rejectInternalPending(new Error(`connection_unavailable: ${reason}`));
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, reason);
    } catch {
      // Ignore a stale socket close failure.
    }
    this.intentionallyClosing = false;
    this.lastCloseReason = reason;
    this.publishState("idle", 0);
  }

  private async open(reconnecting: boolean) {
    if (!this.currentBaseUrl || !this.currentToken || !this.currentKey) {
      throw new Error("connection_unavailable: realtime endpoint or identity is unavailable");
    }
    const factory = this.options.createWebSocket ?? defaultSocketFactory;
    const deviceId = getDesktopDeviceId(this.options.app);
    const socket = factory(
      createAgentPlatformRealtimeUrl(this.currentBaseUrl, this.currentToken, deviceId),
    );
    this.generation += 1;
    const generation = this.generation;
    this.socket = socket;
    this.publishState(reconnecting ? "reconnecting" : "connecting", 1);
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.rejectConnect = null;
        this.reconnectAttempt = 0;
        this.publishState("connected", 1);
        this.resetHeartbeatTimer(socket, generation);
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.rejectConnect = null;
        reject(error);
      };
      this.rejectConnect = rejectOnce;
      socket.onopen = () => {
        // The physical socket is not usable until Platform's protocol-v2
        // connected handshake has been validated.
      };
      socket.onmessage = (event) => {
        void this.handleMessage(socket, generation, event.data)
          .then((handshakeCompleted) => {
            if (handshakeCompleted) resolveOnce();
          })
          .catch((error) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            rejectOnce(normalized);
            this.options.onDiagnostic?.(normalized.message);
            this.handleClosed(socket, generation, normalized);
            try {
              socket.close(1002, "invalid realtime frame");
            } catch {
              // handleClosed already cleared local ownership.
            }
          });
      };
      socket.onerror = () => {
        const error = new Error("connection_unavailable: Agent Platform realtime connection failed");
        rejectOnce(error);
        this.handleClosed(socket, generation, error);
      };
      socket.onclose = () => {
        const error = new Error("connection_unavailable: Agent Platform realtime connection closed");
        rejectOnce(error);
        this.handleClosed(socket, generation, error);
      };
      timer = unrefTimer(setTimeout(() => {
        const error = new Error("PLATFORM_WS_HANDSHAKE_TIMEOUT: Agent Platform protocol-v2 handshake timed out");
        rejectOnce(error);
        this.handleClosed(socket, generation, error);
        try {
          socket.close(1000, "connect timeout");
        } catch {
          // handleClosed already cleared local ownership.
        }
      }, timeoutMs));
    });
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private async handleMessage(
    socket: AgentPlatformRealtimeSocket,
    generation: number,
    data: unknown,
  ): Promise<boolean> {
    if (socket !== this.socket || generation !== this.generation) {
      this.options.onStaleFrame?.();
      return false;
    }
    const text = await readFrameText(
      data,
      this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    );
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("protocol_error: Agent Platform frame must be an object");
    }
    const frame = parsed as AgentPlatformRealtimeFrame;
    this.options.onTrace?.("in", frame);
    const kind = readText(frame.frame);
    const type = readText(frame.type);
    const now = Date.now();
    if (this.state.phase !== "connected") {
      if (kind !== "push" || type !== "connected") {
        throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: connected must be the first Platform frame");
      }
      const handshake = validateConnectedHandshake(frame);
      this.physicalSessionId = handshake.sessionId;
      this.lastPhysicalSessionId = handshake.sessionId;
      this.negotiatedSilenceTimeoutMs = handshake.silenceTimeoutMs;
      this.lastHeartbeatSequence = 0;
      this.lastInboundAt = now;
      this.resetHeartbeatTimer(socket, generation);
      return true;
    }
    if (kind === "push" && type === "connected") {
      throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: duplicate connected handshake");
    }
    if (!["request", "response", "stream", "push", "error"].includes(kind)) {
      throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: invalid Platform frame envelope");
    }
    this.lastInboundAt = now;
    this.resetHeartbeatTimer(socket, generation);
    if (kind === "push" && type === "heartbeat") {
      const payload = frame.data;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: heartbeat.data must be an object");
      }
      const heartbeat = payload as Record<string, unknown>;
      if (
        readText(heartbeat.sessionId) !== this.physicalSessionId ||
        readSafeInteger(heartbeat.sequence) === null ||
        (readSafeInteger(heartbeat.sequence) ?? 0) <= this.lastHeartbeatSequence ||
        readSafeInteger(heartbeat.timestamp) === null
      ) {
        throw new Error("PLATFORM_WS_PROTOCOL_MISMATCH: heartbeat fields are invalid");
      }
      this.lastHeartbeatSequence = readSafeInteger(heartbeat.sequence) ?? 0;
      this.lastHeartbeatAt = now;
      this.refreshLivenessState();
      return false;
    }
    this.refreshLivenessState();
    const id = readText(frame.id);
    if ((kind === "response" || kind === "error") && id) {
      const pending = this.internalPending.get(id);
      if (pending) {
        this.internalPending.delete(id);
        clearTimeout(pending.timer);
        if (kind === "error") pending.reject(frameError(frame));
        else pending.resolve(frame);
        return false;
      }
    }
    if (kind === "push" && readText(frame.type) === "auth.expiring") {
      void this.refreshAuthorization().catch((error) => {
        this.handleClosed(socket, generation, error instanceof Error ? error : new Error(String(error)));
        try {
          socket.close(1000, "auth refresh failed");
        } catch {
          // handleClosed already cleared local ownership.
        }
      });
      return false;
    }
    this.options.onFrame(frame, generation);
    return false;
  }

  private handleClosed(
    socket: AgentPlatformRealtimeSocket,
    generation: number,
    error: Error,
  ) {
    if (socket !== this.socket || generation !== this.generation) {
      return;
    }
    this.socket = null;
    this.connectPromise = null;
    this.clearHeartbeatTimer();
    this.physicalSessionId = "";
    this.negotiatedSilenceTimeoutMs = 0;
    this.lastHeartbeatSequence = 0;
    this.rejectInternalPending(error);
    const protocolMismatch = error.message.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH");
    this.lastCloseReason = error.message;
    this.publishState(this.disposed || protocolMismatch ? "closed" : "reconnecting", 0, error.message);
    if (
      !protocolMismatch && !this.disposed && !this.intentionallyClosing &&
      this.currentBaseUrl && this.currentToken
    ) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) {
      return;
    }
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * (2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    const random = this.options.random?.() ?? Math.random();
    const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4;
    const delay = Math.round(exponential * jitter);
    this.reconnectTimer = unrefTimer(setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectCount += 1;
      void this.refreshTokenForReconnect()
        .then(() => this.open(true))
        .catch((error) => {
          this.publishState("reconnecting", 0, error instanceof Error ? error.message : String(error));
          this.scheduleReconnect();
        });
    }, delay));
  }

  private async refreshTokenForReconnect() {
    const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      throw new Error(tokenResult.message || "connection_unavailable: access token unavailable");
    }
    const token = tokenResult.token.trim();
    const deviceId = getDesktopDeviceId(this.options.app);
    const identitySessionId = createAgentPlatformIdentitySessionId(token, deviceId);
    if (this.currentKey && identitySessionId !== this.currentKey.identitySessionId) {
      throw new Error("connection_unavailable: identity changed during reconnect");
    }
    this.currentToken = token;
  }

  private async refreshAuthorization() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const promise = (async () => {
      const tokenResult = await this.options.issueAccessToken(this.options.app, "unauthorized");
      if (!tokenResult.ok || !tokenResult.token.trim()) {
        throw new Error(tokenResult.message || "connection_unavailable: token refresh failed");
      }
      await this.refreshAuthorizationWithToken(tokenResult.token.trim(), true);
    })();
    this.refreshPromise = promise;
    try {
      await promise;
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    }
  }

  private async refreshAuthorizationWithToken(token: string, force = false) {
    if (!force && token === this.currentToken) {
      return;
    }
    const frame = await this.sendInternalRequest("auth.refresh", { token });
    if (Number(frame.code) !== 0) {
      throw frameError(frame);
    }
    this.currentToken = token;
  }

  private sendInternalRequest(type: string, payload: Record<string, unknown>) {
    const id = `desktop-main-${type}-${randomUUID()}`;
    return new Promise<AgentPlatformRealtimeFrame>((resolve, reject) => {
      const timer = unrefTimer(setTimeout(() => {
        this.internalPending.delete(id);
        reject(new Error(`${type} timed out`));
      }, AUTH_REQUEST_TIMEOUT_MS));
      this.internalPending.set(id, { resolve, reject, timer });
      try {
        this.send({ frame: "request", type, id, payload });
      } catch (error) {
        this.internalPending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resetHeartbeatTimer(
    socket: AgentPlatformRealtimeSocket,
    generation: number,
  ) {
    this.clearHeartbeatTimer();
    const timeoutMs = this.options.heartbeatTimeoutMs ?? this.negotiatedSilenceTimeoutMs;
    if (timeoutMs <= 0) return;
    this.heartbeatTimer = unrefTimer(setTimeout(() => {
      const error = new Error("PLATFORM_CONNECTION_UNAVAILABLE: Agent Platform inbound silence timed out");
      this.handleClosed(socket, generation, error);
      try {
        socket.close(1000, "heartbeat timeout");
      } catch {
        // handleClosed already cleared local ownership.
      }
    }, timeoutMs));
  }

  private clearHeartbeatTimer() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectInternalPending(error: Error) {
    for (const [id, pending] of this.internalPending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.internalPending.delete(id);
    }
  }

  private refreshLivenessState() {
    this.state = {
      ...this.state,
      ...(this.lastInboundAt ? { lastInboundAt: this.lastInboundAt } : {}),
      ...(this.lastHeartbeatAt ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
      ...(this.lastCloseReason ? { closeReason: this.lastCloseReason } : {}),
    };
  }
}
