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

import { PlatformChatSearchResponse, PlatformChatSummary, PlatformRunSummary, createMessageId, createRunId, isPendingAwaitingPayload, isPlatformEventType, normalizeAwaitingPayload, readAwaitingMode, readAwaitingPayloadMode, readErrorPayloadText, readFinalAssistantTextFromMessages, readNumber, readOptionalPlatformTimestamp, readOutputTextFromRecord, readRequiredPlatformTimestamp, readString, validateAwaitingPayloadTimes, validatePresentPlatformTimes } from "./bridge.shared.part-1";

export function readFinalAssistantTextFromChatFile(filePath: string, runId: string): string {
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

export function normalizePlatformEvent(raw: Record<string, unknown>, fallback: {
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

export function isAssistantRunTerminalEvent(event: AssistantEvent) {
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

export function mapChatSummary(summary: PlatformChatSummary, path: string): AssistantChatSummary | null {
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

export function mapHistoryChat(
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

export function mapChatSearchResult(value: unknown, path: string): AssistantChatSearchResult | null {
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

export function mapChatSearchResponse(
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

export function readChatAgentKey(summary: PlatformChatSummary) {
  return readString(summary.agentKey) || readString(summary.workerKey);
}

export function readChatIsRead(summary: PlatformChatSummary) {
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

export function chatHasPendingAwaiting(summary: PlatformChatSummary) {
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

export function readChatAwaitingMode(summary: PlatformChatSummary) {
  return (
    readAwaitingMode(summary.awaitingMode) ||
    readAwaitingMode(summary.mode) ||
    readAwaitingPayloadMode(summary.awaiting)
  );
}

export function mapRunMessages(run: PlatformRunSummary, path: string): AssistantChatMessage[] {
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

export function normalizeAssistantPermissionMode(value: unknown): AssistantStartRunRequest["permissionMode"] {
  return value === "full_access" || value === "page_control" ? value : "default";
}

export function normalizeAssistantAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  return value === "default" || value === "auto_approve" || value === "full_access" ? value : undefined;
}
