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

export type AgentPlatformAssistantBridgePorts = {
  toDesktopPetAgentOptions: (agents: unknown) => DesktopPetAgentOption[];
  resolveAssistantAttachmentPath: (app: App, chatId: string, attachmentId: string) => string;
  resolveAssistantChatFile: (app: App, chatId: string) => string;
  readNavigationAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]>;
  readCopilotAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]>;
};

import { AGENT_PLATFORM_SERVICE_ID, ActiveAssistantRun, AgentPlatformChatExportResult, AgentPlatformImageCompletionRequest, AgentPlatformImageCompletionResult, AgentPlatformImageOperation, AgentPlatformRawChatJSONLResult, ApiResponse, AssistantRunWakeLock, IMAGE_OPERATION_INSTRUCTIONS, ImageGenerateOutcome, MAX_CONVERSATION_MARKDOWN_BYTES, MAX_GENERATED_IMAGE_BYTES, MAX_RAW_CHAT_JSONL_BYTES, PLATFORM_OUTPUT_TEXT_KEYS, PlatformAdminRegistryListResponse, PlatformAgentSummary, PlatformArchiveChatResponse, PlatformChatDetail, PlatformChatSearchResponse, PlatformChatSummary, PlatformRunSummary, PlatformUploadTicket, ResponseBytesTooLargeError, STRUCTURED_PLATFORM_TIME_FIELDS, buildZenmiImageGenerateMessage, chatHasPendingAwaiting, createApiUrl, createChatId, createMessageId, createRunId, dataUrlToBlob, filenameFromContentDisposition, imageGenerateFailureMessage, imageResultRecord, isAssistantRunTerminalEvent, isPendingAwaitingPayload, isPlatformEventType, mapChatSearchResponse, mapChatSearchResult, mapChatSummary, mapHistoryChat, mapRunMessages, normalizeAssistantAccessLevel, normalizeAssistantPermissionMode, normalizeAwaitingPayload, normalizePlatformEvent, nowEpochMillis, observeImageGenerateEvent, readAssistantEventOutputText, readAssistantTextContent, readAwaitingMode, readAwaitingPayloadMode, readChatAgentKey, readChatAwaitingMode, readChatIsRead, readErrorCode, readErrorPayloadText, readErrorText, readFinalAssistantTextFromChatFile, readFinalAssistantTextFromMessages, readNumber, readOptionalPlatformTimestamp, readOutputTextFromRecord, readRequiredPlatformTimestamp, readResponseBytesWithLimit, readString, unwrapApiResponse, validGeneratedImageRelativePath, validateAwaitingPayloadTimes, validatePresentPlatformTimes } from "./bridge.shared";

import { AgentPlatformAssistantBridge_acquireWakeLockForActiveRuns_1, AgentPlatformAssistantBridge_releaseWakeLockIfIdle_2, AgentPlatformAssistantBridge_startRun_3, AgentPlatformAssistantBridge_completeText_4, AgentPlatformAssistantBridge_completeImage_5, AgentPlatformAssistantBridge_stopRun_6, AgentPlatformAssistantBridge_submitAwaiting_7, AgentPlatformAssistantBridge_listAgents_8, AgentPlatformAssistantBridge_listMcpRuntimeStatuses_9, AgentPlatformAssistantBridge_listNavigationAgents_10, AgentPlatformAssistantBridge_listCopilotAgents_11, AgentPlatformAssistantBridge_listChats_12, AgentPlatformAssistantBridge_listHistoryChats_13 } from "./bridge.methods-1";

import { AgentPlatformAssistantBridge_getChat_1, AgentPlatformAssistantBridge_getChatInfo_2, AgentPlatformAssistantBridge_searchChats_3, AgentPlatformAssistantBridge_deleteChat_4, AgentPlatformAssistantBridge_markAgentChatsRead_5, AgentPlatformAssistantBridge_renameChat_6, AgentPlatformAssistantBridge_archiveChat_7, AgentPlatformAssistantBridge_downloadChatExport_8, AgentPlatformAssistantBridge_createChatSnapshotRequest_9, AgentPlatformAssistantBridge_downloadRawChatJSONL_10 } from "./bridge.methods-2";

import { AgentPlatformAssistantBridge_runQuery_1, AgentPlatformAssistantBridge_dispose_2, AgentPlatformAssistantBridge_bestEffortInterrupt_3, AgentPlatformAssistantBridge_readPersistedFinalAssistantMessage_4, AgentPlatformAssistantBridge_uploadAttachments_5, AgentPlatformAssistantBridge_uploadAttachment_6, AgentPlatformAssistantBridge_attachmentToBlob_7, AgentPlatformAssistantBridge_getJson_8, AgentPlatformAssistantBridge_resolvePlatform_9, AgentPlatformAssistantBridge_platformFetch_10, AgentPlatformAssistantBridge_jsonHeaders_11 } from "./bridge.methods-3";

export class AgentPlatformAssistantBridge {
  private readonly activeRuns = new Map<string, ActiveAssistantRun>();
  private readonly realtimeBroker: RealtimeBroker;
  private readonly ownsRealtimeBroker: boolean;
  private disposed = false;

  constructor(private readonly options: {
    app: App;
    onEvent: (event: AssistantEvent) => void;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    getDesktopDeviceId?: (app: App) => string;
    ports: AgentPlatformAssistantBridgePorts;
    wakeLock?: AssistantRunWakeLock;
    realtimeBroker?: RealtimeBroker;
    createWebSocket?: AgentPlatformRealtimeSocketFactory;
    assistantWsConnectTimeoutMs?: number;
    assistantWsAcceptanceTimeoutMs?: number;
  }) {
    this.ownsRealtimeBroker = !options.realtimeBroker;
    this.realtimeBroker = options.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      getDesktopDeviceId: options.getDesktopDeviceId ?? (() => "desktop-main"),
      createWebSocket: options.createWebSocket,
      connectTimeoutMs: options.assistantWsConnectTimeoutMs,
      acceptanceTimeoutMs: options.assistantWsAcceptanceTimeoutMs,
    });
  }

  private acquireWakeLockForActiveRuns() { return AgentPlatformAssistantBridge_acquireWakeLockForActiveRuns_1(this); }

  private releaseWakeLockIfIdle() { return AgentPlatformAssistantBridge_releaseWakeLockIfIdle_2(this); }

  async startRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> { return AgentPlatformAssistantBridge_startRun_3(this, request); }

  async completeText(
    request: AssistantStartRunRequest,
    onRawEvent?: (event: Record<string, unknown>) => boolean | void,
    strictAttachments = false
  ): Promise<AssistantTextCompletionResult> { return AgentPlatformAssistantBridge_completeText_4(this, request, onRawEvent, strictAttachments); }

  async completeImage(request: AgentPlatformImageCompletionRequest): Promise<AgentPlatformImageCompletionResult> { return AgentPlatformAssistantBridge_completeImage_5(this, request); }

  async stopRun(runId: string): Promise<AssistantStopRunResult> { return AgentPlatformAssistantBridge_stopRun_6(this, runId); }

  async submitAwaiting(request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> { return AgentPlatformAssistantBridge_submitAwaiting_7(this, request); }

  async listAgents(): Promise<DesktopPetAgentOption[]> { return AgentPlatformAssistantBridge_listAgents_8(this); }

  async listMcpRuntimeStatuses() { return AgentPlatformAssistantBridge_listMcpRuntimeStatuses_9(this); }

  async listNavigationAgents(): Promise<AssistantNavAgentItemsResult> { return AgentPlatformAssistantBridge_listNavigationAgents_10(this); }

  async listCopilotAgents(): Promise<AssistantNavAgentItemsResult> { return AgentPlatformAssistantBridge_listCopilotAgents_11(this); }

  async listChats(): Promise<AssistantChatSummary[]> { return AgentPlatformAssistantBridge_listChats_12(this); }

  async listHistoryChats(): Promise<AssistantHistoryChatsResult> { return AgentPlatformAssistantBridge_listHistoryChats_13(this); }

  async getChat(chatId: string): Promise<AssistantChatDetail | null> { return AgentPlatformAssistantBridge_getChat_1(this, chatId); }

  async getChatInfo(chatId: string): Promise<AssistantChatInfo | null> { return AgentPlatformAssistantBridge_getChatInfo_2(this, chatId); }

  async searchChats(request: AssistantChatSearchRequest): Promise<AssistantChatSearchResponse> { return AgentPlatformAssistantBridge_searchChats_3(this, request); }

  async deleteChat(chatId: string) { return AgentPlatformAssistantBridge_deleteChat_4(this, chatId); }

  async markAgentChatsRead(agentKey: string) { return AgentPlatformAssistantBridge_markAgentChatsRead_5(this, agentKey); }

  async renameChat(chatId: string, chatName: string) { return AgentPlatformAssistantBridge_renameChat_6(this, chatId, chatName); }

  async archiveChat(chatId: string) { return AgentPlatformAssistantBridge_archiveChat_7(this, chatId); }

  async downloadChatExport(chatId: string): Promise<AgentPlatformChatExportResult> { return AgentPlatformAssistantBridge_downloadChatExport_8(this, chatId); }

  async createChatSnapshotRequest(chatId: string): Promise<
    | { ok: true; snapshotUrl: string; bearerToken: string }
    | { ok: false; message: string }
  > { return AgentPlatformAssistantBridge_createChatSnapshotRequest_9(this, chatId); }

  async downloadRawChatJSONL(chatId: string): Promise<AgentPlatformRawChatJSONLResult> { return AgentPlatformAssistantBridge_downloadRawChatJSONL_10(this, chatId); }

  private async runQuery(
    baseUrl: string,
    token: string,
    request: AssistantStartRunRequest,
    run: {
      chatId: string;
      runId: string;
      activeRun: ActiveAssistantRun;
      onAcceptance?: (result: AssistantStartRunResult) => void;
      onRawEvent?: (event: Record<string, unknown>) => boolean | void;
      strictAttachments?: boolean;
    }
  ): Promise<AssistantTextCompletionResult> { return AgentPlatformAssistantBridge_runQuery_1(this, baseUrl, token, request, run); }

  dispose() { return AgentPlatformAssistantBridge_dispose_2(this); }

  private bestEffortInterrupt(runId: string, activeRun: ActiveAssistantRun, message: string) { return AgentPlatformAssistantBridge_bestEffortInterrupt_3(this, runId, activeRun, message); }

  private async readPersistedFinalAssistantMessage(chatId: string, runId: string): Promise<string> { return AgentPlatformAssistantBridge_readPersistedFinalAssistantMessage_4(this, chatId, runId); }

  private async uploadAttachments(
    baseUrl: string,
    token: string,
    chatId: string,
    runId: string,
    attachments: AssistantAttachment[],
    strict = false
  ) { return AgentPlatformAssistantBridge_uploadAttachments_5(this, baseUrl, token, chatId, runId, attachments, strict); }

  private async uploadAttachment(baseUrl: string, token: string, chatId: string, runId: string, attachment: AssistantAttachment) { return AgentPlatformAssistantBridge_uploadAttachment_6(this, baseUrl, token, chatId, runId, attachment); }

  private async attachmentToBlob(chatId: string, attachment: AssistantAttachment) { return AgentPlatformAssistantBridge_attachmentToBlob_7(this, chatId, attachment); }

  private async getJson<T>(
    pathOrUrl: string,
    options: { allowNotFound?: boolean; fallbackWhenUnavailable?: T } = {}
  ): Promise<T> { return AgentPlatformAssistantBridge_getJson_8(this, pathOrUrl, options); }

  private async resolvePlatform(): Promise<
    { ok: true; baseUrl: string; token: string } | { ok: false; message: string }
  > { return AgentPlatformAssistantBridge_resolvePlatform_9(this); }

  private platformFetch(baseUrl: string, pathname: string, init: RequestInit) { return AgentPlatformAssistantBridge_platformFetch_10(this, baseUrl, pathname, init); }

  private jsonHeaders(token: string, extra: Record<string, string> = {}) { return AgentPlatformAssistantBridge_jsonHeaders_11(this, token, extra); }

}

export * from "./bridge.shared";
