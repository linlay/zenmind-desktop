import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AssistantNavAgentIcon,
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem,
  ServiceId,
  ServiceState
} from "../../../shared/contracts";

type AgentPlatformApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type PlatformChatSummary = {
  id?: unknown;
  chatId?: unknown;
  chatName?: unknown;
  name?: unknown;
  title?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  lastMessage?: unknown;
  preview?: unknown;
  message?: unknown;
  read?: unknown;
  isRead?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  status?: unknown;
};

type PlatformAgentSummary = {
  key?: unknown;
  name?: unknown;
  displayName?: unknown;
  role?: unknown;
  icon?: unknown;
  stats?: {
    totalCount?: unknown;
    unreadCount?: unknown;
  };
  chats?: unknown;
  recentChats?: unknown;
  relatedChats?: unknown;
  chatList?: unknown;
  conversations?: unknown;
};

type NavigationPushFrame = {
  frame?: unknown;
  type?: unknown;
  payload?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

type NavigationPushEvent = {
  type: string;
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  lastRunId?: unknown;
  runId?: unknown;
  lastRunContent?: unknown;
  text?: unknown;
  message?: unknown;
  read?: unknown;
  isRead?: unknown;
  readAt?: unknown;
  readRunId?: unknown;
  agentUnreadCount?: unknown;
  unreadCount?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

export type AssistantNavigationPushEvent = {
  type: string;
  chatId: string | null;
  runId: string | null;
  status: string | null;
};

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

export type AssistantNavigationApplyResult = {
  items: AssistantNavAgentItem[];
  changed: boolean;
  shouldRefresh: boolean;
};

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";
const NAVIGATION_AGENT_CHAT_LIMIT = 5;
const NAVIGATION_AGENT_HISTORY_LIMIT = 50;
const NAVIGATION_REFRESH_DEBOUNCE_MS = 350;
const NAVIGATION_UNAVAILABLE_RETRY_MS = 12_000;
const NAVIGATION_RECONNECT_MS = 10_000;
const IGNORED_PUSH_TYPES = new Set(["heartbeat", "live.connected"]);
const FINISHED_AWAITING_STATUSES = new Set([
  "answered",
  "cancelled",
  "canceled",
  "completed",
  "done",
  "error",
  "expired",
  "failed",
  "resolved",
  "timeout"
]);

function nowIso() {
  return new Date().toISOString();
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toNonNegativeInteger(value: unknown) {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

function isFinishedAwaitingStatus(value: string) {
  return FINISHED_AWAITING_STATUSES.has(value);
}

function hasAwaitingListItems(value: unknown) {
  return Array.isArray(value) && value.some((item) => isObjectRecord(item));
}

function hasPendingAwaitingPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasPendingAwaitingPayload(item));
  }
  if (!isObjectRecord(value)) {
    return false;
  }

  const type = toText(value.type).toLowerCase();
  if (type === "awaiting.answer") {
    return false;
  }
  const mode = toText(value.mode).toLowerCase();
  if (mode === "approval" && !hasAwaitingListItems(value.approvals)) {
    return false;
  }

  const status = toText(value.status).toLowerCase();
  if (isFinishedAwaitingStatus(status)) {
    return false;
  }

  if (isObjectRecord(value.answer)) {
    const answerType = toText(value.answer.type).toLowerCase();
    const answerStatus = toText(value.answer.status).toLowerCase();
    if (answerType === "awaiting.answer" || isFinishedAwaitingStatus(answerStatus)) {
      return false;
    }
  }

  if (value.hasPendingAwaiting === true) {
    return true;
  }
  if (value.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(value.awaitingCount) > 0) {
    return true;
  }
  if (type === "awaiting.ask" || status === "awaiting" || status === "pending" || toText(value.awaitingId)) {
    return true;
  }
  return hasPendingAwaitingPayload(value.awaiting);
}

function toTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampToIso(value: unknown) {
  const timestamp = toTimestampMs(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : nowIso();
}

function createApiUrl(baseUrl: string, pathname: string) {
  const url = new URL(pathname, baseUrl);
  return url.toString();
}

function createWsUrl(baseUrl: string, token: string) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token.trim()) {
    url.searchParams.set("token", token.trim());
  }
  return url.toString();
}

function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function unwrapApiResponse<T>(payload: unknown): T {
  if (isObjectRecord(payload) && "code" in payload && "data" in payload) {
    const response = payload as AgentPlatformApiResponse<T>;
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

async function readApiJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`agent-platform returned HTTP ${response.status}`);
  }
  return unwrapApiResponse<T>(await response.json());
}

function readAgentKey(agent: PlatformAgentSummary) {
  return toText(agent.key);
}

function readAgentDisplayName(agent: PlatformAgentSummary, fallback: string) {
  return toText(agent.name) || toText(agent.displayName) || fallback;
}

function readAgentIcon(agent: PlatformAgentSummary): AssistantNavAgentIcon | undefined {
  if (typeof agent.icon === "string" && agent.icon.trim()) {
    return agent.icon.trim();
  }
  if (isObjectRecord(agent.icon)) {
    const color = toText(agent.icon.color);
    const name = toText(agent.icon.name);
    if (color || name) {
      return {
        ...(color ? { color } : {}),
        ...(name ? { name } : {})
      };
    }
  }
  return undefined;
}

function readChatAgentKey(chat: PlatformChatSummary, fallbackAgentKey = "") {
  return toText(chat.agentKey) || toText(chat.firstAgentKey) || fallbackAgentKey;
}

function readChatIsRead(chat: PlatformChatSummary) {
  if (typeof chat.isRead === "boolean") {
    return chat.isRead;
  }
  if (typeof chat.read === "boolean") {
    return chat.read;
  }
  if (isObjectRecord(chat.read) && typeof chat.read.isRead === "boolean") {
    return chat.read.isRead;
  }
  return true;
}

function readChatPendingAwaiting(chat: PlatformChatSummary) {
  if (chat.hasPendingAwaiting === true) {
    return true;
  }
  if (chat.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(chat.awaitingCount) > 0) {
    return true;
  }
  if (hasPendingAwaitingPayload(chat.awaiting)) {
    return true;
  }
  return toText(chat.status).toLowerCase() === "awaiting";
}

function compareNavChats(left: AssistantNavChatItem, right: AssistantNavChatItem) {
  const rightTime = toTimestampMs(right.updatedAt);
  const leftTime = toTimestampMs(left.updatedAt);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return left.chatId.localeCompare(right.chatId);
}

function mapNavigationChat(chat: PlatformChatSummary, fallbackAgentKey = ""): AssistantNavChatItem | null {
  const chatId = toText(chat.chatId) || toText(chat.id);
  if (!chatId) {
    return null;
  }
  const lastRunContent = toText(chat.lastRunContent) || toText(chat.lastMessage) || toText(chat.preview) || toText(chat.message);
  const chatName = toText(chat.chatName) || toText(chat.name) || toText(chat.title) || lastRunContent || "新的对话";
  return {
    chatId,
    chatName,
    agentKey: readChatAgentKey(chat, fallbackAgentKey),
    updatedAt: timestampToIso(chat.updatedAt || chat.createdAt),
    lastRunId: toText(chat.lastRunId),
    lastRunContent,
    isRead: readChatIsRead(chat),
    hasPendingAwaiting: readChatPendingAwaiting(chat)
  };
}

function readAgentRawChatLists(agent: PlatformAgentSummary): unknown[][] {
  return [
    agent.chats,
    agent.recentChats,
    agent.relatedChats,
    agent.chatList,
    agent.conversations
  ].filter((candidate): candidate is unknown[] => Array.isArray(candidate));
}

function readAgentChats(agent: PlatformAgentSummary, agentKey: string): AssistantNavChatItem[] {
  const chatsById = new Map<string, AssistantNavChatItem>();
  for (const rawChats of readAgentRawChatLists(agent)) {
    for (const rawChat of rawChats) {
      const chat = mapNavigationChat(rawChat as PlatformChatSummary, agentKey);
      if (!chat || chatsById.has(chat.chatId)) {
        continue;
      }
      chatsById.set(chat.chatId, chat);
    }
  }
  return [...chatsById.values()].sort(compareNavChats);
}

function createNavigationAgentItem(agent: PlatformAgentSummary, includeChatLimit: number): AssistantNavAgentItem | null {
  const agentKey = readAgentKey(agent);
  if (!agentKey) {
    return null;
  }
  const chats = readAgentChats(agent, agentKey);
  const recentChats = chats.slice(0, includeChatLimit);
  const latestChat = recentChats[0] ?? null;
  const totalCount = toNonNegativeInteger(agent.stats?.totalCount);
  const statsUnreadCount = toNonNegativeInteger(agent.stats?.unreadCount);
  const unreadFromChats = chats.filter((chat) => !chat.isRead).length;
  const unreadCount = Math.max(statsUnreadCount, unreadFromChats);
  const latestPreview = latestChat
    ? (latestChat.lastRunContent || latestChat.chatName).replace(/\s+/gu, " ").trim()
    : "";
  return {
    agentKey,
    displayName: readAgentDisplayName(agent, agentKey),
    role: toText(agent.role),
    ...(readAgentIcon(agent) ? { icon: readAgentIcon(agent) } : {}),
    unreadCount,
    unreadChatCount: unreadCount,
    chatCount: Math.max(totalCount, chats.length),
    hasPendingAwaiting: chats.some((chat) => chat.hasPendingAwaiting),
    latestChatId: latestChat?.chatId ?? null,
    latestPreview: latestPreview.slice(0, 120),
    updatedAt: latestChat?.updatedAt ?? nowIso(),
    recentChats
  };
}

export function buildAssistantNavigationAgentsFromPlatformAgents(
  agentsInput: unknown,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): AssistantNavAgentItem[] {
  const agents = Array.isArray(agentsInput) ? agentsInput as PlatformAgentSummary[] : [];
  return agents
    .map((agent) => createNavigationAgentItem(agent, includeChatLimit))
    .filter((agent): agent is AssistantNavAgentItem => Boolean(agent))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

function normalizePushType(type: string) {
  if (type === "run.started") {
    return "run.start";
  }
  if (type === "run.finished") {
    return "run.complete";
  }
  return type;
}

function toPushEvent(frame: NavigationPushFrame): NavigationPushEvent {
  const nestedRecord = isObjectRecord(frame.payload)
    ? frame.payload
    : isObjectRecord(frame.data)
      ? frame.data
      : {};
  const { frame: _frame, payload: _payload, data: _data, ...topLevel } = frame;
  const type = normalizePushType(toText(frame.type) || toText(nestedRecord.type));
  return {
    ...nestedRecord,
    ...topLevel,
    type
  } as NavigationPushEvent;
}

function readPushAgentKey(event: NavigationPushEvent) {
  return toText(event.agentKey) || toText(event.firstAgentKey);
}

function readPushChatId(event: NavigationPushEvent) {
  return toText(event.chatId);
}

function readPushUpdatedAt(event: NavigationPushEvent, fallback: string) {
  return timestampToIso(event.updatedAt || event.timestamp || event.createdAt || fallback);
}

function readPushPreview(event: NavigationPushEvent) {
  return toText(event.lastRunContent) || toText(event.text) || toText(event.message);
}

function readPushPendingAwaiting(event: NavigationPushEvent, fallback: boolean) {
  if (event.type === "awaiting.ask") {
    return true;
  }
  if (event.type === "awaiting.answer" || event.type === "run.start" || event.type === "run.complete") {
    return false;
  }
  if (event.hasPendingAwaiting === true) {
    return true;
  }
  if (event.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(event.awaitingCount) > 0) {
    return true;
  }
  if (hasPendingAwaitingPayload(event.awaiting)) {
    return true;
  }
  if (toText(event.status).toLowerCase() === "awaiting") {
    return true;
  }
  return fallback;
}

function createChatPatchFromPush(event: NavigationPushEvent, current?: AssistantNavChatItem): AssistantNavChatItem | null {
  const chatId = readPushChatId(event);
  if (!chatId) {
    return null;
  }
  const preview = readPushPreview(event);
  const agentKey = readPushAgentKey(event) || current?.agentKey || "";
  const chatName = toText(event.chatName) || current?.chatName || preview || "新的对话";
  const updatedAt = readPushUpdatedAt(event, current?.updatedAt || nowIso());
  let isRead = current?.isRead ?? true;
  if (event.type === "chat.read") {
    isRead = true;
  } else if (event.type === "chat.unread") {
    isRead = false;
  } else if (typeof event.isRead === "boolean") {
    isRead = event.isRead;
  } else if (typeof event.read === "boolean") {
    isRead = event.read;
  } else if (isObjectRecord(event.read) && typeof event.read.isRead === "boolean") {
    isRead = event.read.isRead;
  }
  return {
    chatId,
    chatName,
    agentKey,
    updatedAt,
    lastRunId: toText(event.lastRunId) || toText(event.runId) || current?.lastRunId || "",
    lastRunContent: preview || current?.lastRunContent || (event.type === "run.start" ? "思考中" : ""),
    isRead,
    hasPendingAwaiting: readPushPendingAwaiting(event, current?.hasPendingAwaiting ?? false)
  };
}

function readPushUnreadCount(event: NavigationPushEvent, fallback: number, change: "increment" | "decrement" | "preserve") {
  if (event.agentUnreadCount !== undefined) {
    return toNonNegativeInteger(event.agentUnreadCount);
  }
  if (event.unreadCount !== undefined) {
    return toNonNegativeInteger(event.unreadCount);
  }
  if (change === "increment") {
    return toNonNegativeInteger(fallback + 1);
  }
  if (change === "decrement") {
    return toNonNegativeInteger(fallback - 1);
  }
  return fallback;
}

function refreshAgentDerivedFields(agent: AssistantNavAgentItem): AssistantNavAgentItem {
  const recentChats = [...agent.recentChats].sort(compareNavChats).slice(0, NAVIGATION_AGENT_CHAT_LIMIT);
  const latestChat = recentChats[0] ?? null;
  const unreadFromChats = recentChats.filter((chat) => !chat.isRead).length;
  const unreadCount = Math.max(agent.unreadCount, unreadFromChats);
  const latestPreview = latestChat
    ? (latestChat.lastRunContent || latestChat.chatName).replace(/\s+/gu, " ").trim()
    : "";
  return {
    ...agent,
    recentChats,
    unreadCount,
    unreadChatCount: unreadCount,
    hasPendingAwaiting: recentChats.some((chat) => chat.hasPendingAwaiting),
    latestChatId: latestChat?.chatId ?? null,
    latestPreview: latestPreview.slice(0, 120),
    updatedAt: latestChat?.updatedAt ?? agent.updatedAt
  };
}

function findAgentIndexForPush(items: AssistantNavAgentItem[], event: NavigationPushEvent) {
  const agentKey = readPushAgentKey(event);
  if (agentKey) {
    return items.findIndex((item) => item.agentKey === agentKey);
  }
  const chatId = readPushChatId(event);
  if (!chatId) {
    return -1;
  }
  return items.findIndex((item) => item.recentChats.some((chat) => chat.chatId === chatId));
}

export function applyAssistantNavigationPush(
  currentItems: AssistantNavAgentItem[],
  frame: NavigationPushFrame
): AssistantNavigationApplyResult {
  const event = toPushEvent(frame);
  const type = event.type;
  if (!type || IGNORED_PUSH_TYPES.has(type)) {
    return { items: currentItems, changed: false, shouldRefresh: false };
  }

  const agentIndex = findAgentIndexForPush(currentItems, event);
  if (agentIndex < 0) {
    return { items: currentItems, changed: false, shouldRefresh: true };
  }

  const nextItems = currentItems.slice();
  const currentAgent = currentItems[agentIndex];
  let nextAgent = { ...currentAgent, recentChats: currentAgent.recentChats.slice() };
  const chatId = readPushChatId(event);
  const chatIndex = chatId ? nextAgent.recentChats.findIndex((chat) => chat.chatId === chatId) : -1;
  const currentChat = chatIndex >= 0 ? nextAgent.recentChats[chatIndex] : undefined;

  if (type === "chat.read_all") {
    nextAgent = refreshAgentDerivedFields({
      ...nextAgent,
      unreadCount: 0,
      unreadChatCount: 0,
      recentChats: nextAgent.recentChats.map((chat) => ({ ...chat, isRead: true }))
    });
    nextItems[agentIndex] = nextAgent;
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  if (type === "chat.deleted" || type === "chat.archived") {
    if (!chatId) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    nextAgent.recentChats = nextAgent.recentChats.filter((chat) => chat.chatId !== chatId);
    nextAgent.chatCount = Math.max(0, nextAgent.chatCount - (chatIndex >= 0 ? 1 : 0));
    nextAgent.unreadCount = currentChat && !currentChat.isRead ? Math.max(0, nextAgent.unreadCount - 1) : nextAgent.unreadCount;
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: nextItems, changed: true, shouldRefresh: true };
  }

  if (type === "chat.read" || type === "chat.unread") {
    const patch = createChatPatchFromPush(event, currentChat);
    if (patch && chatIndex >= 0) {
      nextAgent.recentChats[chatIndex] = patch;
    } else if (patch) {
      nextAgent.recentChats.unshift(patch);
      nextAgent.chatCount = Math.max(nextAgent.chatCount, nextAgent.recentChats.length);
    }
    nextAgent.unreadCount = readPushUnreadCount(
      event,
      nextAgent.unreadCount,
      type === "chat.read" ? "decrement" : "increment"
    );
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  if (
    type === "chat.created" ||
    type === "chat.updated" ||
    type === "run.start" ||
    type === "run.complete" ||
    type === "awaiting.ask" ||
    type === "awaiting.answer"
  ) {
    const patch = createChatPatchFromPush(event, currentChat);
    if (!patch) {
      return { items: currentItems, changed: false, shouldRefresh: true };
    }
    if (chatIndex >= 0) {
      nextAgent.recentChats[chatIndex] = patch;
    } else {
      nextAgent.recentChats.unshift(patch);
      if (type === "chat.created") {
        nextAgent.chatCount = Math.max(nextAgent.chatCount + 1, nextAgent.recentChats.length);
      } else {
        nextAgent.chatCount = Math.max(nextAgent.chatCount, nextAgent.recentChats.length);
      }
    }
    nextAgent.unreadCount = readPushUnreadCount(event, nextAgent.unreadCount, "preserve");
    nextItems[agentIndex] = refreshAgentDerivedFields(nextAgent);
    return { items: nextItems, changed: true, shouldRefresh: false };
  }

  return { items: currentItems, changed: false, shouldRefresh: true };
}

export async function readAssistantNavigationAgentsFromPlatform(
  baseUrl: string,
  token: string,
  includeChatLimit = NAVIGATION_AGENT_CHAT_LIMIT
): Promise<AssistantNavAgentItem[]> {
  const agents = await readApiJson<unknown[]>(
    `${createApiUrl(baseUrl, "/api/agents")}?includeChats=${encodeURIComponent(String(includeChatLimit))}&scope=nav`,
    token
  );
  return buildAssistantNavigationAgentsFromPlatformAgents(agents, includeChatLimit);
}

export class AssistantNavigationStatusClient {
  private ws: MinimalWebSocket | null = null;
  private stopped = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private latestResult: AssistantNavAgentItemsResult = {
    ok: false,
    items: [],
    message: "智能助理导航状态尚未初始化。",
    updatedAt: nowIso()
  };
  private lastBaseUrl = "";
  private lastToken = "";

  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    onSnapshot: (result: AssistantNavAgentItemsResult) => void;
    onPushEvent?: (event: AssistantNavigationPushEvent) => void;
    onDebug?: (message: string) => void;
  }) {}

  start() {
    this.stopped = false;
    this.scheduleRefresh(0);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.closeWebSocket();
  }

  getSnapshot() {
    return this.latestResult;
  }

  scheduleRefresh(delayMs = NAVIGATION_REFRESH_DEBOUNCE_MS) {
    if (this.stopped) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow();
    }, Math.max(0, delayMs));
  }

  async refreshNow(): Promise<AssistantNavAgentItemsResult> {
    if (this.stopped) {
      return this.latestResult;
    }
    try {
      const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        this.setSnapshot({
          ok: false,
          items: [],
          message: "agent-platform 暂未运行。",
          updatedAt: nowIso()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
      const token = tokenResult.ok ? tokenResult.token.trim() : "";
      if (!token) {
        this.setSnapshot({
          ok: false,
          items: [],
          message: tokenResult.message || "缺少 agent-platform access token。",
          updatedAt: nowIso()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const items = await readAssistantNavigationAgentsFromPlatform(baseUrl, token);
      this.setSnapshot({
        ok: true,
        items,
        message: "已读取智能助手导航状态。",
        updatedAt: nowIso()
      });
      this.connectWebSocket(baseUrl, token);
      return this.latestResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onDebug?.(message);
      this.setSnapshot({
        ok: false,
        items: [],
        message,
        updatedAt: nowIso()
      });
      this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
      return this.latestResult;
    }
  }

  private setSnapshot(result: AssistantNavAgentItemsResult) {
    this.latestResult = result;
    this.options.onSnapshot(result);
  }

  private connectWebSocket(baseUrl: string, token: string) {
    const WebSocketConstructor = getWebSocketConstructor();
    if (!WebSocketConstructor) {
      this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
      return;
    }
    if (this.ws && this.lastBaseUrl === baseUrl && this.lastToken === token) {
      return;
    }
    this.closeWebSocket();
    this.lastBaseUrl = baseUrl;
    this.lastToken = token;
    const socket = new WebSocketConstructor(createWsUrl(baseUrl, token));
    this.ws = socket;
    socket.onmessage = (event) => this.handleWebSocketMessage(event.data);
    socket.onclose = () => this.handleWebSocketClosed();
    socket.onerror = () => this.handleWebSocketClosed();
    socket.onopen = () => undefined;
  }

  private handleWebSocketMessage(data: unknown) {
    if (this.stopped) {
      return;
    }
    const raw = typeof data === "string" ? data : String(data ?? "");
    let frame: NavigationPushFrame;
    try {
      frame = JSON.parse(raw) as NavigationPushFrame;
    } catch {
      return;
    }
    if (toText(frame.frame) !== "push") {
      return;
    }
    const event = toPushEvent(frame);
    this.options.onPushEvent?.({
      type: event.type,
      chatId: readPushChatId(event) || null,
      runId: toText(event.runId) || toText(event.lastRunId) || null,
      status: toText(event.status) || null
    });
    const next = applyAssistantNavigationPush(this.latestResult.items, frame);
    if (next.changed) {
      this.setSnapshot({
        ok: true,
        items: next.items,
        message: "已同步智能助手导航通知。",
        updatedAt: nowIso()
      });
    }
    if (next.shouldRefresh) {
      this.scheduleRefresh();
    }
  }

  private handleWebSocketClosed() {
    if (this.stopped) {
      return;
    }
    this.closeWebSocket();
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.scheduleRefresh(0);
    }, NAVIGATION_RECONNECT_MS);
  }

  private closeWebSocket() {
    const socket = this.ws;
    this.ws = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, "assistant navigation refresh");
    } catch {
      // Ignore close failures for sockets that are already closing.
    }
  }

  private clearTimers() {
    for (const timer of [this.refreshTimer, this.reconnectTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.refreshTimer = null;
    this.reconnectTimer = null;
  }
}

export const __testInternals = {
  NAVIGATION_AGENT_CHAT_LIMIT,
  NAVIGATION_AGENT_HISTORY_LIMIT,
  createWsUrl,
  toPushEvent
};
