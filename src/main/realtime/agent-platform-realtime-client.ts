import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
} from "../../shared/contracts";
import { getDesktopDeviceId } from "../device-identity";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
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

export type AgentPlatformRealtimeConnectionState = {
  phase: AgentWebclientConnectionPhase;
  generation: number;
  physicalConnectionCount: 0 | 1;
  reconnectCount: number;
  key: RealtimeConnectionKey | null;
  lastError?: string;
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

  requiresRotation(baseUrl: string, token: string) {
    if (!this.currentKey) return false;
    const nextKey = {
      endpoint: normalizeAgentPlatformRealtimeEndpoint(baseUrl),
      identitySessionId: createAgentPlatformIdentitySessionId(
        token,
        getDesktopDeviceId(this.options.app),
      ),
    };
    return this.currentKey.endpoint !== nextKey.endpoint ||
      this.currentKey.identitySessionId !== nextKey.identitySessionId;
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
    if (
      this.currentKey &&
      (this.currentKey.endpoint !== nextKey.endpoint ||
        this.currentKey.identitySessionId !== nextKey.identitySessionId)
    ) {
      this.rotateConnection("endpoint or identity changed");
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
      ...(lastError ? { lastError } : {}),
    };
    this.options.onState?.(this.getState());
  }

  private rotateConnection(reason: string) {
    this.intentionallyClosing = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
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
      socket.onopen = resolveOnce;
      socket.onmessage = (event) => {
        void this.handleMessage(socket, generation, event.data).catch((error) => {
          this.options.onDiagnostic?.(error instanceof Error ? error.message : String(error));
          this.handleClosed(socket, generation, error instanceof Error ? error : new Error(String(error)));
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
        const error = new Error("connection_unavailable: Agent Platform realtime connection timed out");
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
  ) {
    if (socket !== this.socket || generation !== this.generation) {
      this.options.onStaleFrame?.();
      return;
    }
    this.resetHeartbeatTimer(socket, generation);
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
    const id = readText(frame.id);
    if ((kind === "response" || kind === "error") && id) {
      const pending = this.internalPending.get(id);
      if (pending) {
        this.internalPending.delete(id);
        clearTimeout(pending.timer);
        if (kind === "error") pending.reject(frameError(frame));
        else pending.resolve(frame);
        return;
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
      return;
    }
    this.options.onFrame(frame, generation);
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
    this.rejectInternalPending(error);
    this.publishState(this.disposed ? "closed" : "reconnecting", 0, error.message);
    if (!this.disposed && !this.intentionallyClosing && this.currentBaseUrl && this.currentToken) {
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
    const timeoutMs = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (timeoutMs <= 0) return;
    this.heartbeatTimer = unrefTimer(setTimeout(() => {
      const error = new Error("connection_unavailable: Agent Platform heartbeat timed out");
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
}
