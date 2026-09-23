import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AssistantChatDetail,
  AssistantChatInfo,
  AssistantChatSearchRequest,
  AssistantChatSearchResponse,
  AssistantChatSummary,
  AssistantEvent,
  AssistantHistoryChatsResult,
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AssistantStopRunResult,
  AssistantSubmitAwaitingRequest,
  AssistantSubmitAwaitingResult,
  AssistantTextCompletionResult,
  DesktopPetAgentOption,
  ServiceId,
  ServiceState
} from "../../../shared/contracts";
import { AgentDirectory } from "./agent-directory";
import { AttachmentUploader } from "./attachment-upload";
import {
  AgentPlatformChatExportResult,
  AgentPlatformImageCompletionRequest,
  AgentPlatformImageCompletionResult,
  AgentPlatformRawChatJSONLResult,
  AssistantRunWakeLock
} from "./bridge-contracts";
import { ChatClient } from "./chat-client";
import { ChatExportClient } from "./chat-export";
import { ImageCompletion } from "./completion";
import { PlatformClient } from "./platform-client";
import type { AgentPlatformRealtimeSocketFactory } from "./realtime/agent-platform-realtime-client";
import { RealtimeBroker } from "./realtime/realtime-broker";
import { AssistantRunController } from "./run-controller";

export type AgentPlatformAssistantBridgePorts = {
  toDesktopPetAgentOptions: (agents: unknown) => DesktopPetAgentOption[];
  resolveAssistantAttachmentPath: (app: App, chatId: string, attachmentId: string) => string;
  resolveAssistantChatFile: (app: App, chatId: string) => string;
  readNavigationAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]>;
  readCopilotAgents: (baseUrl: string, token: string) => Promise<AssistantNavAgentItem[]>;
};

export class AgentPlatformAssistantBridge {
  private readonly realtimeBroker: RealtimeBroker;
  private readonly ownsRealtimeBroker: boolean;
  private readonly platform: PlatformClient;
  private readonly runs: AssistantRunController;
  private readonly directory: AgentDirectory;
  private readonly chats: ChatClient;
  private readonly exports: ChatExportClient;
  private readonly completion: ImageCompletion;

  constructor(options: {
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
    this.platform = new PlatformClient(options);
    const attachments = new AttachmentUploader(this.platform, (chatId, attachmentId) => options.ports.resolveAssistantAttachmentPath(options.app, chatId, attachmentId));
    this.runs = new AssistantRunController(this.platform, this.realtimeBroker, this.ownsRealtimeBroker, attachments, { onEvent: options.onEvent, wakeLock: options.wakeLock, resolveChatFile: (chatId) => options.ports.resolveAssistantChatFile(options.app, chatId) });
    this.directory = new AgentDirectory(this.platform, options.ports);
    this.chats = new ChatClient(this.platform);
    this.exports = new ChatExportClient(this.platform);
    this.completion = new ImageCompletion(this.platform, (request, onRawEvent, strictAttachments) => this.runs.completeText(request, onRawEvent, strictAttachments));
  }

  async startRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> { return this.runs.startRun(request); }

  async completeText(
    request: AssistantStartRunRequest,
    onRawEvent?: (event: Record<string, unknown>) => boolean | void,
    strictAttachments = false
  ): Promise<AssistantTextCompletionResult> { return this.runs.completeText(request, onRawEvent, strictAttachments); }

  async completeImage(request: AgentPlatformImageCompletionRequest): Promise<AgentPlatformImageCompletionResult> { return this.completion.completeImage(request); }

  async observeRun(input: Omit<Parameters<RealtimeBroker["subscribeRun"]>[0], "baseUrl" | "token" | "kind" | "role">) {
    const available = await this.platform.resolvePlatform();
    if (!available.ok) throw new Error("Agent Platform is unavailable");
    return this.realtimeBroker.subscribeRun({ ...input, baseUrl: available.baseUrl, token: available.token, kind: "internal", role: "internal" });
  }

  async stopRun(runId: string): Promise<AssistantStopRunResult> { return this.runs.stopRun(runId); }

  async submitAwaiting(request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> { return this.runs.submitAwaiting(request); }

  async listAgents(): Promise<DesktopPetAgentOption[]> { return this.directory.listAgents(); }

  async listMcpRuntimeStatuses() { return this.directory.listMcpRuntimeStatuses(); }

  async listNavigationAgents(): Promise<AssistantNavAgentItemsResult> { return this.directory.listNavigationAgents(); }

  async listCopilotAgents(): Promise<AssistantNavAgentItemsResult> { return this.directory.listCopilotAgents(); }

  async listChats(): Promise<AssistantChatSummary[]> { return this.chats.listChats(); }

  async listHistoryChats(): Promise<AssistantHistoryChatsResult> { return this.chats.listHistoryChats(); }

  async getChat(chatId: string): Promise<AssistantChatDetail | null> { return this.chats.getChat(chatId); }

  async getChatInfo(chatId: string): Promise<AssistantChatInfo | null> { return this.chats.getChatInfo(chatId); }

  async searchChats(request: AssistantChatSearchRequest): Promise<AssistantChatSearchResponse> { return this.chats.searchChats(request); }

  async deleteChat(chatId: string) { return this.chats.deleteChat(chatId); }

  async markChatRead(chatId: string, runId?: string | null) { return this.chats.markChatRead(chatId, runId); }
  async markAgentChatsRead(agentKey: string) { return this.chats.markAgentChatsRead(agentKey); }

  async renameChat(chatId: string, chatName: string) { return this.chats.renameChat(chatId, chatName); }

  async archiveChat(chatId: string) { return this.chats.archiveChat(chatId); }

  async downloadChatExport(chatId: string): Promise<AgentPlatformChatExportResult> { return this.exports.downloadChatExport(chatId); }

  async createChatSnapshotRequest(chatId: string): Promise<
    | { ok: true; snapshotUrl: string; bearerToken: string }
    | { ok: false; message: string }
  > { return this.exports.createChatSnapshotRequest(chatId); }

  async downloadRawChatJSONL(chatId: string): Promise<AgentPlatformRawChatJSONLResult> { return this.exports.downloadRawChatJSONL(chatId); }

  dispose() { return this.runs.dispose(); }

}

export * from "./bridge.shared";
