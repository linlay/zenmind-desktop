import type { EnterpriseChatRuntimeMethodContext } from "./runtime.shared";
import { openAsBlob } from "node:fs";

import fs from "node:fs";

import path from "node:path";

import type { App } from "electron";

import type {
  EnterpriseChatAttachment,
  EnterpriseChatAttachmentData,
  EnterpriseChatAttachmentInput,
  EnterpriseChatConnectionState,
  EnterpriseChatConversation,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatDesktopAction,
  EnterpriseChatDesktopActionResult,
  EnterpriseChatDesktopActionStatus,
  EnterpriseChatDownloadResult,
  EnterpriseChatExecuteActionInput,
  EnterpriseChatExecuteActionResult,
  EnterpriseChatMarkReadInput,
  EnterpriseChatMessage,
  EnterpriseChatOpenConversationInput,
  EnterpriseChatOpenDirectInput,
  EnterpriseChatSaveSelfProfileInput,
  EnterpriseChatSendFilesInput,
  EnterpriseChatSendMessageInput,
  EnterpriseChatSendPastedFilesInput,
  EnterpriseChatSendRawAgentChatInput,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../../shared/contracts";

import {
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES,
  ENTERPRISE_CHAT_MAX_PASTED_FILES
} from "../../../shared/contracts/enterprise-chat";

import {
  ENTERPRISE_CHAT_REMOTE_ACTION_NAMES,
  getEnterpriseChatRemoteAction
} from "../../../shared/enterprise-chat-actions";

import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";

import type { EpochMilliseconds } from "../../../shared/time-contract";

import { getDesktopDeviceInfo } from "../identity";

import {
  EnterpriseChatActionLedger,
  enterpriseChatActionScope,
  type EnterpriseChatActionLedgerEntry
} from "./action-ledger";

import {
  clearEnterpriseChatAvatar,
  readEnterpriseChatSelfProfile,
  saveEnterpriseChatAvatar,
  saveEnterpriseChatMotto
} from "./local-profile";

import { createEnterpriseChatSupportBundle } from "./support-bundle";

import {
  DEFAULT_ENTERPRISE_IM_BASE_URL,
  normalizeEnterpriseImBaseUrl
} from "./settings";

import { t } from "../../support/i18n/main-i18n";

import { getDesktopSsoAccessToken } from "../identity";

import { ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES, ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES, ENTERPRISE_CHAT_MAX_SELECTED_FILES, ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES, ENTERPRISE_CHAT_RECONNECT_MAX_MS, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS, EnterpriseChatRawAgentChatData, EnterpriseChatRequestError, EnterpriseChatRuntimeOptions, FetchLike, FetchResponseLike, PendingWebSocketRequest, ServerBootstrap, ServerSession, WebSocketLike, WebSocketMessageEventLike, contentTypeForFile, createDefaultWebSocket, errorMessage, isRecord, localizedDesktopActionSummary, mergeConversationUsers, mergeMessage, normalizeAttachment, normalizeConversation, normalizeConversations, normalizeDesktopAction, normalizeDesktopActionResult, normalizeMessage, normalizeMessages, normalizeServerUrl, normalizeUser, nowEpochMilliseconds, readEpochMilliseconds, readNumber, readOnline, readText, readWebSocketText, safeDownloadName, safeRawAgentChatFilename, toWebSocketUrl } from "./runtime.shared";

export async function EnterpriseChatRuntime_deliverDesktopActionReceipt_1(self: EnterpriseChatRuntimeMethodContext, entry: EnterpriseChatActionLedgerEntry) {
    if (entry.phase !== "terminal" ||
        !entry.status ||
        entry.deliveryState === "delivered" ||
        !self.socket ||
        !self.socketSynced ||
        self.socket.readyState !== 1) {
        return entry.deliveryState === "delivered";
    }
    try {
        await self.sendMessagePayload({
            conversationId: entry.conversationId,
            clientMessageId: `desktop-action-result:${entry.requestId}`,
            body: entry.resultMessage.slice(0, 1000),
            fileIds: entry.fileIds,
            replyToId: entry.messageId,
            kind: "desktop_action_result",
            desktopAction: {
                requestId: entry.requestId,
                targetDeviceId: entry.targetDeviceId,
                action: entry.action,
                status: entry.status,
                message: entry.resultMessage.slice(0, 1000),
                completedAt: entry.completedAt
            }
        });
        self.getDesktopActionLedger()?.markDelivered(entry.scope, entry.requestId);
        return true;
    }
    catch {
        return false;
    }
}

export function EnterpriseChatRuntime_flushDesktopActionReceipts_2(self: EnterpriseChatRuntimeMethodContext) {
    if (self.actionReceiptFlushPromise) {
        return self.actionReceiptFlushPromise;
    }
    const scope = self.currentDesktopActionScope();
    const ledger = self.getDesktopActionLedger();
    if (!scope || !ledger) {
        return Promise.resolve();
    }
    self.actionReceiptFlushPromise = (async () => {
        for (const entry of ledger.pendingReceipts(scope)) {
            if (!await self.deliverDesktopActionReceipt(entry)) {
                break;
            }
        }
    })().finally(() => {
        self.actionReceiptFlushPromise = null;
        self.updateSnapshot({});
    });
    return self.actionReceiptFlushPromise;
}

export function EnterpriseChatRuntime_reconcileDesktopActionMessages_3(self: EnterpriseChatRuntimeMethodContext, messages: EnterpriseChatMessage[], conversation?: EnterpriseChatConversation) {
    const scope = self.currentDesktopActionScope();
    const ledger = self.getDesktopActionLedger();
    const currentUserId = self.snapshot.currentUser?.id ?? "";
    const currentDeviceId = self.getDeviceInfo().deviceId;
    if (!scope || !ledger || !currentUserId || !currentDeviceId) {
        return;
    }
    const requestsById = new Map(messages
        .filter((message) => Boolean(message.desktopAction))
        .map((message) => [message.id, message] as const));
    for (const resultMessage of messages) {
        const result = resultMessage.desktopActionResult;
        const requestMessage = requestsById.get(resultMessage.replyToId);
        const request = requestMessage?.desktopAction;
        if (!result ||
            !requestMessage ||
            !request ||
            resultMessage.senderId !== currentUserId ||
            result.targetDeviceId !== currentDeviceId ||
            request.requestId !== result.requestId ||
            request.targetDeviceId !== result.targetDeviceId ||
            request.action !== result.action ||
            requestMessage.conversationId !== resultMessage.conversationId) {
            continue;
        }
        ledger.recordDelivered({
            scope,
            messageId: requestMessage.id,
            requestId: request.requestId,
            conversationId: requestMessage.conversationId,
            targetDeviceId: request.targetDeviceId,
            action: request.action,
            status: result.status,
            resultMessage: result.message,
            fileIds: resultMessage.attachments.map((attachment) => attachment.id),
            completedAt: result.completedAt
        });
    }
    if (!conversation || conversation.type !== "direct") {
        return;
    }
    for (const requestMessage of requestsById.values()) {
        const request = requestMessage.desktopAction;
        if (!request ||
            request.expiresAt > Date.now() ||
            requestMessage.senderId === currentUserId ||
            requestMessage.revokedAt ||
            request.targetDeviceId !== currentDeviceId ||
            !getEnterpriseChatRemoteAction(request.action) ||
            ledger.hasLegacyMessage(requestMessage.id) ||
            ledger.find(scope, request.requestId)) {
            continue;
        }
        try {
            ledger.claim({
                scope,
                messageId: requestMessage.id,
                requestId: request.requestId,
                conversationId: requestMessage.conversationId,
                targetDeviceId: request.targetDeviceId,
                action: request.action
            });
            ledger.complete(scope, request.requestId, {
                status: "expired",
                resultMessage: "Desktop action request expired."
            });
        }
        catch {
            // Expired requests remain non-executable even if their acknowledgement cannot be persisted.
        }
    }
}

export async function EnterpriseChatRuntime_sendMessagePayload_4(self: EnterpriseChatRuntimeMethodContext, input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }) {
    self.assertMessageSendReady();
    const result = await self.sendWebSocketRequest("message.send", {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        body: input.body,
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.desktopAction ? { desktopAction: input.desktopAction } : {}),
        mentionUserIds: [],
        fileIds: input.fileIds
    });
    const record = isRecord(result) ? result : {};
    const message = normalizeMessage(record.message);
    if (message.id) {
        self.applyMessage(message);
    }
    return self.getState();
}

export function EnterpriseChatRuntime_assertMessageSendReady_5(self: EnterpriseChatRuntimeMethodContext) {
    if (!self.socket || !self.socketSynced || self.socket.readyState !== 1) {
        throw new Error("Enterprise chat is reconnecting. Try again in a moment.");
    }
}

export async function EnterpriseChatRuntime_markRead_6(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatMarkReadInput) {
    const conversationId = readText(input?.conversationId);
    const seq = Math.max(0, Math.trunc(readNumber(input?.seq)));
    if (!conversationId || seq <= 0) {
        return self.getState();
    }
    if (self.socket && self.socketSynced && self.socket.readyState === 1) {
        await self.sendWebSocketRequest("receipt.read", { conversationId, seq });
    }
    self.updateSnapshot({
        conversations: self.snapshot.conversations.map((conversation) => conversation.id === conversationId
            ? {
                ...conversation,
                lastReadSeq: Math.max(conversation.lastReadSeq, seq),
                unreadCount: 0
            }
            : conversation)
    });
    return self.getState();
}

export function EnterpriseChatRuntime_handleSignedOut_7(self: EnterpriseChatRuntimeMethodContext) {
    self.disconnect();
    self.clearSession();
    self.updateSnapshot({
        connectionState: self.snapshot.enabled ? "signed_out" : "disabled",
        message: "",
        currentUser: null,
        selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
        users: [],
        conversations: [],
        activeConversationId: "",
        activeMessages: [],
        latestEventId: 0
    });
}

export function EnterpriseChatRuntime_stop_8(self: EnterpriseChatRuntimeMethodContext) {
    self.disconnect();
    self.clearSession();
}

export async function EnterpriseChatRuntime_ensureSession_9(self: EnterpriseChatRuntimeMethodContext) {
    if (self.imSessionToken &&
        self.imSessionTokenExpiresAt > Date.now() + 30000) {
        return;
    }
    const state = await self.refresh();
    if (!self.imSessionToken || state.connectionState === "error") {
        throw new Error(state.message || "Enterprise chat session is unavailable.");
    }
}

export async function EnterpriseChatRuntime_uploadFilePath_10(self: EnterpriseChatRuntimeMethodContext, filePath: string) {
    const blob = await openAsBlob(filePath, { type: contentTypeForFile(filePath) });
    return self.uploadBlob(blob, path.basename(filePath));
}

export async function EnterpriseChatRuntime_uploadBlob_11(self: EnterpriseChatRuntimeMethodContext, blob: Blob, filename: string) {
    const form = new FormData();
    form.append("file", blob, safeDownloadName(filename, self.platform));
    const response = await self.requestJson<unknown>("/api/v1/files", {
        method: "POST",
        body: form
    });
    const attachment = normalizeAttachment(response);
    if (!attachment) {
        throw new Error("The IM server returned invalid attachment metadata.");
    }
    return attachment;
}

export async function EnterpriseChatRuntime_fetchAttachment_12(self: EnterpriseChatRuntimeMethodContext, fileId: string, maxBytes: number) {
    await self.ensureSession();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    try {
        const response = await self.fetchImpl(`${self.serverUrl}/api/v1/files/${encodeURIComponent(fileId)}`, {
            headers: {
                Authorization: `Bearer ${self.imSessionToken}`
            },
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`Attachment download failed (${response.status}).`);
        }
        if (typeof response.arrayBuffer !== "function") {
            throw new Error("Attachment response cannot be read.");
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
            throw new Error("Attachment exceeds the local preview or download limit.");
        }
        return {
            buffer,
            contentType: "application/octet-stream"
        };
    }
    finally {
        clearTimeout(timeout);
    }
}

export async function EnterpriseChatRuntime_exchangeSession_13(self: EnterpriseChatRuntimeMethodContext, identityToken: string): Promise<ServerSession> {
    const device = self.getDeviceInfo();
    const response = await self.requestJson<unknown>("/api/v1/session/exchange", {
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
        throw new Error("The IM server returned an invalid session.");
    }
    return { token, expiresAt, user };
}

export async function EnterpriseChatRuntime_requestBootstrap_14(self: EnterpriseChatRuntimeMethodContext): Promise<ServerBootstrap> {
    const response = await self.requestJson<unknown>("/api/v1/sync/bootstrap");
    const record = isRecord(response) ? response : {};
    const user = normalizeUser(record.user);
    if (!user.id) {
        throw new Error("The IM server returned an invalid employee identity.");
    }
    return {
        user,
        conversations: normalizeConversations(record.conversations),
        latestEventId: Math.max(0, Math.trunc(readNumber(record.latestEventId)))
    };
}

export async function EnterpriseChatRuntime_requestUsers_15(self: EnterpriseChatRuntimeMethodContext) {
    const users: EnterpriseChatUser[] = [];
    const pageSize = 100;
    for (let offset = 0; offset < 10000; offset += pageSize) {
        const response = await self.requestJson<unknown>(`/api/v1/users?limit=${pageSize}&offset=${offset}`);
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

export async function EnterpriseChatRuntime_requestJson_16<T>(self: EnterpriseChatRuntimeMethodContext, path: string, init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {}, useImSessionToken = true): Promise<T> {
    if (!self.fetchImpl) {
        throw new Error("This Desktop runtime does not provide fetch support.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers
    };
    if (useImSessionToken) {
        if (!self.imSessionToken) {
            clearTimeout(timeout);
            throw new Error("Enterprise chat session is unavailable.");
        }
        headers.Authorization = `Bearer ${self.imSessionToken}`;
    }
    try {
        const response = await self.fetchImpl(`${self.serverUrl}${path}`, {
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
            }
            catch {
                detail = readText(await response.text().catch(() => ""));
            }
            throw new EnterpriseChatRequestError(response.status, detail || `Enterprise chat request failed (${response.status}).`);
        }
        return await response.json() as T;
    }
    finally {
        clearTimeout(timeout);
    }
}
