import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanCurrentUser,
  KanbanIssueResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopDeviceId } from "../identity";
import { ASSISTANT_AGENT_LIST_TIMEOUT_MS, normalizeDesktopPetAgentOptions, readInstalledAgentOptions } from "./agent-directory";
import { deliveryIssuePayload, deliveryPayloadRecord, deliverySourceRevision, getRemoteIssueId, issueSyncMode } from "./cloud-event-model";
import {
  completeDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanManualRunByRunId,
  listDesktopKanbanIssues,
  readDesktopKanbanSyncCursor,
  recordDesktopKanbanCommandReceipt,
  updateDesktopKanbanIssueRuntimeState,
  updateDesktopKanbanManualRun,
  upsertDispatchedDesktopKanbanIssue,
  type KanbanCloudSnapshot
} from "./local-store";
import { optionalText, readText } from "./protocol-values";
import { REMOTE_START_RUN_ACK_TIMEOUT_MS, createKanbanRemoteChatId, createKanbanRemoteRunId, waitForRemoteStartRunAck, withTimeout } from "./run-policy";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState,
  type KanbanDesktopDelivery,
  type KanbanDesktopDeliveryApplyResult
} from "./ws-client";

export interface CommandDeliveryDependencies {
  currentUser(): KanbanCurrentUser;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "onDebug" | "listLocalAgents" | "assistantBridge">;
  readonly wsClient: Pick<KanbanDesktopWsClient, "request">;
  applySnapshot(snapshot: KanbanCloudSnapshot): void;
  applyDispatch(issue: unknown, revision: number): KanbanIssueResult;
  notifyChanged(): void;
  handleRemoteStartFailure(runId: string, chatId: string, message: string): Promise<void>;
  readonly connectionState: KanbanDesktopConnectionState;
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

export async function applyDelivery(dependencies: CommandDeliveryDependencies, delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult> {
  const currentUser = dependencies.currentUser();
  const cursor = readDesktopKanbanSyncCursor(dependencies.options.app, currentUser);
  const sourceRevision = deliverySourceRevision(delivery);
  if (delivery.kind === "snapshot_reset") {
    const snapshot = await dependencies.wsClient.request<KanbanCloudSnapshot>("snapshot.get", {
      scope: "project_set",
      deviceId: getDesktopDeviceId(dependencies.options.app)
    });
    dependencies.applySnapshot(snapshot);
    return {
      ok: true,
      lastAppliedRevision: readDesktopKanbanSyncCursor(dependencies.options.app, currentUser).lastAppliedRevision
    };
  }
  if (delivery.kind !== "command") {
    return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.kind || "unknown" }) };
  }
  const payload = deliveryPayloadRecord(delivery);
  const issue = deliveryIssuePayload(delivery);
  if (delivery.eventType === "command.dispatchIssue") {
    const result = dependencies.applyDispatch(issue, sourceRevision);
    return { ok: result.ok, message: result.message, lastAppliedRevision: cursor.lastAppliedRevision };
  }
  if (delivery.eventType === "command.runIssue" || delivery.eventType === "command.reviewIssue") {
    const commandId = readText(delivery.commandId) || `delivery:${getDesktopDeviceId(dependencies.options.app)}:${delivery.deliverySeq}`;
    const receipt = recordDesktopKanbanCommandReceipt(dependencies.options.app, currentUser, {
      commandId,
      deliverySeq: delivery.deliverySeq,
      projectId: readText(delivery.projectId) || readText(payload.projectId),
      sourceRevision,
      payload,
      issue
    });
    dependencies.notifyChanged();
    return { ok: receipt.ok, message: receipt.message, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, sourceRevision) };
  }
  return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.eventType || "unknown" }) };
}

export async function listAgents(dependencies: CommandDeliveryDependencies): Promise<DesktopPetAgentOption[]> {
  dependencies.options.onDebug?.(t("kanban.runtime.debugReadingAgents"));
  const installedAgents = readInstalledAgentOptions(dependencies.options.app);
  const localAgents = normalizeDesktopPetAgentOptions(dependencies.options.listLocalAgents?.() ?? []);
  let platformAgents: DesktopPetAgentOption[] = [];
  try {
    platformAgents = normalizeDesktopPetAgentOptions(await withTimeout(() => dependencies.options.assistantBridge.listAgents(), ASSISTANT_AGENT_LIST_TIMEOUT_MS, t("kanban.runtime.agentListTimeout")));
  }
  catch (error) {
    dependencies.options.onDebug?.(t("kanban.runtime.debugAgentListFallback", {
      message: error instanceof Error ? error.message : String(error)
    }));
  }
  const agents = normalizeDesktopPetAgentOptions([
    ...installedAgents,
    ...platformAgents,
    ...localAgents
  ]);
  dependencies.options.onDebug?.(t("kanban.runtime.debugAgentsReturned", {
    total: agents.length,
    installed: installedAgents.length,
    platform: platformAgents.length,
    cached: localAgents.length
  }));
  return agents;
}

export async function startRemoteRun(dependencies: CommandDeliveryDependencies, request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
  const currentUser = dependencies.currentUser();
  let localIssueId = "";
  if (request.issue !== undefined) {
    const dispatchResult = upsertDispatchedDesktopKanbanIssue(dependencies.options.app, currentUser, request.issue, request.revision ?? 0, "cloud_dispatch");
    dependencies.notifyChanged();
    if (!dispatchResult.ok || !dispatchResult.issue) {
      return {
        ok: false,
        runId: "",
        chatId: request.chatId?.trim() || "",
        message: dispatchResult.message
      };
    }
    localIssueId = dispatchResult.issue.id;
  }
  const chatId = request.chatId?.trim() || createKanbanRemoteChatId();
  const fallbackRunId = request.runId?.trim() || createKanbanRemoteRunId();
  const startRequest = { ...request, chatId, runId: fallbackRunId, requestId: request.requestId?.trim() || fallbackRunId };
  const startRun = dependencies.options.assistantBridge.startRun(startRequest);
  const applyRunResult = (runResult: AssistantStartRunResult) => {
    if (runResult.ok && localIssueId) {
      updateDesktopKanbanIssueRuntimeState(dependencies.options.app, currentUser, localIssueId, {
        status: "in_progress",
        chatId: runResult.chatId,
        runId: runResult.runId,
        runState: "running"
      });
      dependencies.notifyChanged();
    }
  };
  try {
    const runResult = await waitForRemoteStartRunAck(startRun, REMOTE_START_RUN_ACK_TIMEOUT_MS);
    if (runResult) {
      applyRunResult(runResult);
      return runResult;
    }
  }
  catch (error) {
    return {
      ok: false,
      runId: "",
      chatId,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  if (localIssueId) {
    updateDesktopKanbanIssueRuntimeState(dependencies.options.app, currentUser, localIssueId, {
      status: "in_progress",
      chatId,
      runId: fallbackRunId,
      runState: "running"
    });
    dependencies.notifyChanged();
  }
  void startRun.then((runResult) => {
    applyRunResult(runResult);
    if (!runResult.ok) {
      void dependencies.handleRemoteStartFailure(fallbackRunId, chatId, runResult.message)
        .catch((error) => dependencies.options.onDebug?.(error instanceof Error ? error.message : String(error)));
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void dependencies.handleRemoteStartFailure(fallbackRunId, chatId, message)
      .catch((failureError) => dependencies.options.onDebug?.(failureError instanceof Error ? failureError.message : String(failureError)));
    dependencies.options.onDebug?.(t("kanban.runtime.debugBackgroundStartFailed", { message }));
  });
  dependencies.options.onDebug?.(t("kanban.runtime.debugSlowStartRun"));
  return {
    ok: true,
    runId: fallbackRunId,
    chatId,
    message: t("kanban.runtime.dispatchedStarting")
  };
}

export async function handleRemoteStartFailure(dependencies: CommandDeliveryDependencies, runId: string, chatId: string, message: string) {
  const currentUser = dependencies.currentUser();
  const manualReceipt = getDesktopKanbanManualRunByRunId(dependencies.options.app, currentUser, runId);
  const commandReceipt = getDesktopKanbanCommandReceiptByRunId(dependencies.options.app, currentUser, runId);
  const matchingCloudIssue = listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues.find((issue) => issueSyncMode(issue) === "cloud" && ((manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
    (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)));
  if (!matchingCloudIssue && !manualReceipt && !commandReceipt) {
    return;
  }
  if (manualReceipt) {
    updateDesktopKanbanManualRun(dependencies.options.app, currentUser, runId, "failed", message);
  }
  await dependencies.appendRunEvent({
    projectId: commandReceipt?.projectId || manualReceipt?.projectId || matchingCloudIssue?.projectId || "",
    issueId: commandReceipt?.issueId || manualReceipt?.issueId || (matchingCloudIssue ? getRemoteIssueId(matchingCloudIssue) : ""),
    issueRunId: commandReceipt?.issueRunId || manualReceipt?.issueRunId,
    runId,
    chatId: chatId || commandReceipt?.chatId,
    eventType: "run.failed",
    payload: {
      ...(manualReceipt ? { source: "desktop_manual", agentKey: manualReceipt.agentKey } : {}),
      ...(commandReceipt ? { commandId: commandReceipt.commandId, agentKey: optionalText(commandReceipt.payload.agentKey) } : {}),
      status: "failed",
      runState: "failed",
      runId,
      chatId: chatId || commandReceipt?.chatId,
      error: message,
    },
  });
  if (commandReceipt) {
    completeDesktopKanbanCommandReceiptByRunId(dependencies.options.app, currentUser, runId, "failed");
  }
}
