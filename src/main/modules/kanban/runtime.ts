import fs from "node:fs";

import path from "node:path";

import { randomUUID } from "node:crypto";

import yaml from "js-yaml";

import type { App } from "electron";

import type {
  AssistantNavigationPushEvent,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanCloudConfig,
  KanbanCloudConfigResult,
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanProject,
  KanbanRunState,
  KanbanRunIssueInput,
  KanbanRunIssueResult,
  KanbanSettings,
  KanbanSettingsInput,
  KanbanSettingsResult,
  KanbanStatus
} from "../../../shared/contracts";

import { parseKanbanPriority } from "../../../shared/contracts";

import { PRODUCT_NAME } from "../../../shared/brand";

import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";

import { getDesktopDeviceInfo } from "../identity";

import { getDesktopDeviceId } from "../identity";

import { readDesktopSsoAccessToken, readDesktopSsoAccessTokenUser } from "../identity";

import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

import {
  applyDesktopKanbanCloudSnapshot,
  completeDesktopKanbanCommandReceiptByRunId,
  createLocalDesktopKanbanIssue,
  deleteDesktopKanbanCloudMutation,
  deleteDesktopKanbanRunEvent,
  deleteDesktopKanbanIssue,
  ensureDesktopKanbanDefaultBinding,
  getDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanIssue,
  getDesktopKanbanManualRunByRunId,
  hasDesktopKanbanCloudProject,
  listPendingDesktopKanbanManualRuns,
  listPendingDesktopKanbanCommandReceipts,
  listDesktopKanbanCloudMutations,
  listDesktopKanbanRunEvents,
  markDesktopKanbanCommandReceiptReported,
  markDesktopKanbanCloudMutationAttempt,
  markDesktopKanbanRunEventAttempt,
  listDesktopKanbanIssues,
  moveDesktopKanbanIssue,
  readDesktopKanbanSyncCursor,
  recordDesktopKanbanCommandReceipt,
  recordDesktopKanbanCloudMutation,
  recordDesktopKanbanManualRun,
  recordDesktopKanbanRunEvent,
  tombstoneDesktopKanbanCloudIssue,
  updateDesktopKanbanIssue,
  updateDesktopKanbanCommandReceipt,
  updateDesktopKanbanCommandReceiptIdentity,
  updateDesktopKanbanManualRun,
  updateDesktopKanbanIssueRuntimeState,
  upsertDispatchedDesktopKanbanIssue,
  writeDesktopKanbanSyncCursor,
  type KanbanCloudSnapshot,
  type KanbanCommandReceipt
} from "./local-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  convertLocalProjectIssuesToLocal,
  createLocalDesktopProject,
  findLocalDesktopProject
} from "./local-projects";

import {
  KanbanDesktopWsClient,
  KanbanDesktopRequestError,
  type KanbanDesktopDelivery,
  type KanbanDesktopDeliveryApplyResult,
  type KanbanDesktopConnectionState,
  type KanbanDesktopIssueEvent,
  type KanbanDesktopIssueEventApplyResult,
  type KanbanDesktopSyncLocalProject,
  type KanbanDesktopWsConfig
} from "./ws-client";

import { t } from "../../support/i18n/main-i18n";

import { appendKanbanWsLog } from "../../support/logging/desktop";

import { ASSISTANT_AGENT_LIST_TIMEOUT_MS, AgentPlatformCaller, AssistantBridgeLike, DEFAULT_SELECTED_PROJECT_ID, KANBAN_CONFIG_FILE, KanbanConnectionFallbackState, KanbanDesktopConfigFile, KanbanRunFinishedPushResolution, KanbanRuntimeOptions, REMOTE_START_RUN_ACK_TIMEOUT_MS, buildKanbanAutomationMessage, buildKanbanAutomationPayload, deliveryIssueId, deliveryIssuePayload, deliveryPayloadRecord, deliverySourceRevision, getKanbanConfigPath, getKanbanDeviceInfo, getRemoteIssueId, hasKanbanCloudFields, hasLegacyKanbanSelectedProjectId, hasLegacyKanbanToken, isKanbanCloudConfigComplete, isRecord, issueEventIssueId, issueEventIssuePayload, issueSyncMode, kanbanIssueFromAutomationPayload, normalizeKanbanCloudConfig, normalizeKanbanSettings, normalizeRemoteAccessLevel, nullableText, optionalText, parseStructuredReviewText, readBoolean, readDueDate, readEffortSeconds, readInstalledAgentOptions, readJsonConfigFile, readKanbanCloudConfig, readKanbanOwnerConfig, readKanbanSettings, readKanbanWsConfig, readPositiveIntegerEnv, readStringList, readText, resolveKanbanRunFinishedPush, resolveKanbanWsConnection, saveKanbanSettings, stableClientEventId, writeKanbanCloudConfig, writeKanbanSettings } from "./runtime.shared";

import { KanbanRuntime_start_1, KanbanRuntime_stop_2, KanbanRuntime_refreshDeviceInfo_3, KanbanRuntime_listIssues_4, KanbanRuntime_getCloudConfig_5, KanbanRuntime_getSettings_6, KanbanRuntime_resyncCloudBoard_7, KanbanRuntime_listLocalProjects_8, KanbanRuntime_listSyncLocalProjects_9, KanbanRuntime_saveCloudConfig_10, KanbanRuntime_saveSettings_11, KanbanRuntime_createIssue_12, KanbanRuntime_updateIssue_13, KanbanRuntime_moveIssue_14, KanbanRuntime_deleteIssueWithAutomation_15, KanbanRuntime_syncIssueAutomation_16, KanbanRuntime_claimIssue_17, KanbanRuntime_runIssue_18, KanbanRuntime_bindHumanReferenceChat_19, KanbanRuntime_unbindHumanReferenceChat_20 } from "./runtime.methods-1";

import { KanbanRuntime_sendCloudMutation_1, KanbanRuntime_flushCloudOutboxes_2, KanbanRuntime_flushCloudMutationOutbox_3, KanbanRuntime_flushRunEventOutbox_4, KanbanRuntime_sendRunEventOutboxItem_5, KanbanRuntime_handleRejectedRunEvent_6, KanbanRuntime_recoverPendingManualRuns_7, KanbanRuntime_sendNavigationPushEvent_8, KanbanRuntime_currentUser_9, KanbanRuntime_refreshConnection_10, KanbanRuntime_applySnapshot_11, KanbanRuntime_applyDispatch_12, KanbanRuntime_cloudIssueReadOnlyResult_13, KanbanRuntime_cloudIssueReadOnlyDeleteResult_14, KanbanRuntime_applyIssueEvent_15 } from "./runtime.methods-2";

import { KanbanRuntime_applyDelivery_1, KanbanRuntime_processPendingCommandReceipts_2, KanbanRuntime_inspectReceiptRun_3, KanbanRuntime_localChatExists_4, KanbanRuntime_readStructuredReviewResult_5, KanbanRuntime_reportFailedCommandReceipt_6, KanbanRuntime_scheduleCommandReceiptRecovery_7, KanbanRuntime_appendRunEvent_8, KanbanRuntime_createLocalProject_9, KanbanRuntime_bindLocalProject_10, KanbanRuntime_unbindLocalProject_11, KanbanRuntime_listAgents_12, KanbanRuntime_startRemoteRun_13 } from "./runtime.methods-3";

import { KanbanRuntime_handleRemoteStartFailure_1, KanbanRuntime_notifyChanged_2, KanbanRuntime_syncAutomationForIssue_3, KanbanRuntime_syncRemoteAutomationPayload_4 } from "./runtime.methods-4";

export class KanbanRuntime {
  private readonly wsClient: KanbanDesktopWsClient;
  private connectionState: KanbanDesktopConnectionState = "disabled";
  private connectionFallbackState: KanbanConnectionFallbackState = "disabled";
  private commandReceiptProcessing = false;
  private commandReceiptRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudMutationProcessing = false;
  private runEventProcessing = false;
  private negotiatedContractVersion = "";
  private negotiatedCapabilities: string[] = [];

  constructor(private readonly options: KanbanRuntimeOptions) {
    this.wsClient = new KanbanDesktopWsClient({
      capabilities: [
        "command.dispatchIssue",
        "command.runIssue",
        "command.reviewIssue",
        "run.event.append",
        "issue.run.prepare",
        "issue.chat.bind",
        "issue.chat.unbind",
        "issue.claim",
        "agent.listDesktop",
        "automation.sync"
      ],
      getDeviceId: () => getDesktopDeviceId(this.options.app),
      getDeviceInfo: () => getKanbanDeviceInfo(this.options.app),
      getSyncCursor: () => readDesktopKanbanSyncCursor(this.options.app, this.currentUser()),
      onSyncCursor: (cursor) => {
        writeDesktopKanbanSyncCursor(this.options.app, this.currentUser(), cursor);
      },
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onDelivery: (delivery) => this.applyDelivery(delivery),
      onDeliveryAcked: () => this.processPendingCommandReceipts(),
      onIssueEvent: (event) => this.applyIssueEvent(event),
      onDispatchIssue: (issue, revision) => this.applyDispatch(issue, revision),
      onListAgents: () => this.listAgents(),
      onStartRun: (request) => this.startRemoteRun(request),
      onAutomationSync: (payload) => this.syncRemoteAutomationPayload(payload),
      onListLocalProjects: () => this.listLocalProjects(),
      onListSyncLocalProjects: () => this.listSyncLocalProjects(),
      onCreateLocalProject: (payload) => Promise.resolve(this.createLocalProject(payload)),
      onBindProject: (payload) => Promise.resolve(this.bindLocalProject(payload)),
      onUnbindProject: (payload) => Promise.resolve(this.unbindLocalProject(payload)),
      onContractNegotiated: (contractVersion, capabilities) => {
        this.negotiatedContractVersion = contractVersion;
        this.negotiatedCapabilities = capabilities;
        this.notifyChanged();
      },
      onConnected: () => {
        void this.flushCloudOutboxes()
          .then(() => this.recoverPendingManualRuns())
          .then(() => this.processPendingCommandReceipts())
          .catch((error) => this.options.onDebug?.(error instanceof Error ? error.message : String(error)));
      },
      onStateChanged: (state) => {
        this.connectionState = state === "disabled" ? this.connectionFallbackState : state;
        this.notifyChanged();
      },
      onDebug: (message) => appendKanbanWsLog(this.options.app, {
        event: "debug",
        message
      }),
      onWsLog: (entry) => appendKanbanWsLog(this.options.app, entry)
    });
  }

  start() { return KanbanRuntime_start_1(this as any); }

  stop() { return KanbanRuntime_stop_2(this as any); }

  refreshDeviceInfo() { return KanbanRuntime_refreshDeviceInfo_3(this as any); }

  listIssues(): KanbanListResult { return KanbanRuntime_listIssues_4(this as any); }

  getCloudConfig(): KanbanCloudConfigResult { return KanbanRuntime_getCloudConfig_5(this as any); }

  getSettings(): KanbanSettingsResult { return KanbanRuntime_getSettings_6(this as any); }

  async resyncCloudBoard(): Promise<KanbanListResult> { return KanbanRuntime_resyncCloudBoard_7(this as any); }

  async listLocalProjects(): Promise<{ ok: boolean; projects: KanbanProject[]; message: string }> { return KanbanRuntime_listLocalProjects_8(this as any); }

  async listSyncLocalProjects(): Promise<KanbanDesktopSyncLocalProject[]> { return KanbanRuntime_listSyncLocalProjects_9(this as any); }

  saveCloudConfig(input: KanbanCloudConfig): KanbanCloudConfigResult { return KanbanRuntime_saveCloudConfig_10(this as any, input); }

  saveSettings(input: KanbanSettingsInput): KanbanSettingsResult { return KanbanRuntime_saveSettings_11(this as any, input); }

  async createIssue(input: KanbanIssueInput): Promise<KanbanIssueResult> { return KanbanRuntime_createIssue_12(this as any, input); }

  async updateIssue(issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult> { return KanbanRuntime_updateIssue_13(this as any, issueId, input); }

  async moveIssue(input: KanbanIssueMoveInput): Promise<KanbanIssueResult> { return KanbanRuntime_moveIssue_14(this as any, input); }

  async deleteIssueWithAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> { return KanbanRuntime_deleteIssueWithAutomation_15(this as any, issueId, callAgentPlatform); }

  async syncIssueAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> { return KanbanRuntime_syncIssueAutomation_16(this as any, issueId, callAgentPlatform); }

  async claimIssue(issueId: string): Promise<KanbanIssueResult> { return KanbanRuntime_claimIssue_17(this as any, issueId); }

  async runIssue(input: KanbanRunIssueInput): Promise<KanbanRunIssueResult> { return KanbanRuntime_runIssue_18(this as any, input); }

  async bindHumanReferenceChat(input: { issueId: string; stageId: string; statusId: string; chatId: string }) { return KanbanRuntime_bindHumanReferenceChat_19(this as any, input); }

  async unbindHumanReferenceChat(issueChatId: string) { return KanbanRuntime_unbindHumanReferenceChat_20(this as any, issueChatId); }

  private async sendCloudMutation(item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue }> { return KanbanRuntime_sendCloudMutation_1(this as any, item); }

  private async flushCloudOutboxes() { return KanbanRuntime_flushCloudOutboxes_2(this as any); }

  private async flushCloudMutationOutbox() { return KanbanRuntime_flushCloudMutationOutbox_3(this as any); }

  private async flushRunEventOutbox() { return KanbanRuntime_flushRunEventOutbox_4(this as any); }

  private async sendRunEventOutboxItem(item: ReturnType<typeof listDesktopKanbanRunEvents>[number]) { return KanbanRuntime_sendRunEventOutboxItem_5(this as any, item); }

  private async handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string) { return KanbanRuntime_handleRejectedRunEvent_6(this as any, item, message); }

  private async recoverPendingManualRuns() { return KanbanRuntime_recoverPendingManualRuns_7(this as any); }

  sendNavigationPushEvent(event: AssistantNavigationPushEvent) { return KanbanRuntime_sendNavigationPushEvent_8(this as any, event); }

  private currentUser(): KanbanCurrentUser { return KanbanRuntime_currentUser_9(this as any); }

  private refreshConnection(options: { forceReconnect?: boolean } = {}) { return KanbanRuntime_refreshConnection_10(this as any, options); }

  private applySnapshot(snapshot: KanbanCloudSnapshot) { return KanbanRuntime_applySnapshot_11(this as any, snapshot); }

  private applyDispatch(issue: unknown, revision: number): KanbanIssueResult { return KanbanRuntime_applyDispatch_12(this as any, issue, revision); }

  private cloudIssueReadOnlyResult(): KanbanIssueResult { return KanbanRuntime_cloudIssueReadOnlyResult_13(this as any); }

  private cloudIssueReadOnlyDeleteResult(issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[] } { return KanbanRuntime_cloudIssueReadOnlyDeleteResult_14(this as any, issues); }

  private async applyIssueEvent(event: KanbanDesktopIssueEvent): Promise<KanbanDesktopIssueEventApplyResult> { return KanbanRuntime_applyIssueEvent_15(this as any, event); }

  private async applyDelivery(delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult> { return KanbanRuntime_applyDelivery_1(this as any, delivery); }

  private async processPendingCommandReceipts() { return KanbanRuntime_processPendingCommandReceipts_2(this as any); }

  private async inspectReceiptRun(chatId: string, runId: string): Promise<{
    exists: boolean;
    terminalEventType?: "run.completed" | "run.failed" | "run.cancelled";
    message?: string;
    error?: string;
  }> { return KanbanRuntime_inspectReceiptRun_3(this as any, chatId, runId); }

  private async localChatExists(chatId: string) { return KanbanRuntime_localChatExists_4(this as any, chatId); }

  private async readStructuredReviewResult(chatId: string, runId: string) { return KanbanRuntime_readStructuredReviewResult_5(this as any, chatId, runId); }

  private async reportFailedCommandReceipt(receipt: KanbanCommandReceipt, error: string) { return KanbanRuntime_reportFailedCommandReceipt_6(this as any, receipt, error); }

  private scheduleCommandReceiptRecovery() { return KanbanRuntime_scheduleCommandReceiptRecovery_7(this as any); }

  private async appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    issueRunId?: string | null;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; queued: boolean; message: string }> { return KanbanRuntime_appendRunEvent_8(this as any, input); }

  // 响应云端 desktop.project.createLocal:在本地真正创建项目。
  private createLocalProject(payload: unknown) { return KanbanRuntime_createLocalProject_9(this as any, payload); }

  // 响应云端 desktop.project.bind:校验本地项目存在并返回项目信息。
  private bindLocalProject(payload: unknown) { return KanbanRuntime_bindLocalProject_10(this as any, payload); }

  // 响应云端 desktop.project.unbind:把该本地项目下的 cloud issue 转为 local 保留副本。
  private unbindLocalProject(payload: unknown) { return KanbanRuntime_unbindLocalProject_11(this as any, payload); }

  private async listAgents(): Promise<DesktopPetAgentOption[]> { return KanbanRuntime_listAgents_12(this as any); }

  private async startRemoteRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> { return KanbanRuntime_startRemoteRun_13(this as any, request); }

  private async handleRemoteStartFailure(runId: string, chatId: string, message: string) { return KanbanRuntime_handleRemoteStartFailure_1(this as any, runId, chatId, message); }

  private notifyChanged() { return KanbanRuntime_notifyChanged_2(this as any); }

  private async syncAutomationForIssue(
    issue: KanbanIssue,
    callAgentPlatform: AgentPlatformCaller<App>
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> { return KanbanRuntime_syncAutomationForIssue_3(this as any, issue, callAgentPlatform); }

  private async syncRemoteAutomationPayload(payload: unknown) { return KanbanRuntime_syncRemoteAutomationPayload_4(this as any, payload); }
}

export function createKanbanRuntime(options: KanbanRuntimeOptions) {
  return new KanbanRuntime(options);
}

export * from "./runtime.shared";
