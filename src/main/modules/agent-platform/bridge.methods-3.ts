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

export async function AgentPlatformAssistantBridge_runQuery_1(self: any, baseUrl: string, token: string, request: AssistantStartRunRequest, run: {
      chatId: string;
      runId: string;
      activeRun: ActiveAssistantRun;
      onAcceptance?: (result: AssistantStartRunResult) => void;
      onRawEvent?: (event: Record<string, unknown>) => boolean | void;
      strictAttachments?: boolean;
    }): Promise<AssistantTextCompletionResult> {
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
        const references = await self.uploadAttachments(baseUrl, token, run.chatId, run.runId, request.attachments ?? [], run.strictAttachments === true);
        const accessLevel = normalizeAssistantAccessLevel(request.accessLevel);
        const requestId = request.requestId?.trim() || run.runId;
        const query: RealtimeQueryHandle = self.realtimeBroker.query({
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
            onEvent: async (event: Record<string, unknown>, eventPath: string) => {
                const stopAfterEvent = run.onRawEvent?.(event) === true;
                const normalizedEvent = normalizePlatformEvent(event, {
                    runId: run.runId,
                    chatId: run.chatId,
                    source: request.source
                }, eventPath);
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
                    const terminalMessage = normalizedEvent.message ||
                        eventText ||
                        finalMessage.trim() ||
                        (await self.readPersistedFinalAssistantMessage(run.chatId, run.runId));
                    if (!finalMessage && terminalMessage) {
                        finalMessage = terminalMessage;
                    }
                    if (!normalizedEvent.message && terminalMessage) {
                        normalizedEvent.message = terminalMessage;
                    }
                }
                self.options.onEvent(normalizedEvent);
                if (stopAfterEvent && !run.activeRun.controller.signal.aborted) {
                    stoppedByRawEvent = true;
                    await self.bestEffortInterrupt(run.runId, run.activeRun, "Image Studio reached its single permitted tool boundary.");
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
    }
    catch (error) {
        if (stoppedByRawEvent) {
            return {
                ok: false,
                runId: run.runId,
                chatId: run.chatId,
                text: "",
                message: "Image Studio stopped the agent after its single permitted tool result."
            };
        }
        const message = (error as Error).name === "AbortError"
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
        if (error instanceof Error &&
            (error.name === "connection_lost_before_acceptance" ||
                error.message.startsWith("connection_lost_before_acceptance:")) &&
            run.activeRun.agentKey) {
            self.bestEffortInterrupt(run.runId, run.activeRun, "Desktop Assistant WebSocket disconnected.");
        }
        if ((error as Error).name === "AbortError") {
            if (!self.disposed) {
                self.options.onEvent({
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
        if (!self.disposed) {
            self.options.onEvent({
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
    }
    finally {
        if (self.activeRuns.get(run.runId) === run.activeRun) {
            self.activeRuns.delete(run.runId);
            self.releaseWakeLockIfIdle();
        }
    }
}

export function AgentPlatformAssistantBridge_dispose_2(self: any) {
    if (self.disposed) {
        return;
    }
    self.disposed = true;
    for (const [runId, activeRun] of self.activeRuns) {
        if (activeRun.agentKey) {
            self.bestEffortInterrupt(runId, activeRun, "Desktop Assistant runtime disposed.");
        }
        activeRun.controller.abort();
    }
    self.activeRuns.clear();
    if (self.ownsRealtimeBroker) {
        self.realtimeBroker.dispose();
    }
    self.releaseWakeLockIfIdle();
}

export function AgentPlatformAssistantBridge_bestEffortInterrupt_3(self: any, runId: string, activeRun: ActiveAssistantRun, message: string) {
    return self.platformFetch(activeRun.baseUrl, "/api/interrupt", {
        method: "POST",
        headers: self.jsonHeaders(activeRun.token),
        body: JSON.stringify({ runId, agentKey: activeRun.agentKey, message })
    }).then(() => undefined).catch(() => undefined);
}

export async function AgentPlatformAssistantBridge_readPersistedFinalAssistantMessage_4(self: any, chatId: string, runId: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const text = readFinalAssistantTextFromChatFile(self.options.ports.resolveAssistantChatFile(self.options.app, chatId), runId);
        if (text || attempt === 3) {
            return text;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return "";
}

export async function AgentPlatformAssistantBridge_uploadAttachments_5(self: any, baseUrl: string, token: string, chatId: string, runId: string, attachments: AssistantAttachment[], strict = false) {
    const references: PlatformUploadTicket[] = [];
    for (const attachment of attachments) {
        const ticket = strict
            ? await self.uploadAttachment(baseUrl, token, chatId, runId, attachment)
            : await self.uploadAttachment(baseUrl, token, chatId, runId, attachment).catch(() => null);
        if (ticket) {
            references.push(ticket);
        }
    }
    return references;
}

export async function AgentPlatformAssistantBridge_uploadAttachment_6(self: any, baseUrl: string, token: string, chatId: string, runId: string, attachment: AssistantAttachment) {
    const formData = new FormData();
    formData.set("requestId", runId);
    formData.set("chatId", chatId);
    formData.set("name", attachment.name);
    const fileBlob = await self.attachmentToBlob(chatId, attachment);
    formData.set("file", fileBlob, attachment.name);
    const response = await self.platformFetch(baseUrl, "/api/upload", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`
        },
        body: formData
    });
    if (!response.ok) {
        throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<{
        upload: PlatformUploadTicket;
    }>(await response.json());
    return payload.upload;
}

export async function AgentPlatformAssistantBridge_attachmentToBlob_7(self: any, chatId: string, attachment: AssistantAttachment) {
    if (attachment.dataUrl) {
        const blob = dataUrlToBlob(attachment.dataUrl, attachment.mimeType);
        if (blob) {
            return blob;
        }
    }
    try {
        const attachmentPath = self.options.ports.resolveAssistantAttachmentPath(self.options.app, chatId, attachment.id);
        const buffer = await fs.promises.readFile(attachmentPath);
        return new Blob([buffer], { type: attachment.mimeType || "application/octet-stream" });
    }
    catch {
        const fallback = attachment.text || attachment.name || attachment.id;
        return new Blob([Buffer.from(fallback, "utf8")], { type: attachment.mimeType || "text/plain" });
    }
}

export async function AgentPlatformAssistantBridge_getJson_8<T>(self: any, pathOrUrl: string, options: { allowNotFound?: boolean; fallbackWhenUnavailable?: T } = {}): Promise<T> {
    const availability = await self.resolvePlatform();
    if (!availability.ok) {
        if ("fallbackWhenUnavailable" in options) {
            return options.fallbackWhenUnavailable as T;
        }
        throw new Error(availability.message);
    }
    const response = await self.platformFetch(availability.baseUrl, pathOrUrl, {
        headers: self.jsonHeaders(availability.token)
    });
    if (response.status === 404 && options.allowNotFound) {
        return null as T;
    }
    if (!response.ok) {
        throw new Error(await readErrorText(response));
    }
    return unwrapApiResponse<T>(await response.json());
}

export async function AgentPlatformAssistantBridge_resolvePlatform_9(self: any): Promise<
    { ok: true; baseUrl: string; token: string } | { ok: false; message: string }
  > {
    const serviceState = await self.options.getServiceState(self.options.app, AGENT_PLATFORM_SERVICE_ID).catch((error: unknown) => ({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        healthMeta: { webUrl: "", port: null }
    }) as Pick<ServiceState, "status" | "message" | "healthMeta">);
    const baseUrl = serviceState.status === "running"
        ? serviceState.healthMeta.webUrl.trim() ||
            (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
        : "";
    if (!baseUrl) {
        return {
            ok: false,
            message: serviceState.message || t("agentPlatform.notRunningStartInControlCenter")
        };
    }
    const tokenResult = await self.options.issueAccessToken(self.options.app, "missing");
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

export function AgentPlatformAssistantBridge_platformFetch_10(self: any, baseUrl: string, pathname: string, init: RequestInit) {
    return fetch(createApiUrl(baseUrl, pathname), init);
}

export function AgentPlatformAssistantBridge_jsonHeaders_11(self: any, token: string, extra: Record<string, string> = {}) {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extra
    };
}
