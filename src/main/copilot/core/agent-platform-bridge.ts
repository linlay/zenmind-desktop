import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AssistantAttachment,
  AssistantAwaitingMode,
  AssistantChatDetail,
  AssistantChatMessage,
  AssistantChatSummary,
  AssistantEvent,
  AssistantMemoryItem,
  AssistantMemorySettings,
  AssistantMemoryStats,
  AssistantMemoryStorage,
  AssistantMemorySummary,
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantRunEvent,
  AssistantRunEventType,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AssistantStopRunResult,
  AssistantSubmitAwaitingRequest,
  AssistantSubmitAwaitingResult,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceCorrectionResult,
  AssistantVoiceTranscriptionRequest,
  AssistantVoiceTranscriptionResult,
  DesktopPetAgentOption,
  ServiceId,
  ServiceState
} from "../../../shared/contracts";
import { toDesktopPetAgentOptions } from "../pet-copilot/pet-status-client";
import { DesktopPetSseParser } from "../pet-copilot/desktop-pet-preview";
import { resolveAssistantAttachmentPath } from "../attachments/attachment-store";
import {
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform
} from "./assistant-navigation-status-client";

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";
const DONE_SENTINEL = "[DONE]";
const DEFAULT_MEMORY_SETTINGS: AssistantMemorySettings = {
  enabled: true,
  autoLearn: true,
  maxItems: 200,
  maxChars: 12000
};

type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

type AgentPlatformChatExportResult =
  | { ok: true; message: string; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename: string; bytes?: never };

type PlatformUploadTicket = {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  sha256?: string;
  sandboxPath?: string;
};

type PlatformChatSummary = {
  chatId?: string;
  chatName?: string;
  agentKey?: string;
  workerKey?: string;
  createdAt?: number;
  updatedAt?: number;
  lastRunContent?: string;
  read?: boolean | { isRead?: boolean };
  isRead?: boolean;
  awaiting?: unknown;
  hasPendingAwaiting?: boolean;
  awaitingCount?: number;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: string;
};

type PlatformRunSummary = {
  runId?: string;
  initialMessage?: string;
  assistantText?: string;
  startedAt?: number;
  completedAt?: number;
};

type PlatformChatDetail = {
  chatId?: string;
  chatName?: string;
  events?: Array<Record<string, unknown>>;
  runs?: PlatformRunSummary[];
};

type PlatformMemoryRecord = {
  id?: string;
  chatId?: string;
  runId?: string;
  kind?: string;
  scopeType?: string;
  subjectKey?: string;
  category?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  status?: string;
  sourceChatId?: string;
  sourceRunId?: string;
  accessCount?: number;
  createdAt?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
};

type PlatformMemoryRecordsResponse = {
  count?: number;
  results?: PlatformMemoryRecord[];
};

type PlatformMemoryHistoryResponse = {
  events?: Array<Record<string, unknown>>;
};

type PlatformAgentSummary = {
  key?: string;
  name?: string;
  displayName?: string;
  role?: string;
  icon?: unknown;
  stats?: {
    unreadCount?: number;
    totalCount?: number;
  };
  chats?: unknown;
};

function nowIso() {
  return new Date().toISOString();
}

function createChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createMessageId(role: string, runId: string) {
  return `msg_${role}_${runId}_${randomUUID().slice(0, 8)}`;
}

function createApiUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function readAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = readString(value).trim().toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "plan"
    ? mode
    : undefined;
}

function readAwaitingPayloadMode(value: unknown): AssistantAwaitingMode | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const mode = readAwaitingPayloadMode(item);
      if (mode) {
        return mode;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return readAwaitingMode(record.mode) || readAwaitingPayloadMode(record.awaiting);
}

function isPendingAwaitingPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(isPendingAwaitingPayload);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const type = readString(record.type).trim().toLowerCase();
  if (type === "awaiting.answer" || type === "awaiting.answered") {
    return false;
  }
  const status = readString(record.status).trim().toLowerCase();
  if (["answered", "cancelled", "canceled", "completed", "done", "error", "failed", "resolved", "timeout"].includes(status)) {
    return false;
  }
  if (record.hasPendingAwaiting === true || readNumber(record.awaitingCount) > 0) {
    return true;
  }
  if (record.hasPendingAwaiting === false) {
    return false;
  }
  return type === "awaiting.ask" ||
    type === "awaiting.asking" ||
    status === "awaiting" ||
    status === "pending" ||
    Boolean(readString(record.awaitingId)) ||
    isPendingAwaitingPayload(record.awaiting);
}

function timestampToIso(value: unknown) {
  const numberValue = readNumber(value);
  if (numberValue > 0) {
    return new Date(numberValue).toISOString();
  }
  return nowIso();
}

function readErrorCode(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") {
    return record.code;
  }
  const data = record.data;
  if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).code === "string") {
    return (data as Record<string, unknown>).code as string;
  }
  return "";
}

function recoverLegacyUtf8Filename(value: string) {
  if (!value || /[\u4e00-\u9fff]/u.test(value)) {
    return value;
  }
  if (typeof TextDecoder === "undefined") {
    return value;
  }

  try {
    const bytes = Uint8Array.from(
      Array.from(value, (char) => char.charCodeAt(0) & 0xff)
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded || value;
  } catch {
    return value;
  }
}

async function readErrorText(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `HTTP ${response.status}`;
    }
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const code = readErrorCode(payload);
      const message = typeof payload.msg === "string"
        ? payload.msg
        : typeof payload.message === "string"
          ? payload.message
          : text;
      return code ? `${code}: ${message}` : message;
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

function filenameFromContentDisposition(value: string | null) {
  const header = String(value || "");
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(header);
  if (quotedMatch?.[1]) {
    return recoverLegacyUtf8Filename(quotedMatch[1].trim());
  }
  const plainMatch = /filename=([^;]+)/i.exec(header);
  return plainMatch?.[1]
    ? recoverLegacyUtf8Filename(plainMatch[1].trim())
    : "";
}

function unwrapApiResponse<T>(payload: unknown): T {
  if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload) {
    const response = payload as ApiResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data;
  }
  return payload as T;
}

function dataUrlToBlob(dataUrl: string, fallbackMimeType: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/u.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1] || fallbackMimeType || "application/octet-stream";
  const encoded = match[3] || "";
  const bytes = match[2]
    ? Buffer.from(encoded, "base64")
    : Buffer.from(decodeURIComponent(encoded), "utf8");
  return new Blob([bytes], { type: mimeType });
}

function isPlatformEventType(type: string): type is AssistantRunEventType {
  return Boolean(type);
}

function normalizePlatformEvent(raw: Record<string, unknown>, fallback: {
  runId: string;
  chatId: string;
  source?: AssistantStartRunRequest["source"];
}): AssistantEvent | null {
  const type = readString(raw.type);
  if (!type) {
    return null;
  }
  const runId = readString(raw.runId) || fallback.runId;
  const chatId = readString(raw.chatId) || fallback.chatId;
  const event: AssistantEvent = {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.seq === "number" ? { seq: raw.seq } : {}),
    runId,
    chatId,
    type: isPlatformEventType(type) ? type : "content.delta",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestampToIso(raw.timestamp),
    ...(fallback.source ? { source: fallback.source } : {}),
    ...(typeof raw.status === "string" ? { status: raw.status as AssistantEvent["status"] } : {}),
    ...(typeof raw.delta === "string" ? { delta: raw.delta } : {}),
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(typeof raw.action === "string" ? { action: raw.action } : {}),
    ...(typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.awaitingId === "string" ? { awaitingId: raw.awaitingId } : {}),
    ...(typeof raw.mode === "string" ? { mode: raw.mode as AssistantAwaitingMode } : {}),
    ...(typeof raw.viewportType === "string" ? { viewportType: raw.viewportType } : {}),
    ...(typeof raw.viewportKey === "string" ? { viewportKey: raw.viewportKey } : {}),
    ...(typeof raw.timeout === "number" || raw.timeout === null ? { timeout: raw.timeout } : {}),
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
    ...(typeof raw.timestamp === "number" ? { timestamp: raw.timestamp } : {}),
    ...(Array.isArray(raw.questions) ? { questions: raw.questions as AssistantEvent["questions"] } : {}),
    ...(Array.isArray(raw.approvals) ? { approvals: raw.approvals as AssistantEvent["approvals"] } : {}),
    ...(Array.isArray(raw.forms) ? { forms: raw.forms as AssistantEvent["forms"] } : {}),
    ...(typeof raw.artifactCount === "number" ? { artifactCount: raw.artifactCount } : {}),
    ...(Array.isArray(raw.artifacts) ? { artifacts: raw.artifacts } : {}),
    ...(raw.data !== undefined ? { data: raw.data } : {})
  };
  if (typeof raw.awaiting === "object" && raw.awaiting !== null) {
    event.awaiting = raw.awaiting as AssistantEvent["awaiting"];
  }
  return event;
}

function isAssistantRunTerminalEvent(event: AssistantEvent) {
  return event.type === "done" ||
    event.type === "run.complete" ||
    event.type === "error" ||
    event.type === "stopped" ||
    event.type === "run.error" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.type === "run.expired";
}

function mapChatSummary(summary: PlatformChatSummary): AssistantChatSummary {
  const id = readString(summary.chatId);
  return {
    id,
    title: readString(summary.chatName) || "新的对话",
    createdAt: timestampToIso(summary.createdAt),
    updatedAt: timestampToIso(summary.updatedAt || summary.createdAt),
    lastMessage: readString(summary.lastRunContent),
    messageCount: 0
  };
}

function readChatAgentKey(summary: PlatformChatSummary) {
  return readString(summary.agentKey) || readString(summary.workerKey);
}

function readChatIsRead(summary: PlatformChatSummary) {
  if (typeof summary.isRead === "boolean") {
    return summary.isRead;
  }
  if (typeof summary.read === "boolean") {
    return summary.read;
  }
  if (typeof summary.read === "object" && summary.read !== null && typeof summary.read.isRead === "boolean") {
    return summary.read.isRead;
  }
  return true;
}

function chatHasPendingAwaiting(summary: PlatformChatSummary) {
  if (summary.hasPendingAwaiting === true) {
    return true;
  }
  if (summary.hasPendingAwaiting === false) {
    return false;
  }
  if (readNumber(summary.awaitingCount) > 0) {
    return true;
  }
  if (isPendingAwaitingPayload(summary.awaiting)) {
    return true;
  }
  return readString(summary.status).toLowerCase() === "awaiting";
}

function readChatAwaitingMode(summary: PlatformChatSummary) {
  return readAwaitingMode(summary.awaitingMode) ||
    readAwaitingMode(summary.mode) ||
    readAwaitingPayloadMode(summary.awaiting);
}

function compareChatUpdatedAt(left: PlatformChatSummary, right: PlatformChatSummary) {
  return readNumber(right.updatedAt || right.createdAt) - readNumber(left.updatedAt || left.createdAt);
}

function createNavigationAgentItem(agent: DesktopPetAgentOption, chats: PlatformChatSummary[]): AssistantNavAgentItem {
  const sortedChats = [...chats].sort(compareChatUpdatedAt);
  const latestChat = sortedChats[0] ?? null;
  const latestPreview = latestChat
    ? (readString(latestChat.lastRunContent) || readString(latestChat.chatName)).replace(/\s+/gu, " ").trim()
    : "";
  const unreadFromChats = sortedChats.filter((chat) => !readChatIsRead(chat)).length;
  return {
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    role: agent.role,
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    unreadCount: Math.max(0, agent.unreadCount, unreadFromChats),
    unreadChatCount: Math.max(0, agent.unreadCount, unreadFromChats),
    chatCount: sortedChats.length,
    hasPendingAwaiting: sortedChats.some(chatHasPendingAwaiting),
    latestChatId: latestChat ? readString(latestChat.chatId) || null : null,
    latestPreview: latestPreview.slice(0, 120),
    updatedAt: latestChat ? timestampToIso(latestChat.updatedAt || latestChat.createdAt) : nowIso(),
    recentChats: []
  };
}

function mapRunMessages(run: PlatformRunSummary): AssistantChatMessage[] {
  const runId = readString(run.runId) || createRunId();
  const createdAt = timestampToIso(run.startedAt);
  const completedAt = timestampToIso(run.completedAt || run.startedAt);
  const messages: AssistantChatMessage[] = [];
  const userContent = readString(run.initialMessage).trim();
  if (userContent) {
    messages.push({
      id: createMessageId("user", runId),
      role: "user",
      content: userContent,
      createdAt,
      runId
    });
  }
  const assistantContent = readString(run.assistantText).trim();
  if (assistantContent) {
    messages.push({
      id: createMessageId("assistant", runId),
      role: "assistant",
      content: assistantContent,
      createdAt: completedAt,
      runId
    });
  }
  return messages;
}

function mapMemoryRecord(record: PlatformMemoryRecord): AssistantMemoryItem {
  const kind = record.kind === "observation" ? "observation" : "fact";
  const status = record.status === "archived" || record.status === "open" ? record.status : "active";
  return {
    id: readString(record.id),
    kind,
    title: readString(record.title) || readString(record.summary).slice(0, 48) || "记忆",
    summary: readString(record.summary || record.title),
    category: readString(record.category),
    scopeType: record.scopeType === "chat" ? "chat" : "user",
    facet: readString(record.category),
    subjectKey: readString(record.subjectKey),
    tags: Array.isArray(record.tags) ? record.tags.filter((item): item is string => typeof item === "string") : [],
    importance: readNumber(record.importance),
    confidence: readNumber(record.confidence),
    status,
    sourceChatId: readString(record.sourceChatId || record.chatId),
    sourceRunId: readString(record.sourceRunId || record.runId),
    referenceCount: readNumber(record.accessCount),
    createdAt: timestampToIso(record.createdAt),
    updatedAt: timestampToIso(record.updatedAt || record.createdAt),
    ...(record.lastAccessedAt ? { lastReferencedAt: timestampToIso(record.lastAccessedAt) } : {})
  };
}

function createUnsupportedVoiceCorrectionResult(rawText: string): AssistantVoiceCorrectionResult {
  return {
    ok: false,
    text: rawText,
    rawText,
    correctedText: rawText,
    changeLevel: "none",
    confidence: 0,
    glossaryHits: [],
    uncertainTerms: [],
    message: "agent-platform 当前未提供语音文本纠错接口。"
  };
}

function normalizeAssistantPermissionMode(value: unknown): AssistantStartRunRequest["permissionMode"] {
  return value === "full_access" || value === "page_control" ? value : "default";
}

export class AgentPlatformAssistantBridge {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly options: {
    app: App;
    onEvent: (event: AssistantEvent) => void;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
  }) {}

  async startRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = createRunId();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId,
        message: "请输入要询问的内容。"
      };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        runId,
        chatId,
        message: availability.message
      };
    }
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    void this.runQuery(availability.baseUrl, availability.token, request, { chatId, runId, controller });
    return {
      ok: true,
      runId,
      chatId,
      message: "已交给 agent-platform 处理。",
      permissionMode: normalizeAssistantPermissionMode(request.permissionMode),
      fullAccessExpiresAt: null,
      fullAccessRemainingMs: 0
    };
  }

  async stopRun(runId: string): Promise<AssistantStopRunResult> {
    const trimmedRunId = runId.trim();
    this.activeRuns.get(trimmedRunId)?.abort();
    this.activeRuns.delete(trimmedRunId);
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(availability.baseUrl, "/api/interrupt", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({ runId: trimmedRunId, message: "Desktop requested stop." })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已请求 agent-platform 中断运行。" };
  }

  async submitAwaiting(request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> {
    const runId = request.runId?.trim() || "";
    if (!runId) {
      return { ok: false, message: "缺少 runId，无法提交给 agent-platform。" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const params = request.action === "submit"
      ? request.params ?? []
      : [{ action: request.action, reason: request.reason || "" }];
    const response = await this.platformFetch(availability.baseUrl, "/api/submit", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({
        runId,
        awaitingId: request.awaitingId,
        params
      })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已提交给 agent-platform。" };
  }

  async listAgents(): Promise<DesktopPetAgentOption[]> {
    const data = await this.getJson<PlatformAgentSummary[]>("/api/agents", {
      fallbackWhenUnavailable: []
    });
    return toDesktopPetAgentOptions(Array.isArray(data) ? data : []);
  }

  async listNavigationAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        message: availability.message,
        updatedAt: nowIso()
      };
    }
    return {
      ok: true,
      items: await readAssistantNavigationAgentsFromPlatform(availability.baseUrl, availability.token),
      message: "已读取智能助手导航状态。",
      updatedAt: nowIso()
    };
  }

  async listCopilotAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        message: availability.message,
        updatedAt: nowIso()
      };
    }
    return {
      ok: true,
      items: await readAssistantCopilotAgentsFromPlatform(availability.baseUrl, availability.token),
      message: "已读取侧边助手智能体列表。",
      updatedAt: nowIso()
    };
  }

  async listChats(): Promise<AssistantChatSummary[]> {
    const data = await this.getJson<PlatformChatSummary[]>("/api/chats");
    return Array.isArray(data) ? data.map(mapChatSummary) : [];
  }

  async getChat(chatId: string): Promise<AssistantChatDetail | null> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return null;
    }
    const data = await this.getJson<PlatformChatDetail>(`/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=true`, {
      allowNotFound: true
    });
    if (!data) {
      return null;
    }
    const events = Array.isArray(data.events)
      ? data.events
        .map((event) => normalizePlatformEvent(event, { runId: readString(event.runId), chatId: trimmedChatId }))
        .filter((event): event is AssistantRunEvent => Boolean(event && event.type !== "delta" && event.type !== "done" && event.type !== "error" && event.type !== "stopped"))
      : [];
    const messages = Array.isArray(data.runs) ? data.runs.flatMap(mapRunMessages) : [];
    return {
      summary: {
        id: readString(data.chatId) || trimmedChatId,
        title: readString(data.chatName) || "新的对话",
        createdAt: messages[0]?.createdAt ?? nowIso(),
        updatedAt: messages[messages.length - 1]?.createdAt ?? nowIso(),
        lastMessage: messages[messages.length - 1]?.content ?? "",
        messageCount: messages.length
      },
      messages,
      events
    };
  }

  async deleteChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: "缺少会话 ID。" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(
      availability.baseUrl,
      `/api/chat/delete?chatId=${encodeURIComponent(trimmedChatId)}`,
      {
        method: "POST",
        headers: this.jsonHeaders(availability.token),
        body: JSON.stringify({})
      }
    );
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已删除对话。" };
  }

  async markAgentChatsRead(agentKey: string) {
    const trimmedAgentKey = agentKey.trim();
    if (!trimmedAgentKey) {
      return { ok: false, message: "缺少 agentKey。" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(availability.baseUrl, "/api/read", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({ agentKey: trimmedAgentKey })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已将智能体会话全部标记为已读。" };
  }

  async renameChat(chatId: string, chatName: string) {
    const trimmedChatId = chatId.trim();
    const trimmedChatName = chatName.trim();
    if (!trimmedChatId || !trimmedChatName) {
      return { ok: false, message: "缺少会话 ID 或名称。" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(
      availability.baseUrl,
      `/api/chat/rename?chatId=${encodeURIComponent(trimmedChatId)}`,
      {
        method: "POST",
        headers: this.jsonHeaders(availability.token),
        body: JSON.stringify({ chatName: trimmedChatName })
      }
    );
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已重命名会话。" };
  }

  async archiveChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: "缺少会话 ID。" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(availability.baseUrl, "/api/chat/archive", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({ chatIds: [trimmedChatId] })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: "已归档会话。" };
  }

  async downloadChatExport(chatId: string): Promise<AgentPlatformChatExportResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: "缺少会话 ID。", filename: "" };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message, filename: "" };
    }
    const response = await this.platformFetch(
      availability.baseUrl,
      `/api/chat/export?chatId=${encodeURIComponent(trimmedChatId)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/octet-stream, application/json",
          Authorization: `Bearer ${availability.token}`
        }
      }
    );
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response), filename: "" };
    }
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.md`;
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: true, message: "已下载会话导出。", filename, bytes };
  }

  async getMemorySettings(): Promise<AssistantMemorySettings> {
    return DEFAULT_MEMORY_SETTINGS;
  }

  async saveMemorySettings(_input: Partial<AssistantMemorySettings>): Promise<AssistantMemorySettings> {
    return DEFAULT_MEMORY_SETTINGS;
  }

  async getMemorySummary(): Promise<AssistantMemorySummary> {
    const [itemsResult, historyResult] = await Promise.allSettled([
      this.listMemoryItems(),
      this.getJson<PlatformMemoryHistoryResponse>("/api/memory/history?limit=1")
    ]);
    const items = itemsResult.status === "fulfilled" ? itemsResult.value.items : [];
    const recentHistory = historyResult.status === "fulfilled" ? historyResult.value.events?.[0] : null;
    return {
      settings: DEFAULT_MEMORY_SETTINGS,
      stats: this.createMemoryStats(items),
      storage: this.createPlatformMemoryStorage(),
      directoryPath: "",
      recentAudit: recentHistory
        ? {
            operation: readString(recentHistory.operation),
            status: "ok",
            reason: readString(recentHistory.reason),
            timestamp: timestampToIso(recentHistory.ts)
          }
        : null
    };
  }

  async listMemoryItems(): Promise<{
    items: AssistantMemoryItem[];
    settings: AssistantMemorySettings;
    stats: AssistantMemoryStats;
    storage: AssistantMemoryStorage;
  }> {
    const data = await this.getJson<PlatformMemoryRecordsResponse>("/api/memory/records?limit=200");
    const items = Array.isArray(data.results) ? data.results.map(mapMemoryRecord) : [];
    return {
      items,
      settings: DEFAULT_MEMORY_SETTINGS,
      stats: this.createMemoryStats(items),
      storage: this.createPlatformMemoryStorage()
    };
  }

  async deleteMemoryItem(_memoryId: string) {
    return {
      ok: false,
      message: "agent-platform 当前未提供删除单条记忆的 HTTP 接口。"
    };
  }

  async clearMemoryItems() {
    return {
      ok: false,
      message: "agent-platform 当前未提供清空记忆的 HTTP 接口。"
    };
  }

  async correctVoiceText(request: AssistantVoiceCorrectionRequest): Promise<AssistantVoiceCorrectionResult> {
    return createUnsupportedVoiceCorrectionResult(request.text);
  }

  async transcribeVoiceAudio(_request: AssistantVoiceTranscriptionRequest): Promise<AssistantVoiceTranscriptionResult> {
    return {
      ...createUnsupportedVoiceCorrectionResult(""),
      message: "agent-platform 当前未提供语音转写接口。"
    };
  }

  private async runQuery(
    baseUrl: string,
    token: string,
    request: AssistantStartRunRequest,
    run: { chatId: string; runId: string; controller: AbortController }
  ) {
    try {
      const references = await this.uploadAttachments(baseUrl, token, run.chatId, run.runId, request.attachments ?? []);
      const response = await this.platformFetch(baseUrl, "/api/query", {
        method: "POST",
        headers: this.jsonHeaders(token, { Accept: "text/event-stream" }),
        body: JSON.stringify({
          runId: run.runId,
          chatId: run.chatId,
          agentKey: request.agentKey?.trim() || undefined,
          message: request.message.trim(),
          references,
          params: {
            desktop: {
              source: request.source || "copilot",
              action: request.action || "chat",
              pageContext: request.pageContext ?? null
            }
          },
          scene: request.pageContext
            ? {
                url: request.pageContext.url,
                title: request.pageContext.title
              }
            : undefined,
          stream: true
        }),
        signal: run.controller.signal
      });
      if (!response.ok) {
        throw new Error(await readErrorText(response));
      }
      const sawTerminalEvent = await this.consumeQueryStream(response, {
        runId: run.runId,
        chatId: run.chatId,
        source: request.source
      });
      if (!sawTerminalEvent) {
        this.options.onEvent({
          runId: run.runId,
          chatId: run.chatId,
          type: "run.complete",
          createdAt: nowIso(),
          ...(request.source ? { source: request.source } : {})
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        this.options.onEvent({
          runId: run.runId,
          chatId: run.chatId,
          type: "stopped",
          createdAt: nowIso(),
          message: "已停止。"
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.onEvent({
        runId: run.runId,
        chatId: run.chatId,
        type: "error",
        createdAt: nowIso(),
        message,
        error: message
      });
    } finally {
      this.activeRuns.delete(run.runId);
    }
  }

  private async consumeQueryStream(response: Response, fallback: {
    runId: string;
    chatId: string;
    source?: AssistantStartRunRequest["source"];
  }) {
    if (!response.body) {
      return false;
    }
    const parser = new DesktopPetSseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sawTerminalEvent = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
        const result = done ? parser.finish() : parser.push(chunk);
        for (const event of result.events) {
          const normalizedEvent = normalizePlatformEvent(event.raw, fallback) ?? {
            runId: fallback.runId,
            chatId: fallback.chatId,
            type: "content.delta",
            createdAt: nowIso(),
            delta: event.delta || event.text || event.content || ""
          };
          if (isAssistantRunTerminalEvent(normalizedEvent)) {
            sawTerminalEvent = true;
          }
          this.options.onEvent(normalizedEvent);
        }
        if (result.done) {
          break;
        }
        if (done) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return sawTerminalEvent;
  }

  private async uploadAttachments(baseUrl: string, token: string, chatId: string, runId: string, attachments: AssistantAttachment[]) {
    const references: PlatformUploadTicket[] = [];
    for (const attachment of attachments) {
      const ticket = await this.uploadAttachment(baseUrl, token, chatId, runId, attachment).catch(() => null);
      if (ticket) {
        references.push(ticket);
      }
    }
    return references;
  }

  private async uploadAttachment(baseUrl: string, token: string, chatId: string, runId: string, attachment: AssistantAttachment) {
    const formData = new FormData();
    formData.set("requestId", runId);
    formData.set("chatId", chatId);
    formData.set("name", attachment.name);
    const fileBlob = await this.attachmentToBlob(chatId, attachment);
    formData.set("file", fileBlob, attachment.name);
    const response = await this.platformFetch(baseUrl, "/api/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<{ upload: PlatformUploadTicket }>(await response.json());
    return payload.upload;
  }

  private async attachmentToBlob(chatId: string, attachment: AssistantAttachment) {
    if (attachment.dataUrl) {
      const blob = dataUrlToBlob(attachment.dataUrl, attachment.mimeType);
      if (blob) {
        return blob;
      }
    }
    try {
      const attachmentPath = resolveAssistantAttachmentPath(this.options.app, chatId, attachment.id);
      const buffer = await fs.promises.readFile(attachmentPath);
      return new Blob([buffer], { type: attachment.mimeType || "application/octet-stream" });
    } catch {
      const fallback = attachment.text || attachment.name || attachment.id;
      return new Blob([Buffer.from(fallback, "utf8")], { type: attachment.mimeType || "text/plain" });
    }
  }

  private async getJson<T>(
    pathOrUrl: string,
    options: { allowNotFound?: boolean; fallbackWhenUnavailable?: T } = {}
  ): Promise<T> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      if ("fallbackWhenUnavailable" in options) {
        return options.fallbackWhenUnavailable as T;
      }
      throw new Error(availability.message);
    }
    const response = await this.platformFetch(availability.baseUrl, pathOrUrl, {
      headers: this.jsonHeaders(availability.token)
    });
    if (response.status === 404 && options.allowNotFound) {
      return null as T;
    }
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    return unwrapApiResponse<T>(await response.json());
  }

  private async resolvePlatform(): Promise<
    | { ok: true; baseUrl: string; token: string }
    | { ok: false; message: string }
  > {
    const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID).catch((error) => ({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      healthMeta: { webUrl: "", port: null }
    } as Pick<ServiceState, "status" | "message" | "healthMeta">));
    const baseUrl = serviceState.status === "running"
      ? serviceState.healthMeta.webUrl.trim() || (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
      : "";
    if (!baseUrl) {
      return {
        ok: false,
        message: serviceState.message || "agent-platform 未运行，请先在控制中心启动平台服务。"
      };
    }
    const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      return {
        ok: false,
        message: tokenResult.message || "agent-platform token 不可用。"
      };
    }
    return {
      ok: true,
      baseUrl,
      token: tokenResult.token.trim()
    };
  }

  private platformFetch(baseUrl: string, pathname: string, init: RequestInit) {
    return fetch(createApiUrl(baseUrl, pathname), init);
  }

  private jsonHeaders(token: string, extra: Record<string, string> = {}) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extra
    };
  }

  private createMemoryStats(items: AssistantMemoryItem[]): AssistantMemoryStats {
    const lastLearnedAt = items.reduce<string | null>((latest, item) => {
      if (!latest || item.createdAt > latest) {
        return item.createdAt;
      }
      return latest;
    }, null);
    const lastReferencedAt = items.reduce<string | null>((latest, item) => {
      if (item.lastReferencedAt && (!latest || item.lastReferencedAt > latest)) {
        return item.lastReferencedAt;
      }
      return latest;
    }, null);
    return {
      total: items.length,
      factCount: items.filter((item) => item.kind === "fact").length,
      observationCount: items.filter((item) => item.kind === "observation").length,
      lastLearnedAt,
      lastReferencedAt
    };
  }

  private createPlatformMemoryStorage(): AssistantMemoryStorage {
    return {
      recordsPath: "agent-platform:/api/memory/records",
      staticPath: "agent-platform:/api/memory/scope",
      auditPath: "agent-platform:/api/memory/history",
      directoryPath: ""
    };
  }
}
