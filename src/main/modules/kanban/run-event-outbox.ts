import type {
  AssistantNavigationPushEvent,
  KanbanCurrentUser
} from "../../../shared/contracts";
import { isAgentPlatformEpochMilliseconds } from "../../../shared/time-contract";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopDeviceId } from "../identity";
import { getRemoteIssueId, issueSyncMode } from "./cloud-event-model";
import {
  completeDesktopKanbanCommandReceiptByRunId,
  deleteDesktopKanbanRunEvent,
  getDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanManualRunByRunId,
  listDesktopKanbanIssues,
  listDesktopKanbanRunEvents,
  markDesktopKanbanRunEventAttempt,
  recordDesktopKanbanRunEvent,
  updateDesktopKanbanIssueRuntimeState,
  updateDesktopKanbanManualRun
} from "./local-store";
import { optionalText, readText } from "./protocol-values";
import { resolveKanbanRunFinishedPush, stableClientEventId } from "./run-policy";
import { DEFAULT_SELECTED_PROJECT_ID } from "./runtime-config";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopRequestError,
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface RunEventOutboxDependencies {
  flushCloudMutationOutbox(): Promise<void>;
  flushRunEventOutbox(): Promise<void>;
  runEventProcessing: boolean;
  readonly wsClient: Pick<KanbanDesktopWsClient, "isOpen" | "requestWithId">;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "assistantBridge" | "onDebug">;
  currentUser(): KanbanCurrentUser;
  sendRunEventOutboxItem(item: ReturnType<typeof listDesktopKanbanRunEvents>[number]): Promise<{ accepted: boolean; queued: boolean; message: string; }>;
  handleRejectedRunEvent(item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string): Promise<void>;
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  readonly connectionState: KanbanDesktopConnectionState;
  notifyChanged(): void;
  readStructuredReviewResult(chatId: string, runId: string): Promise<{ verdict: "approved" | "changes_requested" | "rejected"; summary: string; } | undefined>;
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
}

export async function flushCloudOutboxes(dependencies: RunEventOutboxDependencies) {
  await dependencies.flushCloudMutationOutbox();
  await dependencies.flushRunEventOutbox();
}

export async function flushRunEventOutbox(dependencies: RunEventOutboxDependencies) {
  if (dependencies.runEventProcessing || !dependencies.wsClient.isOpen())
    return;
  dependencies.runEventProcessing = true;
  try {
    for (const item of listDesktopKanbanRunEvents(dependencies.options.app, dependencies.currentUser())) {
      const result = await dependencies.sendRunEventOutboxItem(item);
      if (!result.accepted && !result.queued) {
        await dependencies.handleRejectedRunEvent(item, result.message);
        continue;
      }
      if (result.queued)
        break;
    }
  }
  finally {
    dependencies.runEventProcessing = false;
  }
}

export async function sendRunEventOutboxItem(dependencies: RunEventOutboxDependencies, item: ReturnType<typeof listDesktopKanbanRunEvents>[number]) {
  const currentUser = dependencies.currentUser();
  if (!dependencies.wsClient.isOpen()) {
    return { accepted: false, queued: true, message: t("kanban.cloudSync.notConnected") };
  }
  try {
    const result = await dependencies.wsClient.requestWithId<{
      ok?: boolean;
      message?: string;
    }>("run.event.append", {
      deviceId: getDesktopDeviceId(dependencies.options.app),
      clientEventId: item.clientEventId,
      sourceDeliverySeq: item.sourceDeliverySeq,
      projectId: item.projectId,
      issueId: item.issueId,
      issueRunId: item.issueRunId,
      externalRunId: item.externalRunId,
      chatId: item.chatId || undefined,
      eventType: item.eventType,
      payload: item.payload
    }, item.clientEventId, undefined, item.projectId);
    if (result?.ok === false) {
      deleteDesktopKanbanRunEvent(dependencies.options.app, currentUser, item.clientEventId);
      return { accepted: false, queued: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: "run.event.append" }) };
    }
    deleteDesktopKanbanRunEvent(dependencies.options.app, currentUser, item.clientEventId);
    return { accepted: true, queued: false, message: readText(result?.message) };
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof KanbanDesktopRequestError) {
      deleteDesktopKanbanRunEvent(dependencies.options.app, currentUser, item.clientEventId);
      return { accepted: false, queued: false, message };
    }
    markDesktopKanbanRunEventAttempt(dependencies.options.app, currentUser, item.clientEventId, message);
    return { accepted: false, queued: true, message };
  }
}

export async function handleRejectedRunEvent(dependencies: RunEventOutboxDependencies, item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string) {
  if (item.eventType !== "run.started" || readText(item.payload.source) !== "desktop_manual")
    return;
  await dependencies.options.assistantBridge.stopRun?.(item.runId).catch(() => undefined);
  updateDesktopKanbanManualRun(dependencies.options.app, dependencies.currentUser(), item.runId, "failed", message);
}

export function sendNavigationPushEvent(dependencies: RunEventOutboxDependencies, event: AssistantNavigationPushEvent) {
  dependencies.refreshConnection();
  if (event.frame === "push" && event.type === "chat.updated") {
    const lastRunId = event.lastRunId?.trim();
    const chatId = event.chatId?.trim();
    if (!lastRunId || !chatId || typeof event.lastRunContent !== "string"
      || !isAgentPlatformEpochMilliseconds(event.updatedAt)) return;
    const currentUser = dependencies.currentUser();
    const issue = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues.find((candidate) =>
      issueSyncMode(candidate) !== "cloud" && candidate.lastRunId === lastRunId && candidate.lastRunChatId === chatId);
    const content = event.lastRunContent.trim() || null;
    if (!issue || issue.runResultMessage === content) return;
    const result = updateDesktopKanbanIssueRuntimeState(dependencies.options.app, currentUser, issue.id, {}, { runResultMessage: content });
    if (result.ok) dependencies.notifyChanged();
    return;
  }
  const runId = event.runId?.trim() ?? "";
  const semanticTime = event.type === "run.started" ? event.startedAt : event.finishedAt;
  if (event.frame !== "push" ||
    (event.type !== "run.started" && event.type !== "run.finished") ||
    !runId ||
    !isAgentPlatformEpochMilliseconds(semanticTime)) {
    dependencies.options.onDebug?.(`ignored invalid navigation push: frame=${event.frame || ""} type=${event.type || ""} runId=${runId} semanticTime=${String(semanticTime ?? "")}`);
    return;
  }
  const currentUser = dependencies.currentUser();
  const issues = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues;
  const matchingLocalIssue = issues.find((issue) => issueSyncMode(issue) !== "cloud" && (issue.runId === runId || issue.activeRunId === runId));
  if (event.type === "run.started") {
    if (!matchingLocalIssue) {
      return;
    }
    const result = updateDesktopKanbanIssueRuntimeState(dependencies.options.app, currentUser, matchingLocalIssue.id, {
      status: "in_progress",
      chatId: event.chatId || matchingLocalIssue.chatId,
      runId,
      runState: "running",
    }, { runStartedAt: new Date(event.startedAt!).toISOString() });
    if (result.ok) {
      dependencies.notifyChanged();
    }
    return;
  }
  const terminal = resolveKanbanRunFinishedPush(event);
  if (!terminal) {
    dependencies.options.onDebug?.(`ignored invalid run.finished protocol: runId=${runId} status=${event.status || ""} finishReason=${event.finishReason || ""}`);
    return;
  }
  dependencies.options.onDebug?.(`accepted navigation run.finished: runId=${runId} status=${event.status} finishReason=${event.finishReason} runState=${terminal.runState}`);
  if (matchingLocalIssue) {
    const result = updateDesktopKanbanIssueRuntimeState(dependencies.options.app, currentUser, matchingLocalIssue.id, {
      status: terminal.status,
      chatId: event.chatId || matchingLocalIssue.chatId,
      runId: null,
      runState: terminal.runState,
    }, { runFinishedAt: new Date(event.finishedAt!).toISOString() });
    if (result.ok) {
      dependencies.notifyChanged();
    }
    return;
  }
  const manualReceipt = getDesktopKanbanManualRunByRunId(dependencies.options.app, currentUser, runId);
  const commandReceipt = getDesktopKanbanCommandReceiptByRunId(dependencies.options.app, currentUser, runId);
  const matchingCloudIssue = issues.find((issue) => issueSyncMode(issue) === "cloud" && ((manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
    (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)));
  if (matchingCloudIssue || manualReceipt || commandReceipt) {
    const commandId = commandReceipt?.commandId || readText(matchingCloudIssue?.dispatchCommandId);
    if (manualReceipt) {
      updateDesktopKanbanManualRun(dependencies.options.app, currentUser, runId, terminal.runState === "completed" ? "completed" : terminal.runState === "cancelled" ? "cancelled" : "failed", null);
    }
    void (async () => {
      const reviewResult = commandReceipt?.commandType === "review" && terminal.terminalEventType === "run.completed"
        ? await dependencies.readStructuredReviewResult(commandReceipt.chatId, runId)
        : undefined;
      await dependencies.appendRunEvent({
        projectId: commandReceipt?.projectId || manualReceipt?.projectId || matchingCloudIssue?.projectId || "",
        issueId: commandReceipt?.issueId || manualReceipt?.issueId || (matchingCloudIssue ? getRemoteIssueId(matchingCloudIssue) : ""),
        issueRunId: commandReceipt?.issueRunId || manualReceipt?.issueRunId,
        runId,
        chatId: event.chatId || commandReceipt?.chatId,
        eventType: terminal.terminalEventType,
        payload: {
          ...(manualReceipt ? { source: "desktop_manual", agentKey: manualReceipt.agentKey } : {}),
          ...(commandReceipt ? { agentKey: optionalText(commandReceipt.payload.agentKey) } : {}),
          ...(commandId ? { commandId } : {}),
          ...(reviewResult ? { reviewResult } : {}),
          type: event.type,
          status: event.status,
          finishReason: event.finishReason,
          runState: terminal.runState,
          chatId: event.chatId || commandReceipt?.chatId,
          runId,
        }
      });
      if (commandReceipt) {
        completeDesktopKanbanCommandReceiptByRunId(dependencies.options.app, currentUser, runId, terminal.runState === "completed" ? "completed" : "failed");
      }
    })().catch((error) => dependencies.options.onDebug?.(error instanceof Error ? error.message : String(error)));
  }
}

export async function appendRunEvent(dependencies: RunEventOutboxDependencies, input: {
  sourceDeliverySeq?: number;
  projectId?: string;
  issueId: string;
  issueRunId?: string | null;
  runId?: string | null;
  chatId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<{ accepted: boolean; queued: boolean; message: string }> {
  const issueId = readText(input.issueId);
  if (!issueId) {
    return { accepted: false, queued: false, message: t("kanban.runtime.dispatchInvalid") };
  }
  const deviceId = getDesktopDeviceId(dependencies.options.app);
  const issueRunId = readText(input.issueRunId);
  const item = {
    clientEventId: stableClientEventId(deviceId, [issueRunId || issueId, readText(input.runId), input.eventType]),
    sourceDeliverySeq: input.sourceDeliverySeq ?? 0,
    projectId: readText(input.projectId) || DEFAULT_SELECTED_PROJECT_ID,
    issueId,
    issueRunId,
    externalRunId: readText(input.runId),
    runId: readText(input.runId),
    chatId: readText(input.chatId),
    eventType: input.eventType,
    payload: input.payload
  };
  recordDesktopKanbanRunEvent(dependencies.options.app, dependencies.currentUser(), item);
  const result = await dependencies.sendRunEventOutboxItem({
    ...item,
    attemptCount: 0,
    lastError: null
  });
  if (!result.accepted && !result.queued) {
    await dependencies.handleRejectedRunEvent({ ...item, attemptCount: 0, lastError: null }, result.message);
  }
  return result;
}
