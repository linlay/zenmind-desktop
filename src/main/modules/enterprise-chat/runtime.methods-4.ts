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

export async function EnterpriseChatRuntime_connectWebSocket_1(self: EnterpriseChatRuntimeMethodContext) {
    if (!self.snapshot.enabled || !self.imSessionToken) {
        return;
    }
    const ticketResponse = await self.requestJson<unknown>("/api/v1/ws-tickets", {
        method: "POST",
        body: "{}"
    });
    const ticketRecord = isRecord(ticketResponse) ? ticketResponse : {};
    const ticket = readText(ticketRecord.ticket);
    if (!ticket) {
        throw new Error("The IM server did not issue a WebSocket ticket.");
    }
    const socket = self.createWebSocket(toWebSocketUrl(self.serverUrl, ticket));
    self.socket = socket;
    self.socketSynced = false;
    self.socketClosing = false;
    socket.onopen = () => {
        if (self.socket !== socket) {
            return;
        }
        void self.sendWebSocketRequest("sync.resume", {
            afterEventId: self.snapshot.latestEventId
        }).catch((error) => {
            if (self.socket !== socket || self.socketClosing) {
                return;
            }
            self.updateSnapshot({
                connectionState: "reconnecting",
                message: errorMessage(error)
            });
            socket.close();
        });
    };
    socket.onmessage = (event) => {
        if (self.socket === socket) {
            void self.handleWebSocketMessage(event.data);
        }
    };
    socket.onerror = () => {
        if (self.socket === socket && !self.socketClosing) {
            self.updateSnapshot({
                connectionState: "reconnecting",
                message: "Enterprise chat WebSocket connection failed."
            });
        }
    };
    socket.onclose = () => {
        if (self.socket !== socket) {
            return;
        }
        self.socket = null;
        self.socketSynced = false;
        self.rejectPendingRequests(new Error("Enterprise chat connection closed."));
        if (!self.socketClosing && self.snapshot.enabled && self.getIdentityToken()) {
            self.updateSnapshot({
                connectionState: "reconnecting",
                message: ""
            });
            self.scheduleReconnect();
        }
    };
}

export async function EnterpriseChatRuntime_handleWebSocketMessage_2(self: EnterpriseChatRuntimeMethodContext, data: unknown) {
    const text = await readWebSocketText(data);
    if (!text) {
        return;
    }
    let envelope: Record<string, unknown>;
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!isRecord(parsed)) {
            return;
        }
        envelope = parsed;
    }
    catch {
        return;
    }
    const frame = readText(envelope.frame);
    const type = readText(envelope.type);
    if (frame === "response") {
        const id = readText(envelope.id);
        const pending = self.pendingRequests.get(id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timeout);
        self.pendingRequests.delete(id);
        if (envelope.ok === true) {
            pending.resolve(envelope.result);
        }
        else {
            const error = isRecord(envelope.error) ? envelope.error : {};
            pending.reject(new Error(readText(error.message) || "Enterprise chat request failed."));
        }
        return;
    }
    if (frame !== "push") {
        return;
    }
    const eventId = Math.max(0, Math.trunc(readNumber(envelope.eventId)));
    if (eventId > self.snapshot.latestEventId) {
        self.snapshot.latestEventId = eventId;
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    if (type === "sync.ready") {
        self.socketSynced = true;
        self.reconnectAttempt = 0;
        self.updateSnapshot({
            connectionState: "connected",
            message: "",
            latestEventId: Math.max(self.snapshot.latestEventId, Math.trunc(readNumber(payload.eventId)))
        });
        void self.sendWebSocketRequest("device.capabilities.publish", {
            clientKind: "desktop",
            platform: self.platform,
            clientVersion: self.app.getVersion(),
            actions: ENTERPRISE_CHAT_REMOTE_ACTION_NAMES
        }).catch((error) => {
            self.updateSnapshot({ message: errorMessage(error) });
        });
        void self.refreshEmployeeDirectory();
        void self.flushDesktopActionReceipts();
        return;
    }
    if (type === "sync.reset_required") {
        void self.refresh();
        return;
    }
    if (type === "presence.changed") {
        const userRecord = isRecord(payload.user) ? payload.user : {};
        const userId = readText(payload.userId) || readText(userRecord.id);
        const online = typeof payload.online === "boolean"
            ? payload.online
            : typeof userRecord.online === "boolean"
                ? userRecord.online
                : null;
        if (userId && online !== null) {
            const knownUser = self.snapshot.currentUser?.id === userId ||
                self.snapshot.users.some((user) => user.id === userId);
            self.applyPresence(userId, online);
            if (!knownUser) {
                void self.refreshEmployeeDirectory();
            }
        }
        return;
    }
    if (type === "message.created" || type === "message.edited" || type === "message.revoked") {
        const message = normalizeMessage(payload.message);
        if (message.id) {
            self.applyMessage(message);
        }
        void self.refreshConversationSummaries();
        return;
    }
    if (type === "conversation.created" ||
        type === "conversation.updated" ||
        type === "member.added" ||
        type === "member.updated" ||
        type === "member.removed" ||
        type === "receipt.read") {
        void self.refreshConversationSummaries();
    }
}

export function EnterpriseChatRuntime_applyMessage_3(self: EnterpriseChatRuntimeMethodContext, message: EnterpriseChatMessage) {
    const isActive = self.snapshot.activeConversationId === message.conversationId;
    const conversation = self.snapshot.conversations.find((item) => item.id === message.conversationId);
    self.reconcileDesktopActionMessages(isActive ? mergeMessage(self.snapshot.activeMessages, message) : [message], conversation);
    self.updateSnapshot({
        activeMessages: isActive
            ? mergeMessage(self.snapshot.activeMessages, message)
            : self.snapshot.activeMessages,
        conversations: self.snapshot.conversations.map((conversation) => conversation.id === message.conversationId
            ? {
                ...conversation,
                lastSeq: Math.max(conversation.lastSeq, message.seq),
                lastMessage: message,
                updatedAt: message.createdAt,
                unreadCount: message.senderId !== self.snapshot.currentUser?.id && !isActive
                    ? conversation.unreadCount + 1
                    : conversation.unreadCount
            }
            : conversation)
    });
}

export function EnterpriseChatRuntime_applyPresence_4(self: EnterpriseChatRuntimeMethodContext, userId: string, online: boolean) {
    self.presenceRevision += 1;
    const updateUser = (user: EnterpriseChatUser) => user.id === userId ? { ...user, online } : user;
    self.updateSnapshot({
        currentUser: self.snapshot.currentUser
            ? updateUser(self.snapshot.currentUser)
            : null,
        users: self.snapshot.users.map(updateUser),
        conversations: self.snapshot.conversations.map((conversation) => ({
            ...conversation,
            members: conversation.members.map((member) => ({
                ...member,
                user: updateUser(member.user)
            }))
        }))
    });
}

export async function EnterpriseChatRuntime_refreshConversationSummaries_5(self: EnterpriseChatRuntimeMethodContext) {
    try {
        const response = await self.requestJson<unknown>("/api/v1/conversations");
        const record = isRecord(response) ? response : {};
        self.updateSnapshot({
            conversations: mergeConversationUsers(normalizeConversations(record.items), [
                ...(self.snapshot.currentUser ? [self.snapshot.currentUser] : []),
                ...self.snapshot.users
            ])
        });
    }
    catch {
        // The next durable event or manual refresh will retry the summary projection.
    }
}

export async function EnterpriseChatRuntime_refreshEmployeeDirectory_6(self: EnterpriseChatRuntimeMethodContext) {
    const revisionAtRequestStart = self.presenceRevision;
    try {
        let users = await self.requestUsers();
        if (self.presenceRevision !== revisionAtRequestStart) {
            const livePresence = new Map([
                ...(self.snapshot.currentUser ? [self.snapshot.currentUser] : []),
                ...self.snapshot.users
            ].map((user) => [user.id, user.online] as const));
            users = users.map((user) => livePresence.has(user.id)
                ? { ...user, online: livePresence.get(user.id) ?? null }
                : user);
        }
        const currentUserId = self.snapshot.currentUser?.id ?? "";
        const directoryCurrentUser = users.find((user) => user.id === currentUserId);
        const currentUser = self.snapshot.currentUser && directoryCurrentUser
            ? { ...self.snapshot.currentUser, ...directoryCurrentUser }
            : self.snapshot.currentUser;
        const visibleUsers = users.filter((user) => user.id !== currentUserId);
        self.updateSnapshot({
            currentUser,
            users: visibleUsers,
            conversations: mergeConversationUsers(self.snapshot.conversations, [
                ...(currentUser ? [currentUser] : []),
                ...visibleUsers
            ])
        });
    }
    catch {
        // Presence pushes remain usable; the next sync or manual refresh retries the directory.
    }
}

export function EnterpriseChatRuntime_sendWebSocketRequest_7(self: EnterpriseChatRuntimeMethodContext, type: string, payload: unknown) {
    const socket = self.socket;
    if (!socket || socket.readyState !== 1) {
        return Promise.reject(new Error("Enterprise chat connection is unavailable."));
    }
    const id = self.nextRequestId(type);
    return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
            self.pendingRequests.delete(id);
            reject(new Error("Enterprise chat request timed out."));
        }, ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
        self.pendingRequests.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({
            v: 1,
            frame: "request",
            id,
            type,
            payload
        }));
    });
}

export function EnterpriseChatRuntime_nextRequestId_8(self: EnterpriseChatRuntimeMethodContext, prefix: string) {
    self.requestSequence += 1;
    return `${prefix}-${Date.now()}-${self.requestSequence}`;
}

export function EnterpriseChatRuntime_updateSnapshot_9(self: EnterpriseChatRuntimeMethodContext, patch: Partial<EnterpriseChatSnapshot>) {
    self.snapshot = {
        ...self.snapshot,
        ...patch,
        updatedAt: nowEpochMilliseconds()
    };
    self.onStateChanged?.(self.getState());
}

export function EnterpriseChatRuntime_scheduleReconnect_10(self: EnterpriseChatRuntimeMethodContext) {
    if (self.reconnectTimer || !self.snapshot.enabled) {
        return;
    }
    self.reconnectAttempt += 1;
    const delay = Math.min(ENTERPRISE_CHAT_RECONNECT_MAX_MS, 1000 * 2 ** Math.min(self.reconnectAttempt - 1, 5));
    self.reconnectTimer = setTimeout(() => {
        self.reconnectTimer = null;
        void self.refresh();
    }, delay);
}

export function EnterpriseChatRuntime_scheduleSessionRefresh_11(self: EnterpriseChatRuntimeMethodContext) {
    if (self.sessionRefreshTimer) {
        clearTimeout(self.sessionRefreshTimer);
    }
    const delay = Math.max(5000, self.imSessionTokenExpiresAt - Date.now() - 60000);
    self.sessionRefreshTimer = setTimeout(() => {
        self.sessionRefreshTimer = null;
        void self.refresh();
    }, delay);
}

export function EnterpriseChatRuntime_disconnect_12(self: EnterpriseChatRuntimeMethodContext) {
    if (self.reconnectTimer) {
        clearTimeout(self.reconnectTimer);
        self.reconnectTimer = null;
    }
    self.socketClosing = true;
    const socket = self.socket;
    self.socket = null;
    self.socketSynced = false;
    if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        try {
            socket.close();
        }
        catch {
            // Closing an already-closed WebSocket is harmless.
        }
    }
    self.rejectPendingRequests(new Error("Enterprise chat connection closed."));
}

export function EnterpriseChatRuntime_clearSession_13(self: EnterpriseChatRuntimeMethodContext) {
    self.imSessionToken = "";
    self.imSessionTokenExpiresAt = 0;
    if (self.sessionRefreshTimer) {
        clearTimeout(self.sessionRefreshTimer);
        self.sessionRefreshTimer = null;
    }
}

export function EnterpriseChatRuntime_rejectPendingRequests_14(self: EnterpriseChatRuntimeMethodContext, error: Error) {
    for (const pending of self.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
    }
    self.pendingRequests.clear();
}
