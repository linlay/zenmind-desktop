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

export function AgentPlatformAssistantBridge_acquireWakeLockForActiveRuns_1(self: any) {
    if (self.activeRuns.size === 1) {
        self.options.wakeLock?.acquire();
    }
}

export function AgentPlatformAssistantBridge_releaseWakeLockIfIdle_2(self: any) {
    if (self.activeRuns.size === 0) {
        self.options.wakeLock?.release();
    }
}

export async function AgentPlatformAssistantBridge_startRun_3(self: any, request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
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
    if (self.disposed) {
        return {
            ok: false,
            runId,
            chatId,
            message: "Assistant bridge is disposed"
        };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return {
            ok: false,
            runId,
            chatId,
            message: availability.message
        };
    }
    const existing = self.activeRuns.get(runId);
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
    self.activeRuns.set(runId, activeRun);
    self.acquireWakeLockForActiveRuns();
    void self.runQuery(availability.baseUrl, availability.token, request, {
        chatId,
        runId,
        activeRun,
        onAcceptance: resolveAcceptance,
    });
    return acceptance;
}

export async function AgentPlatformAssistantBridge_completeText_4(self: any, request: AssistantStartRunRequest, onRawEvent?: (event: Record<string, unknown>) => boolean | void, strictAttachments = false): Promise<AssistantTextCompletionResult> {
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
    if (self.disposed) {
        return {
            ok: false,
            runId,
            chatId,
            text: "",
            message: "Assistant bridge is disposed"
        };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return {
            ok: false,
            runId,
            chatId,
            text: "",
            message: availability.message
        };
    }
    if (self.activeRuns.has(runId)) {
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
    self.activeRuns.set(runId, activeRun);
    self.acquireWakeLockForActiveRuns();
    return self.runQuery(availability.baseUrl, availability.token, request, {
        chatId,
        runId,
        activeRun,
        onRawEvent,
        strictAttachments,
    });
}

export async function AgentPlatformAssistantBridge_completeImage_5(self: any, request: AgentPlatformImageCompletionRequest): Promise<AgentPlatformImageCompletionResult> {
    const outcome: ImageGenerateOutcome = {
        callCount: 0,
        resultSeen: false,
        ok: false,
        message: "",
        artifacts: []
    };
    const completion = await self.completeText({
        ...request,
        message: buildZenmiImageGenerateMessage(request)
    }, (event: Record<string, unknown>) => observeImageGenerateEvent(event, outcome), true);
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
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, runId: completion.runId, chatId: completion.chatId, message: availability.message, images: [] };
    }
    const images: Extract<AgentPlatformImageCompletionResult, {
        ok: true;
    }>["images"] = [];
    for (const artifact of outcome.artifacts.slice(0, request.count)) {
        const relativePath = readString(artifact.relativePath).trim();
        if (!validGeneratedImageRelativePath(relativePath))
            continue;
        const resourceURL = new URL("/api/resource", availability.baseUrl);
        resourceURL.searchParams.set("file", `${completion.chatId}/${relativePath}`);
        const response = await self.platformFetch(availability.baseUrl, resourceURL.toString(), {
            method: "GET",
            headers: { Authorization: `Bearer ${availability.token}` }
        });
        if (!response.ok)
            continue;
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
            continue;
        let bytes: Buffer;
        try {
            bytes = await readResponseBytesWithLimit(response, MAX_GENERATED_IMAGE_BYTES);
        }
        catch {
            continue;
        }
        if (bytes.length === 0)
            continue;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const expectedSha256 = readString(artifact.sha256).trim().toLowerCase();
        if (expectedSha256 && expectedSha256 !== sha256)
            continue;
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

export async function AgentPlatformAssistantBridge_stopRun_6(self: any, runId: string): Promise<AssistantStopRunResult> {
    const trimmedRunId = runId.trim();
    const activeRun = self.activeRuns.get(trimmedRunId);
    activeRun?.controller.abort();
    if (self.activeRuns.delete(trimmedRunId)) {
        self.releaseWakeLockIfIdle();
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const response = await self.platformFetch(availability.baseUrl, "/api/interrupt", {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
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

export async function AgentPlatformAssistantBridge_submitAwaiting_7(self: any, request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> {
    const runId = request.runId?.trim() || "";
    if (!runId) {
        return { ok: false, message: t("agentPlatform.runIdRequired") };
    }
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return { ok: false, message: availability.message };
    }
    const params = request.action === "submit" ? (request.params ?? []) : [{ action: request.action, reason: request.reason || "" }];
    const response = await self.platformFetch(availability.baseUrl, "/api/submit", {
        method: "POST",
        headers: self.jsonHeaders(availability.token),
        body: JSON.stringify({
            runId,
            ...(self.activeRuns.get(runId)?.agentKey ? { agentKey: self.activeRuns.get(runId)?.agentKey } : {}),
            awaitingId: request.awaitingId,
            params
        })
    });
    if (!response.ok) {
        return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("agentPlatform.submitted") };
}

export async function AgentPlatformAssistantBridge_listAgents_8(self: any): Promise<DesktopPetAgentOption[]> {
    const data = await callGetJson<PlatformAgentSummary[]>(self, "/api/agents", {
        fallbackWhenUnavailable: []
    });
    return self.options.ports.toDesktopPetAgentOptions(Array.isArray(data) ? data : []);
}

export async function AgentPlatformAssistantBridge_listMcpRuntimeStatuses_9(self: any) {
    const data = await callGetJson<PlatformAdminRegistryListResponse>(self, "/api/admin/registries");
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

export async function AgentPlatformAssistantBridge_listNavigationAgents_10(self: any): Promise<AssistantNavAgentItemsResult> {
    const availability = await self.resolvePlatform();
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
        items: await self.options.ports.readNavigationAgents(availability.baseUrl, availability.token),
        chatItems: [],
        chatItemsHasMore: false,
        message: t("assistant.navigationStatusRead"),
        updatedAt: nowEpochMillis()
    };
}

export async function AgentPlatformAssistantBridge_listCopilotAgents_11(self: any): Promise<AssistantNavAgentItemsResult> {
    const availability = await self.resolvePlatform();
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
        items: await self.options.ports.readCopilotAgents(availability.baseUrl, availability.token),
        chatItems: [],
        chatItemsHasMore: false,
        message: t("assistant.copilotAgentsRead"),
        updatedAt: nowEpochMillis()
    };
}

export async function AgentPlatformAssistantBridge_listChats_12(self: any): Promise<AssistantChatSummary[]> {
    const data = await callGetJson<PlatformChatSummary[]>(self, "/api/chats");
    return Array.isArray(data)
        ? data
            .map((summary, index) => mapChatSummary(summary, `chats[${index}]`))
            .filter((summary): summary is AssistantChatSummary => summary !== null)
        : [];
}

export async function AgentPlatformAssistantBridge_listHistoryChats_13(self: any): Promise<AssistantHistoryChatsResult> {
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        return {
            ok: false,
            items: [],
            message: availability.message,
            updatedAt: nowEpochMillis(),
        };
    }
    const response = await self.platformFetch(availability.baseUrl, "/api/chats", {
        headers: self.jsonHeaders(availability.token),
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
