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

import { AGENT_PLATFORM_SERVICE_ID, ActiveAssistantRun, AgentPlatformChatExportResult, AgentPlatformImageCompletionRequest, AgentPlatformImageCompletionResult, AgentPlatformImageOperation, AgentPlatformRawChatJSONLResult, ApiResponse, AssistantRunWakeLock, IMAGE_OPERATION_INSTRUCTIONS, ImageGenerateOutcome, MAX_CONVERSATION_MARKDOWN_BYTES, MAX_GENERATED_IMAGE_BYTES, MAX_RAW_CHAT_JSONL_BYTES, PLATFORM_OUTPUT_TEXT_KEYS, PlatformAdminRegistryListResponse, PlatformAgentSummary, PlatformArchiveChatResponse, PlatformChatDetail, PlatformChatSearchResponse, PlatformChatSummary, PlatformRunSummary, PlatformUploadTicket, ResponseBytesTooLargeError, STRUCTURED_PLATFORM_TIME_FIELDS, buildZenmiImageGenerateMessage, chatHasPendingAwaiting, createApiUrl, createChatId, createMessageId, createRunId, dataUrlToBlob, filenameFromContentDisposition, imageGenerateFailureMessage, imageResultRecord, isAssistantRunTerminalEvent, isPendingAwaitingPayload, isPlatformEventType, mapChatSearchResponse, mapChatSearchResult, mapChatSummary, mapHistoryChat, mapRunMessages, normalizeAssistantAccessLevel, normalizeAssistantPermissionMode, normalizeAwaitingPayload, normalizePlatformEvent, nowEpochMillis, observeImageGenerateEvent, readAssistantEventOutputText, readAssistantTextContent, readAwaitingMode, readAwaitingPayloadMode, readChatAgentKey, readChatAwaitingMode, readChatIsRead, readErrorCode, readErrorPayloadText, readErrorText, readFinalAssistantTextFromChatFile, readFinalAssistantTextFromMessages, readNumber, readOptionalPlatformTimestamp, readOutputTextFromRecord, readRequiredPlatformTimestamp, readResponseBytesWithLimit, readString, unwrapApiResponse, validGeneratedImageRelativePath, validateAwaitingPayloadTimes, validatePresentPlatformTimes } from "./bridge.shared";

const callGetJson = <T>(self: any, ...args: any[]): Promise<T> => self.getJson(...args) as Promise<T>;

export async function AgentPlatformAssistantBridge_getChat_1(self: any, chatId: string): Promise<AssistantChatDetail | null> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return null;
    }
    const data = await callGetJson<PlatformChatDetail>(self, `/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=true`, {
        allowNotFound: true
    });
    if (!data) {
        return null;
    }
    validatePresentPlatformTimes(data as Record<string, unknown>, "chat");
    const events = Array.isArray(data.events)
        ? data.events
            .map((event, index) => normalizePlatformEvent(event, { runId: readString(event.runId), chatId: trimmedChatId }, `chat.events[${index}]`))
            .filter((event): event is AssistantRunEvent => Boolean(event &&
            event.type !== "delta" &&
            event.type !== "done" &&
            event.type !== "error" &&
            event.type !== "stopped"))
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

export async function AgentPlatformAssistantBridge_getChatInfo_2(self: any, chatId: string): Promise<AssistantChatInfo | null> {
    const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
    if (!trimmedChatId) {
        return null;
    }
    const data = await callGetJson<PlatformChatDetail>(self, `/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=false`, { allowNotFound: true });
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

export async function AgentPlatformAssistantBridge_searchChats_3(self: any, request: AssistantChatSearchRequest): Promise<AssistantChatSearchResponse> {
    const query = request?.query?.trim() ?? "";
    if (!query) {
        return { query: "", count: 0, results: [] };
    }
    const limit = Number.isFinite(Number(request.limit)) && Number(request.limit) > 0
        ? Math.floor(Number(request.limit))
        : undefined;
    const agentKey = request.agentKey?.trim() ?? "";
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        throw new Error(availability.message);
    }
    const body = {
        query,
        ...(limit ? { limit } : {}),
        ...(agentKey ? { agentKey } : {})
    };
    const response = await self.platformFetch(availability.baseUrl, "/api/chats/search", {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<PlatformChatSearchResponse>(await response.json());
    return mapChatSearchResponse(payload, query);
}

export async function AgentPlatformAssistantBridge_deleteChat_4(self: any, chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, `/api/chat/delete?chatId=${encodeURIComponent(trimmedChatId)}`, {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify({})
    });
    if (!response.ok) {
        return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.chatDeleted") };
}

export async function AgentPlatformAssistantBridge_markAgentChatsRead_5(self: any, agentKey: string) {
    const trimmedAgentKey = agentKey.trim();
    if (!trimmedAgentKey) {
        return { ok: false, message: t("assistant.agentKeyRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, "/api/read", {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify({ agentKey: trimmedAgentKey })
    });
    if (!response.ok) {
        return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.agentChatsMarkedRead") };
}

export async function AgentPlatformAssistantBridge_renameChat_6(self: any, chatId: string, chatName: string) {
    const trimmedChatId = chatId.trim();
    const trimmedChatName = chatName.trim();
    if (!trimmedChatId || !trimmedChatName) {
        return { ok: false, message: t("assistant.chatIdOrNameRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, `/api/chat/rename?chatId=${encodeURIComponent(trimmedChatId)}`, {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify({ chatName: trimmedChatName })
    });
    if (!response.ok) {
        return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.chatRenamed") };
}

export async function AgentPlatformAssistantBridge_archiveChat_7(self: any, chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, "/api/chat/archive", {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify({ chatIds: [trimmedChatId] })
    });
    if (!response.ok) {
        return { ok: false, message: await readErrorText(response) };
    }
    let payload: PlatformArchiveChatResponse;
    try {
        payload = unwrapApiResponse<PlatformArchiveChatResponse>(await response.json());
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : t("assistant.chatArchiveFailed")
        };
    }
    const archiveResult = payload.results?.find((result) => result.chatId?.trim() === trimmedChatId) ?? payload.results?.[0];
    if (archiveResult?.success !== true) {
        return {
            ok: false,
            message: archiveResult?.error?.trim() || t("assistant.chatArchiveFailed")
        };
    }
    return { ok: true, message: t("assistant.chatArchived") };
}

export async function AgentPlatformAssistantBridge_downloadChatExport_8(self: any, chatId: string): Promise<AgentPlatformChatExportResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return {
            ok: false,
            message: t("assistant.chatIdRequired"),
            filename: ""
        };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message, filename: "" };
    }
    const response = await self.platformFetch(availability.baseUrl, `/api/chat/export?chatId=${encodeURIComponent(trimmedChatId)}&format=markdown`, {
        method: "GET",
        headers: {
            Accept: "text/markdown, application/json",
            Authorization: `Bearer ${availability.token}`
        }
    });
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
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof ResponseBytesTooLargeError
                ? t("assistant.chatExportTooLarge")
                : t("assistant.chatExportReadFailed"),
            filename: ""
        };
    }
}

export async function AgentPlatformAssistantBridge_createChatSnapshotRequest_9(self: any, chatId: string): Promise<
    | { ok: true; snapshotUrl: string; bearerToken: string }
    | { ok: false; message: string }
  > {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await self.resolvePlatform();
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

export async function AgentPlatformAssistantBridge_downloadRawChatJSONL_10(self: any, chatId: string): Promise<AgentPlatformRawChatJSONLResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
        return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, `/api/chat/jsonl?chatId=${encodeURIComponent(trimmedChatId)}`, {
        method: "GET",
        headers: {
            Accept: "text/plain, application/x-ndjson",
            Authorization: `Bearer ${availability.token}`
        }
    });
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
            filename: filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.jsonl`,
            bytes: await readResponseBytesWithLimit(response, MAX_RAW_CHAT_JSONL_BYTES)
        };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof ResponseBytesTooLargeError
                ? t("assistant.rawChatJsonlTooLarge")
                : t("assistant.rawChatJsonlReadFailed")
        };
    }
}
