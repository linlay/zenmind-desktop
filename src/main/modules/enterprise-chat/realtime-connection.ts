import type {
  EnterpriseChatMessage,
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import {
  ENTERPRISE_CHAT_REMOTE_ACTION_NAMES
} from "../../../shared/enterprise-chat-actions";
import { ENTERPRISE_CHAT_RECONNECT_MAX_MS, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS, PendingWebSocketRequest, WebSocketLike, readWebSocketText, toWebSocketUrl } from "./connection-transport";
import { normalizeMessage } from "./message-projection";
import { errorMessage, isRecord, readNumber, readText } from "./protocol-values";

export interface RealtimeConnectionDependencies {
  readonly snapshot: EnterpriseChatSnapshot;
  readonly imSessionToken: string;
  requestJson<T>(path: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }, useImSessionToken?: boolean): Promise<T>;
  readonly createWebSocket: (url: string) => WebSocketLike;
  readonly serverUrl: string;
  socket: WebSocketLike | null;
  socketSynced: boolean;
  socketClosing: boolean;
  sendWebSocketRequest(type: string, payload: unknown): Promise<unknown>;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  handleWebSocketMessage(data: unknown): Promise<void>;
  rejectPendingRequests(error: Error): void;
  readonly getIdentityToken: () => string | null;
  scheduleReconnect(): void;
  readonly pendingRequests: Map<string, PendingWebSocketRequest>;
  reconnectAttempt: number;
  readonly platform: NodeJS.Platform;
  readonly app: Electron.App;
  refreshEmployeeDirectory(): Promise<void>;
  flushDesktopActionReceipts(): Promise<void>;
  refresh(): Promise<EnterpriseChatSnapshot>;
  applyPresence(userId: string, online: boolean): void;
  applyMessage(message: EnterpriseChatMessage): void;
  refreshConversationSummaries(): Promise<void>;
  nextRequestId(prefix: string): string;
  requestSequence: number;
  reconnectTimer: NodeJS.Timeout | null;
}

export async function connectWebSocket(dependencies: RealtimeConnectionDependencies) {
  if (!dependencies.snapshot.enabled || !dependencies.imSessionToken) {
    return;
  }
  const ticketResponse = await dependencies.requestJson<unknown>("/api/v1/ws-tickets", {
    method: "POST",
    body: "{}"
  });
  const ticketRecord = isRecord(ticketResponse) ? ticketResponse : {};
  const ticket = readText(ticketRecord.ticket);
  if (!ticket) {
    throw new Error("The IM server did not issue a WebSocket ticket.");
  }
  const socket = dependencies.createWebSocket(toWebSocketUrl(dependencies.serverUrl, ticket));
  dependencies.socket = socket;
  dependencies.socketSynced = false;
  dependencies.socketClosing = false;
  socket.onopen = () => {
    if (dependencies.socket !== socket) {
      return;
    }
    void dependencies.sendWebSocketRequest("sync.resume", {
      afterEventId: dependencies.snapshot.latestEventId
    }).catch((error) => {
      if (dependencies.socket !== socket || dependencies.socketClosing) {
        return;
      }
      dependencies.updateSnapshot({
        connectionState: "reconnecting",
        message: errorMessage(error)
      });
      socket.close();
    });
  };
  socket.onmessage = (event) => {
    if (dependencies.socket === socket) {
      void dependencies.handleWebSocketMessage(event.data);
    }
  };
  socket.onerror = () => {
    if (dependencies.socket === socket && !dependencies.socketClosing) {
      dependencies.updateSnapshot({
        connectionState: "reconnecting",
        message: "Enterprise chat WebSocket connection failed."
      });
    }
  };
  socket.onclose = () => {
    if (dependencies.socket !== socket) {
      return;
    }
    dependencies.socket = null;
    dependencies.socketSynced = false;
    dependencies.rejectPendingRequests(new Error("Enterprise chat connection closed."));
    if (!dependencies.socketClosing && dependencies.snapshot.enabled && dependencies.getIdentityToken()) {
      dependencies.updateSnapshot({
        connectionState: "reconnecting",
        message: ""
      });
      dependencies.scheduleReconnect();
    }
  };
}

export async function handleWebSocketMessage(dependencies: RealtimeConnectionDependencies, data: unknown) {
  const text = await readWebSocketText(data);
  if (!text) {
    return;
  }
  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return;
    }
    envelope = parsed;
  }
  catch {
    return;
  }
  const frame = readText(envelope.frame);
  const type = readText(envelope.type);
  if (frame === "response") {
    const id = readText(envelope.id);
    const pending = dependencies.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    dependencies.pendingRequests.delete(id);
    if (envelope.ok === true) {
      pending.resolve(envelope.result);
    }
    else {
      const error = isRecord(envelope.error) ? envelope.error : {};
      pending.reject(new Error(readText(error.message) || "Enterprise chat request failed."));
    }
    return;
  }
  if (frame !== "push") {
    return;
  }
  const eventId = Math.max(0, Math.trunc(readNumber(envelope.eventId)));
  if (eventId > dependencies.snapshot.latestEventId) {
    dependencies.snapshot.latestEventId = eventId;
  }
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  if (type === "sync.ready") {
    dependencies.socketSynced = true;
    dependencies.reconnectAttempt = 0;
    dependencies.updateSnapshot({
      connectionState: "connected",
      message: "",
      latestEventId: Math.max(dependencies.snapshot.latestEventId, Math.trunc(readNumber(payload.eventId)))
    });
    void dependencies.sendWebSocketRequest("device.capabilities.publish", {
      clientKind: "desktop",
      platform: dependencies.platform,
      clientVersion: dependencies.app.getVersion(),
      actions: ENTERPRISE_CHAT_REMOTE_ACTION_NAMES
    }).catch((error) => {
      dependencies.updateSnapshot({ message: errorMessage(error) });
    });
    void dependencies.refreshEmployeeDirectory();
    void dependencies.flushDesktopActionReceipts();
    return;
  }
  if (type === "sync.reset_required") {
    void dependencies.refresh();
    return;
  }
  if (type === "presence.changed") {
    const userRecord = isRecord(payload.user) ? payload.user : {};
    const userId = readText(payload.userId) || readText(userRecord.id);
    const online = typeof payload.online === "boolean"
      ? payload.online
      : typeof userRecord.online === "boolean"
        ? userRecord.online
        : null;
    if (userId && online !== null) {
      const knownUser = dependencies.snapshot.currentUser?.id === userId ||
        dependencies.snapshot.users.some((user) => user.id === userId);
      dependencies.applyPresence(userId, online);
      if (!knownUser) {
        void dependencies.refreshEmployeeDirectory();
      }
    }
    return;
  }
  if (type === "message.created" || type === "message.edited" || type === "message.revoked") {
    const message = normalizeMessage(payload.message);
    if (message.id) {
      dependencies.applyMessage(message);
    }
    void dependencies.refreshConversationSummaries();
    return;
  }
  if (type === "conversation.created" ||
    type === "conversation.updated" ||
    type === "member.added" ||
    type === "member.updated" ||
    type === "member.removed" ||
    type === "receipt.read") {
    void dependencies.refreshConversationSummaries();
  }
}

export function sendWebSocketRequest(dependencies: RealtimeConnectionDependencies, type: string, payload: unknown) {
  const socket = dependencies.socket;
  if (!socket || socket.readyState !== 1) {
    return Promise.reject(new Error("Enterprise chat connection is unavailable."));
  }
  const id = dependencies.nextRequestId(type);
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      dependencies.pendingRequests.delete(id);
      reject(new Error("Enterprise chat request timed out."));
    }, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    dependencies.pendingRequests.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({
      v: 1,
      frame: "request",
      id,
      type,
      payload
    }));
  });
}

export function nextRequestId(dependencies: RealtimeConnectionDependencies, prefix: string) {
  dependencies.requestSequence += 1;
  return `${prefix}-${Date.now()}-${dependencies.requestSequence}`;
}

export function scheduleReconnect(dependencies: RealtimeConnectionDependencies) {
  if (dependencies.reconnectTimer || !dependencies.snapshot.enabled) {
    return;
  }
  dependencies.reconnectAttempt += 1;
  const delay = Math.min(ENTERPRISE_CHAT_RECONNECT_MAX_MS, 1000 * 2 ** Math.min(dependencies.reconnectAttempt - 1, 5));
  dependencies.reconnectTimer = setTimeout(() => {
    dependencies.reconnectTimer = null;
    void dependencies.refresh();
  }, delay);
}

export function disconnect(dependencies: RealtimeConnectionDependencies) {
  if (dependencies.reconnectTimer) {
    clearTimeout(dependencies.reconnectTimer);
    dependencies.reconnectTimer = null;
  }
  dependencies.socketClosing = true;
  const socket = dependencies.socket;
  dependencies.socket = null;
  dependencies.socketSynced = false;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try {
      socket.close();
    }
    catch {
      // Closing an already-closed WebSocket is harmless.
    }
  }
  dependencies.rejectPendingRequests(new Error("Enterprise chat connection closed."));
}

export function rejectPendingRequests(dependencies: RealtimeConnectionDependencies, error: Error) {
  for (const pending of dependencies.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  dependencies.pendingRequests.clear();
}
