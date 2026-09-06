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

export async function EnterpriseChatRuntime_sendSupportBundle_1(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendSupportBundleInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    if (!conversationId || !clientMessageId) {
        throw new Error("conversationId and clientMessageId are required.");
    }
    await self.ensureSession();
    self.assertMessageSendReady();
    const bundle = await self.createSupportBundle();
    const bundleBytes = Uint8Array.from(bundle.bytes);
    const attachment = await self.uploadBlob(new Blob([bundleBytes.buffer], { type: "application/zip" }), bundle.filename);
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body: "",
        fileIds: [attachment.id]
    });
}

export async function EnterpriseChatRuntime_sendRawAgentChat_2(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendRawAgentChatInput, rawChat: EnterpriseChatRawAgentChatData) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const chatId = readText(input?.chatId);
    if (!conversationId || !clientMessageId || !chatId) {
        throw new Error("conversationId, chatId, and clientMessageId are required.");
    }
    if (!(rawChat?.bytes instanceof Uint8Array)) {
        throw new Error(t("assistant.rawChatJsonlReadFailed"));
    }
    if (rawChat.bytes.byteLength > ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES) {
        throw new Error(t("assistant.rawChatJsonlTooLarge"));
    }
    await self.ensureSession();
    self.assertMessageSendReady();
    const filename = safeRawAgentChatFilename(readText(input.chatName) || path.basename(readText(rawChat.filename), ".jsonl"), chatId, self.platform);
    const bytes = Uint8Array.from(rawChat.bytes);
    const attachment = await self.uploadBlob(new Blob([bytes.buffer], { type: "application/x-ndjson" }), filename);
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body: "",
        kind: "file",
        fileIds: [attachment.id]
    });
}

export async function EnterpriseChatRuntime_saveSelfProfile_3(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSaveSelfProfileInput) {
    const userId = self.snapshot.currentUser?.id ?? "";
    if (!userId) {
        throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selfProfile = await saveEnterpriseChatMotto(self.app, self.platform, self.serverUrl, userId, typeof input?.motto === "string" ? input.motto : "");
    self.updateSnapshot({ selfProfile });
    return self.getState();
}

export async function EnterpriseChatRuntime_selectSelfAvatar_4(self: EnterpriseChatRuntimeMethodContext) {
    const userId = self.snapshot.currentUser?.id ?? "";
    if (!userId) {
        throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selected = (await self.selectAvatar()).map((value) => value.trim()).filter(Boolean);
    if (selected.length === 0) {
        return self.getState();
    }
    const selfProfile = await saveEnterpriseChatAvatar(self.app, self.platform, self.serverUrl, userId, selected[0]);
    self.updateSnapshot({ selfProfile });
    return self.getState();
}

export async function EnterpriseChatRuntime_clearSelfAvatar_5(self: EnterpriseChatRuntimeMethodContext) {
    const userId = self.snapshot.currentUser?.id ?? "";
    if (!userId) {
        throw new Error("Enterprise chat profile requires a signed-in user.");
    }
    const selfProfile = await clearEnterpriseChatAvatar(self.app, self.platform, self.serverUrl, userId);
    self.updateSnapshot({ selfProfile });
    return self.getState();
}

export async function EnterpriseChatRuntime_sendPastedFiles_6(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendPastedFilesInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const files = Array.isArray(input?.files) ? input.files : [];
    if (!conversationId || !clientMessageId) {
        throw new Error("conversationId and clientMessageId are required.");
    }
    if (files.length === 0 || files.length > ENTERPRISE_CHAT_MAX_PASTED_FILES) {
        throw new Error(`Paste between 1 and ${ENTERPRISE_CHAT_MAX_PASTED_FILES} files.`);
    }
    const blobs = files.map((file, index) => {
        const value: unknown = file;
        const record = isRecord(value) ? value : {};
        const name = readText(record.name) || `pasted-file-${Date.now()}-${index + 1}`;
        const contentType = readText(record.contentType) || contentTypeForFile(name);
        const sizeBytes = Math.max(0, Math.trunc(readNumber(record.sizeBytes)));
        const rawDataBase64 = record.dataBase64;
        const hasData = typeof rawDataBase64 === "string";
        const dataBase64 = hasData
            ? rawDataBase64.trim()
            : "";
        const maxBase64Length = Math.ceil(ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES / 3) * 4 + 4;
        if (!hasData ||
            dataBase64.length > maxBase64Length ||
            dataBase64.length % 4 === 1 ||
            !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)) {
            throw new Error(`Pasted file "${name}" has invalid data.`);
        }
        const bytes = Buffer.from(dataBase64, "base64");
        if (bytes.length > ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES ||
            bytes.length !== sizeBytes) {
            throw new Error(`Pasted file "${name}" exceeds the local attachment limit.`);
        }
        return {
            blob: new Blob([bytes], { type: contentType }),
            name
        };
    });
    await self.ensureSession();
    self.assertMessageSendReady();
    const fileIds: string[] = [];
    for (const file of blobs) {
        const attachment = await self.uploadBlob(file.blob, file.name);
        fileIds.push(attachment.id);
    }
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body: "",
        fileIds
    });
}

export async function EnterpriseChatRuntime_sendScreenshot_7(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatSendScreenshotInput) {
    const conversationId = readText(input?.conversationId);
    const clientMessageId = readText(input?.clientMessageId);
    const mode = readText(input?.mode);
    if (!conversationId || !clientMessageId) {
        throw new Error("conversationId and clientMessageId are required.");
    }
    if (mode !== "region" && mode !== "window" && mode !== "desktop") {
        throw new Error("Screenshot mode is invalid.");
    }
    if (!self.captureScreenshot) {
        throw new Error("Screenshot capture is unavailable.");
    }
    const capture = await self.captureScreenshot(mode);
    if (!capture.ok) {
        if (capture.cancelled) {
            return self.getState();
        }
        throw new Error(capture.message || "Screenshot capture failed.");
    }
    const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
    if (bytes.length === 0) {
        throw new Error("Screenshot capture returned no image.");
    }
    await self.ensureSession();
    self.assertMessageSendReady();
    const attachment = await self.uploadBlob(new Blob([bytes], { type: capture.mimeType || "image/png" }), `screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
    return self.sendMessagePayload({
        conversationId,
        clientMessageId,
        body: "",
        fileIds: [attachment.id]
    });
}

export async function EnterpriseChatRuntime_loadAttachment_8(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData> {
    const fileId = readText(input?.fileId);
    if (!fileId) {
        throw new Error("fileId is required.");
    }
    const { buffer, contentType } = await self.fetchAttachment(fileId, ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES);
    return {
        fileId,
        contentType: readText(input?.contentType) || contentType,
        sizeBytes: buffer.length,
        dataBase64: buffer.toString("base64")
    };
}

export async function EnterpriseChatRuntime_downloadAttachment_9(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult> {
    const fileId = readText(input?.fileId);
    if (!fileId) {
        throw new Error("fileId is required.");
    }
    const { buffer } = await self.fetchAttachment(fileId, ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES);
    const filename = safeDownloadName(readText(input?.name) || "attachment", self.platform);
    const saveResult = self.showSaveDialog
        ? await self.showSaveDialog({
            title: "Save attachment",
            defaultPath: path.join(self.app.getPath("downloads"), filename)
        })
        : {
            canceled: false,
            filePath: path.join(self.app.getPath("downloads"), filename)
        };
    if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, path: "", message: "Download cancelled." };
    }
    const target = saveResult.filePath;
    if (self.platform === "win32") {
        await fs.promises.writeFile(target, buffer);
    }
    else {
        await fs.promises.writeFile(target, buffer, { mode: 0o600 });
    }
    return { ok: true, path: target, message: "" };
}

export async function EnterpriseChatRuntime_executeMessageDesktopAction_10(self: EnterpriseChatRuntimeMethodContext, input: EnterpriseChatExecuteActionInput): Promise<EnterpriseChatExecuteActionResult> {
    const messageId = readText(input?.messageId);
    if (input?.decision !== "confirm" && input?.decision !== "decline") {
        throw new Error("A local Desktop action decision is required.");
    }
    const message = self.snapshot.activeMessages.find((item) => item.id === messageId);
    const conversation = message
        ? self.snapshot.conversations.find((item) => item.id === message.conversationId)
        : undefined;
    const request = message?.desktopAction;
    const scope = self.currentDesktopActionScope();
    const ledger = self.getDesktopActionLedger();
    const existing = request && scope
        ? ledger?.find(scope, request.requestId)
        : undefined;
    if (existing || (message && ledger?.hasLegacyMessage(message.id))) {
        return self.handledDesktopActionResult(existing);
    }
    if (!message ||
        !request ||
        !conversation ||
        self.desktopActionState(message, conversation) !== "pending" ||
        !scope ||
        !ledger) {
        return self.notExecutableDesktopActionResult();
    }
    let claimed: EnterpriseChatActionLedgerEntry;
    try {
        const claim = ledger.claim({
            scope,
            messageId: message.id,
            requestId: request.requestId,
            conversationId: message.conversationId,
            targetDeviceId: request.targetDeviceId,
            action: request.action
        });
        if (!claim.created) {
            return self.handledDesktopActionResult(claim.entry);
        }
        claimed = claim.entry;
    }
    catch (error) {
        return self.notExecutableDesktopActionResult(errorMessage(error));
    }
    self.updateSnapshot({});
    let status: EnterpriseChatDesktopActionStatus;
    let resultMessage: string;
    let fileIds: string[] = [];
    let response: DesktopActionCallResponse | undefined;
    if (input.decision === "decline") {
        status = "declined";
        resultMessage = "User declined the Desktop action request.";
    }
    else {
        try {
            if (request.action.startsWith("desktop.support.")) {
                fileIds = await self.createRemoteSupportAttachment(request);
                status = "succeeded";
                resultMessage = fileIds.length > 0
                    ? "Requested support information was sent."
                    : "Support request completed.";
            }
            else if (!self.executeDesktopAction) {
                status = "unsupported";
                resultMessage = "Desktop action execution is unavailable.";
            }
            else {
                const result = await self.executeDesktopAction({
                    ...request,
                    args: { ...request.args },
                    messageId: message.id,
                    conversationId: message.conversationId,
                    senderId: message.senderId
                });
                response = result.response;
                status = result.response?.ok === true ? "succeeded" : "failed";
                resultMessage = result.message;
            }
        }
        catch (error) {
            status = "failed";
            resultMessage = errorMessage(error);
        }
    }
    const terminal = ledger.complete(scope, claimed.requestId, {
        status,
        resultMessage,
        fileIds
    });
    self.updateSnapshot({});
    const delivered = await self.deliverDesktopActionReceipt(terminal);
    return {
        confirmed: input.decision === "confirm",
        status,
        disposition: "completed",
        deliveryState: delivered ? "delivered" : "pending",
        ...(response ? { response } : {}),
        message: resultMessage
    };
}

export function EnterpriseChatRuntime_handledDesktopActionResult_11(self: EnterpriseChatRuntimeMethodContext, entry?: EnterpriseChatActionLedgerEntry): EnterpriseChatExecuteActionResult {
    return {
        confirmed: entry?.status !== "declined",
        status: entry?.status ?? "failed",
        disposition: "already_handled",
        deliveryState: entry?.phase === "terminal"
            ? entry.deliveryState
            : "not_applicable",
        message: entry?.resultMessage || "This Desktop action request was already handled."
    };
}

export function EnterpriseChatRuntime_notExecutableDesktopActionResult_12(self: EnterpriseChatRuntimeMethodContext, message = "This Desktop action request is not executable."): EnterpriseChatExecuteActionResult {
    return {
        confirmed: false,
        status: "unsupported",
        disposition: "not_executable",
        deliveryState: "not_applicable",
        message
    };
}

export async function EnterpriseChatRuntime_createRemoteSupportAttachment_13(self: EnterpriseChatRuntimeMethodContext, request: EnterpriseChatDesktopAction) {
    if (request.action === "desktop.support.requestDiagnostics") {
        const bundle = await self.createSupportBundle();
        const attachment = await self.uploadBlob(new Blob([Uint8Array.from(bundle.bytes).buffer], { type: "application/zip" }), bundle.filename);
        return [attachment.id];
    }
    if (request.action === "desktop.support.requestScreenshot") {
        const mode = readText(request.args.mode) as EnterpriseChatScreenshotMode;
        if (!self.captureScreenshot || !["region", "window", "desktop"].includes(mode)) {
            throw new Error("Screenshot capture is unavailable or the mode is invalid.");
        }
        const capture = await self.captureScreenshot(mode);
        if (!capture.ok || capture.cancelled) {
            throw new Error(capture.message || "Screenshot capture was cancelled.");
        }
        const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
        if (bytes.length === 0) {
            throw new Error("Screenshot capture returned no image.");
        }
        const attachment = await self.uploadBlob(new Blob([bytes], { type: capture.mimeType || "image/png" }), `desktop-screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
        return [attachment.id];
    }
    if (!self.createSupportArtifact) {
        throw new Error("The requested support artifact is unavailable.");
    }
    const artifact = await self.createSupportArtifact(request.action, request.args);
    const attachment = await self.uploadBlob(new Blob([Uint8Array.from(artifact.bytes).buffer], { type: artifact.contentType }), artifact.filename);
    return [attachment.id];
}
