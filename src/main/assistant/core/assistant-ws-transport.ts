import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type { AgentAuthIssueResult } from "../../../shared/contracts";
import { requireAgentPlatformEpochMillis } from "../../../shared/time-contract";
import { getDesktopDeviceId } from "../../device-identity";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

export type AssistantWsLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type AssistantWsFactory = (url: string) => AssistantWsLike;

export class AssistantWsDisconnectedError extends Error {
  constructor(message = "Assistant WebSocket disconnected") {
    super(message);
    this.name = "AssistantWsDisconnectedError";
  }
}

export type AssistantWsQueryAccepted = {
  agentKey: string;
};

export type AssistantWsQueryCompleted = {
  reason: string;
  lastSeq?: number;
};

export type AssistantWsQueryHandle = {
  accepted: Promise<AssistantWsQueryAccepted>;
  completed: Promise<AssistantWsQueryCompleted>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

type QueryTransaction = {
  id: string;
  expectedRunId: string;
  expectedChatId: string;
  expectedAgentKey: string;
  signal?: AbortSignal;
  abortListener?: () => void;
  acceptanceTimer?: ReturnType<typeof setTimeout>;
  accepted: Deferred<AssistantWsQueryAccepted>;
  completed: Deferred<AssistantWsQueryCompleted>;
  bufferedEvents: Array<{ event: Record<string, unknown>; path: string }>;
  eventQueue: Promise<void>;
  onEvent: (event: Record<string, unknown>, path: string) => Promise<void> | void;
  eventIndex: number;
};

type ControlTransaction = {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  // A query can fail before its caller moves from `accepted` to `completed`.
  // Keep that second rejection observed without changing the promise returned to callers.
  void deferred.promise.catch(() => undefined);
  return deferred;
}

function createAbortError() {
  const error = new Error("Assistant query aborted");
  error.name = "AbortError";
  return error;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTerminalEventType(type: string) {
  return type === "done" ||
    type === "error" ||
    type === "stopped" ||
    type === "run.complete" ||
    type === "run.error" ||
    type === "run.cancel" ||
    type === "run.stopped" ||
    type === "run.interrupt" ||
    type === "run.expired";
}

function createWebSocketUrl(baseUrl: string, token: string, deviceId: string) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("source", "desktop-assistant");
  url.searchParams.set("deviceId", deviceId);
  return url.toString();
}

function defaultWebSocketFactory(url: string): AssistantWsLike {
  const WebSocketConstructor = globalThis.WebSocket as unknown as (new (target: string) => AssistantWsLike) | undefined;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is unavailable in the Electron main process");
  }
  return new WebSocketConstructor(url);
}

async function readMessageText(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text();
  }
  throw new Error("Assistant WebSocket received an unsupported message payload");
}

function frameError(frame: Record<string, unknown>) {
  const type = readString(frame.type) || "websocket_error";
  const message = readString(frame.msg) || readString(frame.message) || type;
  return new Error(`${type}: ${message}`);
}

export class AssistantWsTransport {
  private socket: AssistantWsLike | null = null;
  private socketBaseUrl = "";
  private socketToken = "";
  private connectPromise: Promise<AssistantWsLike> | null = null;
  private rejectConnect: ((error: unknown) => void) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly queries = new Map<string, QueryTransaction>();
  private readonly pendingQueryIds = new Set<string>();
  private readonly controls = new Map<string, ControlTransaction>();
  private readonly reverseRequestIds = new Set<string>();

  constructor(private readonly options: {
    app: App;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    createWebSocket?: AssistantWsFactory;
    connectTimeoutMs?: number;
    acceptanceTimeoutMs?: number;
  }) {}

  query(options: {
    baseUrl: string;
    token: string;
    id: string;
    payload: Record<string, unknown>;
    runId: string;
    chatId: string;
    agentKey?: string;
    signal?: AbortSignal;
    onEvent: (event: Record<string, unknown>, path: string) => Promise<void> | void;
  }): AssistantWsQueryHandle {
    const accepted = createDeferred<AssistantWsQueryAccepted>();
    const completed = createDeferred<AssistantWsQueryCompleted>();
    const id = options.id.trim();
    const transaction: QueryTransaction = {
      id,
      expectedRunId: options.runId,
      expectedChatId: options.chatId,
      expectedAgentKey: options.agentKey?.trim() || "",
      signal: options.signal,
      accepted,
      completed,
      bufferedEvents: [],
      eventQueue: Promise.resolve(),
      onEvent: options.onEvent,
      eventIndex: 0,
    };

    if (!id) {
      this.failQuery(transaction, new Error("Assistant WebSocket request id is required"));
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (this.disposed) {
      this.failQuery(transaction, createAbortError());
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (this.queries.has(id) || this.pendingQueryIds.has(id)) {
      this.failQuery(transaction, new Error(`duplicate_id: Assistant WebSocket request id ${id} is already active`));
      return { accepted: accepted.promise, completed: completed.promise };
    }

    if (options.signal) {
      transaction.abortListener = () => this.failQuery(transaction, createAbortError());
      options.signal.addEventListener("abort", transaction.abortListener, { once: true });
    }
    this.pendingQueryIds.add(id);
    void this.startQuery(transaction, options.baseUrl, options.token, options.payload);
    return { accepted: accepted.promise, completed: completed.promise };
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const abortError = createAbortError();
    this.rejectConnect?.(abortError);
    this.rejectConnect = null;
    for (const transaction of [...this.queries.values()]) {
      this.failQuery(transaction, abortError);
    }
    for (const control of this.controls.values()) {
      clearTimeout(control.timer);
      control.reject(abortError);
    }
    this.controls.clear();
    const socket = this.socket;
    this.socket = null;
    this.socketBaseUrl = "";
    this.socketToken = "";
    this.connectPromise = null;
    this.refreshPromise = null;
    this.pendingQueryIds.clear();
    this.reverseRequestIds.clear();
    try {
      socket?.close(1000, "desktop-assistant disposed");
    } catch {
      // The socket is already unusable; local transactions are already cleaned up.
    }
  }

  private async startQuery(
    transaction: QueryTransaction,
    baseUrl: string,
    token: string,
    payload: Record<string, unknown>,
  ) {
    try {
      const socket = await this.ensureConnected(baseUrl, token);
      if (transaction.completed.settled || transaction.signal?.aborted) {
        throw createAbortError();
      }
      this.pendingQueryIds.delete(transaction.id);
      this.queries.set(transaction.id, transaction);
      transaction.acceptanceTimer = setTimeout(() => {
        this.failQuery(transaction, new Error("Assistant query timed out waiting for run.start"));
      }, this.options.acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        frame: "request",
        type: "/api/query",
        id: transaction.id,
        payload,
      }));
    } catch (error) {
      this.failQuery(transaction, error);
    }
  }

  private async ensureConnected(baseUrl: string, token: string) {
    if (this.disposed) {
      throw createAbortError();
    }
    if (this.connectPromise) {
      const socket = await this.connectPromise;
      if (baseUrl !== this.socketBaseUrl) {
        throw new Error("Assistant WebSocket base URL changed while connecting");
      }
      if (token !== this.socketToken) {
        await this.refreshAuthorizationWithToken(token);
      }
      return socket;
    }
    if (this.socket && this.socketBaseUrl === baseUrl) {
      if (token !== this.socketToken) {
        await this.refreshAuthorizationWithToken(token);
      }
      return this.socket;
    }
    if (this.socket) {
      const previous = this.socket;
      this.handleDisconnect(new AssistantWsDisconnectedError("Assistant WebSocket endpoint changed"), previous);
      try {
        previous.close(1000, "endpoint changed");
      } catch {
        // The endpoint is already unusable.
      }
    }

    const factory = this.options.createWebSocket ?? defaultWebSocketFactory;
    const socket = factory(createWebSocketUrl(baseUrl, token, getDesktopDeviceId(this.options.app)));
    this.socket = socket;
    this.socketBaseUrl = baseUrl;
    this.socketToken = token;
    this.reverseRequestIds.clear();
    const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const connectPromise = new Promise<AssistantWsLike>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
        }
        this.rejectConnect = null;
        resolve(socket);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
        }
        this.rejectConnect = null;
        reject(error);
      };
      this.rejectConnect = rejectOnce;
      socket.onopen = resolveOnce;
      socket.onmessage = (event) => {
        void this.handleMessage(socket, event.data).catch((error) => {
          this.handleDisconnect(error, socket);
          try {
            socket.close(1002, "invalid assistant frame");
          } catch {
            // The socket is already unusable.
          }
        });
      };
      socket.onerror = () => {
        const error = new AssistantWsDisconnectedError("Assistant WebSocket connection failed");
        rejectOnce(error);
        this.handleDisconnect(error, socket);
      };
      socket.onclose = () => {
        const error = new AssistantWsDisconnectedError();
        rejectOnce(error);
        this.handleDisconnect(error, socket);
      };
      connectTimer = setTimeout(() => {
        const error = new AssistantWsDisconnectedError("Assistant WebSocket connection timed out");
        rejectOnce(error);
        this.handleDisconnect(error, socket);
        try {
          socket.close(1000, "connect timeout");
        } catch {
          // The socket is already unusable.
        }
      }, connectTimeoutMs);
    });
    this.connectPromise = connectPromise;
    try {
      return await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  private async handleMessage(socket: AssistantWsLike, data: unknown) {
    if (socket !== this.socket) {
      return;
    }
    const text = await readMessageText(data);
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Assistant WebSocket frame must be an object");
    }
    const frame = readString(parsed.frame);
    if (frame === "stream") {
      this.handleStreamFrame(parsed);
      return;
    }
    if (frame === "error") {
      this.handleErrorFrame(parsed);
      return;
    }
    if (frame === "response") {
      this.handleResponseFrame(parsed);
      return;
    }
    if (frame === "push") {
      this.handlePushFrame(parsed);
      return;
    }
    if (frame === "request") {
      this.handleReverseRequest(socket, parsed);
      return;
    }
    throw new Error(`Assistant WebSocket received unknown frame type: ${frame || "<empty>"}`);
  }

  private handleStreamFrame(frame: Record<string, unknown>) {
    const id = readString(frame.id);
    const transaction = this.queries.get(id);
    if (!transaction) {
      return;
    }
    if (isRecord(frame.event)) {
      try {
        this.handleQueryEvent(transaction, frame.event);
      } catch (error) {
        this.failQuery(transaction, error);
        return;
      }
    }
    const reason = readString(frame.reason);
    if (!reason) {
      return;
    }
    if (!transaction.accepted.settled) {
      this.failQuery(transaction, new Error("Assistant query ended before a valid run.start event"));
      return;
    }
    const lastSeq = typeof frame.lastSeq === "number" && Number.isFinite(frame.lastSeq)
      ? frame.lastSeq
      : undefined;
    transaction.eventQueue.then(() => {
      this.cleanupQuery(transaction);
      transaction.completed.resolve({ reason, ...(lastSeq !== undefined ? { lastSeq } : {}) });
    }).catch((error) => this.failQuery(transaction, error));
  }

  private handleQueryEvent(transaction: QueryTransaction, event: Record<string, unknown>) {
    const path = `ws.query[${transaction.id}].events[${transaction.eventIndex}]`;
    transaction.eventIndex += 1;
    const type = readString(event.type);
    if (!type) {
      throw new Error("time_contract_violation: stream event.type is required");
    }
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventRunId = readString(event.runId);
    const eventChatId = readString(event.chatId);
    if (eventRunId && eventRunId !== transaction.expectedRunId) {
      throw new Error(`Assistant stream identity conflict: expected runId ${transaction.expectedRunId}, received ${eventRunId}`);
    }
    if (eventChatId && eventChatId !== transaction.expectedChatId) {
      throw new Error(`Assistant stream identity conflict: expected chatId ${transaction.expectedChatId}, received ${eventChatId}`);
    }

    if (!transaction.accepted.settled) {
      transaction.bufferedEvents.push({ event, path });
      if (type === "run.start") {
        if (eventRunId !== transaction.expectedRunId || eventChatId !== transaction.expectedChatId) {
          throw new Error("Assistant run.start must carry the requested runId and chatId");
        }
        const agentKey = readString(event.agentKey);
        if (!agentKey) {
          throw new Error("Assistant run.start must carry agentKey owner identity");
        }
        if (transaction.expectedAgentKey && agentKey !== transaction.expectedAgentKey) {
          throw new Error(`Assistant stream identity conflict: expected agentKey ${transaction.expectedAgentKey}, received ${agentKey}`);
        }
        if (transaction.acceptanceTimer) {
          clearTimeout(transaction.acceptanceTimer);
          transaction.acceptanceTimer = undefined;
        }
        transaction.accepted.resolve({ agentKey });
        const buffered = transaction.bufferedEvents.splice(0);
        // Resolving acceptance first gives startRun its stronger ACK boundary;
        // buffered chat events are then broadcast in their original order.
        transaction.eventQueue = transaction.eventQueue.then(async () => {
          await Promise.resolve();
          for (const bufferedEvent of buffered) {
            await transaction.onEvent(bufferedEvent.event, bufferedEvent.path);
          }
        });
        void transaction.eventQueue.catch((error) => this.failQuery(transaction, error));
        return;
      }
      if (isTerminalEventType(type)) {
        throw new Error("Assistant query produced a terminal event before run.start");
      }
      return;
    }

    transaction.eventQueue = transaction.eventQueue.then(() => transaction.onEvent(event, path));
    void transaction.eventQueue.catch((error) => this.failQuery(transaction, error));
  }

  private handleErrorFrame(frame: Record<string, unknown>) {
    const id = readString(frame.id);
    const control = this.controls.get(id);
    if (control) {
      this.controls.delete(id);
      clearTimeout(control.timer);
      control.reject(frameError(frame));
      return;
    }
    const transaction = this.queries.get(id);
    if (transaction) {
      this.failQuery(transaction, frameError(frame));
    }
  }

  private handleResponseFrame(frame: Record<string, unknown>) {
    const id = readString(frame.id);
    const control = this.controls.get(id);
    if (!control) {
      return;
    }
    this.controls.delete(id);
    clearTimeout(control.timer);
    if (Number(frame.code) !== 0) {
      control.reject(frameError(frame));
      return;
    }
    control.resolve(frame);
  }

  private handlePushFrame(frame: Record<string, unknown>) {
    const type = readString(frame.type);
    if (type === "heartbeat" || type === "connected") {
      return;
    }
    if (type === "auth.expiring") {
      void this.refreshAuthorization().catch((error) => {
        const socket = this.socket;
        if (!socket) {
          return;
        }
        this.handleDisconnect(error, socket);
        try {
          socket.close(1000, "auth refresh failed");
        } catch {
          // The socket is already unusable.
        }
      });
    }
  }

  private handleReverseRequest(socket: AssistantWsLike, frame: Record<string, unknown>) {
    const id = readString(frame.id);
    const requestType = readString(frame.type);
    if (!id) {
      return;
    }
    if (this.reverseRequestIds.has(id)) {
      this.sendError(socket, id, "duplicate_id", 409, "request id was already handled");
      return;
    }
    this.reverseRequestIds.add(id);
    if (requestType.startsWith("webclient.")) {
      this.sendError(socket, id, "unsupported_in_current_view", 409, "Desktop Assistant has no Agent WebClient action surface");
      return;
    }
    this.sendError(socket, id, "unknown_request_type", 404, `unsupported reverse request type: ${requestType || "<empty>"}`);
  }

  private sendError(socket: AssistantWsLike, id: string, type: string, code: number, msg: string) {
    socket.send(JSON.stringify({
      frame: "error",
      type,
      id,
      code,
      msg,
      data: { code: type, message: msg },
    }));
  }

  private async refreshAuthorization() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const refreshPromise = (async () => {
      const tokenResult = await this.options.issueAccessToken(this.options.app, "unauthorized");
      if (!tokenResult.ok || !tokenResult.token.trim()) {
        throw new Error(tokenResult.message || "Agent Platform access token refresh failed");
      }
      await this.refreshAuthorizationWithToken(tokenResult.token.trim(), true);
    })();
    this.refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null;
      }
    }
  }

  private async refreshAuthorizationWithToken(token: string, force = false) {
    if (!force && token === this.socketToken) {
      return;
    }
    const socket = this.socket;
    if (!socket) {
      throw new AssistantWsDisconnectedError();
    }
    await this.sendControlRequest(socket, "auth.refresh", { token });
    this.socketToken = token;
  }

  private sendControlRequest(socket: AssistantWsLike, type: string, payload: Record<string, unknown>) {
    const id = `desktop-assistant-${type}-${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error(`${type} timed out`));
      }, CONTROL_REQUEST_TIMEOUT_MS);
      this.controls.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ frame: "request", type, id, payload }));
      } catch (error) {
        this.controls.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private failQuery(transaction: QueryTransaction, error: unknown) {
    this.cleanupQuery(transaction);
    transaction.accepted.reject(error);
    transaction.completed.reject(error);
  }

  private cleanupQuery(transaction: QueryTransaction) {
    this.pendingQueryIds.delete(transaction.id);
    if (this.queries.get(transaction.id) === transaction) {
      this.queries.delete(transaction.id);
    }
    if (transaction.acceptanceTimer) {
      clearTimeout(transaction.acceptanceTimer);
      transaction.acceptanceTimer = undefined;
    }
    if (transaction.signal && transaction.abortListener) {
      transaction.signal.removeEventListener("abort", transaction.abortListener);
      transaction.abortListener = undefined;
    }
  }

  private handleDisconnect(error: unknown, socket: AssistantWsLike) {
    if (socket !== this.socket) {
      return;
    }
    const disconnectError = error instanceof AssistantWsDisconnectedError
      ? error
      : new AssistantWsDisconnectedError(error instanceof Error ? error.message : String(error));
    this.rejectConnect?.(disconnectError);
    this.rejectConnect = null;
    this.socket = null;
    this.socketBaseUrl = "";
    this.socketToken = "";
    this.connectPromise = null;
    this.refreshPromise = null;
    this.reverseRequestIds.clear();
    for (const transaction of [...this.queries.values()]) {
      this.failQuery(transaction, disconnectError);
    }
    for (const control of this.controls.values()) {
      clearTimeout(control.timer);
      control.reject(disconnectError);
    }
    this.controls.clear();
  }
}
