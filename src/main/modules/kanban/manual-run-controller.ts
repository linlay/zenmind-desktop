import type {
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanCurrentUser,
  KanbanRunIssueInput,
  KanbanRunIssueResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopDeviceId } from "../identity";
import { getRemoteIssueId, issueSyncMode } from "./cloud-event-model";
import {
  getDesktopKanbanIssue,
  listDesktopKanbanIssues,
  listDesktopKanbanRunEvents,
  listPendingDesktopKanbanManualRuns,
  recordDesktopKanbanManualRun,
  updateDesktopKanbanManualRun
} from "./local-store";
import { readText } from "./protocol-values";
import { buildDesktopKanbanRunPrompt, createKanbanRemoteChatId, createKanbanRemoteRunId, stableClientEventId } from "./run-policy";
import { DEFAULT_SELECTED_PROJECT_ID } from "./runtime-config";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface ManualRunControllerDependencies {
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  currentUser(): KanbanCurrentUser;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "assistantBridge">;
  readonly connectionState: KanbanDesktopConnectionState;
  readonly negotiatedContractVersion: string;
  readonly negotiatedCapabilities: string[];
  readonly wsClient: Pick<KanbanDesktopWsClient, "isOpen" | "request">;
  listAgents(): Promise<DesktopPetAgentOption[]>;
  appendRunEvent(input: {
    sourceDeliverySeq?: number;
    projectId?: string;
    issueId: string;
    issueRunId?: string | null;
    runId?: string | null;
    chatId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ accepted: boolean; queued: boolean; message: string; }>;
  inspectReceiptRun(chatId: string, runId: string): Promise<{ exists: boolean; terminalEventType?: "run.completed" | "run.failed" | "run.cancelled"; message?: string; error?: string; }>;
  handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string): Promise<void>;
}

export async function runIssue(dependencies: ManualRunControllerDependencies, input: KanbanRunIssueInput): Promise<KanbanRunIssueResult> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, readText(input?.issueId));
  const currentIssues = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues;
  if (!issue || issueSyncMode(issue) !== "cloud") {
    return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
  }
  if (!dependencies.negotiatedContractVersion.startsWith("1.") || !dependencies.negotiatedCapabilities.includes("run.event.append") || !dependencies.wsClient.isOpen()) {
    return { ok: false, message: t("kanban.cloudSync.notConnected"), issues: currentIssues };
  }
  if (issue.status !== "todo") {
    return { ok: false, message: t("kanban.run.todoRequired"), issues: currentIssues };
  }
  if (readText(issue.assigneeId) !== currentUser.id) {
    return { ok: false, message: t("kanban.run.claimRequired"), issues: currentIssues };
  }
  if (issue.runState === "running" || readText(issue.activeRunId)) {
    return { ok: false, message: t("kanban.run.alreadyRunning"), issues: currentIssues };
  }
  const agentKey = readText(input?.agentKey);
  const availableAgents = await dependencies.listAgents();
  if (!agentKey || !availableAgents.some((agent) => agent.agentKey === agentKey)) {
    return { ok: false, message: t("kanban.feedback.noAgents"), issues: currentIssues };
  }
  const projectId = readText(issue.projectId) || DEFAULT_SELECTED_PROJECT_ID;
  const remoteIssueId = getRemoteIssueId(issue);
  let prepared: {
    issueRun?: {
      id?: string;
    };
    preferredChatId?: string;
  };
  try {
    prepared = await dependencies.wsClient.request("issue.run.prepare", {
      issueId: remoteIssueId,
      agentKey,
      forceNewChat: input.forceNewChat === true
    });
  }
  catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      issues: currentIssues,
      agentKey
    };
  }
  const issueRunId = readText(prepared.issueRun?.id);
  if (!issueRunId) {
    return { ok: false, message: t("kanban.runtime.dispatchInvalid"), issues: currentIssues, agentKey };
  }
  const preferredChatId = input.forceNewChat === true ? "" : readText(prepared.preferredChatId);
  let chatId = preferredChatId || createKanbanRemoteChatId();
  let missingPreferredChatId = "";
  if (preferredChatId && dependencies.options.assistantBridge.getChat) {
    try {
      if (!await dependencies.options.assistantBridge.getChat(preferredChatId)) {
        missingPreferredChatId = preferredChatId;
        chatId = createKanbanRemoteChatId();
      }
    }
    catch {
      missingPreferredChatId = preferredChatId;
      chatId = createKanbanRemoteChatId();
    }
  }
  const runId = createKanbanRemoteRunId();
  recordDesktopKanbanManualRun(dependencies.options.app, currentUser, { issueRunId, runId, chatId, issueId: remoteIssueId, projectId, agentKey });
  const failPreparedRun = async (message: string) => {
    updateDesktopKanbanManualRun(dependencies.options.app, currentUser, runId, "failed", message);
    await dependencies.appendRunEvent({
      projectId,
      issueId: remoteIssueId,
      issueRunId,
      runId,
      chatId,
      eventType: "run.failed",
      payload: { source: "desktop_manual", status: "failed", agentKey, runId, chatId, error: message }
    }).catch(() => undefined);
  };
  let runResult: AssistantStartRunResult;
  try {
    runResult = await dependencies.options.assistantBridge.startRun({
      agentKey,
      chatId,
      runId,
      requestId: runId,
      message: buildDesktopKanbanRunPrompt(issue),
      source: "sidebar"
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failPreparedRun(message);
    return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
  }
  if (!runResult.ok) {
    await failPreparedRun(runResult.message);
    return { ok: false, message: runResult.message, issues: currentIssues, chatId, runId, agentKey };
  }
  if (readText(runResult.runId) !== runId || readText(runResult.chatId) !== chatId) {
    await dependencies.options.assistantBridge.stopRun?.(readText(runResult.runId) || runId).catch(() => undefined);
    const message = t("kanban.run.identityMismatch");
    await failPreparedRun(message);
    return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
  }
  updateDesktopKanbanManualRun(dependencies.options.app, currentUser, runId, "started");
  try {
    const appended = await dependencies.appendRunEvent({
      projectId,
      issueId: remoteIssueId,
      issueRunId,
      runId,
      chatId,
      eventType: "run.started",
      payload: {
        source: "desktop_manual",
        status: "running",
        agentKey,
        runId,
        chatId,
        ...(missingPreferredChatId ? { missingPreferredChatId } : {})
      }
    });
    if (!appended.accepted && !appended.queued) {
      updateDesktopKanbanManualRun(dependencies.options.app, currentUser, runId, "failed", appended.message);
      return { ok: false, message: appended.message, issues: currentIssues, chatId, runId, agentKey };
    }
    return {
      ok: true,
      message: t("kanban.feedback.assignedToAssistant"),
      issue,
      issues: currentIssues,
      chatId,
      runId,
      agentKey
    };
  }
  catch (error) {
    await dependencies.options.assistantBridge.stopRun?.(runId).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await failPreparedRun(message);
    return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
  }
}

export async function recoverPendingManualRuns(dependencies: ManualRunControllerDependencies) {
  if (!dependencies.wsClient.isOpen())
    return;
  const currentUser = dependencies.currentUser();
  const issues = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues;
  for (const receipt of listPendingDesktopKanbanManualRuns(dependencies.options.app, currentUser)) {
    const recovery = await dependencies.inspectReceiptRun(receipt.chatId, receipt.runId);
    const issue = issues.find((candidate) => issueSyncMode(candidate) === "cloud" && getRemoteIssueId(candidate) === receipt.issueId);
    if (recovery.terminalEventType) {
      await dependencies.appendRunEvent({
        projectId: receipt.projectId,
        issueId: receipt.issueId,
        issueRunId: receipt.issueRunId,
        runId: receipt.runId,
        chatId: receipt.chatId,
        eventType: recovery.terminalEventType,
        payload: {
          source: "desktop_manual",
          status: recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed",
          agentKey: receipt.agentKey,
          runId: receipt.runId,
          chatId: receipt.chatId,
          message: recovery.message,
          error: recovery.error
        }
      });
      updateDesktopKanbanManualRun(dependencies.options.app, currentUser, receipt.runId, recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed", recovery.error ?? null);
      continue;
    }
    if (!recovery.exists && receipt.state === "starting") {
      if (!issue) {
        updateDesktopKanbanManualRun(dependencies.options.app, currentUser, receipt.runId, "failed", t("kanban.runtime.missing"));
        continue;
      }
      const result = await dependencies.options.assistantBridge.startRun({
        agentKey: receipt.agentKey,
        chatId: receipt.chatId,
        runId: receipt.runId,
        requestId: receipt.runId,
        message: buildDesktopKanbanRunPrompt(issue),
        source: "sidebar"
      });
      if (!result.ok) {
        updateDesktopKanbanManualRun(dependencies.options.app, currentUser, receipt.runId, "failed", result.message);
        await dependencies.appendRunEvent({
          projectId: receipt.projectId,
          issueId: receipt.issueId,
          issueRunId: receipt.issueRunId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          eventType: "run.failed",
          payload: { source: "desktop_manual", status: "failed", agentKey: receipt.agentKey, error: result.message }
        });
        continue;
      }
    }
    if (!recovery.exists && receipt.state === "started") {
      continue;
    }
    if (receipt.state === "starting") {
      updateDesktopKanbanManualRun(dependencies.options.app, currentUser, receipt.runId, "started");
    }
    const started = await dependencies.appendRunEvent({
      projectId: receipt.projectId,
      issueId: receipt.issueId,
      issueRunId: receipt.issueRunId,
      runId: receipt.runId,
      chatId: receipt.chatId,
      eventType: "run.started",
      payload: { source: "desktop_manual", status: "running", agentKey: receipt.agentKey, runId: receipt.runId, chatId: receipt.chatId }
    });
    if (!started.accepted && !started.queued) {
      await dependencies.handleRejectedRunEvent({
        clientEventId: stableClientEventId(getDesktopDeviceId(dependencies.options.app), [receipt.issueId, receipt.runId, "run.started"]),
        projectId: receipt.projectId,
        issueId: receipt.issueId,
        issueRunId: receipt.issueRunId,
        externalRunId: receipt.runId,
        runId: receipt.runId,
        chatId: receipt.chatId,
        eventType: "run.started",
        sourceDeliverySeq: 0,
        payload: { source: "desktop_manual", agentKey: receipt.agentKey },
        attemptCount: 0,
        lastError: null
      }, started.message);
    }
  }
}
