import type { App } from "electron";
import type { AgentAuthIssueResult, AssistantNavAgentIcon, DesktopPetAgentOption, ServiceId, ServiceState } from "../../../shared/contracts";
import { readEpochMillis } from "../../../shared/time-contract";
import {
  DESKTOP_PET_STATUS_HINT_TEXTS,
  sanitizeDesktopPetUnreadCount,
  toDesktopPetText as toText
} from "../../../shared/desktop-pet";
import { getDesktopDeviceId } from "../../device-identity";
import { t } from "../../i18n/main-i18n";
import { createApiUrl } from "./agent-platform-api";
import type { DesktopPetBoundAgentStatus } from "./desktop-pet";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  normalizeDesktopPetBoundAgentKey
} from "./desktop-pet";

type AgentPlatformApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type AgentSummary = {
  key?: unknown;
  name?: unknown;
  displayName?: unknown;
  role?: unknown;
  icon?: unknown;
  stats?: {
    unreadCount?: unknown;
  };
};

type ChatSummary = {
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  updatedAt?: unknown;
  lastRunContent?: unknown;
  read?: unknown;
  isRead?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
};

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

export type AgentPlatformPetPushFrame = {
  frame?: unknown;
  type?: unknown;
  data?: unknown;
  payload?: unknown;
};

const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const AGENT_PLATFORM_STATUS_STALE_MS = 90_000;
const AGENT_PLATFORM_RECONNECT_MS = 10_000;
const AGENT_PLATFORM_REFRESH_DEBOUNCE_MS = 350;
const AGENT_PLATFORM_UNAVAILABLE_RETRY_MS = 12_000;
const AGENT_PLATFORM_DONE_REFRESH_MS = 4_200;
const AGENT_PLATFORM_DONE_REMINDER_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_DESKTOP_PET_AGENT_DISPLAY_NAME =
  DESKTOP_PET_APPEARANCE_OPTIONS.find((appearance) => appearance.id === DEFAULT_DESKTOP_PET_APPEARANCE_ID)?.displayName ??
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
const LEGACY_DESKTOP_PET_BOUND_AGENT_REQUEST_KEYS = new Set([
  "zen",
  DEFAULT_DESKTOP_PET_AGENT_DISPLAY_NAME
]);
const STRUCTURED_PUSH_TIME_FIELDS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "timestamp",
  "expiresAt",
  "readAt",
] as const;

function readUnreadCountFromPush(
  data: Record<string, unknown>,
  fallback: number,
  fallbackChange: "increment" | "decrement" | "preserve" = "preserve"
) {
  if (data.agentUnreadCount !== undefined) {
    return sanitizeDesktopPetUnreadCount(data.agentUnreadCount);
  }
  if (data.unreadCount !== undefined) {
    return sanitizeDesktopPetUnreadCount(data.unreadCount);
  }
  if (fallbackChange === "increment") {
    return sanitizeDesktopPetUnreadCount(fallback + 1);
  }
  if (fallbackChange === "decrement") {
    return sanitizeDesktopPetUnreadCount(fallback - 1);
  }
  return fallback;
}

function toTimestampMs(value: unknown) {
  return readEpochMillis(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const DESKTOP_PET_STATUS_WS_SOURCE = "desktop-pet";

function createWsUrl(baseUrl: string, token: string, source = "", deviceId = "") {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token.trim()) {
    url.searchParams.set("token", token.trim());
  }
  url.searchParams.set("source", source.trim());
  url.searchParams.set("deviceId", deviceId.trim());
  return url.toString();
}

function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function compareChatFreshness(a: ChatSummary, b: ChatSummary) {
  const updatedA = toTimestampMs(a.updatedAt) ?? 0;
  const updatedB = toTimestampMs(b.updatedAt) ?? 0;
  if (updatedA !== updatedB) {
    return updatedB - updatedA;
  }
  return toText(a.chatId).localeCompare(toText(b.chatId));
}

function readChatReadState(chat: ChatSummary | Record<string, unknown>): boolean | null {
  if (isObjectRecord(chat.read) && typeof chat.read.isRead === "boolean") {
    return chat.read.isRead;
  }
  if (typeof chat.read === "boolean") {
    return chat.read;
  }
  if (typeof chat.isRead === "boolean") {
    return chat.isRead;
  }
  return null;
}

function countUnreadChatsFromReadState(chats: ChatSummary[]) {
  let sawReadState = false;
  let unreadCount = 0;
  for (const chat of chats) {
    const isRead = readChatReadState(chat);
    if (isRead === null) {
      continue;
    }
    sawReadState = true;
    if (!isRead) {
      unreadCount += 1;
    }
  }
  return sawReadState ? unreadCount : null;
}

function getAgentKey(agent: AgentSummary | null | undefined) {
  return toText(agent?.key);
}

function getAgentDisplayName(agent: AgentSummary | null | undefined) {
  return toText(agent?.name) || toText(agent?.displayName);
}

function findAgentByKey(agents: AgentSummary[], key: string) {
  return agents.find((agent) => getAgentKey(agent) === key) ?? null;
}

function findAgentByDisplayName(agents: AgentSummary[], displayName: string) {
  return agents.find((agent) => getAgentDisplayName(agent) === displayName) ?? null;
}

function readAgentIcon(agent: AgentSummary): AssistantNavAgentIcon | undefined {
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

export function toDesktopPetAgentOptions(agentsInput: unknown): DesktopPetAgentOption[] {
  return (toArray(agentsInput) as AgentSummary[])
    .map((agent) => {
      const agentKey = getAgentKey(agent);
      if (!agentKey) {
        return null;
      }
      const icon = readAgentIcon(agent);
      return {
        agentKey,
        displayName: getAgentDisplayName(agent) || agentKey,
        role: toText(agent.role),
        ...(icon ? { icon } : {}),
        unreadCount: sanitizeDesktopPetUnreadCount(agent.stats?.unreadCount)
      };
    })
    .filter((agent): agent is DesktopPetAgentOption => Boolean(agent))
    .sort((a, b) => {
      if (a.agentKey === DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY) {
        return -1;
      }
      if (b.agentKey === DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY) {
        return 1;
      }
      return a.displayName.localeCompare(b.displayName, "zh-CN");
    });
}

export function resolveAgentPlatformPetBoundAgentKey(
  boundAgentKey: string,
  agentsInput: unknown
): {
  requestedKey: string;
  resolvedKey: string;
  agent: AgentSummary | null;
} {
  const requestedKey = normalizeDesktopPetBoundAgentKey(boundAgentKey);
  const agents = toArray(agentsInput) as AgentSummary[];
  const exactAgent = findAgentByKey(agents, requestedKey);
  if (exactAgent) {
    return {
      requestedKey,
      resolvedKey: getAgentKey(exactAgent),
      agent: exactAgent
    };
  }

  const displayNameAgent = findAgentByDisplayName(agents, requestedKey);
  if (displayNameAgent) {
    return {
      requestedKey,
      resolvedKey: getAgentKey(displayNameAgent) || requestedKey,
      agent: displayNameAgent
    };
  }

  const defaultAgent = findAgentByKey(agents, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  if (defaultAgent && LEGACY_DESKTOP_PET_BOUND_AGENT_REQUEST_KEYS.has(requestedKey)) {
    return {
      requestedKey,
      resolvedKey: getAgentKey(defaultAgent),
      agent: defaultAgent
    };
  }

  const prefixMatches = requestedKey.length >= 3
    ? agents.filter((agent) => getAgentKey(agent).startsWith(requestedKey))
    : [];
  if (prefixMatches.length === 1) {
    const agent = prefixMatches[0];
    return {
      requestedKey,
      resolvedKey: getAgentKey(agent),
      agent
    };
  }

  return {
    requestedKey,
    resolvedKey: requestedKey,
    agent: null
  };
}

function readFrameData(frame: AgentPlatformPetPushFrame): Record<string, unknown> {
  if (isObjectRecord(frame.data)) {
    return frame.data;
  }
  if (isObjectRecord(frame.payload)) {
    return frame.payload;
  }
  return {};
}

function readFrameTimestamp(frame: AgentPlatformPetPushFrame) {
  return readEpochMillis(readFrameData(frame).timestamp);
}

function hasValidPresentFrameTimes(frame: AgentPlatformPetPushFrame) {
  const data = readFrameData(frame);
  return STRUCTURED_PUSH_TIME_FIELDS.every((field) =>
    data[field] === undefined || readEpochMillis(data[field]) !== undefined
  );
}

function requiresFrameTimestamp(frameType: string) {
  return frameType === "chat.read_all" ||
    frameType === "chat.read" ||
    frameType === "chat.unread" ||
    frameType === "chat.updated" ||
    frameType === "run.started" ||
    frameType === "run.finished";
}

function readFrameAgentKey(data: Record<string, unknown>) {
  const nestedChat = isObjectRecord(data.chat) ? data.chat : {};
  const nestedRun = isObjectRecord(data.run) ? data.run : {};
  return toText(data.agentKey) || toText(nestedChat.agentKey) || toText(nestedRun.agentKey);
}

function readFramePreviewText(data: Record<string, unknown>) {
  const nestedChat = isObjectRecord(data.chat) ? data.chat : {};
  const nestedRun = isObjectRecord(data.run) ? data.run : {};
  return toText(data.lastRunContent) ||
    toText(data.latestPreview) ||
    toText(data.messagePreview) ||
    toText(data.message) ||
    toText(data.content) ||
    toText(data.text) ||
    toText(data.summary) ||
    toText(nestedChat.lastRunContent) ||
    toText(nestedChat.message) ||
    toText(nestedRun.lastRunContent) ||
    toText(nestedRun.message);
}

function readCompletionPreview(data: Record<string, unknown>, fallback = "") {
  const directPreview = readFramePreviewText(data);
  if (directPreview) {
    return directPreview;
  }
  const fallbackPreview = toText(fallback);
  return fallbackPreview && !DESKTOP_PET_STATUS_HINT_TEXTS.has(fallbackPreview)
    ? fallbackPreview
    : t("desktopPet.doneFallback");
}

function getFrameChatId(frame: AgentPlatformPetPushFrame) {
  const data = readFrameData(frame);
  const nestedChat = isObjectRecord(data.chat) ? data.chat : {};
  const nestedRun = isObjectRecord(data.run) ? data.run : {};
  return toText(data.chatId) || toText(nestedChat.chatId) || toText(nestedRun.chatId);
}

async function readApiJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`agent-platform ${url} returned HTTP ${response.status}`);
  }
  const payload = await response.json() as AgentPlatformApiResponse<T>;
  return payload.data as T;
}

export function buildAgentPlatformPetStatus(input: {
  boundAgentKey?: string;
  agents: unknown;
  chats: unknown;
  updatedAt?: number;
}): DesktopPetBoundAgentStatus {
  const agents = toArray(input.agents) as AgentSummary[];
  const requestedBoundAgentKey = input.boundAgentKey ? normalizeDesktopPetBoundAgentKey(input.boundAgentKey) : "";
  const allChats = (toArray(input.chats) as ChatSummary[])
    .filter((chat) => readEpochMillis(chat.updatedAt) !== undefined)
    .sort(compareChatFreshness);
  const resolved = requestedBoundAgentKey
    ? resolveAgentPlatformPetBoundAgentKey(requestedBoundAgentKey, agents)
    : null;
  const latestPendingChat = allChats.find((chat) => Boolean(chat.awaiting || chat.hasPendingAwaiting)) ?? null;
  const latestChat = requestedBoundAgentKey
    ? allChats.find((chat) => toText(chat.agentKey) === resolved?.resolvedKey) ?? null
    : latestPendingChat ?? allChats[0] ?? null;
  const boundAgentKey = resolved?.resolvedKey ||
    toText(latestChat?.agentKey) ||
    getAgentKey(agents[0]) ||
    DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
  const chats = requestedBoundAgentKey
    ? allChats.filter((chat) => toText(chat.agentKey) === boundAgentKey)
    : allChats;
  const matchedAgent = resolved?.agent || findAgentByKey(agents, boundAgentKey);
  const updatedAt = readEpochMillis(input.updatedAt) ??
    readEpochMillis(latestChat?.updatedAt);

  if (!matchedAgent) {
    return {
      agentKey: boundAgentKey,
      displayName: "",
      role: "",
      presence: "offline",
      unreadCount: 0,
      latestPreview: t("desktopPet.status.agentOffline"),
      chatId: null,
      hasPendingAwaiting: false,
      stale: false,
      ...(updatedAt === undefined ? {} : { updatedAt })
    };
  }

  const relevantChat = latestPendingChat ?? latestChat ?? chats[0] ?? null;
  const hasPendingAwaiting = requestedBoundAgentKey
    ? Boolean(relevantChat?.awaiting || relevantChat?.hasPendingAwaiting)
    : chats.some((chat) => Boolean(chat.awaiting || chat.hasPendingAwaiting));
  const chatUnreadCount = countUnreadChatsFromReadState(chats);

  return {
    agentKey: boundAgentKey,
    displayName: getAgentDisplayName(matchedAgent) || boundAgentKey,
    role: toText(matchedAgent.role),
    presence: hasPendingAwaiting ? "busy" : "available",
    unreadCount: chatUnreadCount ?? sanitizeDesktopPetUnreadCount(matchedAgent.stats?.unreadCount),
    latestPreview: toText(relevantChat?.lastRunContent) || toText(relevantChat?.chatName),
    chatId: toText(relevantChat?.chatId) || null,
    hasPendingAwaiting,
    stale: false,
    ...(updatedAt === undefined ? {} : { updatedAt })
  };
}

export function applyAgentPlatformPetPush(
  current: DesktopPetBoundAgentStatus | null,
  boundAgentKey: string,
  frame: AgentPlatformPetPushFrame
): DesktopPetBoundAgentStatus | null {
  const frameType = toText(frame.type);
  const data = readFrameData(frame);
  const timestamp = readFrameTimestamp(frame);
  if (timestamp === undefined) {
    return current;
  }
  const eventAgentKey = readFrameAgentKey(data);
  const configuredBoundAgentKey = normalizeDesktopPetBoundAgentKey(boundAgentKey);
  const normalizedBoundAgentKey = current?.agentKey || configuredBoundAgentKey || eventAgentKey;
  if (configuredBoundAgentKey && eventAgentKey && eventAgentKey !== normalizedBoundAgentKey) {
    return current;
  }

  if (frameType === "chat.read_all") {
    if (!current && !eventAgentKey) {
      return null;
    }
    return {
      ...(current ?? buildAgentPlatformPetStatus({ boundAgentKey: normalizedBoundAgentKey, agents: [], chats: [] })),
      agentKey: normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      unreadCount: 0,
      presence: current?.presence ?? "available",
      stale: false,
      updatedAt: timestamp
    };
  }

  if (frameType === "chat.read" || frameType === "chat.unread") {
    if (!current && !eventAgentKey) {
      return null;
    }
    const currentPresence = current?.presence;
    return {
      ...(current ?? buildAgentPlatformPetStatus({ boundAgentKey: normalizedBoundAgentKey, agents: [], chats: [] })),
      agentKey: normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: toText(data.chatId) || current?.chatId || null,
      unreadCount: readUnreadCountFromPush(
        data,
        current?.unreadCount ?? 0,
        frameType === "chat.read" ? "decrement" : "increment"
      ),
      presence: currentPresence === "busy" || currentPresence === "away" ? currentPresence : "available",
      stale: false,
      updatedAt: timestamp
    };
  }

  if (frameType === "chat.updated") {
    const chatId = getFrameChatId(frame);
    const latestPreview = readFramePreviewText(data);
    if (!latestPreview) {
      return current;
    }
    if (!eventAgentKey && (!current?.chatId || !chatId || current.chatId !== chatId)) {
      return current;
    }
    return {
      ...(current ?? buildAgentPlatformPetStatus({ boundAgentKey: normalizedBoundAgentKey, agents: [], chats: [] })),
      agentKey: normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: chatId || current?.chatId || null,
      presence: "away",
      unreadCount: readUnreadCountFromPush(data, current?.unreadCount ?? 0),
      latestPreview,
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: timestamp
    };
  }

  if (frameType === "run.started") {
    if (configuredBoundAgentKey && (!eventAgentKey || eventAgentKey !== normalizedBoundAgentKey)) {
      return current;
    }
    return {
      ...(current ?? buildAgentPlatformPetStatus({ boundAgentKey: normalizedBoundAgentKey, agents: [], chats: [] })),
      agentKey: eventAgentKey || normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: toText(data.chatId) || current?.chatId || null,
      presence: "busy",
      unreadCount: readUnreadCountFromPush(data, current?.unreadCount ?? 0),
      latestPreview: t("desktopPet.status.thinking"),
      stale: false,
      updatedAt: timestamp
    };
  }

  if (frameType === "run.finished") {
    const chatId = toText(data.chatId);
    if (configuredBoundAgentKey && eventAgentKey && eventAgentKey !== normalizedBoundAgentKey) {
      return current;
    }
    if (!eventAgentKey && (!current?.chatId || !chatId || current.chatId !== chatId)) {
      return current;
    }
    return {
      ...(current ?? buildAgentPlatformPetStatus({ boundAgentKey: normalizedBoundAgentKey, agents: [], chats: [] })),
      agentKey: eventAgentKey || normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: chatId || current?.chatId || null,
      presence: "away",
      unreadCount: readUnreadCountFromPush(data, current?.unreadCount ?? 0),
      latestPreview: readCompletionPreview(data, current?.latestPreview),
      stale: false,
      updatedAt: timestamp
    };
  }

  return current;
}

export function applyAgentPlatformCompletionReminder(
  current: DesktopPetBoundAgentStatus | null,
  boundAgentKey: string,
  frame: AgentPlatformPetPushFrame,
  finishedChats: ReadonlyMap<string, number>,
  now = Date.now()
): DesktopPetBoundAgentStatus | null {
  const frameType = toText(frame.type);
  if (frameType !== "chat.read" && frameType !== "chat.unread") {
    return current;
  }
  const data = readFrameData(frame);
  const timestamp = readFrameTimestamp(frame);
  if (timestamp === undefined) {
    return current;
  }
  const eventAgentKey = readFrameAgentKey(data);
  const configuredBoundAgentKey = normalizeDesktopPetBoundAgentKey(boundAgentKey);
  const normalizedBoundAgentKey = current?.agentKey || configuredBoundAgentKey || eventAgentKey;
  if (configuredBoundAgentKey && eventAgentKey && eventAgentKey !== normalizedBoundAgentKey) {
    return current;
  }
  const chatId = toText(data.chatId) || current?.chatId || "";
  if (!chatId) {
    return current;
  }
  const finishedAt = finishedChats.get(chatId);
  if (!finishedAt || now - finishedAt > AGENT_PLATFORM_DONE_REMINDER_MAX_AGE_MS) {
    return current;
  }

  return {
    ...(current ?? buildAgentPlatformPetStatus({
      boundAgentKey: normalizeDesktopPetBoundAgentKey(boundAgentKey),
      agents: [],
      chats: []
    })),
    agentKey: normalizedBoundAgentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    chatId,
    presence: "away",
    unreadCount: readUnreadCountFromPush(data, current?.unreadCount ?? 0),
    latestPreview: readCompletionPreview(data, current?.latestPreview),
    hasPendingAwaiting: false,
    stale: false,
    updatedAt: timestamp
  };
}

export class AgentPlatformPetStatusClient {
  private ws: MinimalWebSocket | null = null;
  private stopped = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBaseUrl = "";
  private lastToken = "";
  private latestStatus: DesktopPetBoundAgentStatus | null = null;
  private finishedChats = new Map<string, number>();

  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    onStatus: (status: DesktopPetBoundAgentStatus | null) => void;
    onAgents?: (agents: DesktopPetAgentOption[]) => void;
    onRunStarted?: (input: { runId: string; chatId: string | null; agentKey: string; timestamp: number }) => void;
    onRunFinished?: (input: { runId: string; chatId: string | null; agentKey: string; message: string; timestamp: number }) => void;
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

  scheduleRefresh(delayMs = AGENT_PLATFORM_REFRESH_DEBOUNCE_MS) {
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

  async refreshNow() {
    if (this.stopped) {
      return;
    }

    try {
      const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        this.setStatus(null);
        this.scheduleRefresh(AGENT_PLATFORM_UNAVAILABLE_RETRY_MS);
        return;
      }

      const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
      if (!tokenResult.ok || !tokenResult.token.trim()) {
        this.setStatus(null);
        this.scheduleRefresh(AGENT_PLATFORM_UNAVAILABLE_RETRY_MS);
        return;
      }

      const token = tokenResult.token.trim();
      const agents = await readApiJson<unknown[]>(createApiUrl(baseUrl, "/api/agents"), token);
      this.options.onAgents?.(toDesktopPetAgentOptions(agents));
      const chats = await readApiJson<unknown[]>(createApiUrl(baseUrl, "/api/chats"), token);
      const nextStatus = buildAgentPlatformPetStatus({
        agents,
        chats
      });
      this.setStatus(nextStatus);
      this.connectWebSocket(baseUrl, token);
    } catch (error) {
      this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      this.setStatus(null);
      this.scheduleRefresh(AGENT_PLATFORM_UNAVAILABLE_RETRY_MS);
    }
  }

  private setStatus(status: DesktopPetBoundAgentStatus | null) {
    this.latestStatus = status;
    this.options.onStatus(status);
    this.scheduleStaleTimer(status);
  }

  private scheduleStaleTimer(status: DesktopPetBoundAgentStatus | null) {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (!status || status.stale) {
      return;
    }
    this.staleTimer = setTimeout(() => {
      if (!this.latestStatus || this.latestStatus.stale) {
        return;
      }
      this.setStatus({
        ...this.latestStatus,
        stale: true,
        presence: "offline"
      });
    }, AGENT_PLATFORM_STATUS_STALE_MS);
  }

  private connectWebSocket(baseUrl: string, token: string) {
    const WebSocketConstructor = getWebSocketConstructor();
    if (!WebSocketConstructor) {
      this.scheduleRefresh(AGENT_PLATFORM_UNAVAILABLE_RETRY_MS);
      return;
    }
    if (this.ws && this.lastBaseUrl === baseUrl && this.lastToken === token) {
      return;
    }

    this.closeWebSocket();
    this.lastBaseUrl = baseUrl;
    this.lastToken = token;
    const wsUrl = createWsUrl(
      baseUrl,
      token,
      DESKTOP_PET_STATUS_WS_SOURCE,
      getDesktopDeviceId(this.options.app)
    );
    const socket = new WebSocketConstructor(wsUrl);
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
    let frame: AgentPlatformPetPushFrame;
    try {
      frame = JSON.parse(raw) as AgentPlatformPetPushFrame;
    } catch {
      return;
    }
    if (toText(frame.frame) !== "push") {
      return;
    }
    const frameType = toText(frame.type);
    if (!hasValidPresentFrameTimes(frame) ||
      (requiresFrameTimestamp(frameType) && readFrameTimestamp(frame) === undefined)) {
      this.options.onDebug?.(`time_contract_violation: pet push ${frameType} requires epoch_ms_int64 timestamp`);
      this.scheduleRefresh();
      return;
    }
    const frameData = readFrameData(frame);
    const currentBoundAgentKey = this.latestStatus?.agentKey || DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
    let nextStatus = applyAgentPlatformPetPush(this.latestStatus, currentBoundAgentKey, frame);
    if (frameType === "run.started") {
      const chatId = getFrameChatId(frame);
      if (chatId) {
        this.finishedChats.delete(chatId);
      }
      const runId = toText(frameData.runId);
      const eventAgentKey = readFrameAgentKey(frameData);
      const matchedAgentKey = nextStatus?.agentKey || eventAgentKey;
      const timestamp = readFrameTimestamp(frame);
      if (timestamp !== undefined && runId && eventAgentKey && (!matchedAgentKey || eventAgentKey === matchedAgentKey)) {
        this.options.onRunStarted?.({
          runId,
          chatId: chatId || null,
          agentKey: eventAgentKey,
          timestamp
        });
      }
    } else if (frameType === "run.finished") {
      const chatId = getFrameChatId(frame) || nextStatus?.chatId || "";
      if (chatId) {
        this.rememberFinishedChat(chatId);
      }
      const runId = toText(frameData.runId);
      const eventAgentKey = readFrameAgentKey(frameData);
      const matchedAgentKey = eventAgentKey || nextStatus?.agentKey || currentBoundAgentKey;
      const timestamp = readFrameTimestamp(frame);
      if (timestamp !== undefined && (runId || chatId) && (!eventAgentKey || eventAgentKey === matchedAgentKey)) {
        this.options.onRunFinished?.({
          runId,
          chatId: chatId || null,
          agentKey: matchedAgentKey,
          message: readCompletionPreview(frameData, nextStatus?.latestPreview),
          timestamp
        });
      }
    } else if (frameType === "chat.read" || frameType === "chat.unread") {
      nextStatus = applyAgentPlatformCompletionReminder(nextStatus, currentBoundAgentKey, frame, this.finishedChats);
    }
    if (nextStatus !== this.latestStatus) {
      this.setStatus(nextStatus);
    }
    if (
      frameType === "chat.unread" ||
      frameType === "chat.read" ||
      frameType === "chat.read_all" ||
      frameType === "chat.updated"
    ) {
      this.scheduleRefresh(nextStatus?.presence === "away" ? AGENT_PLATFORM_DONE_REFRESH_MS : AGENT_PLATFORM_REFRESH_DEBOUNCE_MS);
    } else if (frameType === "run.finished") {
      this.scheduleRefresh(AGENT_PLATFORM_DONE_REFRESH_MS);
    }
  }

  private rememberFinishedChat(chatId: string) {
    const now = Date.now();
    this.finishedChats.set(chatId, now);
    for (const [candidateChatId, finishedAt] of this.finishedChats) {
      if (now - finishedAt > AGENT_PLATFORM_DONE_REMINDER_MAX_AGE_MS) {
        this.finishedChats.delete(candidateChatId);
      }
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
    }, AGENT_PLATFORM_RECONNECT_MS);
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
      socket.close(1000, "desktop pet refresh");
    } catch {
      // Ignore close failures for already-closing sockets.
    }
  }

  private clearTimers() {
    for (const timer of [this.refreshTimer, this.reconnectTimer, this.staleTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.refreshTimer = null;
    this.reconnectTimer = null;
    this.staleTimer = null;
  }
}

export const __testInternals = {
  AGENT_PLATFORM_STATUS_STALE_MS,
  createWsUrl,
  readFrameData
};
