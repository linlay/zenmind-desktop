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

import { EnterpriseChatRuntime_getState_1, EnterpriseChatRuntime_currentDesktopActionScope_2, EnterpriseChatRuntime_getDesktopActionLedger_3, EnterpriseChatRuntime_desktopActionState_4, EnterpriseChatRuntime_projectMessage_5, EnterpriseChatRuntime_setEnabled_6, EnterpriseChatRuntime_refresh_7, EnterpriseChatRuntime_reloadConfiguration_8, EnterpriseChatRuntime_performRefresh_9, EnterpriseChatRuntime_updateServerUrl_10, EnterpriseChatRuntime_openDirectConversation_11, EnterpriseChatRuntime_openConversation_12, EnterpriseChatRuntime_createGroup_13, EnterpriseChatRuntime_sendMessage_14, EnterpriseChatRuntime_sendFiles_15 } from "./runtime.methods-1";

import { EnterpriseChatRuntime_sendSupportBundle_1, EnterpriseChatRuntime_sendRawAgentChat_2, EnterpriseChatRuntime_saveSelfProfile_3, EnterpriseChatRuntime_selectSelfAvatar_4, EnterpriseChatRuntime_clearSelfAvatar_5, EnterpriseChatRuntime_sendPastedFiles_6, EnterpriseChatRuntime_sendScreenshot_7, EnterpriseChatRuntime_loadAttachment_8, EnterpriseChatRuntime_downloadAttachment_9, EnterpriseChatRuntime_executeMessageDesktopAction_10, EnterpriseChatRuntime_handledDesktopActionResult_11, EnterpriseChatRuntime_notExecutableDesktopActionResult_12, EnterpriseChatRuntime_createRemoteSupportAttachment_13 } from "./runtime.methods-2";

import { EnterpriseChatRuntime_deliverDesktopActionReceipt_1, EnterpriseChatRuntime_flushDesktopActionReceipts_2, EnterpriseChatRuntime_reconcileDesktopActionMessages_3, EnterpriseChatRuntime_sendMessagePayload_4, EnterpriseChatRuntime_assertMessageSendReady_5, EnterpriseChatRuntime_markRead_6, EnterpriseChatRuntime_handleSignedOut_7, EnterpriseChatRuntime_stop_8, EnterpriseChatRuntime_ensureSession_9, EnterpriseChatRuntime_uploadFilePath_10, EnterpriseChatRuntime_uploadBlob_11, EnterpriseChatRuntime_fetchAttachment_12, EnterpriseChatRuntime_exchangeSession_13, EnterpriseChatRuntime_requestBootstrap_14, EnterpriseChatRuntime_requestUsers_15, EnterpriseChatRuntime_requestJson_16 } from "./runtime.methods-3";

import { EnterpriseChatRuntime_connectWebSocket_1, EnterpriseChatRuntime_handleWebSocketMessage_2, EnterpriseChatRuntime_applyMessage_3, EnterpriseChatRuntime_applyPresence_4, EnterpriseChatRuntime_refreshConversationSummaries_5, EnterpriseChatRuntime_refreshEmployeeDirectory_6, EnterpriseChatRuntime_sendWebSocketRequest_7, EnterpriseChatRuntime_nextRequestId_8, EnterpriseChatRuntime_updateSnapshot_9, EnterpriseChatRuntime_scheduleReconnect_10, EnterpriseChatRuntime_scheduleSessionRefresh_11, EnterpriseChatRuntime_disconnect_12, EnterpriseChatRuntime_clearSession_13, EnterpriseChatRuntime_rejectPendingRequests_14 } from "./runtime.methods-4";

export class EnterpriseChatRuntime {
  private readonly app: App;
  private serverUrl: string;
  private readonly getServerUrl: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly getIdentityToken: () => string | null;
  private readonly refreshIdentityToken?: () => Promise<string | null>;
  private readonly getDeviceInfo: () => { deviceId: string; deviceName: string };
  private readonly platform: NodeJS.Platform;
  private readonly selectFiles: () => Promise<string[]>;
  private readonly selectAvatar: () => Promise<string[]>;
  private readonly showSaveDialog?: EnterpriseChatRuntimeOptions["showSaveDialog"];
  private readonly createSupportBundle: () => Promise<{ filename: string; bytes: Buffer }>;
  private readonly captureScreenshot?: EnterpriseChatRuntimeOptions["captureScreenshot"];
  private readonly createSupportArtifact?: EnterpriseChatRuntimeOptions["createSupportArtifact"];
  private readonly executeDesktopAction?: EnterpriseChatRuntimeOptions["executeDesktopAction"];
  private readonly onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
  private snapshot: EnterpriseChatSnapshot;
  private imSessionToken = "";
  private imSessionTokenExpiresAt = 0;
  private socket: WebSocketLike | null = null;
  private socketSynced = false;
  private socketClosing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSequence = 0;
  private presenceRevision = 0;
  private desktopActionLedger: EnterpriseChatActionLedger | null = null;
  private desktopActionLedgerPath = "";
  private readonly recoveredDesktopActionScopes = new Set<string>();
  private actionReceiptFlushPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingWebSocketRequest>();
  private refreshPromise: Promise<EnterpriseChatSnapshot> | null = null;

  constructor(options: EnterpriseChatRuntimeOptions) {
    this.app = options.app;
    this.getServerUrl = options.getServerUrl ?? (() =>
      options.serverUrl ?? DEFAULT_ENTERPRISE_IM_BASE_URL
    );
    this.serverUrl = normalizeServerUrl(this.getServerUrl());
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.createWebSocket = options.createWebSocket ?? createDefaultWebSocket;
    this.getIdentityToken = options.getIdentityToken ?? getDesktopSsoAccessToken;
    this.refreshIdentityToken = options.refreshIdentityToken;
    this.getDeviceInfo = options.getDeviceInfo ?? (() => getDesktopDeviceInfo(this.app));
    this.platform = options.platform ?? process.platform;
    this.selectFiles = options.selectFiles ?? (async () => []);
    this.selectAvatar = options.selectAvatar ?? (async () => []);
    this.showSaveDialog = options.showSaveDialog;
    this.createSupportBundle = options.createSupportBundle ?? (() =>
      createEnterpriseChatSupportBundle(this.app, this.platform)
    );
    this.captureScreenshot = options.captureScreenshot;
    this.createSupportArtifact = options.createSupportArtifact;
    this.executeDesktopAction = options.executeDesktopAction;
    this.onStateChanged = options.onStateChanged;
    const initialEnabled = options.initialEnabled ?? false;
    this.snapshot = {
      enabled: initialEnabled,
      connectionState: initialEnabled ? "signed_out" : "disabled",
      message: "",
      serverUrl: this.serverUrl,
      currentUser: null,
      selfProfile: {
        motto: "",
        avatarDataUrl: "",
        hasCustomAvatar: false
      },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0,
      updatedAt: nowEpochMilliseconds()
    };
  }

  getState() { return EnterpriseChatRuntime_getState_1(this as any as any as any); }

  private currentDesktopActionScope() { return EnterpriseChatRuntime_currentDesktopActionScope_2(this as any as any as any); }

  private getDesktopActionLedger() { return EnterpriseChatRuntime_getDesktopActionLedger_3(this as any as any as any); }

  private desktopActionState(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ) { return EnterpriseChatRuntime_desktopActionState_4(this as any as any as any, message, conversation); }

  private projectMessage(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ): EnterpriseChatMessage { return EnterpriseChatRuntime_projectMessage_5(this as any as any as any, message, conversation); }

  async setEnabled(enabled: boolean) { return EnterpriseChatRuntime_setEnabled_6(this as any as any as any, enabled); }

  async refresh() { return EnterpriseChatRuntime_refresh_7(this as any as any as any); }

  async reloadConfiguration(enabled: boolean) { return EnterpriseChatRuntime_reloadConfiguration_8(this as any as any as any, enabled); }

  private async performRefresh() { return EnterpriseChatRuntime_performRefresh_9(this as any as any as any); }

  private updateServerUrl() { return EnterpriseChatRuntime_updateServerUrl_10(this as any as any as any); }

  async openDirectConversation(input: EnterpriseChatOpenDirectInput) { return EnterpriseChatRuntime_openDirectConversation_11(this as any as any as any, input); }

  async openConversation(input: EnterpriseChatOpenConversationInput) { return EnterpriseChatRuntime_openConversation_12(this as any as any as any, input); }

  async createGroup(input: EnterpriseChatCreateGroupInput) { return EnterpriseChatRuntime_createGroup_13(this as any as any as any, input); }

  async sendMessage(input: EnterpriseChatSendMessageInput) { return EnterpriseChatRuntime_sendMessage_14(this as any as any as any, input); }

  async sendFiles(input: EnterpriseChatSendFilesInput) { return EnterpriseChatRuntime_sendFiles_15(this as any as any as any, input); }

  async sendSupportBundle(input: EnterpriseChatSendSupportBundleInput) { return EnterpriseChatRuntime_sendSupportBundle_1(this as any as any as any, input); }

  async sendRawAgentChat(
    input: EnterpriseChatSendRawAgentChatInput,
    rawChat: EnterpriseChatRawAgentChatData
  ) { return EnterpriseChatRuntime_sendRawAgentChat_2(this as any as any as any, input, rawChat); }

  async saveSelfProfile(input: EnterpriseChatSaveSelfProfileInput) { return EnterpriseChatRuntime_saveSelfProfile_3(this as any as any as any, input); }

  async selectSelfAvatar() { return EnterpriseChatRuntime_selectSelfAvatar_4(this as any as any as any); }

  async clearSelfAvatar() { return EnterpriseChatRuntime_clearSelfAvatar_5(this as any as any as any); }

  async sendPastedFiles(input: EnterpriseChatSendPastedFilesInput) { return EnterpriseChatRuntime_sendPastedFiles_6(this as any as any as any, input); }

  async sendScreenshot(input: EnterpriseChatSendScreenshotInput) { return EnterpriseChatRuntime_sendScreenshot_7(this as any as any as any, input); }

  async loadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData> { return EnterpriseChatRuntime_loadAttachment_8(this as any as any as any, input); }

  async downloadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult> { return EnterpriseChatRuntime_downloadAttachment_9(this as any as any as any, input); }

  async executeMessageDesktopAction(
    input: EnterpriseChatExecuteActionInput
  ): Promise<EnterpriseChatExecuteActionResult> { return EnterpriseChatRuntime_executeMessageDesktopAction_10(this as any as any as any, input); }

  private handledDesktopActionResult(
    entry?: EnterpriseChatActionLedgerEntry
  ): EnterpriseChatExecuteActionResult { return EnterpriseChatRuntime_handledDesktopActionResult_11(this as any as any as any, entry); }

  private notExecutableDesktopActionResult(
    message = "This Desktop action request is not executable."
  ): EnterpriseChatExecuteActionResult { return EnterpriseChatRuntime_notExecutableDesktopActionResult_12(this as any as any as any, message); }

  private async createRemoteSupportAttachment(request: EnterpriseChatDesktopAction) { return EnterpriseChatRuntime_createRemoteSupportAttachment_13(this as any as any as any, request); }

  private async deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry) { return EnterpriseChatRuntime_deliverDesktopActionReceipt_1(this as any as any as any, entry); }

  private flushDesktopActionReceipts() { return EnterpriseChatRuntime_flushDesktopActionReceipts_2(this as any as any as any); }

  private reconcileDesktopActionMessages(
    messages: EnterpriseChatMessage[],
    conversation?: EnterpriseChatConversation
  ) { return EnterpriseChatRuntime_reconcileDesktopActionMessages_3(this as any as any as any, messages, conversation); }

  private async sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }) { return EnterpriseChatRuntime_sendMessagePayload_4(this as any as any as any, input); }

  private assertMessageSendReady() { return EnterpriseChatRuntime_assertMessageSendReady_5(this as any as any as any); }

  async markRead(input: EnterpriseChatMarkReadInput) { return EnterpriseChatRuntime_markRead_6(this as any as any as any, input); }

  handleSignedOut() { return EnterpriseChatRuntime_handleSignedOut_7(this as any as any as any); }

  stop() { return EnterpriseChatRuntime_stop_8(this as any as any as any); }

  private async ensureSession() { return EnterpriseChatRuntime_ensureSession_9(this as any as any as any); }

  private async uploadFilePath(filePath: string) { return EnterpriseChatRuntime_uploadFilePath_10(this as any as any as any, filePath); }

  private async uploadBlob(blob: Blob, filename: string) { return EnterpriseChatRuntime_uploadBlob_11(this as any as any as any, blob, filename); }

  private async fetchAttachment(fileId: string, maxBytes: number) { return EnterpriseChatRuntime_fetchAttachment_12(this as any as any as any, fileId, maxBytes); }

  private async exchangeSession(identityToken: string): Promise<ServerSession> { return EnterpriseChatRuntime_exchangeSession_13(this as any as any as any, identityToken); }

  private async requestBootstrap(): Promise<ServerBootstrap> { return EnterpriseChatRuntime_requestBootstrap_14(this as any as any as any); }

  private async requestUsers() { return EnterpriseChatRuntime_requestUsers_15(this as any as any as any); }

  private async requestJson<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
    useImSessionToken = true
  ): Promise<T> { return EnterpriseChatRuntime_requestJson_16(this as any as any as any, path, init, useImSessionToken); }

  private async connectWebSocket() { return EnterpriseChatRuntime_connectWebSocket_1(this as any as any as any); }

  private async handleWebSocketMessage(data: unknown) { return EnterpriseChatRuntime_handleWebSocketMessage_2(this as any as any as any, data); }

  private applyMessage(message: EnterpriseChatMessage) { return EnterpriseChatRuntime_applyMessage_3(this as any as any as any, message); }

  private applyPresence(userId: string, online: boolean) { return EnterpriseChatRuntime_applyPresence_4(this as any as any as any, userId, online); }

  private async refreshConversationSummaries() { return EnterpriseChatRuntime_refreshConversationSummaries_5(this as any as any as any); }

  private async refreshEmployeeDirectory() { return EnterpriseChatRuntime_refreshEmployeeDirectory_6(this as any as any as any); }

  private sendWebSocketRequest(type: string, payload: unknown) { return EnterpriseChatRuntime_sendWebSocketRequest_7(this as any as any as any, type, payload); }

  private nextRequestId(prefix: string) { return EnterpriseChatRuntime_nextRequestId_8(this as any as any as any, prefix); }

  private updateSnapshot(patch: Partial<EnterpriseChatSnapshot>) { return EnterpriseChatRuntime_updateSnapshot_9(this as any as any as any, patch); }

  private scheduleReconnect() { return EnterpriseChatRuntime_scheduleReconnect_10(this as any as any as any); }

  private scheduleSessionRefresh() { return EnterpriseChatRuntime_scheduleSessionRefresh_11(this as any as any as any); }

  private disconnect() { return EnterpriseChatRuntime_disconnect_12(this as any as any as any); }

  private clearSession() { return EnterpriseChatRuntime_clearSession_13(this as any as any as any); }

  private rejectPendingRequests(error: Error) { return EnterpriseChatRuntime_rejectPendingRequests_14(this as any as any as any, error); }
}

export const __testInternals = {
  normalizeDesktopAction,
  mergeConversationUsers,
  normalizeConversation,
  normalizeMessage,
  normalizeServerUrl,
  normalizeUser,
  safeRawAgentChatFilename,
  toWebSocketUrl
};

export * from "./runtime.shared";
