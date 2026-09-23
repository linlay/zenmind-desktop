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
  KanbanRunIssueInput,
  KanbanRunIssueResult,
  KanbanSettingsInput,
  KanbanSettingsResult
} from "../../../shared/contracts";
import { appendKanbanWsLog } from "../../support/logging/desktop";
import { getDesktopDeviceId } from "../identity";
import * as automationSync from "./automation-sync";
import * as cloudIssueActions from "./cloud-issue-actions";
import * as cloudProjection from "./cloud-projection";
import * as commandDelivery from "./command-delivery";
import * as commandRecovery from "./command-recovery";
import * as localIssueActions from "./local-issue-actions";
import * as projectActions from "./local-projects";
import { LocalKanbanScheduler } from "./local-scheduler";
import {
  listDesktopKanbanCloudMutations,
  listDesktopKanbanRunEvents,
  readDesktopKanbanSyncCursor,
  writeDesktopKanbanSyncCursor,
  type KanbanCloudSnapshot,
  type KanbanCommandReceipt
} from "./local-store";
import { saveLocalWorkflowDefinitions } from "./local-workflow-settings";
import * as manualRunController from "./manual-run-controller";
import * as runEventOutbox from "./run-event-outbox";
import { KanbanConnectionFallbackState, getKanbanDeviceInfo } from "./runtime-config";
import { AgentPlatformCaller, KanbanRuntimeOptions } from "./runtime-options";
import * as runtimeSettings from "./runtime-settings";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState,
  type KanbanDesktopDelivery,
  type KanbanDesktopDeliveryApplyResult,
  type KanbanDesktopIssueEvent,
  type KanbanDesktopIssueEventApplyResult,
  type KanbanDesktopSyncLocalProject
} from "./ws-client";

export class KanbanRuntime {
  private readonly localScheduler: LocalKanbanScheduler;
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
    this.localScheduler = new LocalKanbanScheduler(options, () => this.currentUser(), () => this.notifyChanged());
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

  start() { runtimeSettings.start(this.runtimeSettingsDependencies); this.localScheduler.start(); }

  stop() { this.localScheduler.stop(); return runtimeSettings.stop(this.runtimeSettingsDependencies); }

  refreshDeviceInfo() { return runtimeSettings.refreshDeviceInfo(this.runtimeSettingsDependencies); }

  listIssues(): KanbanListResult { return cloudProjection.listIssues(this.cloudProjectionDependencies); }

  getCloudConfig(): KanbanCloudConfigResult { return runtimeSettings.getCloudConfig(this.runtimeSettingsDependencies); }

  getSettings(): KanbanSettingsResult { return runtimeSettings.getSettings(this.runtimeSettingsDependencies); }

  async resyncCloudBoard(): Promise<KanbanListResult> { return cloudProjection.resyncCloudBoard(this.cloudProjectionDependencies); }

  async listLocalProjects(): Promise<{ ok: boolean; projects: KanbanProject[]; message: string }> { return projectActions.listLocalProjects(this.projectActionsDependencies); }

  async listSyncLocalProjects(): Promise<KanbanDesktopSyncLocalProject[]> { return projectActions.listSyncLocalProjects(this.projectActionsDependencies); }

  saveCloudConfig(input: KanbanCloudConfig): KanbanCloudConfigResult { return runtimeSettings.saveCloudConfig(this.runtimeSettingsDependencies, input); }

  saveSettings(input: KanbanSettingsInput): KanbanSettingsResult { const result = runtimeSettings.saveSettings(this.runtimeSettingsDependencies, input); this.localScheduler.wake(); return result; }

  saveLocalWorkflows(input: import("../../../shared/contracts").KanbanLocalWorkflow[]): KanbanListResult {
    saveLocalWorkflowDefinitions(this.options.app, this.currentUser(), input);
    this.notifyChanged();
    return this.listIssues();
  }

  async createIssue(input: KanbanIssueInput): Promise<KanbanIssueResult> { const result = await localIssueActions.createIssue(this.localIssueActionsDependencies, input); if (result.ok) this.notifyChanged(); return result; }

  async updateIssue(issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult> { const result = await localIssueActions.updateIssue(this.localIssueActionsDependencies, issueId, input); if (result.ok) this.notifyChanged(); return result; }

  async moveIssue(input: KanbanIssueMoveInput): Promise<KanbanIssueResult> { const result = await localIssueActions.moveIssue(this.localIssueActionsDependencies, input); if (result.ok) this.notifyChanged(); return result; }

  async deleteIssueWithAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> { return localIssueActions.deleteIssueWithAutomation(this.localIssueActionsDependencies, issueId, callAgentPlatform); }

  async syncIssueAutomation(
    issueId: string,
    callAgentPlatform: AgentPlatformCaller<App> = this.options.callAgentPlatform
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> { return automationSync.syncIssueAutomation(this.automationSyncDependencies, issueId, callAgentPlatform); }

  async claimIssue(issueId: string): Promise<KanbanIssueResult> { return cloudIssueActions.claimIssue(this.cloudIssueActionsDependencies, issueId); }

  async runIssue(input: KanbanRunIssueInput): Promise<KanbanRunIssueResult> { return manualRunController.runIssue(this.manualRunControllerDependencies, input); }

  async bindHumanReferenceChat(input: { issueId: string; stageId: string; statusId: string; chatId: string }) { return cloudIssueActions.bindHumanReferenceChat(this.cloudIssueActionsDependencies, input); }

  async unbindHumanReferenceChat(issueChatId: string) { return cloudIssueActions.unbindHumanReferenceChat(this.cloudIssueActionsDependencies, issueChatId); }

  private async sendCloudMutation(item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue }> { return cloudIssueActions.sendCloudMutation(this.cloudIssueActionsDependencies, item); }

  private async flushCloudOutboxes() { return runEventOutbox.flushCloudOutboxes(this.runEventOutboxDependencies); }

  private async flushCloudMutationOutbox() { return cloudIssueActions.flushCloudMutationOutbox(this.cloudIssueActionsDependencies); }

  private async flushRunEventOutbox() { return runEventOutbox.flushRunEventOutbox(this.runEventOutboxDependencies); }

  private async sendRunEventOutboxItem(item: ReturnType<typeof listDesktopKanbanRunEvents>[number]) { return runEventOutbox.sendRunEventOutboxItem(this.runEventOutboxDependencies, item); }

  private async handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string) { return runEventOutbox.handleRejectedRunEvent(this.runEventOutboxDependencies, item, message); }

  private async recoverPendingManualRuns() { return manualRunController.recoverPendingManualRuns(this.manualRunControllerDependencies); }

  sendNavigationPushEvent(event: AssistantNavigationPushEvent) {
    runEventOutbox.sendNavigationPushEvent(this.runEventOutboxDependencies, event);
    this.localScheduler.wake(event.type === "run.finished");
  }

  private currentUser(): KanbanCurrentUser { return runtimeSettings.currentUser(this.runtimeSettingsDependencies); }

  private refreshConnection(options: { forceReconnect?: boolean } = {}) { return runtimeSettings.refreshConnection(this.runtimeSettingsDependencies, options); }

  private applySnapshot(snapshot: KanbanCloudSnapshot) { return cloudProjection.applySnapshot(this.cloudProjectionDependencies, snapshot); }

  private applyDispatch(issue: unknown, revision: number): KanbanIssueResult { return cloudProjection.applyDispatch(this.cloudProjectionDependencies, issue, revision); }

  private cloudIssueReadOnlyResult(): KanbanIssueResult { return cloudIssueActions.cloudIssueReadOnlyResult(this.cloudIssueActionsDependencies); }

  private cloudIssueReadOnlyDeleteResult(issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[] } { return cloudIssueActions.cloudIssueReadOnlyDeleteResult(this.cloudIssueActionsDependencies, issues); }

  private async applyIssueEvent(event: KanbanDesktopIssueEvent): Promise<KanbanDesktopIssueEventApplyResult> { return cloudProjection.applyIssueEvent(this.cloudProjectionDependencies, event); }

  private async applyDelivery(delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult> { return commandDelivery.applyDelivery(this.commandDeliveryDependencies, delivery); }

  private async processPendingCommandReceipts() { return commandRecovery.processPendingCommandReceipts(this.commandRecoveryDependencies); }

  private async inspectReceiptRun(chatId: string, runId: string): Promise<{
    exists: boolean;
    terminalEventType?: "run.completed" | "run.failed" | "run.cancelled";
    message?: string;
    error?: string;
  }> { return commandRecovery.inspectReceiptRun(this.commandRecoveryDependencies, chatId, runId); }

  private async localChatExists(chatId: string) { return commandRecovery.localChatExists(this.commandRecoveryDependencies, chatId); }

  private async readStructuredReviewResult(chatId: string, runId: string) { return commandRecovery.readStructuredReviewResult(this.commandRecoveryDependencies, chatId, runId); }

  private async reportFailedCommandReceipt(receipt: KanbanCommandReceipt, error: string) { return commandRecovery.reportFailedCommandReceipt(this.commandRecoveryDependencies, receipt, error); }

  private scheduleCommandReceiptRecovery() { return commandRecovery.scheduleCommandReceiptRecovery(this.commandRecoveryDependencies); }

  private async appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    issueRunId?: string | null;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; queued: boolean; message: string }> { return runEventOutbox.appendRunEvent(this.runEventOutboxDependencies, input); }

  // 响应云端 desktop.project.createLocal:在本地真正创建项目。
  private createLocalProject(payload: unknown) { return projectActions.createLocalProject(this.projectActionsDependencies, payload); }

  // 响应云端 desktop.project.bind:校验本地项目存在并返回项目信息。
  private bindLocalProject(payload: unknown) { return projectActions.bindLocalProject(this.projectActionsDependencies, payload); }

  // 响应云端 desktop.project.unbind:把该本地项目下的 cloud issue 转为 local 保留副本。
  private unbindLocalProject(payload: unknown) { return projectActions.unbindLocalProject(this.projectActionsDependencies, payload); }

  private async listAgents(): Promise<DesktopPetAgentOption[]> { return commandDelivery.listAgents(this.commandDeliveryDependencies); }

  private async startRemoteRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> { return commandDelivery.startRemoteRun(this.commandDeliveryDependencies, request); }

  private async handleRemoteStartFailure(runId: string, chatId: string, message: string) { return commandDelivery.handleRemoteStartFailure(this.commandDeliveryDependencies, runId, chatId, message); }

  private notifyChanged() { this.localScheduler.wake(); return cloudProjection.notifyChanged(this.cloudProjectionDependencies); }

  private async syncAutomationForIssue(
    issue: KanbanIssue,
    callAgentPlatform: AgentPlatformCaller<App>
  ): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> { return automationSync.syncAutomationForIssue(this.automationSyncDependencies, issue, callAgentPlatform); }

  private async syncRemoteAutomationPayload(payload: unknown) { return automationSync.syncRemoteAutomationPayload(this.automationSyncDependencies, payload); }

  // Read live state across awaits and callbacks; each service receives only its declared port.
  private get runtimeSettingsDependencies(): runtimeSettings.RuntimeSettingsDependencies {
    const runtime = this;
    return {
      refreshConnection: this.refreshConnection.bind(this),
      get commandReceiptRetryTimer() { return runtime.commandReceiptRetryTimer; },
      set commandReceiptRetryTimer(value) { runtime.commandReceiptRetryTimer = value; },
      get connectionFallbackState() { return runtime.connectionFallbackState; },
      set connectionFallbackState(value) { runtime.connectionFallbackState = value; },
      get negotiatedContractVersion() { return runtime.negotiatedContractVersion; },
      set negotiatedContractVersion(value) { runtime.negotiatedContractVersion = value; },
      get negotiatedCapabilities() { return runtime.negotiatedCapabilities; },
      set negotiatedCapabilities(value) { runtime.negotiatedCapabilities = value; },
      get wsClient() { return runtime.wsClient; },
      notifyChanged: this.notifyChanged.bind(this),
      get options() { return runtime.options; },
      get connectionState() { return runtime.connectionState; },
      set connectionState(value) { runtime.connectionState = value; }
    };
  }

  private get localIssueActionsDependencies(): localIssueActions.LocalIssueActionsDependencies {
    const runtime = this;
    return {
      refreshConnection: this.refreshConnection.bind(this),
      currentUser: this.currentUser.bind(this),
      get options() { return runtime.options; },
      cloudIssueReadOnlyResult: this.cloudIssueReadOnlyResult.bind(this),
      get connectionState() { return runtime.connectionState; },
      cloudIssueReadOnlyDeleteResult: this.cloudIssueReadOnlyDeleteResult.bind(this)
    };
  }

  private get cloudIssueActionsDependencies(): cloudIssueActions.CloudIssueActionsDependencies {
    const runtime = this;
    return {
      refreshConnection: this.refreshConnection.bind(this),
      currentUser: this.currentUser.bind(this),
      get options() { return runtime.options; },
      get connectionState() { return runtime.connectionState; },
      get negotiatedContractVersion() { return runtime.negotiatedContractVersion; },
      get negotiatedCapabilities() { return runtime.negotiatedCapabilities; },
      get wsClient() { return runtime.wsClient; },
      sendCloudMutation: this.sendCloudMutation.bind(this),
      resyncCloudBoard: this.resyncCloudBoard.bind(this),
      notifyChanged: this.notifyChanged.bind(this),
      get cloudMutationProcessing() { return runtime.cloudMutationProcessing; },
      set cloudMutationProcessing(value) { runtime.cloudMutationProcessing = value; }
    };
  }

  private get cloudProjectionDependencies(): cloudProjection.CloudProjectionDependencies {
    const runtime = this;
    return {
      refreshConnection: this.refreshConnection.bind(this),
      get options() { return runtime.options; },
      currentUser: this.currentUser.bind(this),
      get connectionState() { return runtime.connectionState; },
      get negotiatedContractVersion() { return runtime.negotiatedContractVersion; },
      get negotiatedCapabilities() { return runtime.negotiatedCapabilities; },
      get wsClient() { return runtime.wsClient; },
      notifyChanged: this.notifyChanged.bind(this)
    };
  }

  private get projectActionsDependencies(): projectActions.ProjectActionsDependencies {
    const runtime = this;
    return {
      listIssues: this.listIssues.bind(this),
      get options() { return runtime.options; },
      currentUser: this.currentUser.bind(this),
      notifyChanged: this.notifyChanged.bind(this)
    };
  }

  private get commandDeliveryDependencies(): commandDelivery.CommandDeliveryDependencies {
    const runtime = this;
    return {
      currentUser: this.currentUser.bind(this),
      get options() { return runtime.options; },
      get wsClient() { return runtime.wsClient; },
      applySnapshot: this.applySnapshot.bind(this),
      applyDispatch: this.applyDispatch.bind(this),
      notifyChanged: this.notifyChanged.bind(this),
      handleRemoteStartFailure: this.handleRemoteStartFailure.bind(this),
      get connectionState() { return runtime.connectionState; },
      appendRunEvent: this.appendRunEvent.bind(this)
    };
  }

  private get commandRecoveryDependencies(): commandRecovery.CommandRecoveryDependencies {
    const runtime = this;
    return {
      get commandReceiptProcessing() { return runtime.commandReceiptProcessing; },
      set commandReceiptProcessing(value) { runtime.commandReceiptProcessing = value; },
      currentUser: this.currentUser.bind(this),
      get options() { return runtime.options; },
      reportFailedCommandReceipt: this.reportFailedCommandReceipt.bind(this),
      inspectReceiptRun: this.inspectReceiptRun.bind(this),
      readStructuredReviewResult: this.readStructuredReviewResult.bind(this),
      appendRunEvent: this.appendRunEvent.bind(this),
      localChatExists: this.localChatExists.bind(this),
      startRemoteRun: this.startRemoteRun.bind(this),
      scheduleCommandReceiptRecovery: this.scheduleCommandReceiptRecovery.bind(this),
      get commandReceiptRetryTimer() { return runtime.commandReceiptRetryTimer; },
      set commandReceiptRetryTimer(value) { runtime.commandReceiptRetryTimer = value; },
      get wsClient() { return runtime.wsClient; },
      processPendingCommandReceipts: this.processPendingCommandReceipts.bind(this)
    };
  }

  private get runEventOutboxDependencies(): runEventOutbox.RunEventOutboxDependencies {
    const runtime = this;
    return {
      flushCloudMutationOutbox: this.flushCloudMutationOutbox.bind(this),
      flushRunEventOutbox: this.flushRunEventOutbox.bind(this),
      get runEventProcessing() { return runtime.runEventProcessing; },
      set runEventProcessing(value) { runtime.runEventProcessing = value; },
      get wsClient() { return runtime.wsClient; },
      get options() { return runtime.options; },
      currentUser: this.currentUser.bind(this),
      sendRunEventOutboxItem: this.sendRunEventOutboxItem.bind(this),
      handleRejectedRunEvent: this.handleRejectedRunEvent.bind(this),
      refreshConnection: this.refreshConnection.bind(this),
      get connectionState() { return runtime.connectionState; },
      notifyChanged: this.notifyChanged.bind(this),
      readStructuredReviewResult: this.readStructuredReviewResult.bind(this),
      appendRunEvent: this.appendRunEvent.bind(this)
    };
  }

  private get manualRunControllerDependencies(): manualRunController.ManualRunControllerDependencies {
    const runtime = this;
    return {
      refreshConnection: this.refreshConnection.bind(this),
      currentUser: this.currentUser.bind(this),
      get options() { return runtime.options; },
      get connectionState() { return runtime.connectionState; },
      get negotiatedContractVersion() { return runtime.negotiatedContractVersion; },
      get negotiatedCapabilities() { return runtime.negotiatedCapabilities; },
      get wsClient() { return runtime.wsClient; },
      listAgents: this.listAgents.bind(this),
      appendRunEvent: this.appendRunEvent.bind(this),
      inspectReceiptRun: this.inspectReceiptRun.bind(this),
      handleRejectedRunEvent: this.handleRejectedRunEvent.bind(this)
    };
  }

  private get automationSyncDependencies(): automationSync.AutomationSyncDependencies {
    const runtime = this;
    return {
      get options() { return runtime.options; },
      refreshConnection: this.refreshConnection.bind(this),
      currentUser: this.currentUser.bind(this),
      get connectionState() { return runtime.connectionState; },
      cloudIssueReadOnlyResult: this.cloudIssueReadOnlyResult.bind(this),
      syncAutomationForIssue: this.syncAutomationForIssue.bind(this)
    };
  }
}

export function createKanbanRuntime(options: KanbanRuntimeOptions) {
  return new KanbanRuntime(options);
}

export * from "./agent-directory";
export * from "./automation-model";
export * from "./cloud-event-model";
export * from "./protocol-values";
export * from "./run-policy";
export * from "./runtime-config";
export * from "./runtime-options";
