import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AssistantAttachment,
  AssistantAwaitingMode,
  AssistantChatDetail,
  AssistantChatInfo,
  AssistantChatMessage,
  AssistantChatSearchRequest,
  AssistantChatSearchResponse,
  AssistantChatSearchResult,
  AssistantChatSummary,
  AssistantEvent,
  AssistantHistoryChatItem,
  AssistantHistoryChatsResult,
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
  AssistantTextCompletionResult,
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
import {
  isTimeContractViolation,
  parseOptionalNullableAgentPlatformEpochMillis,
  requireAgentPlatformEpochMillis,
  requireEpochMillis,
} from "../../../shared/time-contract";
import { toDesktopPetAgentOptions } from "../pet/agent-options";
import { resolveAssistantAttachmentPath } from "../attachments/attachment-store";
import { resolveAssistantChatStoragePaths } from "./chat-storage-path";
import {
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform
} from "./assistant-navigation-status-client";
import { t } from "../../i18n/main-i18n";
import { parseSafeLoopbackWebUrl } from "../../loopback-url";
import {
  RealtimeBroker,
  type RealtimeQueryHandle,
} from "../../realtime/realtime-broker";
import type { AgentPlatformRealtimeSocketFactory } from "../../realtime/agent-platform-realtime-client";

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";
const MAX_CONVERSATION_MARKDOWN_BYTES = 2 << 20;
const MAX_RAW_CHAT_JSONL_BYTES = 100 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const STRUCTURED_PLATFORM_TIME_FIELDS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "resolvedAt",
  "timestamp",
  "expiresAt",
  "readAt",
  "lastAccessedAt",
] as const;
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

export type AgentPlatformRawChatJSONLResult =
  | { ok: true; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename?: never; bytes?: never };

type AssistantRunWakeLock = {
  acquire: () => void;
  release: () => void;
};

type ActiveAssistantRun = {
  controller: AbortController;
  chatId: string;
  agentKey: string;
  baseUrl: string;
  token: string;
  acceptance?: Promise<AssistantStartRunResult>;
};

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

export type AgentPlatformImageOperation =
  | "generate"
  | "imageToImage"
  | "inpaint"
  | "outpaint"
  | "removeObject"
  | "replaceBackground"
  | "removeBackground"
  | "enhance"
  | "repairSelection";

export type AgentPlatformImageCompletionRequest = Omit<AssistantStartRunRequest, "message"> & {
  operation: AgentPlatformImageOperation;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  strength: number;
  seed: number;
  preserveComposition: boolean;
  edgeMode: "strict" | "soft";
};

export type AgentPlatformImageCompletionResult =
  | {
      ok: true;
      runId: string;
      chatId: string;
      message: string;
      images: Array<{
        name: string;
        mimeType: "image/png" | "image/jpeg" | "image/webp";
        sizeBytes: number;
        sha256: string;
        dataBase64: string;
      }>;
    }
  | {
      ok: false;
      runId: string;
      chatId: string;
      message: string;
      images: [];
    };

type PlatformChatSummary = {
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  workerKey?: unknown;
  teamId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  read?: unknown;
  isRead?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: unknown;
  activeRun?: unknown;
  hasActiveRun?: unknown;
};

type PlatformRunSummary = {
  runId?: unknown;
  initialMessage?: unknown;
  assistantText?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

type PlatformChatDetail = {
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  firstAgentName?: unknown;
  teamId?: unknown;
  source?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  events?: Array<Record<string, unknown>>;
  runs?: PlatformRunSummary[];
  [key: string]: unknown;
};

type PlatformChatSearchResponse = {
  query?: string;
  count?: number;
  results?: unknown;
};

type PlatformArchiveChatResponse = {
  results?: Array<{
    chatId?: string;
    success?: boolean;
    error?: string;
  }>;
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
  createdAt?: unknown;
  updatedAt?: unknown;
  lastAccessedAt?: unknown;
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

type PlatformAdminRegistryListResponse = {
  items?: Array<{
    category?: string;
    file?: string;
    key?: string;
    status?: string;
    summary?: {
      syncStatus?: string;
      toolCount?: number;
      syncDiagnostic?: {
        message?: string;
      };
    };
    diagnostic?: {
      message?: string;
    };
  }>;
};

function createChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistant.now");
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

const IMAGE_OPERATION_INSTRUCTIONS: Record<AgentPlatformImageOperation, string> = {
  generate: "根据提示词生成一张全新图片。",
  imageToImage: "以原图为编辑目标，根据提示词进行图生图修改。",
  inpaint: "只重绘蒙版指定区域，未选区域保持不变。",
  outpaint: "在保持主体与视觉风格的前提下智能扩展原图边界。",
  removeObject: "移除蒙版区域内的对象，并根据周围内容自然补全。",
  replaceBackground: "替换图片背景，主体的外观、姿态和细节保持稳定。",
  removeBackground: "移除背景并保留主体，尽可能输出透明背景。",
  enhance: "增强清晰度、细节与色彩，保持原内容和构图。",
  repairSelection: "清除蒙版区域内的文字、标记或水印，并根据周围内容自然修复；素材已由用户确认拥有或获得授权。"
};

export function buildZenmiImageGenerateMessage(request: AgentPlatformImageCompletionRequest) {
  const source = request.attachments?.find((attachment) => attachment.id === "image-studio-source");
  const mask = request.attachments?.find((attachment) => attachment.id === "image-studio-mask");
  const promptParts = [
    IMAGE_OPERATION_INSTRUCTIONS[request.operation],
    request.prompt.trim(),
    request.negativePrompt?.trim() ? `避免出现：${request.negativePrompt.trim()}。` : "",
    `重绘强度参考 ${Math.round(request.strength * 100)}%。`,
    request.preserveComposition ? "保持原有构图。" : "允许重新组织构图。",
    request.edgeMode === "strict" ? "严格限制修改范围。" : "允许自然影响蒙版边缘。",
    `随机种子参考 ${request.seed}。`
  ].filter(Boolean).join(" ");
  const toolArgs: Record<string, unknown> = {
    prompt: promptParts,
    size: `${request.width}x${request.height}`,
    n: request.count
  };
  if (source) {
    toolArgs.images = [{ source_type: "reference_name", value: source.name }];
  }
  if (source && mask) {
    toolArgs.mask = { source_type: "reference_name", value: mask.name, mode: "white_edit" };
  }
  return [
    "必须且只能调用一次 image_generate 工具；不要调用文件、Shell、浏览器、桌面控制或其他工具，也不要向用户追问。",
    `请使用以下参数调用 image_generate：${JSON.stringify(toolArgs)}`
  ].join("\n");
}

type ImageGenerateOutcome = {
  callCount: number;
  resultSeen: boolean;
  ok: boolean;
  message: string;
  artifacts: Array<Record<string, unknown>>;
};

function imageResultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function imageGenerateFailureMessage(value: unknown): string {
  const record = imageResultRecord(value);
  if (!record) return "image_generate 返回了无效结果。";
  const direct = readString(record.message).trim() || readString(record.error).trim();
  if (direct) return direct;
  const nested = record.output;
  if (typeof nested === "string") {
    try {
      return imageGenerateFailureMessage(JSON.parse(nested));
    } catch {
      return nested.trim().slice(0, 500) || "image_generate 执行失败。";
    }
  }
  if (nested && nested !== value) return imageGenerateFailureMessage(nested);
  return "image_generate 执行失败。";
}

function observeImageGenerateEvent(event: Record<string, unknown>, outcome: ImageGenerateOutcome) {
  const eventType = readString(event.type);
  const toolName = readString(event.toolName);
  if (eventType === "tool.start") {
    if (toolName !== "image_generate") {
      outcome.message = `Zenmi 图片任务不允许调用 ${toolName || "未知工具"}。`;
      return true;
    }
    outcome.callCount += 1;
    if (outcome.callCount > 1) {
      outcome.message = "Zenmi 图片任务检测到第二次 image_generate 调用，运行已终止。";
      return true;
    }
    return false;
  }
  if (eventType !== "tool.result" || toolName !== "image_generate") return false;
  if (outcome.resultSeen) {
    outcome.message = "Zenmi 图片任务返回了多个 image_generate 结果，运行已终止。";
    outcome.ok = false;
    return true;
  }
  outcome.resultSeen = true;
  if (outcome.callCount === 0) outcome.callCount = 1;
  const result = imageResultRecord(event.result);
  const images = result?.images;
  if (result?.ok !== true || !Array.isArray(images) || images.length === 0) {
    outcome.message = imageGenerateFailureMessage(result);
    outcome.ok = false;
    return true;
  }
  for (const image of images) {
    const artifact = imageResultRecord(image);
    if (artifact) outcome.artifacts.push(artifact);
  }
  outcome.ok = outcome.artifacts.length > 0;
  outcome.message = outcome.ok ? "" : "image_generate 未返回有效 images[]。";
  return true;
}

function validGeneratedImageRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("://")) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
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
    mode === "planning"
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
  if (type === "awaiting.answered") {
    return false;
  }
  const status = readString(record.status).trim().toLowerCase();
  if (
    ["answered", "cancelled", "canceled", "completed", "done", "error", "failed", "resolved", "timeout"].includes(
      status
    )
  ) {
    return false;
  }
  if (record.hasPendingAwaiting === true || readNumber(record.awaitingCount) > 0) {
    return true;
  }
  if (record.hasPendingAwaiting === false) {
    return false;
  }
  return (
    type === "awaiting.asking" ||
    status === "awaiting" ||
    status === "pending" ||
    Boolean(readString(record.awaitingId)) ||
    isPendingAwaitingPayload(record.awaiting)
  );
}

function readRequiredPlatformTimestamp(value: unknown, field: string) {
  return requireAgentPlatformEpochMillis(value, field);
}

function readOptionalPlatformTimestamp(value: unknown, field: string) {
  return parseOptionalNullableAgentPlatformEpochMillis(value, field);
}

function validatePresentPlatformTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PLATFORM_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      readOptionalPlatformTimestamp(record[field], `${path}.${field}`);
    }
  }
}

function validateAwaitingPayloadTimes(value: unknown, path: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateAwaitingPayloadTimes(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  validatePresentPlatformTimes(record, path);
  if (record.awaiting !== undefined) {
    validateAwaitingPayloadTimes(record.awaiting, `${path}.awaiting`);
  }
}

function normalizeAwaitingPayload(value: unknown, path: string): AssistantEvent["awaiting"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  validateAwaitingPayloadTimes(record, path);
  const createdAt = readOptionalPlatformTimestamp(record.createdAt, `${path}.createdAt`);
  return {
    ...(record as Omit<NonNullable<AssistantEvent["awaiting"]>, "createdAt">),
    ...(createdAt !== undefined ? { createdAt } : {})
  } as AssistantEvent["awaiting"];
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

async function readErrorText(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `HTTP ${response.status}`;
    }
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const code = readErrorCode(payload);
      const message =
        typeof payload.msg === "string" ? payload.msg : typeof payload.message === "string" ? payload.message : text;
      return code ? `${code}: ${message}` : message;
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

class ResponseBytesTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number
  ) {
    super(`response is ${actualBytes} bytes; limit is ${limitBytes} bytes`);
  }
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseBytesTooLargeError(declaredLength, maxBytes);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new ResponseBytesTooLargeError(bytes.length, maxBytes);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseBytesTooLargeError(totalBytes, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
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
    return quotedMatch[1].trim();
  }
  const plainMatch = /filename=([^;]+)/i.exec(header);
  return plainMatch?.[1] ? plainMatch[1].trim() : "";
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

function readErrorPayloadText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const direct = readString(record.message)
    || readString(record.msg)
    || readString(record.detail)
    || readString(record.code)
    || readString(record.type);
  if (direct) {
    return direct;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return "";
  }
}

const PLATFORM_OUTPUT_TEXT_KEYS = [
  "result",
  "answer",
  "finalMessage",
  "assistantText",
  "lastRunContent",
  "output",
  "stdout",
  "content",
  "text",
  "summary"
] as const;

function readOutputTextFromRecord(record: Record<string, unknown>, keys: readonly string[] = PLATFORM_OUTPUT_TEXT_KEYS): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  const data = record.data;
  if (typeof data === "string") {
    return data.trim();
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = readOutputTextFromRecord(data as Record<string, unknown>, keys);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function readAssistantEventOutputText(event: AssistantEvent): string {
  if (event.message?.trim()) {
    return event.message.trim();
  }
  if (event.delta?.trim()) {
    return event.delta.trim();
  }
  const data = event.data;
  if (typeof data === "string") {
    return data.trim();
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return readOutputTextFromRecord(data as Record<string, unknown>);
  }
  return "";
}

function readAssistantTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        return readString((part as Record<string, unknown>).text);
      }
      return "";
    })
    .join("")
    .trim();
}

function readFinalAssistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    const text = readAssistantTextContent(record.content);
    if (text) {
      return text;
    }
  }
  return "";
}

function resolvePlatformChatFile(app: App, chatId: string): string {
  return resolveAssistantChatStoragePaths(app, chatId)?.chatFilePath ?? "";
}

function readFinalAssistantTextFromChatFile(filePath: string, runId: string): string {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").trim().split(/\n+/u).filter(Boolean);
  } catch {
    return "";
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (runId && readString(record.runId) && readString(record.runId) !== runId) {
      continue;
    }
    const text = readFinalAssistantTextFromMessages(record.messages);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizePlatformEvent(raw: Record<string, unknown>, fallback: {
  runId: string;
  chatId: string;
  source?: AssistantStartRunRequest["source"];
}, path: string): AssistantEvent | null {
  const type = readString(raw.type);
  if (!type) {
    return null;
  }
  validatePresentPlatformTimes(raw, path);
  const timestamp = readRequiredPlatformTimestamp(raw.timestamp, `${path}.timestamp`);
  const runId = readString(raw.runId) || fallback.runId;
  const chatId = readString(raw.chatId) || fallback.chatId;
  const errorText = readErrorPayloadText(raw.error);
  const outputText = readOutputTextFromRecord(raw);
  const message = outputText || readString(raw.message) || readString(raw.msg) || errorText;
  const delta = readString(raw.delta) || (type === "content.delta" ? outputText || readString(raw.message) : "");
  const awaitingMode = readAwaitingMode(raw.mode);
  const event: AssistantEvent = {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.seq === "number" ? { seq: raw.seq } : {}),
    runId,
    chatId,
    type: isPlatformEventType(type) ? type : "content.delta",
    createdAt: timestamp,
    ...(fallback.source ? { source: fallback.source } : {}),
    ...(typeof raw.status === "string" ? { status: raw.status as AssistantEvent["status"] } : {}),
    ...(delta ? { delta } : {}),
    ...(message ? { message } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(typeof raw.action === "string" ? { action: raw.action } : {}),
    ...(typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(typeof raw.awaitingId === "string" ? { awaitingId: raw.awaitingId } : {}),
    ...(awaitingMode ? { mode: awaitingMode } : {}),
    ...(typeof raw.viewportType === "string" ? { viewportType: raw.viewportType } : {}),
    ...(typeof raw.viewportKey === "string" ? { viewportKey: raw.viewportKey } : {}),
    ...(typeof raw.timeout === "number" || raw.timeout === null ? { timeout: raw.timeout } : {}),
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
    timestamp,
    ...(Array.isArray(raw.questions) ? { questions: raw.questions as AssistantEvent["questions"] } : {}),
    ...(Array.isArray(raw.approvals) ? { approvals: raw.approvals as AssistantEvent["approvals"] } : {}),
    ...(Array.isArray(raw.forms) ? { forms: raw.forms as AssistantEvent["forms"] } : {}),
    ...(typeof raw.artifactCount === "number" ? { artifactCount: raw.artifactCount } : {}),
    ...(Array.isArray(raw.artifacts) ? { artifacts: raw.artifacts } : {}),
    ...(raw.data !== undefined ? { data: raw.data } : {})
  };
  if (typeof raw.awaiting === "object" && raw.awaiting !== null) {
    const awaiting = normalizeAwaitingPayload(raw.awaiting, `${path}.awaiting`);
    if (awaiting) {
      event.awaiting = awaiting;
    }
  }
  return event;
}

function isAssistantRunTerminalEvent(event: AssistantEvent) {
  return (
    event.type === "done" ||
    event.type === "run.complete" ||
    event.type === "error" ||
    event.type === "stopped" ||
    event.type === "run.error" ||
    event.type === "run.cancel" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.type === "run.expired"
  );
}

function mapChatSummary(summary: PlatformChatSummary, path: string): AssistantChatSummary | null {
  validatePresentPlatformTimes(summary as Record<string, unknown>, path);
  validateAwaitingPayloadTimes(summary.awaiting, `${path}.awaiting`);
  const id = readString(summary.chatId);
  const createdAt = readRequiredPlatformTimestamp(summary.createdAt, `${path}.createdAt`);
  const updatedAt = readRequiredPlatformTimestamp(summary.updatedAt, `${path}.updatedAt`);
  if (!id) {
    return null;
  }
  return {
    id,
    title: readString(summary.chatName) || t("assistant.newChat"),
    createdAt,
    updatedAt,
    lastMessage: readString(summary.lastRunContent),
    messageCount: 0
  };
}

function mapHistoryChat(
  summary: PlatformChatSummary,
  path: string,
): AssistantHistoryChatItem | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error(`${path} must be an object`);
  }
  validatePresentPlatformTimes(summary as Record<string, unknown>, path);
  validateAwaitingPayloadTimes(summary.awaiting, `${path}.awaiting`);
  const chatId = readString(summary.chatId).trim();
  const createdAt = readRequiredPlatformTimestamp(summary.createdAt, `${path}.createdAt`);
  const updatedAt = readRequiredPlatformTimestamp(summary.updatedAt, `${path}.updatedAt`);
  if (!chatId) {
    return null;
  }
  const awaitingCount = Math.max(0, Math.floor(readNumber(summary.awaitingCount)));
  const awaitingMode = readChatAwaitingMode(summary);
  const teamId = readString(summary.teamId).trim();
  const agentKey = (
    readString(summary.agentKey) ||
    readString(summary.firstAgentKey) ||
    readString(summary.workerKey)
  ).trim();
  return {
    chatId,
    chatName: readString(summary.chatName).trim() || t("assistant.newChat"),
    agentKey,
    ...(teamId ? { teamId } : {}),
    createdAt,
    updatedAt,
    lastRunId: readString(summary.lastRunId).trim(),
    lastRunContent: readString(summary.lastRunContent),
    isRead: readChatIsRead(summary),
    hasActiveRun:
      summary.hasActiveRun === true ||
      (typeof summary.activeRun === "object" && summary.activeRun !== null),
    hasPendingAwaiting: chatHasPendingAwaiting(summary),
    ...(awaitingCount > 0 ? { awaitingCount } : {}),
    ...(awaitingMode ? { awaitingMode } : {}),
  };
}

function mapChatSearchResult(value: unknown, path: string): AssistantChatSearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  validatePresentPlatformTimes(record, path);
  validateAwaitingPayloadTimes(record.awaiting, `${path}.awaiting`);
  const timestamp = readRequiredPlatformTimestamp(record.timestamp, `${path}.timestamp`);
  const chatId = readString(record.chatId).trim();
  if (!chatId) {
    return null;
  }
  const agentKey = readString(record.agentKey).trim();
  const runId = readString(record.runId).trim();
  const role = readString(record.role).trim();
  return {
    chatId,
    chatName: readString(record.chatName),
    ...(agentKey ? { agentKey } : {}),
    ...(runId ? { runId } : {}),
    kind: readString(record.kind),
    ...(role ? { role } : {}),
    timestamp,
    snippet: readString(record.snippet),
    score: readNumber(record.score)
  };
}

function mapChatSearchResponse(
  payload: PlatformChatSearchResponse | null | undefined,
  fallbackQuery: string
): AssistantChatSearchResponse {
  const results = Array.isArray(payload?.results)
    ? payload.results
        .map((item, index) => mapChatSearchResult(item, `chatSearch.results[${index}]`))
        .filter((item): item is AssistantChatSearchResult => Boolean(item))
    : [];
  const rawCount = Number(payload?.count);
  const hasCount = payload && typeof payload === "object" && "count" in payload && Number.isFinite(rawCount);
  return {
    query: readString(payload?.query) || fallbackQuery,
    count: hasCount ? rawCount : results.length,
    results
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
  if (
    typeof summary.read === "object" &&
    summary.read !== null &&
    typeof (summary.read as { isRead?: unknown }).isRead === "boolean"
  ) {
    return (summary.read as { isRead: boolean }).isRead;
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
  return (
    readAwaitingMode(summary.awaitingMode) ||
    readAwaitingMode(summary.mode) ||
    readAwaitingPayloadMode(summary.awaiting)
  );
}

function mapRunMessages(run: PlatformRunSummary, path: string): AssistantChatMessage[] {
  validatePresentPlatformTimes(run as Record<string, unknown>, path);
  const runId = readString(run.runId) || createRunId();
  const userContent = readString(run.initialMessage).trim();
  const assistantContent = readString(run.assistantText).trim();
  const startedAt = readOptionalPlatformTimestamp(run.startedAt, `${path}.startedAt`);
  const completedAt = readOptionalPlatformTimestamp(run.completedAt, `${path}.completedAt`);
  if (userContent && (startedAt === undefined || startedAt === null)) {
    readRequiredPlatformTimestamp(run.startedAt, `${path}.startedAt`);
  }
  if (assistantContent && (completedAt === undefined || completedAt === null)) {
    readRequiredPlatformTimestamp(run.completedAt, `${path}.completedAt`);
  }
  const messages: AssistantChatMessage[] = [];
  if (userContent && startedAt !== undefined && startedAt !== null) {
    messages.push({
      id: createMessageId("user", runId),
      role: "user",
      content: userContent,
      createdAt: startedAt,
      runId
    });
  }
  if (assistantContent && completedAt !== undefined && completedAt !== null) {
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

function mapMemoryRecord(record: PlatformMemoryRecord, path: string): AssistantMemoryItem | null {
  validatePresentPlatformTimes(record as Record<string, unknown>, path);
  const kind = record.kind === "observation" ? "observation" : "fact";
  const status = record.status === "archived" || record.status === "open" ? record.status : "active";
  const createdAt = readRequiredPlatformTimestamp(record.createdAt, `${path}.createdAt`);
  const updatedAt = readRequiredPlatformTimestamp(record.updatedAt, `${path}.updatedAt`);
  const lastReferencedAt = readOptionalPlatformTimestamp(record.lastAccessedAt, `${path}.lastAccessedAt`);
  return {
    id: readString(record.id),
    kind,
    title: readString(record.title) || readString(record.summary).slice(0, 48) || t("assistant.memory"),
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
    createdAt,
    updatedAt,
    ...(lastReferencedAt === undefined ? {} : { lastReferencedAt })
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
    message: t("agentPlatform.voiceCorrectionUnsupported")
  };
}

function normalizeAssistantPermissionMode(value: unknown): AssistantStartRunRequest["permissionMode"] {
  return value === "full_access" || value === "page_control" ? value : "default";
}

function normalizeAssistantAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  return value === "default" || value === "auto_approve" || value === "full_access" ? value : undefined;
}

export class AgentPlatformAssistantBridge {
  private readonly activeRuns = new Map<string, ActiveAssistantRun>();
  private readonly realtimeBroker: RealtimeBroker;
  private readonly ownsRealtimeBroker: boolean;
  private disposed = false;

  constructor(private readonly options: {
    app: App;
    onEvent: (event: AssistantEvent) => void;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    wakeLock?: AssistantRunWakeLock;
    realtimeBroker?: RealtimeBroker;
    createWebSocket?: AgentPlatformRealtimeSocketFactory;
    assistantWsConnectTimeoutMs?: number;
    assistantWsAcceptanceTimeoutMs?: number;
  }) {
    this.ownsRealtimeBroker = !options.realtimeBroker;
    this.realtimeBroker = options.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      createWebSocket: options.createWebSocket,
      connectTimeoutMs: options.assistantWsConnectTimeoutMs,
      acceptanceTimeoutMs: options.assistantWsAcceptanceTimeoutMs,
    });
  }

  private acquireWakeLockForActiveRuns() {
    if (this.activeRuns.size === 1) {
      this.options.wakeLock?.acquire();
    }
  }

  private releaseWakeLockIfIdle() {
    if (this.activeRuns.size === 0) {
      this.options.wakeLock?.release();
    }
  }

  async startRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = request.runId?.trim() || createRunId();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId,
        message: t("assistant.messageRequired")
      };
    }
    if (this.disposed) {
      return {
        ok: false,
        runId,
        chatId,
        message: "Assistant bridge is disposed"
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
    const existing = this.activeRuns.get(runId);
    if (existing) {
      if (existing.chatId !== chatId || !existing.acceptance) {
        return {
          ok: false,
          runId,
          chatId,
          message: "runId is already active with a different Assistant transaction"
        };
      }
      return existing.acceptance;
    }
    const controller = new AbortController();
    let resolveAcceptance!: (result: AssistantStartRunResult) => void;
    const acceptance = new Promise<AssistantStartRunResult>((resolve) => {
      resolveAcceptance = resolve;
    });
    const activeRun: ActiveAssistantRun = {
      controller,
      chatId,
      agentKey: request.agentKey?.trim() || "",
      baseUrl: availability.baseUrl,
      token: availability.token,
      acceptance,
    };
    this.activeRuns.set(runId, activeRun);
    this.acquireWakeLockForActiveRuns();
    void this.runQuery(availability.baseUrl, availability.token, request, {
      chatId,
      runId,
      activeRun,
      onAcceptance: resolveAcceptance,
    });
    return acceptance;
  }

  async completeText(
    request: AssistantStartRunRequest,
    onRawEvent?: (event: Record<string, unknown>) => boolean | void,
    strictAttachments = false
  ): Promise<AssistantTextCompletionResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = request.runId?.trim() || createRunId();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId,
        text: "",
        message: t("assistant.messageRequired")
      };
    }
    if (this.disposed) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: "Assistant bridge is disposed"
      };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: availability.message
      };
    }
    if (this.activeRuns.has(runId)) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: "runId is already active"
      };
    }
    const controller = new AbortController();
    const activeRun: ActiveAssistantRun = {
      controller,
      chatId,
      agentKey: request.agentKey?.trim() || "",
      baseUrl: availability.baseUrl,
      token: availability.token,
    };
    this.activeRuns.set(runId, activeRun);
    this.acquireWakeLockForActiveRuns();
    return this.runQuery(availability.baseUrl, availability.token, request, {
      chatId,
      runId,
      activeRun,
      onRawEvent,
      strictAttachments,
    });
  }

  async completeImage(request: AgentPlatformImageCompletionRequest): Promise<AgentPlatformImageCompletionResult> {
    const outcome: ImageGenerateOutcome = {
      callCount: 0,
      resultSeen: false,
      ok: false,
      message: "",
      artifacts: []
    };
    const completion = await this.completeText(
      {
        ...request,
        message: buildZenmiImageGenerateMessage(request)
      },
      (event) => observeImageGenerateEvent(event, outcome),
      true
    );
    if (outcome.message && !outcome.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: outcome.message, images: [] };
    }
    if (!outcome.resultSeen) {
      if (!completion.ok) {
        return { ok: false, runId: completion.runId, chatId: completion.chatId, message: completion.message, images: [] };
      }
      return {
        ok: false,
        runId: completion.runId,
        chatId: completion.chatId,
        message: "Zenmi 未返回 image_generate 工具结果。",
        images: []
      };
    }
    if (!outcome.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: completion.message, images: [] };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, runId: completion.runId, chatId: completion.chatId, message: availability.message, images: [] };
    }
    const images: Extract<AgentPlatformImageCompletionResult, { ok: true }>["images"] = [];
    for (const artifact of outcome.artifacts.slice(0, request.count)) {
      const relativePath = readString(artifact.relativePath).trim();
      if (!validGeneratedImageRelativePath(relativePath)) continue;
      const resourceURL = new URL("/api/resource", availability.baseUrl);
      resourceURL.searchParams.set("file", `${completion.chatId}/${relativePath}`);
      const response = await this.platformFetch(availability.baseUrl, resourceURL.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${availability.token}` }
      });
      if (!response.ok) continue;
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") continue;
      let bytes: Buffer;
      try {
        bytes = await readResponseBytesWithLimit(response, MAX_GENERATED_IMAGE_BYTES);
      } catch {
        continue;
      }
      if (bytes.length === 0) continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const expectedSha256 = readString(artifact.sha256).trim().toLowerCase();
      if (expectedSha256 && expectedSha256 !== sha256) continue;
      images.push({
        name: path.basename(relativePath),
        mimeType,
        sizeBytes: bytes.length,
        sha256,
        dataBase64: bytes.toString("base64")
      });
    }
    if (images.length === 0) {
      return {
        ok: false,
        runId: completion.runId,
        chatId: completion.chatId,
        message: "Zenmi 已生成图片，但 Desktop 无法安全读取生成结果。",
        images: []
      };
    }
    return {
      ok: true,
      runId: completion.runId,
      chatId: completion.chatId,
      message: "Zenmi 图片生成成功。",
      images
    };
  }

  async stopRun(runId: string): Promise<AssistantStopRunResult> {
    const trimmedRunId = runId.trim();
    const activeRun = this.activeRuns.get(trimmedRunId);
    activeRun?.controller.abort();
    if (this.activeRuns.delete(trimmedRunId)) {
      this.releaseWakeLockIfIdle();
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(availability.baseUrl, "/api/interrupt", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({
        runId: trimmedRunId,
        ...(activeRun?.agentKey ? { agentKey: activeRun.agentKey } : {}),
        message: "Desktop requested stop."
      })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("agentPlatform.stopRequested") };
  }

  async submitAwaiting(request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> {
    const runId = request.runId?.trim() || "";
    if (!runId) {
      return { ok: false, message: t("agentPlatform.runIdRequired") };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const params =
      request.action === "submit" ? (request.params ?? []) : [{ action: request.action, reason: request.reason || "" }];
    const response = await this.platformFetch(availability.baseUrl, "/api/submit", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify({
        runId,
        ...(this.activeRuns.get(runId)?.agentKey ? { agentKey: this.activeRuns.get(runId)?.agentKey } : {}),
        awaitingId: request.awaitingId,
        params
      })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("agentPlatform.submitted") };
  }

  async listAgents(): Promise<DesktopPetAgentOption[]> {
    const data = await this.getJson<PlatformAgentSummary[]>("/api/agents", {
      fallbackWhenUnavailable: []
    });
    return toDesktopPetAgentOptions(Array.isArray(data) ? data : []);
  }

  async listMcpRuntimeStatuses() {
    const data = await this.getJson<PlatformAdminRegistryListResponse>("/api/admin/registries");
    return (data.items ?? [])
      .filter((item) => item.category === "mcp-servers" && (item.key?.trim() || item.file?.trim()))
      .map((item) => ({
        serverKey: item.key?.trim() || item.file?.trim().replace(/\.ya?ml$/iu, "") || "",
        status: item.status?.trim() ?? "",
        syncStatus: item.summary?.syncStatus?.trim() ?? "",
        toolCount: Number.isFinite(item.summary?.toolCount)
          ? Math.max(0, Math.trunc(item.summary?.toolCount ?? 0))
          : 0,
        message: item.summary?.syncDiagnostic?.message?.trim() || item.diagnostic?.message?.trim() || ""
      }));
  }

  async listNavigationAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: availability.message,
        updatedAt: nowEpochMillis()
      };
    }
    return {
      ok: true,
      items: await readAssistantNavigationAgentsFromPlatform(availability.baseUrl, availability.token),
      chatItems: [],
      chatItemsHasMore: false,
      message: t("assistant.navigationStatusRead"),
      updatedAt: nowEpochMillis()
    };
  }

  async listCopilotAgents(): Promise<AssistantNavAgentItemsResult> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message: availability.message,
        updatedAt: nowEpochMillis()
      };
    }
    return {
      ok: true,
      items: await readAssistantCopilotAgentsFromPlatform(availability.baseUrl, availability.token),
      chatItems: [],
      chatItemsHasMore: false,
      message: t("assistant.copilotAgentsRead"),
      updatedAt: nowEpochMillis()
    };
  }

  async listChats(): Promise<AssistantChatSummary[]> {
    const data = await this.getJson<PlatformChatSummary[]>("/api/chats");
    return Array.isArray(data)
      ? data
          .map((summary, index) => mapChatSummary(summary, `chats[${index}]`))
          .filter((summary): summary is AssistantChatSummary => summary !== null)
      : [];
  }

  async listHistoryChats(): Promise<AssistantHistoryChatsResult> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        message: availability.message,
        updatedAt: nowEpochMillis(),
      };
    }
    const response = await this.platformFetch(availability.baseUrl, "/api/chats", {
      headers: this.jsonHeaders(availability.token),
    });
    if (!response.ok) {
      return {
        ok: false,
        items: [],
        message: await readErrorText(response),
        updatedAt: nowEpochMillis(),
      };
    }
    const data = unwrapApiResponse<PlatformChatSummary[]>(await response.json());
    const items = Array.isArray(data)
      ? data
        .map((summary, index) => mapHistoryChat(summary, `historyChats[${index}]`))
        .filter((summary): summary is AssistantHistoryChatItem => summary !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.chatId.localeCompare(right.chatId))
      : [];
    return {
      ok: true,
      items,
      message: "",
      updatedAt: nowEpochMillis(),
    };
  }

  async getChat(chatId: string): Promise<AssistantChatDetail | null> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return null;
    }
    const data = await this.getJson<PlatformChatDetail>(
      `/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=true`,
      {
        allowNotFound: true
      }
    );
    if (!data) {
      return null;
    }
    validatePresentPlatformTimes(data as Record<string, unknown>, "chat");
    const events = Array.isArray(data.events)
      ? data.events
          .map((event, index) =>
            normalizePlatformEvent(
              event,
              { runId: readString(event.runId), chatId: trimmedChatId },
              `chat.events[${index}]`
            )
          )
          .filter((event): event is AssistantRunEvent =>
            Boolean(
              event &&
              event.type !== "delta" &&
              event.type !== "done" &&
              event.type !== "error" &&
              event.type !== "stopped"
            )
          )
      : [];
    const messages = Array.isArray(data.runs)
      ? data.runs.flatMap((run, index) => mapRunMessages(run, `chat.runs[${index}]`))
      : [];
    return {
      summary: {
        id: readString(data.chatId) || trimmedChatId,
        title: readString(data.chatName) || t("assistant.newChat"),
        createdAt: readRequiredPlatformTimestamp(data.createdAt, "chat.createdAt"),
        updatedAt: readRequiredPlatformTimestamp(data.updatedAt, "chat.updatedAt"),
        lastMessage: messages[messages.length - 1]?.content ?? "",
        messageCount: messages.length
      },
      messages,
      events
    };
  }

  async getChatInfo(chatId: string): Promise<AssistantChatInfo | null> {
    const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
    if (!trimmedChatId) {
      return null;
    }
    const data = await this.getJson<PlatformChatDetail>(
      `/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=false`,
      { allowNotFound: true },
    );
    if (!data) {
      return null;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Agent Platform returned an invalid chat detail response.");
    }
    validatePresentPlatformTimes(data, "chatInfo");
    const createdAt = readOptionalPlatformTimestamp(data.createdAt, "chatInfo.createdAt");
    const updatedAt = readOptionalPlatformTimestamp(data.updatedAt, "chatInfo.updatedAt");
    return {
      chatId: readString(data.chatId) || trimmedChatId,
      chatName: readString(data.chatName),
      agentKey: readString(data.agentKey),
      firstAgentKey: readString(data.firstAgentKey),
      firstAgentName: readString(data.firstAgentName),
      teamId: readString(data.teamId),
      source: readString(data.source),
      ...(createdAt !== undefined && createdAt !== null ? { createdAt } : {}),
      ...(updatedAt !== undefined && updatedAt !== null ? { updatedAt } : {}),
      lastRunId: readString(data.lastRunId),
      lastRunContent: readString(data.lastRunContent),
      rawJson: JSON.stringify(data, null, 2),
    };
  }

  async searchChats(request: AssistantChatSearchRequest): Promise<AssistantChatSearchResponse> {
    const query = request?.query?.trim() ?? "";
    if (!query) {
      return { query: "", count: 0, results: [] };
    }
    const limit = Number.isFinite(Number(request.limit)) && Number(request.limit) > 0
      ? Math.floor(Number(request.limit))
      : undefined;
    const agentKey = request.agentKey?.trim() ?? "";
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      throw new Error(availability.message);
    }
    const body = {
      query,
      ...(limit ? { limit } : {}),
      ...(agentKey ? { agentKey } : {})
    };
    const response = await this.platformFetch(availability.baseUrl, "/api/chats/search", {
      method: "POST",
      headers: this.jsonHeaders(availability.token),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<PlatformChatSearchResponse>(await response.json());
    return mapChatSearchResponse(payload, query);
  }

  async deleteChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
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
    return { ok: true, message: t("assistant.chatDeleted") };
  }

  async markAgentChatsRead(agentKey: string) {
    const trimmedAgentKey = agentKey.trim();
    if (!trimmedAgentKey) {
      return { ok: false, message: t("assistant.agentKeyRequired") };
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
    return { ok: true, message: t("assistant.agentChatsMarkedRead") };
  }

  async renameChat(chatId: string, chatName: string) {
    const trimmedChatId = chatId.trim();
    const trimmedChatName = chatName.trim();
    if (!trimmedChatId || !trimmedChatName) {
      return { ok: false, message: t("assistant.chatIdOrNameRequired") };
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
    return { ok: true, message: t("assistant.chatRenamed") };
  }

  async archiveChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
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
    let payload: PlatformArchiveChatResponse;
    try {
      payload = unwrapApiResponse<PlatformArchiveChatResponse>(await response.json());
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : t("assistant.chatArchiveFailed")
      };
    }
    const archiveResult = payload.results?.find(
      (result) => result.chatId?.trim() === trimmedChatId
    ) ?? payload.results?.[0];
    if (archiveResult?.success !== true) {
      return {
        ok: false,
        message: archiveResult?.error?.trim() || t("assistant.chatArchiveFailed")
      };
    }
    return { ok: true, message: t("assistant.chatArchived") };
  }

  async downloadChatExport(chatId: string): Promise<AgentPlatformChatExportResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return {
        ok: false,
        message: t("assistant.chatIdRequired"),
        filename: ""
      };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message, filename: "" };
    }
    const response = await this.platformFetch(
      availability.baseUrl,
      `/api/chat/export?chatId=${encodeURIComponent(trimmedChatId)}&format=markdown`,
      {
        method: "GET",
        headers: {
          Accept: "text/markdown, application/json",
          Authorization: `Bearer ${availability.token}`
        }
      }
    );
    if (!response.ok) {
      return {
        ok: false,
        message: await readErrorText(response),
        filename: ""
      };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/markdown") {
      return {
        ok: false,
        message: t("assistant.chatExportUnsupported"),
        filename: ""
      };
    }
    try {
      return {
        ok: true,
        message: t("assistant.chatExportDownloaded"),
        filename: filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.md`,
        bytes: await readResponseBytesWithLimit(response, MAX_CONVERSATION_MARKDOWN_BYTES)
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof ResponseBytesTooLargeError
            ? t("assistant.chatExportTooLarge")
            : t("assistant.chatExportReadFailed"),
        filename: ""
      };
    }
  }

  async createChatSnapshotRequest(chatId: string): Promise<
    | { ok: true; snapshotUrl: string; bearerToken: string }
    | { ok: false; message: string }
  > {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return availability;
    }
    const baseURL = parseSafeLoopbackWebUrl(availability.baseUrl);
    if (!baseURL) {
      return { ok: false, message: t("assistant.chatHtmlExportUnsupported") };
    }
    const snapshotURL = new URL("/api/chat/export", baseURL.origin);
    snapshotURL.searchParams.set("chatId", trimmedChatId);
    snapshotURL.searchParams.set("format", "snapshot");
    return {
      ok: true,
      snapshotUrl: snapshotURL.toString(),
      bearerToken: availability.token
    };
  }

  async downloadRawChatJSONL(chatId: string): Promise<AgentPlatformRawChatJSONLResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platformFetch(
      availability.baseUrl,
      `/api/chat/jsonl?chatId=${encodeURIComponent(trimmedChatId)}`,
      {
        method: "GET",
        headers: {
          Accept: "text/plain, application/x-ndjson",
          Authorization: `Bearer ${availability.token}`
        }
      }
    );
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/plain" && contentType !== "application/x-ndjson") {
      return { ok: false, message: t("assistant.rawChatJsonlUnsupported") };
    }
    try {
      return {
        ok: true,
        filename:
          filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.jsonl`,
        bytes: await readResponseBytesWithLimit(response, MAX_RAW_CHAT_JSONL_BYTES)
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof ResponseBytesTooLargeError
            ? t("assistant.rawChatJsonlTooLarge")
            : t("assistant.rawChatJsonlReadFailed")
      };
    }
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
    if (itemsResult.status === "rejected" && isTimeContractViolation(itemsResult.reason)) {
      throw itemsResult.reason;
    }
    if (historyResult.status === "rejected" && isTimeContractViolation(historyResult.reason)) {
      throw historyResult.reason;
    }
    const items = itemsResult.status === "fulfilled" ? itemsResult.value.items : [];
    const history = historyResult.status === "fulfilled" ? historyResult.value.events : [];
    const audits = Array.isArray(history)
      ? history.map((event, index) => ({
          operation: readString(event.operation),
          status: "ok",
          reason: readString(event.reason),
          timestamp: readRequiredPlatformTimestamp(event.ts, `memory.history[${index}].ts`)
        }))
      : [];
    const recentAudit = audits[0] ?? null;
    return {
      settings: DEFAULT_MEMORY_SETTINGS,
      stats: this.createMemoryStats(items),
      storage: this.createPlatformMemoryStorage(),
      directoryPath: "",
      recentAudit
    };
  }

  async listMemoryItems(): Promise<{
    items: AssistantMemoryItem[];
    settings: AssistantMemorySettings;
    stats: AssistantMemoryStats;
    storage: AssistantMemoryStorage;
  }> {
    const data = await this.getJson<PlatformMemoryRecordsResponse>("/api/memory/record/list?limit=200");
    const items = Array.isArray(data.results)
      ? data.results
          .map((item, index) => mapMemoryRecord(item, `memory.records[${index}]`))
          .filter((item): item is AssistantMemoryItem => item !== null)
      : [];
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
      message: t("agentPlatform.deleteMemoryUnsupported")
    };
  }

  async clearMemoryItems() {
    return {
      ok: false,
      message: t("agentPlatform.clearMemoryUnsupported")
    };
  }

  async correctVoiceText(request: AssistantVoiceCorrectionRequest): Promise<AssistantVoiceCorrectionResult> {
    return createUnsupportedVoiceCorrectionResult(request.text);
  }

  async transcribeVoiceAudio(_request: AssistantVoiceTranscriptionRequest): Promise<AssistantVoiceTranscriptionResult> {
    return {
      ...createUnsupportedVoiceCorrectionResult(""),
      message: t("agentPlatform.voiceTranscriptionUnsupported")
    };
  }

  private async runQuery(
    baseUrl: string,
    token: string,
    request: AssistantStartRunRequest,
    run: {
      chatId: string;
      runId: string;
      activeRun: ActiveAssistantRun;
      onAcceptance?: (result: AssistantStartRunResult) => void;
      onRawEvent?: (event: Record<string, unknown>) => boolean | void;
      strictAttachments?: boolean;
    }
  ): Promise<AssistantTextCompletionResult> {
    let acceptanceSettled = false;
    let stoppedByRawEvent = false;
    const settleAcceptance = (result: AssistantStartRunResult) => {
      if (acceptanceSettled) {
        return;
      }
      acceptanceSettled = true;
      run.onAcceptance?.(result);
    };
    try {
      const references = await this.uploadAttachments(
        baseUrl,
        token,
        run.chatId,
        run.runId,
        request.attachments ?? [],
        run.strictAttachments === true
      );
      const accessLevel = normalizeAssistantAccessLevel(request.accessLevel);
      const requestId = request.requestId?.trim() || run.runId;
      const query: RealtimeQueryHandle = this.realtimeBroker.query({
        baseUrl,
        token,
        id: requestId,
        runId: run.runId,
        chatId: run.chatId,
        ...(request.agentKey?.trim()
          ? {
              owner: {
                kind: "agent" as const,
                agentKey: request.agentKey.trim()
              }
            }
          : {}),
        signal: run.activeRun.controller.signal,
        payload: {
          requestId,
          runId: run.runId,
          chatId: run.chatId,
          agentKey: request.agentKey?.trim() || undefined,
          message: request.message.trim(),
          ...(accessLevel ? { accessLevel } : {}),
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
        },
        onEvent: async (event, eventPath) => {
          const stopAfterEvent = run.onRawEvent?.(event) === true;
          const normalizedEvent = normalizePlatformEvent(
            event,
            {
              runId: run.runId,
              chatId: run.chatId,
              source: request.source
            },
            eventPath
          );
          if (!normalizedEvent) {
            throw new Error("time_contract_violation: stream event.type is required");
          }
          const eventText = readAssistantEventOutputText(normalizedEvent);
          const delta = normalizedEvent.type === "content.delta" ? normalizedEvent.delta || eventText : "";
          if (delta) {
            finalMessage += delta;
          }
          if (isAssistantRunTerminalEvent(normalizedEvent)) {
            sawTerminalEvent = true;
            const terminalMessage =
              normalizedEvent.message ||
              eventText ||
              finalMessage.trim() ||
              (await this.readPersistedFinalAssistantMessage(run.chatId, run.runId));
            if (!finalMessage && terminalMessage) {
              finalMessage = terminalMessage;
            }
            if (!normalizedEvent.message && terminalMessage) {
              normalizedEvent.message = terminalMessage;
            }
          }
          this.options.onEvent(normalizedEvent);
          if (stopAfterEvent && !run.activeRun.controller.signal.aborted) {
            stoppedByRawEvent = true;
            await this.bestEffortInterrupt(
              run.runId,
              run.activeRun,
              "Image Studio reached its single permitted tool boundary."
            );
            run.activeRun.controller.abort();
          }
        }
      });
      let finalMessage = "";
      let sawTerminalEvent = false;
      const accepted = await query.accepted;
      run.activeRun.agentKey = accepted.owner.kind === "agent" ? accepted.owner.agentKey : run.activeRun.agentKey;
      settleAcceptance({
        ok: true,
        runId: run.runId,
        chatId: run.chatId,
        message: t("agentPlatform.runSubmitted"),
        permissionMode: normalizeAssistantPermissionMode(request.permissionMode),
        fullAccessRemainingMs: 0
      });
      await query.completed;
      if (!sawTerminalEvent) {
        throw new Error("time_contract_violation: stream ended before a timestamped business terminal event");
      }
      return {
        ok: true,
        runId: run.runId,
        chatId: run.chatId,
        text: finalMessage.trim(),
        message: finalMessage.trim()
      };
    } catch (error) {
      if (stoppedByRawEvent) {
        return {
          ok: false,
          runId: run.runId,
          chatId: run.chatId,
          text: "",
          message: "Image Studio stopped the agent after its single permitted tool result."
        };
      }
      const message =
        (error as Error).name === "AbortError"
          ? t("assistant.stopped")
          : error instanceof Error
            ? error.message
            : String(error);
      settleAcceptance({
        ok: false,
        runId: run.runId,
        chatId: run.chatId,
        message
      });
      if (
        error instanceof Error &&
        (error.name === "connection_lost_before_acceptance" ||
          error.message.startsWith("connection_lost_before_acceptance:")) &&
        run.activeRun.agentKey
      ) {
        this.bestEffortInterrupt(run.runId, run.activeRun, "Desktop Assistant WebSocket disconnected.");
      }
      if ((error as Error).name === "AbortError") {
        if (!this.disposed) {
          this.options.onEvent({
            runId: run.runId,
            chatId: run.chatId,
            type: "stopped",
            createdAt: nowEpochMillis(),
            message
          });
        }
        return {
          ok: false,
          runId: run.runId,
          chatId: run.chatId,
          text: "",
          message
        };
      }
      if (!this.disposed) {
        this.options.onEvent({
          runId: run.runId,
          chatId: run.chatId,
          type: "error",
          ...(isTimeContractViolation(error) ? {} : { createdAt: nowEpochMillis() }),
          message,
          error: message
        });
      }
      return {
        ok: false,
        runId: run.runId,
        chatId: run.chatId,
        text: "",
        message
      };
    } finally {
      if (this.activeRuns.get(run.runId) === run.activeRun) {
        this.activeRuns.delete(run.runId);
        this.releaseWakeLockIfIdle();
      }
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [runId, activeRun] of this.activeRuns) {
      if (activeRun.agentKey) {
        this.bestEffortInterrupt(runId, activeRun, "Desktop Assistant runtime disposed.");
      }
      activeRun.controller.abort();
    }
    this.activeRuns.clear();
    if (this.ownsRealtimeBroker) {
      this.realtimeBroker.dispose();
    }
    this.releaseWakeLockIfIdle();
  }

  private bestEffortInterrupt(runId: string, activeRun: ActiveAssistantRun, message: string) {
    return this.platformFetch(activeRun.baseUrl, "/api/interrupt", {
      method: "POST",
      headers: this.jsonHeaders(activeRun.token),
      body: JSON.stringify({ runId, agentKey: activeRun.agentKey, message })
    }).then(() => undefined).catch(() => undefined);
  }

  private async readPersistedFinalAssistantMessage(chatId: string, runId: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const text = readFinalAssistantTextFromChatFile(resolvePlatformChatFile(this.options.app, chatId), runId);
      if (text || attempt === 3) {
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return "";
  }

  private async uploadAttachments(
    baseUrl: string,
    token: string,
    chatId: string,
    runId: string,
    attachments: AssistantAttachment[],
    strict = false
  ) {
    const references: PlatformUploadTicket[] = [];
    for (const attachment of attachments) {
      const ticket = strict
        ? await this.uploadAttachment(baseUrl, token, chatId, runId, attachment)
        : await this.uploadAttachment(baseUrl, token, chatId, runId, attachment).catch(() => null);
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
    { ok: true; baseUrl: string; token: string } | { ok: false; message: string }
  > {
    const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID).catch(
      (error) =>
        ({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          healthMeta: { webUrl: "", port: null }
        }) as Pick<ServiceState, "status" | "message" | "healthMeta">
    );
    const baseUrl =
      serviceState.status === "running"
        ? serviceState.healthMeta.webUrl.trim() ||
          (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
        : "";
    if (!baseUrl) {
      return {
        ok: false,
        message: serviceState.message || t("agentPlatform.notRunningStartInControlCenter")
      };
    }
    const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      return {
        ok: false,
        message: tokenResult.message || t("agentPlatform.tokenUnavailable")
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
    const lastLearnedAt = items.reduce<AssistantMemoryStats["lastLearnedAt"]>((latest, item) => {
      if (latest === null || item.createdAt > latest) {
        return item.createdAt;
      }
      return latest;
    }, null);
    const lastReferencedAt = items.reduce<AssistantMemoryStats["lastReferencedAt"]>((latest, item) => {
      if (
        item.lastReferencedAt !== undefined &&
        item.lastReferencedAt !== null &&
        (latest === null || item.lastReferencedAt > latest)
      ) {
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
      recordsPath: "agent-platform:/api/memory/record/list",
      staticPath: "agent-platform:/api/memory/scope",
      auditPath: "agent-platform:/api/memory/history",
      directoryPath: ""
    };
  }
}
