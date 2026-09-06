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

export function EnterpriseChatRuntime_getState_1(self: EnterpriseChatRuntimeMethodContext) {
    return {
        ...self.snapshot,
        currentUser: self.snapshot.currentUser ? { ...self.snapshot.currentUser } : null,
        selfProfile: { ...self.snapshot.selfProfile },
        users: self.snapshot.users.map((user) => ({ ...user })),
        conversations: self.snapshot.conversations.map((conversation) => ({
            ...conversation,
            lastMessage: conversation.lastMessage
                ? self.projectMessage(conversation.lastMessage, conversation)
                : null,
            members: conversation.members.map((member) => ({
                ...member,
                user: { ...member.user }
            }))
        })),
        activeMessages: self.snapshot.activeMessages.map((message) => self.projectMessage(message, self.snapshot.conversations.find((conversation) => conversation.id === message.conversationId)))
    };
}

export function EnterpriseChatRuntime_currentDesktopActionScope_2(self: EnterpriseChatRuntimeMethodContext) {
    const userId = self.snapshot.currentUser?.id ?? "";
    const deviceId = self.getDeviceInfo().deviceId;
    return userId && deviceId
        ? enterpriseChatActionScope(self.serverUrl, userId, deviceId)
        : "";
}

export function EnterpriseChatRuntime_getDesktopActionLedger_3(self: EnterpriseChatRuntimeMethodContext) {
    let ledgerPath = "";
    try {
        ledgerPath = path.join(self.app.getPath("userData"), "enterprise-chat-action-ledger.json");
    }
    catch {
        return null;
    }
    if (ledgerPath === self.desktopActionLedgerPath) {
        return self.desktopActionLedger;
    }
    self.desktopActionLedgerPath = ledgerPath;
    try {
        self.desktopActionLedger = new EnterpriseChatActionLedger(ledgerPath);
    }
    catch {
        self.desktopActionLedger = null;
    }
    return self.desktopActionLedger;
}

export function EnterpriseChatRuntime_desktopActionState_4(self: EnterpriseChatRuntimeMethodContext, message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation) {
    const request = message.desktopAction;
    if (!request) {
        return undefined;
    }
    const ledger = self.getDesktopActionLedger();
    if (ledger?.hasLegacyMessage(message.id)) {
        return "handled" as const;
    }
    const scope = self.currentDesktopActionScope();
    const entry = scope ? ledger?.find(scope, request.requestId) : undefined;
    if (entry?.phase === "executing") {
        return "executing" as const;
    }
    if (entry?.phase === "terminal") {
        return "handled" as const;
    }
    if (!scope ||
        !ledger ||
        !conversation ||
        conversation.type !== "direct" ||
        message.senderId === self.snapshot.currentUser?.id ||
        message.revokedAt ||
        !getEnterpriseChatRemoteAction(request.action) ||
        request.targetDeviceId !== self.getDeviceInfo().deviceId ||
        request.expiresAt <= Date.now()) {
        return "not_executable" as const;
    }
    return "pending" as const;
}

export function EnterpriseChatRuntime_projectMessage_5(self: EnterpriseChatRuntimeMethodContext, message: EnterpriseChatMessage, conversation?: EnterpriseChatConversation): EnterpriseChatMessage {
    const desktopActionState = self.desktopActionState(message, conversation);
    return {
        ...message,
        attachments: message.attachments.map((attachment) => ({ ...attachment })),
        ...(message.desktopAction
            ? {
                desktopActionHandled: desktopActionState !== "pending",
                desktopActionState,
                desktopAction: {
                    ...message.desktopAction,
                    args: { ...message.desktopAction.args }
                }
            }
            : {})
    };
}

export async function EnterpriseChatRuntime_setEnabled_6(self: EnterpriseChatRuntimeMethodContext, enabled: boolean) {
    if (!enabled) {
        self.disconnect();
        self.clearSession();
        self.updateSnapshot({
            enabled: false,
            connectionState: "disabled",
            message: "",
            currentUser: null,
            selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
            users: [],
            conversations: [],
            activeConversationId: "",
            activeMessages: [],
            latestEventId: 0
        });
        return self.getState();
    }
    const wasEnabled = self.snapshot.enabled;
    self.updateSnapshot({
        enabled: true,
        connectionState: self.getIdentityToken() ? "connecting" : "signed_out",
        message: ""
    });
    if (!wasEnabled || !self.socket) {
        return self.refresh();
    }
    return self.getState();
}

export async function EnterpriseChatRuntime_refresh_7(self: EnterpriseChatRuntimeMethodContext) {
    if (self.refreshPromise) {
        return self.refreshPromise;
    }
    self.refreshPromise = self.performRefresh().finally(() => {
        self.refreshPromise = null;
    });
    return self.refreshPromise;
}

export async function EnterpriseChatRuntime_reloadConfiguration_8(self: EnterpriseChatRuntimeMethodContext, enabled: boolean) {
    const nextServerUrl = normalizeServerUrl(self.getServerUrl());
    if (nextServerUrl !== self.serverUrl) {
        self.disconnect();
        self.clearSession();
        self.serverUrl = nextServerUrl;
        self.updateSnapshot({ serverUrl: nextServerUrl });
    }
    return self.setEnabled(enabled);
}

export async function EnterpriseChatRuntime_performRefresh_9(self: EnterpriseChatRuntimeMethodContext) {
    if (!self.snapshot.enabled) {
        return self.getState();
    }
    const identityToken = readText(self.getIdentityToken());
    if (!identityToken) {
        self.disconnect();
        self.clearSession();
        self.updateSnapshot({
            connectionState: "signed_out",
            message: "",
            currentUser: null,
            selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
            users: [],
            conversations: [],
            activeConversationId: "",
            activeMessages: [],
            latestEventId: 0
        });
        return self.getState();
    }
    self.disconnect();
    self.clearSession();
    try {
        self.updateServerUrl();
        self.updateSnapshot({
            connectionState: "connecting",
            message: "",
            serverUrl: self.serverUrl
        });
        let session: ServerSession;
        try {
            session = await self.exchangeSession(identityToken);
        }
        catch (error) {
            if (!(error instanceof EnterpriseChatRequestError) || error.status !== 401 || !self.refreshIdentityToken) {
                throw error;
            }
            const refreshedIdentityToken = readText(await self.refreshIdentityToken());
            if (!refreshedIdentityToken) {
                throw error;
            }
            session = await self.exchangeSession(refreshedIdentityToken);
        }
        self.imSessionToken = session.token;
        self.imSessionTokenExpiresAt = session.expiresAt;
        self.scheduleSessionRefresh();
        const [bootstrap, users] = await Promise.all([
            self.requestBootstrap(),
            self.requestUsers()
        ]);
        const bootstrapCurrentUser = bootstrap.user.id ? bootstrap.user : session.user;
        const directoryCurrentUser = users.find((user) => user.id === bootstrapCurrentUser.id);
        const currentUser = directoryCurrentUser
            ? { ...bootstrapCurrentUser, ...directoryCurrentUser }
            : bootstrapCurrentUser;
        const visibleUsers = users.filter((user) => user.id && user.id !== currentUser.id);
        const selfProfile = readEnterpriseChatSelfProfile(self.app, self.platform, self.serverUrl, currentUser.id);
        self.updateSnapshot({
            currentUser,
            selfProfile,
            users: visibleUsers,
            conversations: mergeConversationUsers(bootstrap.conversations, [currentUser, ...visibleUsers]),
            latestEventId: bootstrap.latestEventId,
            activeConversationId: "",
            activeMessages: [],
            connectionState: "connecting",
            message: ""
        });
        const actionScope = self.currentDesktopActionScope();
        if (actionScope && !self.recoveredDesktopActionScopes.has(actionScope)) {
            self.recoveredDesktopActionScopes.add(actionScope);
            if (self.getDesktopActionLedger()?.recoverExecuting(actionScope).length) {
                self.updateSnapshot({});
            }
        }
        await self.connectWebSocket();
    }
    catch (error) {
        self.disconnect();
        self.clearSession();
        self.updateSnapshot({
            connectionState: "error",
            message: errorMessage(error),
            currentUser: null,
            selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
            users: [],
            conversations: [],
            activeConversationId: "",
            activeMessages: [],
            latestEventId: 0
        });
    }
    return self.getState();
}

export function EnterpriseChatRuntime_updateServerUrl_10(self: EnterpriseChatRuntimeMethodContext) {
    self.serverUrl = normalizeServerUrl(self.getServerUrl());
}

export async function EnterpriseChatRuntime_openDirectConversation_11(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatOpenDirectInput) {
    const userId = readText(input?.userId);
    if (!userId || userId === self.snapshot.currentUser?.id) {
        throw new Error("A different enterprise employee is required.");
    }
    await self.ensureSession();
    let conversation = self.snapshot.conversations.find((item) => item.type === "direct" &&
        item.members.some((member) => member.user.id === userId));
    if (!conversation) {
        const created = await self.requestJson<unknown>("/api/v1/conversations", {
            method: "POST",
            body: JSON.stringify({
                type: "direct",
                memberIds: [userId]
            })
        });
        conversation = normalizeConversation(created) ?? undefined;
        if (!conversation) {
            throw new Error("The IM server returned an invalid direct conversation.");
        }
        self.snapshot.conversations = [
            conversation,
            ...self.snapshot.conversations.filter((item) => item.id !== conversation?.id)
        ];
    }
    return self.openConversation({ conversationId: conversation.id });
}

export async function EnterpriseChatRuntime_openConversation_12(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatOpenConversationInput) {
    const conversationId = readText(input?.conversationId);
    if (!conversationId) {
        throw new Error("conversationId is required.");
    }
    await self.ensureSession();
    let conversation = self.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
        const response = await self.requestJson<unknown>(`/api/v1/conversations/${encodeURIComponent(conversationId)}`);
        conversation = normalizeConversation(response) ?? undefined;
    }
    if (!conversation) {
        throw new Error("The IM server returned an invalid conversation.");
    }
    [conversation] = mergeConversationUsers([conversation], [
        ...(self.snapshot.currentUser ? [self.snapshot.currentUser] : []),
        ...self.snapshot.users
    ]);
    const response = await self.requestJson<unknown>(`/api/v1/conversations/${encodeURIComponent(conversation.id)}/messages?limit=50`);
    const record = isRecord(response) ? response : {};
    const messages = normalizeMessages(record.items);
    self.reconcileDesktopActionMessages(messages, conversation);
    self.updateSnapshot({
        conversations: [
            conversation,
            ...self.snapshot.conversations.filter((item) => item.id !== conversation?.id)
        ],
        activeConversationId: conversation.id,
        activeMessages: messages,
        message: ""
    });
    void self.flushDesktopActionReceipts();
    if (conversation.lastSeq > conversation.lastReadSeq) {
        await self.markRead({ conversationId: conversation.id, seq: conversation.lastSeq });
    }
    return self.getState();
}

export async function EnterpriseChatRuntime_createGroup_13(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatCreateGroupInput) {
    const title = readText(input?.title);
    const currentUserId = self.snapshot.currentUser?.id ?? "";
    const memberIds = Array.from(new Set(Array.isArray(input?.memberIds)
        ? input.memberIds.map(readText).filter((id) => id && id !== currentUserId)
        : []));
    if (!title || memberIds.length === 0) {
        throw new Error("A group title and at least one other member are required.");
    }
    await self.ensureSession();
    const created = await self.requestJson<unknown>("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
            type: "group",
            title,
            memberIds
        })
    });
    let conversation = normalizeConversation(created);
    if (!conversation || conversation.type !== "group") {
        throw new Error("The IM server returned an invalid group conversation.");
    }
    [conversation] = mergeConversationUsers([conversation], [
        ...(self.snapshot.currentUser ? [self.snapshot.currentUser] : []),
        ...self.snapshot.users
    ]);
    self.updateSnapshot({
        conversations: [
            conversation,
            ...self.snapshot.conversations.filter((item) => item.id !== conversation.id)
        ]
    });
    return self.openConversation({ conversationId: conversation.id });
}

export async function EnterpriseChatRuntime_sendMessage_14(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendMessageInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const body = readText(input?.body);
    if (!conversationId || !clientMessageId || !body) {
        throw new Error("conversationId, clientMessageId, and body are required.");
    }
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body,
        fileIds: []
    });
}

export async function EnterpriseChatRuntime_sendFiles_15(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendFilesInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    if (!conversationId || !clientMessageId) {
        throw new Error("conversationId and clientMessageId are required.");
    }
    const selected = (await self.selectFiles())
        .map((filePath) => filePath.trim())
        .filter(Boolean)
        .slice(0, ENTERPRISE_CHAT_MAX_SELECTED_FILES);
    if (selected.length === 0) {
        return self.getState();
    }
    await self.ensureSession();
    self.assertMessageSendReady();
    const fileIds: string[] = [];
    for (const filePath of selected) {
        const attachment = await self.uploadFilePath(filePath);
        fileIds.push(attachment.id);
    }
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body: "",
        fileIds
    });
}
