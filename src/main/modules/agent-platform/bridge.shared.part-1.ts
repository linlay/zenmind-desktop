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


import { t } from "../../support/i18n/main-i18n";

import { parseSafeLoopbackWebUrl } from "../../infrastructure/network/loopback-url";

import {
  RealtimeBroker,
  type RealtimeQueryHandle,
} from "./realtime/realtime-broker";

import type { AgentPlatformRealtimeSocketFactory } from "./realtime/agent-platform-realtime-client";


export const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";


export const MAX_CONVERSATION_MARKDOWN_BYTES = 2 << 20;

export const MAX_RAW_CHAT_JSONL_BYTES = 100 * 1024 * 1024;

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

export const STRUCTURED_PLATFORM_TIME_FIELDS = [
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

export type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export type AgentPlatformChatExportResult =
  | { ok: true; message: string; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename: string; bytes?: never };

export type AgentPlatformRawChatJSONLResult =
  | { ok: true; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename?: never; bytes?: never };

export type AssistantRunWakeLock = {
  acquire: () => void;
  release: () => void;
};

export type ActiveAssistantRun = {
  controller: AbortController;
  chatId: string;
  agentKey: string;
  baseUrl: string;
  token: string;
  acceptance?: Promise<AssistantStartRunResult>;
};

export type PlatformUploadTicket = {
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

export type PlatformChatSummary = {
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

export type PlatformRunSummary = {
  runId?: unknown;
  initialMessage?: unknown;
  assistantText?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

export type PlatformChatDetail = {
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

export type PlatformChatSearchResponse = {
  query?: string;
  count?: number;
  results?: unknown;
};

export type PlatformArchiveChatResponse = {
  results?: Array<{
    chatId?: string;
    success?: boolean;
    error?: string;
  }>;
};

export type PlatformAgentSummary = {
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

export type PlatformAdminRegistryListResponse = {
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

export function createChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistant.now");
}

export function createRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function createMessageId(role: string, runId: string) {
  return `msg_${role}_${runId}_${randomUUID().slice(0, 8)}`;
}

export function createApiUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export const IMAGE_OPERATION_INSTRUCTIONS: Record<AgentPlatformImageOperation, string> = {
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

export type ImageGenerateOutcome = {
  callCount: number;
  resultSeen: boolean;
  ok: boolean;
  message: string;
  artifacts: Array<Record<string, unknown>>;
};

export function imageResultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function imageGenerateFailureMessage(value: unknown): string {
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

export function observeImageGenerateEvent(event: Record<string, unknown>, outcome: ImageGenerateOutcome) {
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

export function validGeneratedImageRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("://")) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

export function readNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function readAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = readString(value).trim().toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

export function readAwaitingPayloadMode(value: unknown): AssistantAwaitingMode | undefined {
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

export function isPendingAwaitingPayload(value: unknown): boolean {
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

export function readRequiredPlatformTimestamp(value: unknown, field: string) {
  return requireAgentPlatformEpochMillis(value, field);
}

export function readOptionalPlatformTimestamp(value: unknown, field: string) {
  return parseOptionalNullableAgentPlatformEpochMillis(value, field);
}

export function validatePresentPlatformTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PLATFORM_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      readOptionalPlatformTimestamp(record[field], `${path}.${field}`);
    }
  }
}

export function validateAwaitingPayloadTimes(value: unknown, path: string) {
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

export function normalizeAwaitingPayload(value: unknown, path: string): AssistantEvent["awaiting"] {
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

export function readErrorCode(value: unknown) {
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

export async function readErrorText(response: Response) {
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

export class ResponseBytesTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number
  ) {
    super(`response is ${actualBytes} bytes; limit is ${limitBytes} bytes`);
  }
}

export async function readResponseBytesWithLimit(response: Response, maxBytes: number) {
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

export function filenameFromContentDisposition(value: string | null) {
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

export function unwrapApiResponse<T>(payload: unknown): T {
  if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload) {
    const response = payload as ApiResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data;
  }
  return payload as T;
}

export function dataUrlToBlob(dataUrl: string, fallbackMimeType: string) {
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

export function isPlatformEventType(type: string): type is AssistantRunEventType {
  return Boolean(type);
}

export function readErrorPayloadText(value: unknown): string {
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

export const PLATFORM_OUTPUT_TEXT_KEYS = [
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

export function readOutputTextFromRecord(record: Record<string, unknown>, keys: readonly string[] = PLATFORM_OUTPUT_TEXT_KEYS): string {
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

export function readAssistantEventOutputText(event: AssistantEvent): string {
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

export function readAssistantTextContent(content: unknown): string {
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

export function readFinalAssistantTextFromMessages(messages: unknown): string {
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
