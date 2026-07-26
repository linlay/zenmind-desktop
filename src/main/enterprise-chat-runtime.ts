import type { App } from "electron";
import type {
  EnterpriseChatConnectionState,
  EnterpriseChatConversation,
  EnterpriseChatMarkReadInput,
  EnterpriseChatMessage,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../shared/contracts";
import type { EpochMilliseconds } from "../shared/time-contract";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { getDesktopSsoAccessToken } from "./oidc-sso";

const DEFAULT_ENTERPRISE_CHAT_SERVER_URL = "http://127.0.0.1:11956";
const ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS = 15_000;
const ENTERPRISE_CHAT_RECONNECT_MAX_MS = 30_000;

type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

type WebSocketMessageEventLike = { data: unknown };

type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

type PendingWebSocketRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type EnterpriseChatRuntimeOptions = {
  app: App;
  serverUrl?: string;
  initialEnabled?: boolean;
  fetchImpl?: FetchLike;
  createWebSocket?: (url: string) => WebSocketLike;
  getIdentityToken?: () => string | null;
  getDeviceInfo?: () => { deviceId: string; deviceName: string };
  onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
};

type ServerSession = {
  token: string;
  expiresAt: number;
  user: EnterpriseChatUser;
};

type ServerBootstrap = {
  user: EnterpriseChatUser;
  conversations: EnterpriseChatConversation[];
  latestEventId: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readEpochMilliseconds(value: unknown): EpochMilliseconds {
  return Math.max(0, Math.trunc(readNumber(value))) as EpochMilliseconds;
}

function readOnline(value: Record<string, unknown>) {
  if (typeof value.online === "boolean") {
    return value.online;
  }
  // `status=active` is an account state, not a live connection signal.
  return null;
}

function normalizeUser(value: unknown): EnterpriseChatUser {
  const record = isRecord(value) ? value : {};
  return {
    id: readText(record.id),
    displayName: readText(record.displayName) || readText(record.email) || readText(record.id),
    email: readText(record.email),
    avatarUrl: readText(record.avatarUrl),
    status: readText(record.status),
    online: readOnline(record)
  };
}

function normalizeMessage(value: unknown): EnterpriseChatMessage {
  const record = isRecord(value) ? value : {};
  const editedAt = readNumber(record.editedAt);
  const revokedAt = readNumber(record.revokedAt);
  return {
    id: readText(record.id),
    conversationId: readText(record.conversationId),
    seq: Math.max(0, Math.trunc(readNumber(record.seq))),
    senderId: readText(record.senderId),
    clientMessageId: readText(record.clientMessageId),
    kind: readText(record.kind) || "text",
    body: readText(record.body),
    createdAt: readEpochMilliseconds(record.createdAt),
    ...(editedAt > 0 ? { editedAt: readEpochMilliseconds(editedAt) } : {}),
    ...(revokedAt > 0 ? { revokedAt: readEpochMilliseconds(revokedAt) } : {})
  };
}

function normalizeConversation(value: unknown): EnterpriseChatConversation | null {
  const record = isRecord(value) ? value : {};
  if (readText(record.type) !== "direct") {
    return null;
  }
  const members = Array.isArray(record.members)
    ? record.members
      .map((member) => {
        const memberRecord = isRecord(member) ? member : {};
        const user = normalizeUser(memberRecord.user);
        return {
          user,
          role: readText(memberRecord.role),
          joinedSeq: Math.max(0, Math.trunc(readNumber(memberRecord.joinedSeq)))
        };
      })
      .filter((member) => member.user.id)
    : [];
  const lastMessage = isRecord(record.lastMessage)
    ? normalizeMessage(record.lastMessage)
    : null;
  const id = readText(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    type: "direct",
    title: readText(record.title),
    lastReadSeq: Math.max(0, Math.trunc(readNumber(record.lastReadSeq))),
    lastSeq: Math.max(0, Math.trunc(readNumber(record.lastSeq))),
    unreadCount: Math.max(0, Math.trunc(readNumber(record.unreadCount))),
    lastMessage,
    members,
    createdAt: readEpochMilliseconds(record.createdAt),
    updatedAt: readEpochMilliseconds(record.updatedAt)
  };
}

function normalizeConversations(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeConversation).filter((item): item is EnterpriseChatConversation => item !== null)
    : [];
}

function normalizeMessages(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeMessage).filter((item) => item.id && item.conversationId)
    : [];
}

function normalizeServerUrl(value: string | undefined) {
  const candidate = readText(value) || DEFAULT_ENTERPRISE_CHAT_SERVER_URL;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Enterprise chat server URL must use HTTP or HTTPS.");
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1"
  ) {
    throw new Error("Remote enterprise chat servers must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function toWebSocketUrl(serverUrl: string, ticket: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws`;
  url.search = "";
  url.searchParams.set("v", "1");
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function createDefaultWebSocket(url: string): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as unknown as { WebSocket?: new (targetUrl: string) => WebSocketLike }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("This Desktop runtime does not provide WebSocket support.");
  }
  return new WebSocketConstructor(url);
}

function nowEpochMilliseconds() {
  return Date.now() as EpochMilliseconds;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readWebSocketText(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (isRecord(data) && typeof data.text === "function") {
    return String(await (data.text as () => Promise<string>)());
  }
  return "";
}

function mergeMessage(messages: EnterpriseChatMessage[], message: EnterpriseChatMessage) {
  const next = messages.filter((item) => item.id !== message.id);
  next.push(message);
  return next.sort((left, right) => left.seq - right.seq);
}

export class EnterpriseChatRuntime {
  private readonly app: App;
  private readonly serverUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly getIdentityToken: () => string | null;
  private readonly getDeviceInfo: () => { deviceId: string; deviceName: string };
  private readonly onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
  private snapshot: EnterpriseChatSnapshot;
  private collaborationToken = "";
  private collaborationTokenExpiresAt = 0;
  private socket: WebSocketLike | null = null;
  private socketSynced = false;
  private socketClosing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSequence = 0;
  private presenceRevision = 0;
  private pendingRequests = new Map<string, PendingWebSocketRequest>();
  private refreshPromise: Promise<EnterpriseChatSnapshot> | null = null;

  constructor(options: EnterpriseChatRuntimeOptions) {
    this.app = options.app;
    this.serverUrl = normalizeServerUrl(
      options.serverUrl ?? process.env.DESKTOP_COLLABORATION_SERVER_URL
    );
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.createWebSocket = options.createWebSocket ?? createDefaultWebSocket;
    this.getIdentityToken = options.getIdentityToken ?? getDesktopSsoAccessToken;
    this.getDeviceInfo = options.getDeviceInfo ?? (() => getDesktopDeviceInfo(this.app));
    this.onStateChanged = options.onStateChanged;
    const initialEnabled = options.initialEnabled ?? true;
    this.snapshot = {
      enabled: initialEnabled,
      connectionState: initialEnabled ? "signed_out" : "disabled",
      message: "",
      serverUrl: this.serverUrl,
      currentUser: null,
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0,
      updatedAt: nowEpochMilliseconds()
    };
  }

  getState() {
    return {
      ...this.snapshot,
      currentUser: this.snapshot.currentUser ? { ...this.snapshot.currentUser } : null,
      users: this.snapshot.users.map((user) => ({ ...user })),
      conversations: this.snapshot.conversations.map((conversation) => ({
        ...conversation,
        lastMessage: conversation.lastMessage ? { ...conversation.lastMessage } : null,
        members: conversation.members.map((member) => ({
          ...member,
          user: { ...member.user }
        }))
      })),
      activeMessages: this.snapshot.activeMessages.map((message) => ({ ...message }))
    };
  }

  async setEnabled(enabled: boolean) {
    if (!enabled) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        enabled: false,
        connectionState: "disabled",
        message: "",
        currentUser: null,
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
      return this.getState();
    }

    const wasEnabled = this.snapshot.enabled;
    this.updateSnapshot({
      enabled: true,
      connectionState: this.getIdentityToken() ? "connecting" : "signed_out",
      message: ""
    });
    if (!wasEnabled || !this.socket) {
      return this.refresh();
    }
    return this.getState();
  }

  async refresh() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performRefresh() {
    if (!this.snapshot.enabled) {
      return this.getState();
    }
    const identityToken = readText(this.getIdentityToken());
    if (!identityToken) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        connectionState: "signed_out",
        message: "",
        currentUser: null,
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
      return this.getState();
    }

    this.disconnect();
    this.updateSnapshot({ connectionState: "connecting", message: "" });
    try {
      const session = await this.exchangeSession(identityToken);
      this.collaborationToken = session.token;
      this.collaborationTokenExpiresAt = session.expiresAt;
      this.scheduleSessionRefresh();

      const [bootstrap, users] = await Promise.all([
        this.requestBootstrap(),
        this.requestUsers()
      ]);
      this.updateSnapshot({
        currentUser: bootstrap.user.id ? bootstrap.user : session.user,
        users: users.filter((user) => user.id && user.id !== bootstrap.user.id),
        conversations: bootstrap.conversations,
        latestEventId: bootstrap.latestEventId,
        activeConversationId: "",
        activeMessages: [],
        connectionState: "connecting",
        message: ""
      });
      await this.connectWebSocket();
    } catch (error) {
      this.disconnect();
      this.clearSession();
      this.updateSnapshot({
        connectionState: "error",
        message: errorMessage(error),
        currentUser: null,
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
      });
    }
    return this.getState();
  }

  async openDirectConversation(input: EnterpriseChatOpenDirectInput) {
    const userId = readText(input?.userId);
    if (!userId || userId === this.snapshot.currentUser?.id) {
      throw new Error("A different enterprise employee is required.");
    }
    await this.ensureSession();
    let conversation = this.snapshot.conversations.find((item) =>
      item.members.some((member) => member.user.id === userId)
    );
    if (!conversation) {
      const created = await this.requestJson<unknown>("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "direct",
          memberIds: [userId]
        })
      });
      conversation = normalizeConversation(created) ?? undefined;
      if (!conversation) {
        throw new Error("The collaboration server returned an invalid direct conversation.");
      }
      this.snapshot.conversations = [
        conversation,
        ...this.snapshot.conversations.filter((item) => item.id !== conversation?.id)
      ];
    }
    const response = await this.requestJson<unknown>(
      `/api/v1/conversations/${encodeURIComponent(conversation.id)}/messages?limit=50`
    );
    const record = isRecord(response) ? response : {};
    const messages = normalizeMessages(record.items);
    this.updateSnapshot({
      conversations: [
        conversation,
        ...this.snapshot.conversations.filter((item) => item.id !== conversation?.id)
      ],
      activeConversationId: conversation.id,
      activeMessages: messages,
      message: ""
    });
    if (conversation.lastSeq > conversation.lastReadSeq) {
      await this.markRead({ conversationId: conversation.id, seq: conversation.lastSeq });
    }
    return this.getState();
  }

  async sendMessage(input: EnterpriseChatSendMessageInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const body = readText(input?.body);
    if (!conversationId || !clientMessageId || !body) {
      throw new Error("conversationId, clientMessageId, and body are required.");
    }
    if (!this.socket || !this.socketSynced || this.socket.readyState !== 1) {
      throw new Error("Enterprise chat is reconnecting. Try again in a moment.");
    }
    const result = await this.sendWebSocketRequest("message.send", {
      conversationId,
      clientMessageId,
      body,
      mentionUserIds: [],
      fileIds: []
    });
    const record = isRecord(result) ? result : {};
    const message = normalizeMessage(record.message);
    if (message.id) {
      this.applyMessage(message);
    }
    return this.getState();
  }

  async markRead(input: EnterpriseChatMarkReadInput) {
    const conversationId = readText(input?.conversationId);
    const seq = Math.max(0, Math.trunc(readNumber(input?.seq)));
    if (!conversationId || seq <= 0) {
      return this.getState();
    }
    if (this.socket && this.socketSynced && this.socket.readyState === 1) {
      await this.sendWebSocketRequest("receipt.read", { conversationId, seq });
    }
    this.updateSnapshot({
      conversations: this.snapshot.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              lastReadSeq: Math.max(conversation.lastReadSeq, seq),
              unreadCount: 0
            }
          : conversation
      )
    });
    return this.getState();
  }

  handleSignedOut() {
    this.disconnect();
    this.clearSession();
    this.updateSnapshot({
      connectionState: this.snapshot.enabled ? "signed_out" : "disabled",
      message: "",
      currentUser: null,
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0
    });
  }

  stop() {
    this.disconnect();
    this.clearSession();
  }

  private async ensureSession() {
    if (
      this.collaborationToken &&
      this.collaborationTokenExpiresAt > Date.now() + 30_000
    ) {
      return;
    }
    const state = await this.refresh();
    if (!this.collaborationToken || state.connectionState === "error") {
      throw new Error(state.message || "Enterprise chat session is unavailable.");
    }
  }

  private async exchangeSession(identityToken: string): Promise<ServerSession> {
    const device = this.getDeviceInfo();
    const response = await this.requestJson<unknown>("/api/v1/session/exchange", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identityToken}`
      },
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceName: device.deviceName
      })
    }, false);
    const record = isRecord(response) ? response : {};
    const token = readText(record.token);
    const expiresAt = readNumber(record.expiresAt);
    const user = normalizeUser(record.user);
    if (!token || expiresAt <= Date.now() || !user.id) {
      throw new Error("The collaboration server returned an invalid session.");
    }
    return { token, expiresAt, user };
  }

  private async requestBootstrap(): Promise<ServerBootstrap> {
    const response = await this.requestJson<unknown>("/api/v1/sync/bootstrap");
    const record = isRecord(response) ? response : {};
    const user = normalizeUser(record.user);
    if (!user.id) {
      throw new Error("The collaboration server returned an invalid employee identity.");
    }
    return {
      user,
      conversations: normalizeConversations(record.conversations),
      latestEventId: Math.max(0, Math.trunc(readNumber(record.latestEventId)))
    };
  }

  private async requestUsers() {
    const users: EnterpriseChatUser[] = [];
    const pageSize = 100;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const response = await this.requestJson<unknown>(
        `/api/v1/users?limit=${pageSize}&offset=${offset}`
      );
      const record = isRecord(response) ? response : {};
      const page = Array.isArray(record.items)
        ? record.items.map(normalizeUser).filter((user) => user.id)
        : [];
      users.push(...page);
      if (page.length < pageSize) {
        break;
      }
    }
    return users;
  }

  private async requestJson<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
    useCollaborationToken = true
  ): Promise<T> {
    if (!this.fetchImpl) {
      throw new Error("This Desktop runtime does not provide fetch support.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    };
    if (useCollaborationToken) {
      if (!this.collaborationToken) {
        clearTimeout(timeout);
        throw new Error("Enterprise chat session is unavailable.");
      }
      headers.Authorization = `Bearer ${this.collaborationToken}`;
    }
    try {
      const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json();
          const record = isRecord(payload) ? payload : {};
          const error = isRecord(record.error) ? record.error : {};
          detail = readText(error.message) || readText(record.message);
        } catch {
          detail = readText(await response.text().catch(() => ""));
        }
        throw new Error(detail || `Enterprise chat request failed (${response.status}).`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async connectWebSocket() {
    if (!this.snapshot.enabled || !this.collaborationToken) {
      return;
    }
    const ticketResponse = await this.requestJson<unknown>("/api/v1/ws-tickets", {
      method: "POST",
      body: "{}"
    });
    const ticketRecord = isRecord(ticketResponse) ? ticketResponse : {};
    const ticket = readText(ticketRecord.ticket);
    if (!ticket) {
      throw new Error("The collaboration server did not issue a WebSocket ticket.");
    }
    const socket = this.createWebSocket(toWebSocketUrl(this.serverUrl, ticket));
    this.socket = socket;
    this.socketSynced = false;
    this.socketClosing = false;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      void this.sendWebSocketRequest("sync.resume", {
        afterEventId: this.snapshot.latestEventId
      }).catch((error) => {
        if (this.socket !== socket || this.socketClosing) {
          return;
        }
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: errorMessage(error)
        });
        socket.close();
      });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        void this.handleWebSocketMessage(event.data);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket && !this.socketClosing) {
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: "Enterprise chat WebSocket connection failed."
        });
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.socketSynced = false;
      this.rejectPendingRequests(new Error("Enterprise chat connection closed."));
      if (!this.socketClosing && this.snapshot.enabled && this.getIdentityToken()) {
        this.updateSnapshot({
          connectionState: "reconnecting",
          message: ""
        });
        this.scheduleReconnect();
      }
    };
  }

  private async handleWebSocketMessage(data: unknown) {
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
    } catch {
      return;
    }
    const frame = readText(envelope.frame);
    const type = readText(envelope.type);
    if (frame === "response") {
      const id = readText(envelope.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      if (envelope.ok === true) {
        pending.resolve(envelope.result);
      } else {
        const error = isRecord(envelope.error) ? envelope.error : {};
        pending.reject(new Error(readText(error.message) || "Enterprise chat request failed."));
      }
      return;
    }
    if (frame !== "push") {
      return;
    }
    const eventId = Math.max(0, Math.trunc(readNumber(envelope.eventId)));
    if (eventId > this.snapshot.latestEventId) {
      this.snapshot.latestEventId = eventId;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    if (type === "sync.ready") {
      this.socketSynced = true;
      this.reconnectAttempt = 0;
      this.updateSnapshot({
        connectionState: "connected",
        message: "",
        latestEventId: Math.max(
          this.snapshot.latestEventId,
          Math.trunc(readNumber(payload.eventId))
        )
      });
      void this.refreshEmployeeDirectory();
      return;
    }
    if (type === "sync.reset_required") {
      void this.refresh();
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
        const knownUser = this.snapshot.currentUser?.id === userId ||
          this.snapshot.users.some((user) => user.id === userId);
        this.applyPresence(userId, online);
        if (!knownUser) {
          void this.refreshEmployeeDirectory();
        }
      }
      return;
    }
    if (type === "message.created" || type === "message.edited" || type === "message.revoked") {
      const message = normalizeMessage(payload.message);
      if (message.id) {
        this.applyMessage(message);
      }
      void this.refreshConversationSummaries();
      return;
    }
    if (
      type === "conversation.created" ||
      type === "conversation.updated" ||
      type === "member.added" ||
      type === "member.updated" ||
      type === "member.removed" ||
      type === "receipt.read"
    ) {
      void this.refreshConversationSummaries();
    }
  }

  private applyMessage(message: EnterpriseChatMessage) {
    const isActive = this.snapshot.activeConversationId === message.conversationId;
    this.updateSnapshot({
      activeMessages: isActive
        ? mergeMessage(this.snapshot.activeMessages, message)
        : this.snapshot.activeMessages,
      conversations: this.snapshot.conversations.map((conversation) =>
        conversation.id === message.conversationId
          ? {
              ...conversation,
              lastSeq: Math.max(conversation.lastSeq, message.seq),
              lastMessage: message,
              updatedAt: message.createdAt,
              unreadCount: message.senderId !== this.snapshot.currentUser?.id && !isActive
                ? conversation.unreadCount + 1
                : conversation.unreadCount
            }
          : conversation
      )
    });
  }

  private applyPresence(userId: string, online: boolean) {
    this.presenceRevision += 1;
    const updateUser = (user: EnterpriseChatUser) =>
      user.id === userId ? { ...user, online } : user;
    this.updateSnapshot({
      currentUser: this.snapshot.currentUser
        ? updateUser(this.snapshot.currentUser)
        : null,
      users: this.snapshot.users.map(updateUser),
      conversations: this.snapshot.conversations.map((conversation) => ({
        ...conversation,
        members: conversation.members.map((member) => ({
          ...member,
          user: updateUser(member.user)
        }))
      }))
    });
  }

  private async refreshConversationSummaries() {
    try {
      const response = await this.requestJson<unknown>("/api/v1/conversations");
      const record = isRecord(response) ? response : {};
      this.updateSnapshot({
        conversations: normalizeConversations(record.items)
      });
    } catch {
      // The next durable event or manual refresh will retry the summary projection.
    }
  }

  private async refreshEmployeeDirectory() {
    const revisionAtRequestStart = this.presenceRevision;
    try {
      let users = await this.requestUsers();
      if (this.presenceRevision !== revisionAtRequestStart) {
        const livePresence = new Map(
          this.snapshot.users.map((user) => [user.id, user.online] as const)
        );
        users = users.map((user) =>
          livePresence.has(user.id)
            ? { ...user, online: livePresence.get(user.id) ?? null }
            : user
        );
      }
      const currentUserId = this.snapshot.currentUser?.id ?? "";
      this.updateSnapshot({
        users: users.filter((user) => user.id !== currentUserId)
      });
    } catch {
      // Presence pushes remain usable; the next sync or manual refresh retries the directory.
    }
  }

  private sendWebSocketRequest(type: string, payload: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Enterprise chat connection is unavailable."));
    }
    const id = this.nextRequestId(type);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Enterprise chat request timed out."));
      }, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({
        v: 1,
        frame: "request",
        id,
        type,
        payload
      }));
    });
  }

  private nextRequestId(prefix: string) {
    this.requestSequence += 1;
    return `${prefix}-${Date.now()}-${this.requestSequence}`;
  }

  private updateSnapshot(patch: Partial<EnterpriseChatSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      updatedAt: nowEpochMilliseconds()
    };
    this.onStateChanged?.(this.getState());
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.snapshot.enabled) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(
      ENTERPRISE_CHAT_RECONNECT_MAX_MS,
      1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5)
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refresh();
    }, delay);
  }

  private scheduleSessionRefresh() {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
    }
    const delay = Math.max(5_000, this.collaborationTokenExpiresAt - Date.now() - 60_000);
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socketClosing = true;
    const socket = this.socket;
    this.socket = null;
    this.socketSynced = false;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Closing an already-closed WebSocket is harmless.
      }
    }
    this.rejectPendingRequests(new Error("Enterprise chat connection closed."));
  }

  private clearSession() {
    this.collaborationToken = "";
    this.collaborationTokenExpiresAt = 0;
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export const __testInternals = {
  normalizeConversation,
  normalizeMessage,
  normalizeServerUrl,
  normalizeUser,
  toWebSocketUrl
};
