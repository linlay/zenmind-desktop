import type { App } from "electron";
import type {
  EnterpriseChatAttachmentData,
  EnterpriseChatAttachmentInput,
  EnterpriseChatConversation,
  EnterpriseChatCreateGroupInput,
  EnterpriseChatDesktopAction,
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
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import { getDesktopDeviceInfo, getDesktopSsoAccessToken } from "../identity";
import {
  EnterpriseChatActionLedger,
  type EnterpriseChatActionLedgerEntry
} from "./action-ledger";
import * as actionReceipts from "./action-receipts";
import { EnterpriseChatRawAgentChatData, safeRawAgentChatFilename } from "./attachment-policy";
import * as attachmentService from "./attachment-service";
import { FetchLike, PendingWebSocketRequest, ServerSession, WebSocketLike, createDefaultWebSocket, normalizeServerUrl, toWebSocketUrl } from "./connection-transport";
import * as conversationService from "./conversation-service";
import * as desktopActionController from "./desktop-action-controller";
import * as profileController from "./local-profile";
import { ServerBootstrap, mergeConversationUsers, normalizeConversation, normalizeDesktopAction, normalizeMessage, normalizeUser } from "./message-projection";
import { nowEpochMilliseconds } from "./protocol-values";
import * as realtimeConnection from "./realtime-connection";
import { EnterpriseChatRuntimeOptions } from "./runtime-options";
import * as sessionController from "./session-controller";
import {
  DEFAULT_ENTERPRISE_IM_BASE_URL
} from "./settings";
import * as snapshotProjection from "./snapshot-projection";
import { createEnterpriseChatSupportBundle } from "./support-bundle";

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
    const initialEnabled = options.initialEnabled === true && Boolean(this.serverUrl);
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

  getState() { return snapshotProjection.getState(this.snapshotProjectionDependencies); }

  private currentDesktopActionScope() { return desktopActionController.currentDesktopActionScope(this.desktopActionControllerDependencies); }

  private getDesktopActionLedger() { return desktopActionController.getDesktopActionLedger(this.desktopActionControllerDependencies); }

  private desktopActionState(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ) { return desktopActionController.desktopActionState(this.desktopActionControllerDependencies, message, conversation); }

  private projectMessage(
    message: EnterpriseChatMessage,
    conversation?: EnterpriseChatConversation
  ): EnterpriseChatMessage { return snapshotProjection.projectMessage(this.snapshotProjectionDependencies, message, conversation); }

  async setEnabled(enabled: boolean) { return sessionController.setEnabled(this.sessionControllerDependencies, enabled); }

  async refresh() { return sessionController.refresh(this.sessionControllerDependencies); }

  async reloadConfiguration(enabled: boolean) { return sessionController.reloadConfiguration(this.sessionControllerDependencies, enabled); }

  private async performRefresh() { return sessionController.performRefresh(this.sessionControllerDependencies); }

  private updateServerUrl() { return sessionController.updateServerUrl(this.sessionControllerDependencies); }

  async openDirectConversation(input: EnterpriseChatOpenDirectInput) { return conversationService.openDirectConversation(this.conversationServiceDependencies, input); }

  async openConversation(input: EnterpriseChatOpenConversationInput) { return conversationService.openConversation(this.conversationServiceDependencies, input); }

  async createGroup(input: EnterpriseChatCreateGroupInput) { return conversationService.createGroup(this.conversationServiceDependencies, input); }

  async sendMessage(input: EnterpriseChatSendMessageInput) { return conversationService.sendMessage(this.conversationServiceDependencies, input); }

  async sendFiles(input: EnterpriseChatSendFilesInput) { return attachmentService.sendFiles(this.attachmentServiceDependencies, input); }

  async sendSupportBundle(input: EnterpriseChatSendSupportBundleInput) { return attachmentService.sendSupportBundle(this.attachmentServiceDependencies, input); }

  async sendRawAgentChat(
    input: EnterpriseChatSendRawAgentChatInput,
    rawChat: EnterpriseChatRawAgentChatData
  ) { return attachmentService.sendRawAgentChat(this.attachmentServiceDependencies, input, rawChat); }

  async saveSelfProfile(input: EnterpriseChatSaveSelfProfileInput) { return profileController.saveSelfProfile(this.profileControllerDependencies, input); }

  async selectSelfAvatar() { return profileController.selectSelfAvatar(this.profileControllerDependencies); }

  async clearSelfAvatar() { return profileController.clearSelfAvatar(this.profileControllerDependencies); }

  async sendPastedFiles(input: EnterpriseChatSendPastedFilesInput) { return attachmentService.sendPastedFiles(this.attachmentServiceDependencies, input); }

  async sendScreenshot(input: EnterpriseChatSendScreenshotInput) { return attachmentService.sendScreenshot(this.attachmentServiceDependencies, input); }

  async loadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData> { return attachmentService.loadAttachment(this.attachmentServiceDependencies, input); }

  async downloadAttachment(input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult> { return attachmentService.downloadAttachment(this.attachmentServiceDependencies, input); }

  async executeMessageDesktopAction(
    input: EnterpriseChatExecuteActionInput
  ): Promise<EnterpriseChatExecuteActionResult> { return desktopActionController.executeMessageDesktopAction(this.desktopActionControllerDependencies, input); }

  private handledDesktopActionResult(
    entry?: EnterpriseChatActionLedgerEntry
  ): EnterpriseChatExecuteActionResult { return desktopActionController.handledDesktopActionResult(this.desktopActionControllerDependencies, entry); }

  private notExecutableDesktopActionResult(
    message = "This Desktop action request is not executable."
  ): EnterpriseChatExecuteActionResult { return desktopActionController.notExecutableDesktopActionResult(this.desktopActionControllerDependencies, message); }

  private async createRemoteSupportAttachment(request: EnterpriseChatDesktopAction) { return attachmentService.createRemoteSupportAttachment(this.attachmentServiceDependencies, request); }

  private async deliverDesktopActionReceipt(entry: EnterpriseChatActionLedgerEntry) { return actionReceipts.deliverDesktopActionReceipt(this.actionReceiptsDependencies, entry); }

  private flushDesktopActionReceipts() { return actionReceipts.flushDesktopActionReceipts(this.actionReceiptsDependencies); }

  private reconcileDesktopActionMessages(
    messages: EnterpriseChatMessage[],
    conversation?: EnterpriseChatConversation
  ) { return desktopActionController.reconcileDesktopActionMessages(this.desktopActionControllerDependencies, messages, conversation); }

  private async sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }) { return conversationService.sendMessagePayload(this.conversationServiceDependencies, input); }

  private assertMessageSendReady() { return conversationService.assertMessageSendReady(this.conversationServiceDependencies); }

  async markRead(input: EnterpriseChatMarkReadInput) { return conversationService.markRead(this.conversationServiceDependencies, input); }

  handleSignedOut() { return sessionController.handleSignedOut(this.sessionControllerDependencies); }

  stop() { return sessionController.stop(this.sessionControllerDependencies); }

  private async ensureSession() { return sessionController.ensureSession(this.sessionControllerDependencies); }

  private async uploadFilePath(filePath: string) { return attachmentService.uploadFilePath(this.attachmentServiceDependencies, filePath); }

  private async uploadBlob(blob: Blob, filename: string) { return attachmentService.uploadBlob(this.attachmentServiceDependencies, blob, filename); }

  private async fetchAttachment(fileId: string, maxBytes: number) { return attachmentService.fetchAttachment(this.attachmentServiceDependencies, fileId, maxBytes); }

  private async exchangeSession(identityToken: string): Promise<ServerSession> { return sessionController.exchangeSession(this.sessionControllerDependencies, identityToken); }

  private async requestBootstrap(): Promise<ServerBootstrap> { return sessionController.requestBootstrap(this.sessionControllerDependencies); }

  private async requestUsers() { return sessionController.requestUsers(this.sessionControllerDependencies); }

  private async requestJson<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
    useImSessionToken = true
  ): Promise<T> { return sessionController.requestJson(this.sessionControllerDependencies, path, init, useImSessionToken); }

  private async connectWebSocket() { return realtimeConnection.connectWebSocket(this.realtimeConnectionDependencies); }

  private async handleWebSocketMessage(data: unknown) { return realtimeConnection.handleWebSocketMessage(this.realtimeConnectionDependencies, data); }

  private applyMessage(message: EnterpriseChatMessage) { return snapshotProjection.applyMessage(this.snapshotProjectionDependencies, message); }

  private applyPresence(userId: string, online: boolean) { return snapshotProjection.applyPresence(this.snapshotProjectionDependencies, userId, online); }

  private async refreshConversationSummaries() { return conversationService.refreshConversationSummaries(this.conversationServiceDependencies); }

  private async refreshEmployeeDirectory() { return conversationService.refreshEmployeeDirectory(this.conversationServiceDependencies); }

  private sendWebSocketRequest(type: string, payload: unknown) { return realtimeConnection.sendWebSocketRequest(this.realtimeConnectionDependencies, type, payload); }

  private nextRequestId(prefix: string) { return realtimeConnection.nextRequestId(this.realtimeConnectionDependencies, prefix); }

  private updateSnapshot(patch: Partial<EnterpriseChatSnapshot>) { return snapshotProjection.updateSnapshot(this.snapshotProjectionDependencies, patch); }

  private scheduleReconnect() { return realtimeConnection.scheduleReconnect(this.realtimeConnectionDependencies); }

  private scheduleSessionRefresh() { return sessionController.scheduleSessionRefresh(this.sessionControllerDependencies); }

  private disconnect() { return realtimeConnection.disconnect(this.realtimeConnectionDependencies); }

  private clearSession() { return sessionController.clearSession(this.sessionControllerDependencies); }

  private rejectPendingRequests(error: Error) { return realtimeConnection.rejectPendingRequests(this.realtimeConnectionDependencies, error); }

  // Read live state across awaits and callbacks; each service receives only its declared port.
  private get sessionControllerDependencies(): sessionController.SessionControllerDependencies {
    const runtime = this;
    return {
      get serverUrl() { return runtime.serverUrl; },
      set serverUrl(value) { runtime.serverUrl = value; },
      disconnect: this.disconnect.bind(this),
      clearSession: this.clearSession.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this),
      getState: this.getState.bind(this),
      get snapshot() { return runtime.snapshot; },
      get getIdentityToken() { return runtime.getIdentityToken; },
      get socket() { return runtime.socket; },
      refresh: this.refresh.bind(this),
      get refreshPromise() { return runtime.refreshPromise; },
      set refreshPromise(value) { runtime.refreshPromise = value; },
      performRefresh: this.performRefresh.bind(this),
      get getServerUrl() { return runtime.getServerUrl; },
      setEnabled: this.setEnabled.bind(this),
      updateServerUrl: this.updateServerUrl.bind(this),
      exchangeSession: this.exchangeSession.bind(this),
      get refreshIdentityToken() { return runtime.refreshIdentityToken; },
      get imSessionToken() { return runtime.imSessionToken; },
      set imSessionToken(value) { runtime.imSessionToken = value; },
      get imSessionTokenExpiresAt() { return runtime.imSessionTokenExpiresAt; },
      set imSessionTokenExpiresAt(value) { runtime.imSessionTokenExpiresAt = value; },
      scheduleSessionRefresh: this.scheduleSessionRefresh.bind(this),
      requestBootstrap: this.requestBootstrap.bind(this),
      requestUsers: this.requestUsers.bind(this),
      get app() { return runtime.app; },
      get platform() { return runtime.platform; },
      currentDesktopActionScope: this.currentDesktopActionScope.bind(this),
      get recoveredDesktopActionScopes() { return runtime.recoveredDesktopActionScopes; },
      getDesktopActionLedger: this.getDesktopActionLedger.bind(this),
      connectWebSocket: this.connectWebSocket.bind(this),
      get getDeviceInfo() { return runtime.getDeviceInfo; },
      requestJson: this.requestJson.bind(this),
      get fetchImpl() { return runtime.fetchImpl; },
      get sessionRefreshTimer() { return runtime.sessionRefreshTimer; },
      set sessionRefreshTimer(value) { runtime.sessionRefreshTimer = value; }
    };
  }

  private get realtimeConnectionDependencies(): realtimeConnection.RealtimeConnectionDependencies {
    const runtime = this;
    return {
      get snapshot() { return runtime.snapshot; },
      get imSessionToken() { return runtime.imSessionToken; },
      requestJson: this.requestJson.bind(this),
      get createWebSocket() { return runtime.createWebSocket; },
      get serverUrl() { return runtime.serverUrl; },
      get socket() { return runtime.socket; },
      set socket(value) { runtime.socket = value; },
      get socketSynced() { return runtime.socketSynced; },
      set socketSynced(value) { runtime.socketSynced = value; },
      get socketClosing() { return runtime.socketClosing; },
      set socketClosing(value) { runtime.socketClosing = value; },
      sendWebSocketRequest: this.sendWebSocketRequest.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this),
      handleWebSocketMessage: this.handleWebSocketMessage.bind(this),
      rejectPendingRequests: this.rejectPendingRequests.bind(this),
      get getIdentityToken() { return runtime.getIdentityToken; },
      scheduleReconnect: this.scheduleReconnect.bind(this),
      get pendingRequests() { return runtime.pendingRequests; },
      get reconnectAttempt() { return runtime.reconnectAttempt; },
      set reconnectAttempt(value) { runtime.reconnectAttempt = value; },
      get platform() { return runtime.platform; },
      get app() { return runtime.app; },
      refreshEmployeeDirectory: this.refreshEmployeeDirectory.bind(this),
      flushDesktopActionReceipts: this.flushDesktopActionReceipts.bind(this),
      refresh: this.refresh.bind(this),
      applyPresence: this.applyPresence.bind(this),
      applyMessage: this.applyMessage.bind(this),
      refreshConversationSummaries: this.refreshConversationSummaries.bind(this),
      nextRequestId: this.nextRequestId.bind(this),
      get requestSequence() { return runtime.requestSequence; },
      set requestSequence(value) { runtime.requestSequence = value; },
      get reconnectTimer() { return runtime.reconnectTimer; },
      set reconnectTimer(value) { runtime.reconnectTimer = value; }
    };
  }

  private get conversationServiceDependencies(): conversationService.ConversationServiceDependencies {
    const runtime = this;
    return {
      get snapshot() { return runtime.snapshot; },
      ensureSession: this.ensureSession.bind(this),
      requestJson: this.requestJson.bind(this),
      openConversation: this.openConversation.bind(this),
      reconcileDesktopActionMessages: this.reconcileDesktopActionMessages.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this),
      flushDesktopActionReceipts: this.flushDesktopActionReceipts.bind(this),
      markRead: this.markRead.bind(this),
      getState: this.getState.bind(this),
      sendMessagePayload: this.sendMessagePayload.bind(this),
      assertMessageSendReady: this.assertMessageSendReady.bind(this),
      sendWebSocketRequest: this.sendWebSocketRequest.bind(this),
      applyMessage: this.applyMessage.bind(this),
      get socket() { return runtime.socket; },
      get socketSynced() { return runtime.socketSynced; },
      get presenceRevision() { return runtime.presenceRevision; },
      requestUsers: this.requestUsers.bind(this)
    };
  }

  private get attachmentServiceDependencies(): attachmentService.AttachmentServiceDependencies {
    const runtime = this;
    return {
      get selectFiles() { return runtime.selectFiles; },
      getState: this.getState.bind(this),
      ensureSession: this.ensureSession.bind(this),
      assertMessageSendReady: this.assertMessageSendReady.bind(this),
      uploadFilePath: this.uploadFilePath.bind(this),
      sendMessagePayload: this.sendMessagePayload.bind(this),
      get createSupportBundle() { return runtime.createSupportBundle; },
      uploadBlob: this.uploadBlob.bind(this),
      get platform() { return runtime.platform; },
      get captureScreenshot() { return runtime.captureScreenshot; },
      fetchAttachment: this.fetchAttachment.bind(this),
      get showSaveDialog() { return runtime.showSaveDialog; },
      get app() { return runtime.app; },
      requestJson: this.requestJson.bind(this),
      get fetchImpl() { return runtime.fetchImpl; },
      get serverUrl() { return runtime.serverUrl; },
      get imSessionToken() { return runtime.imSessionToken; },
      get createSupportArtifact() { return runtime.createSupportArtifact; }
    };
  }

  private get profileControllerDependencies(): profileController.ProfileControllerDependencies {
    const runtime = this;
    return {
      get snapshot() { return runtime.snapshot; },
      get app() { return runtime.app; },
      get platform() { return runtime.platform; },
      get serverUrl() { return runtime.serverUrl; },
      updateSnapshot: this.updateSnapshot.bind(this),
      getState: this.getState.bind(this),
      get selectAvatar() { return runtime.selectAvatar; }
    };
  }

  private get snapshotProjectionDependencies(): snapshotProjection.SnapshotProjectionDependencies {
    const runtime = this;
    return {
      get snapshot() { return runtime.snapshot; },
      set snapshot(value) { runtime.snapshot = value; },
      projectMessage: this.projectMessage.bind(this),
      desktopActionState: this.desktopActionState.bind(this),
      reconcileDesktopActionMessages: this.reconcileDesktopActionMessages.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this),
      get presenceRevision() { return runtime.presenceRevision; },
      set presenceRevision(value) { runtime.presenceRevision = value; },
      get onStateChanged() { return runtime.onStateChanged; },
      getState: this.getState.bind(this)
    };
  }

  private get desktopActionControllerDependencies(): desktopActionController.DesktopActionControllerDependencies {
    const runtime = this;
    return {
      get snapshot() { return runtime.snapshot; },
      get getDeviceInfo() { return runtime.getDeviceInfo; },
      get serverUrl() { return runtime.serverUrl; },
      get app() { return runtime.app; },
      get desktopActionLedgerPath() { return runtime.desktopActionLedgerPath; },
      set desktopActionLedgerPath(value) { runtime.desktopActionLedgerPath = value; },
      get desktopActionLedger() { return runtime.desktopActionLedger; },
      set desktopActionLedger(value) { runtime.desktopActionLedger = value; },
      getDesktopActionLedger: this.getDesktopActionLedger.bind(this),
      currentDesktopActionScope: this.currentDesktopActionScope.bind(this),
      handledDesktopActionResult: this.handledDesktopActionResult.bind(this),
      desktopActionState: this.desktopActionState.bind(this),
      notExecutableDesktopActionResult: this.notExecutableDesktopActionResult.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this),
      createRemoteSupportAttachment: this.createRemoteSupportAttachment.bind(this),
      get executeDesktopAction() { return runtime.executeDesktopAction; },
      deliverDesktopActionReceipt: this.deliverDesktopActionReceipt.bind(this)
    };
  }

  private get actionReceiptsDependencies(): actionReceipts.ActionReceiptsDependencies {
    const runtime = this;
    return {
      get socket() { return runtime.socket; },
      get socketSynced() { return runtime.socketSynced; },
      sendMessagePayload: this.sendMessagePayload.bind(this),
      getDesktopActionLedger: this.getDesktopActionLedger.bind(this),
      get actionReceiptFlushPromise() { return runtime.actionReceiptFlushPromise; },
      set actionReceiptFlushPromise(value) { runtime.actionReceiptFlushPromise = value; },
      currentDesktopActionScope: this.currentDesktopActionScope.bind(this),
      deliverDesktopActionReceipt: this.deliverDesktopActionReceipt.bind(this),
      updateSnapshot: this.updateSnapshot.bind(this)
    };
  }
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

export * from "./attachment-policy";
export * from "./connection-transport";
export * from "./message-projection";
export * from "./protocol-values";
export * from "./runtime-options";
