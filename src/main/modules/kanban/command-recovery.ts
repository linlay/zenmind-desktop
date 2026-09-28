import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  KanbanCurrentUser
} from "../../../shared/contracts";
import {
  listPendingDesktopKanbanCommandReceipts,
  markDesktopKanbanCommandReceiptReported,
  updateDesktopKanbanCommandReceipt,
  updateDesktopKanbanCommandReceiptIdentity,
  type KanbanCommandReceipt
} from "./local-store";
import { isRecord, optionalText, readText } from "./protocol-values";
import { createKanbanRemoteChatId, normalizeRemoteAccessLevel, parseStructuredReviewText } from "./run-policy";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopWsClient
} from "./ws-client";

export interface CommandRecoveryDependencies {
  commandReceiptProcessing: boolean;
  currentUser(): KanbanCurrentUser;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "assistantBridge" | "onDebug">;
  reportFailedCommandReceipt(receipt: KanbanCommandReceipt, error: string): Promise<void>;
  inspectReceiptRun(chatId: string, runId: string): Promise<{ exists: boolean; terminalEventType?: "run.completed" | "run.failed" | "run.cancelled"; message?: string; error?: string; }>;
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
  localChatExists(chatId: string): Promise<boolean>;
  startRemoteRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult>;
  scheduleCommandReceiptRecovery(): void;
  commandReceiptRetryTimer: NodeJS.Timeout | null;
  readonly wsClient: Pick<KanbanDesktopWsClient, "isOpen">;
  processPendingCommandReceipts(): Promise<void>;
}

export async function processPendingCommandReceipts(dependencies: CommandRecoveryDependencies) {
  if (dependencies.commandReceiptProcessing)
    return;
  dependencies.commandReceiptProcessing = true;
  try {
    const currentUser = dependencies.currentUser();
    const receipts = listPendingDesktopKanbanCommandReceipts(dependencies.options.app, currentUser);
    for (const receipt of receipts) {
      if (receipt.state === "failed") {
        await dependencies.reportFailedCommandReceipt(receipt, receipt.lastError || "Desktop failed to start the command");
        continue;
      }
      const recovery = receipt.state === "starting" || receipt.state === "started"
        ? await dependencies.inspectReceiptRun(receipt.chatId, receipt.runId)
        : { exists: false as const, terminalEventType: undefined, message: undefined, error: undefined };
      if (recovery.terminalEventType) {
        const reviewResult = receipt.commandType === "review" && recovery.terminalEventType === "run.completed"
          ? await dependencies.readStructuredReviewResult(receipt.chatId, receipt.runId)
          : undefined;
        await dependencies.appendRunEvent({
          sourceDeliverySeq: receipt.deliverySeq,
          projectId: receipt.projectId,
          issueId: receipt.issueId,
          issueRunId: receipt.issueRunId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          eventType: recovery.terminalEventType,
          payload: {
            status: recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed",
            commandId: receipt.commandId,
            runId: receipt.runId,
            chatId: receipt.chatId,
            message: recovery.message,
            error: recovery.error,
            ...(reviewResult ? { reviewResult } : {})
          }
        });
        updateDesktopKanbanCommandReceipt(dependencies.options.app, currentUser, receipt.commandId, recovery.terminalEventType === "run.completed" ? "completed" : "failed");
        continue;
      }
      if (!recovery.exists) {
        updateDesktopKanbanCommandReceipt(dependencies.options.app, currentUser, receipt.commandId, "starting", null, true);
        const issue = receipt.payload.issue;
        const issueRevision = isRecord(issue) && typeof issue.revision === "number" ? issue.revision : 0;
        const preferredChatId = readText(receipt.payload.preferredChatId);
        const preferredChatMissing = preferredChatId === receipt.chatId && !await dependencies.localChatExists(preferredChatId);
        const requiresNewChat = receipt.commandType === "review" || receipt.payload.forceNewChat === true || readText(receipt.payload.chatPolicy) === "new" || preferredChatMissing;
        if (requiresNewChat) {
          const freshChatId = createKanbanRemoteChatId();
          updateDesktopKanbanCommandReceiptIdentity(dependencies.options.app, currentUser, receipt.commandId, freshChatId, receipt.runId);
          receipt.chatId = freshChatId;
        }
        const runResult = await dependencies.startRemoteRun({
          issue,
          revision: issueRevision,
          agentKey: optionalText(receipt.payload.agentKey),
          accessLevel: normalizeRemoteAccessLevel(receipt.payload.accessLevel),
          chatId: receipt.chatId,
          runId: receipt.runId,
          requestId: receipt.requestId,
          message: readText(receipt.payload.message),
          source: "sidebar"
        });
        if (!runResult.ok) {
          updateDesktopKanbanCommandReceipt(dependencies.options.app, currentUser, receipt.commandId, "failed", runResult.message);
          await dependencies.reportFailedCommandReceipt(receipt, runResult.message);
          continue;
        }
      }
      updateDesktopKanbanCommandReceipt(dependencies.options.app, currentUser, receipt.commandId, "started");
      const preferredChatId = readText(receipt.payload.preferredChatId);
      const missingPreferredChatId = receipt.commandType === "run" && preferredChatId && receipt.chatId !== preferredChatId &&
        receipt.payload.forceNewChat !== true && readText(receipt.payload.chatPolicy) !== "new"
        ? preferredChatId
        : "";
      await dependencies.appendRunEvent({
        sourceDeliverySeq: receipt.deliverySeq,
        projectId: receipt.projectId,
        issueId: receipt.issueId,
        issueRunId: receipt.issueRunId,
        runId: receipt.runId,
        chatId: receipt.chatId,
        eventType: "run.started",
        payload: {
          status: "running",
          agentKey: optionalText(receipt.payload.agentKey),
          commandId: receipt.commandId,
          runId: receipt.runId,
          chatId: receipt.chatId,
          ...(missingPreferredChatId ? { missingPreferredChatId } : {})
        }
      });
    }
  }
  finally {
    dependencies.commandReceiptProcessing = false;
    dependencies.scheduleCommandReceiptRecovery();
  }
}

export async function inspectReceiptRun(dependencies: CommandRecoveryDependencies, chatId: string, runId: string): Promise<{
  exists: boolean;
  terminalEventType?: "run.completed" | "run.failed" | "run.cancelled";
  message?: string;
  error?: string;
}> {
  if (!dependencies.options.assistantBridge.getChat)
    return { exists: false };
  try {
    const detail = await dependencies.options.assistantBridge.getChat(chatId);
    const events = (detail?.events ?? []).filter((event) => event.runId === runId).sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
    const terminal = [...events].reverse().find((event) => ["run.complete", "run.error", "run.stopped", "run.interrupt", "run.expired"].includes(readText(event.type)));
    if (terminal) {
      const type = readText(terminal.type);
      return {
        exists: true,
        terminalEventType: type === "run.complete" ? "run.completed" : type === "run.stopped" || type === "run.interrupt" ? "run.cancelled" : "run.failed",
        message: readText(terminal.message) || undefined,
        error: readText(terminal.error) || undefined
      };
    }
    return {
      exists: Boolean(detail?.messages?.some((message) => message.runId === runId) || events.length > 0)
    };
  }
  catch {
    return { exists: false };
  }
}

export async function localChatExists(dependencies: CommandRecoveryDependencies, chatId: string) {
  if (!chatId || !dependencies.options.assistantBridge.getChat)
    return true;
  try {
    return Boolean(await dependencies.options.assistantBridge.getChat(chatId));
  }
  catch {
    return false;
  }
}

export async function readStructuredReviewResult(dependencies: CommandRecoveryDependencies, chatId: string, runId: string) {
  if (!dependencies.options.assistantBridge.getChat)
    return undefined;
  try {
    const detail = await dependencies.options.assistantBridge.getChat(chatId);
    const messages = (detail?.messages ?? []).filter((message) => message.runId === runId);
    for (const message of [...messages].reverse()) {
      const parsed = parseStructuredReviewText(readText(message.content));
      if (parsed)
        return parsed;
    }
  }
  catch {
    return undefined;
  }
  return undefined;
}

export async function reportFailedCommandReceipt(dependencies: CommandRecoveryDependencies, receipt: KanbanCommandReceipt, error: string) {
  await dependencies.appendRunEvent({
    sourceDeliverySeq: receipt.deliverySeq,
    projectId: receipt.projectId,
    issueId: receipt.issueId,
    issueRunId: receipt.issueRunId,
    runId: receipt.runId,
    chatId: receipt.chatId,
    eventType: "run.failed",
    payload: {
      status: "failed",
      commandId: receipt.commandId,
      runId: receipt.runId,
      chatId: receipt.chatId,
      error
    }
  });
  markDesktopKanbanCommandReceiptReported(dependencies.options.app, dependencies.currentUser(), receipt.commandId);
}

export function scheduleCommandReceiptRecovery(dependencies: CommandRecoveryDependencies) {
  if (dependencies.commandReceiptRetryTimer)
    clearTimeout(dependencies.commandReceiptRetryTimer);
  const pending = listPendingDesktopKanbanCommandReceipts(dependencies.options.app, dependencies.currentUser());
  if (pending.length === 0 || !dependencies.wsClient.isOpen()) {
    dependencies.commandReceiptRetryTimer = null;
    return;
  }
  dependencies.commandReceiptRetryTimer = setTimeout(() => {
    dependencies.commandReceiptRetryTimer = null;
    void dependencies.processPendingCommandReceipts().catch((error) => dependencies.options.onDebug?.(error instanceof Error ? error.message : String(error)));
  }, 5000);
}
