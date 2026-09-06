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

import { appendKanbanWsLog } from "../../support/logging/desktop";import { ASSISTANT_AGENT_LIST_TIMEOUT_MS, DEFAULT_SELECTED_PROJECT_ID, KanbanRuntimeMethodContext, REMOTE_START_RUN_ACK_TIMEOUT_MS, createKanbanRemoteChatId, createKanbanRemoteRunId, deliveryIssuePayload, deliveryPayloadRecord, deliverySourceRevision, isRecord, normalizeDesktopPetAgentOptions, normalizeRemoteAccessLevel, optionalText, parseStructuredReviewText, readInstalledAgentOptions, readStringList, readText, stableClientEventId, waitForRemoteStartRunAck, withTimeout } from "./runtime.shared";



export async function KanbanRuntime_applyDelivery_1(self: KanbanRuntimeMethodContext, delivery: KanbanDesktopDelivery): Promise<KanbanDesktopDeliveryApplyResult> {
    const currentUser = self.currentUser();
    const cursor = readDesktopKanbanSyncCursor(self.options.app, currentUser);
    const sourceRevision = deliverySourceRevision(delivery);
    if (delivery.kind === "snapshot_reset") {
        const snapshot = await self.wsClient.request<KanbanCloudSnapshot>("snapshot.get", {
            scope: "project_set",
            deviceId: getDesktopDeviceId(self.options.app)
        });
        self.applySnapshot(snapshot);
        return {
            ok: true,
            lastAppliedRevision: readDesktopKanbanSyncCursor(self.options.app, currentUser).lastAppliedRevision
        };
    }
    if (delivery.kind !== "command") {
        return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.kind || "unknown" }) };
    }
    const payload = deliveryPayloadRecord(delivery);
    const issue = deliveryIssuePayload(delivery);
    if (delivery.eventType === "command.dispatchIssue") {
        const result = self.applyDispatch(issue, sourceRevision);
        return { ok: result.ok, message: result.message, lastAppliedRevision: cursor.lastAppliedRevision };
    }
    if (delivery.eventType === "command.runIssue" || delivery.eventType === "command.reviewIssue") {
        const commandId = readText(delivery.commandId) || `delivery:${getDesktopDeviceId(self.options.app)}:${delivery.deliverySeq}`;
        const receipt = recordDesktopKanbanCommandReceipt(self.options.app, currentUser, {
            commandId,
            deliverySeq: delivery.deliverySeq,
            projectId: readText(delivery.projectId) || readText(payload.projectId),
            sourceRevision,
            payload,
            issue
        });
        self.notifyChanged();
        return { ok: receipt.ok, message: receipt.message, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, sourceRevision) };
    }
    return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: delivery.eventType || "unknown" }) };
}

export async function KanbanRuntime_processPendingCommandReceipts_2(self: KanbanRuntimeMethodContext) {
    if (self.commandReceiptProcessing)
        return;
    self.commandReceiptProcessing = true;
    try {
        const currentUser = self.currentUser();
        const receipts = listPendingDesktopKanbanCommandReceipts(self.options.app, currentUser);
        for (const receipt of receipts) {
            if (receipt.state === "failed") {
                await self.reportFailedCommandReceipt(receipt, receipt.lastError || "Desktop failed to start the command");
                continue;
            }
            const recovery = receipt.state === "starting" || receipt.state === "started"
                ? await self.inspectReceiptRun(receipt.chatId, receipt.runId)
                : { exists: false as const, terminalEventType: undefined, message: undefined, error: undefined };
            if (recovery.terminalEventType) {
                const reviewResult = receipt.commandType === "review" && recovery.terminalEventType === "run.completed"
                    ? await self.readStructuredReviewResult(receipt.chatId, receipt.runId)
                    : undefined;
                await self.appendRunEvent({
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
                updateDesktopKanbanCommandReceipt(self.options.app, currentUser, receipt.commandId, recovery.terminalEventType === "run.completed" ? "completed" : "failed");
                continue;
            }
            if (!recovery.exists) {
                updateDesktopKanbanCommandReceipt(self.options.app, currentUser, receipt.commandId, "starting", null, true);
                const issue = receipt.payload.issue;
                const issueRevision = isRecord(issue) && typeof issue.revision === "number" ? issue.revision : 0;
                const preferredChatId = readText(receipt.payload.preferredChatId);
                const preferredChatMissing = preferredChatId === receipt.chatId && !await self.localChatExists(preferredChatId);
                const requiresNewChat = receipt.commandType === "review" || receipt.payload.forceNewChat === true || readText(receipt.payload.chatPolicy) === "new" || preferredChatMissing;
                if (requiresNewChat) {
                    const freshChatId = createKanbanRemoteChatId();
                    updateDesktopKanbanCommandReceiptIdentity(self.options.app, currentUser, receipt.commandId, freshChatId, receipt.runId);
                    receipt.chatId = freshChatId;
                }
                const runResult = await self.startRemoteRun({
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
                    updateDesktopKanbanCommandReceipt(self.options.app, currentUser, receipt.commandId, "failed", runResult.message);
                    await self.reportFailedCommandReceipt(receipt, runResult.message);
                    continue;
                }
            }
            updateDesktopKanbanCommandReceipt(self.options.app, currentUser, receipt.commandId, "started");
            const preferredChatId = readText(receipt.payload.preferredChatId);
            const missingPreferredChatId = receipt.commandType === "run" && preferredChatId && receipt.chatId !== preferredChatId &&
                receipt.payload.forceNewChat !== true && readText(receipt.payload.chatPolicy) !== "new"
                ? preferredChatId
                : "";
            await self.appendRunEvent({
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
        self.commandReceiptProcessing = false;
        self.scheduleCommandReceiptRecovery();
    }
}

export async function KanbanRuntime_inspectReceiptRun_3(self: KanbanRuntimeMethodContext, chatId: string, runId: string): Promise<{
    exists: boolean;
    terminalEventType?: "run.completed" | "run.failed" | "run.cancelled";
    message?: string;
    error?: string;
  }> {
    if (!self.options.assistantBridge.getChat)
        return { exists: false };
    try {
        const detail = await self.options.assistantBridge.getChat(chatId);
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

export async function KanbanRuntime_localChatExists_4(self: KanbanRuntimeMethodContext, chatId: string) {
    if (!chatId || !self.options.assistantBridge.getChat)
        return true;
    try {
        return Boolean(await self.options.assistantBridge.getChat(chatId));
    }
    catch {
        return false;
    }
}

export async function KanbanRuntime_readStructuredReviewResult_5(self: KanbanRuntimeMethodContext, chatId: string, runId: string) {
    if (!self.options.assistantBridge.getChat)
        return undefined;
    try {
        const detail = await self.options.assistantBridge.getChat(chatId);
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

export async function KanbanRuntime_reportFailedCommandReceipt_6(self: KanbanRuntimeMethodContext, receipt: KanbanCommandReceipt, error: string) {
    await self.appendRunEvent({
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
    markDesktopKanbanCommandReceiptReported(self.options.app, self.currentUser(), receipt.commandId);
}

export function KanbanRuntime_scheduleCommandReceiptRecovery_7(self: KanbanRuntimeMethodContext) {
    if (self.commandReceiptRetryTimer)
        clearTimeout(self.commandReceiptRetryTimer);
    const pending = listPendingDesktopKanbanCommandReceipts(self.options.app, self.currentUser());
    if (pending.length === 0 || !self.wsClient.isOpen()) {
        self.commandReceiptRetryTimer = null;
        return;
    }
    self.commandReceiptRetryTimer = setTimeout(() => {
        self.commandReceiptRetryTimer = null;
        void self.processPendingCommandReceipts().catch((error) => self.options.onDebug?.(error instanceof Error ? error.message : String(error)));
    }, 5000);
}

export async function KanbanRuntime_appendRunEvent_8(self: KanbanRuntimeMethodContext, input: {
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
    const deviceId = getDesktopDeviceId(self.options.app);
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
    recordDesktopKanbanRunEvent(self.options.app, self.currentUser(), item);
    const result = await self.sendRunEventOutboxItem({
        ...item,
        attemptCount: 0,
        lastError: null
    });
    if (!result.accepted && !result.queued) {
        await self.handleRejectedRunEvent({ ...item, attemptCount: 0, lastError: null }, result.message);
    }
    return result;
}

export function KanbanRuntime_createLocalProject_9(self: KanbanRuntimeMethodContext, payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const result = createLocalDesktopProject(self.options.app, self.currentUser(), {
        id: readText(record.localProjectId),
        name: readText(record.name),
        versions: readStringList(record.versions),
        components: readStringList(record.components)
    });
    if (result.ok) {
        self.notifyChanged();
    }
    return result;
}

export function KanbanRuntime_bindLocalProject_10(self: KanbanRuntimeMethodContext, payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const localProjectId = readText(record.localProjectId);
    if (!localProjectId) {
        return { ok: false, message: t("kanban.localProject.idRequired") };
    }
    const project = findLocalDesktopProject(self.options.app, self.currentUser(), localProjectId);
    if (!project) {
        return { ok: false, message: t("kanban.localProject.notFound") };
    }
    return {
        ok: true,
        message: t("kanban.localProject.bindConfirmed"),
        project: { id: project.id, name: project.name, slug: project.slug, path: project.path }
    };
}

export function KanbanRuntime_unbindLocalProject_11(self: KanbanRuntimeMethodContext, payload: unknown) {
    const record = isRecord(payload) ? payload : {};
    const localProjectId = readText(record.localProjectId);
    const converted = localProjectId
        ? convertLocalProjectIssuesToLocal(self.options.app, self.currentUser(), localProjectId)
        : 0;
    if (converted > 0) {
        self.notifyChanged();
    }
    return {
        ok: true,
        message: converted > 0
            ? t("kanban.localProject.unboundWithConverted", { count: converted })
            : t("kanban.localProject.unboundConfirmed")
    };
}

export async function KanbanRuntime_listAgents_12(self: KanbanRuntimeMethodContext): Promise<DesktopPetAgentOption[]> {
    self.options.onDebug?.(t("kanban.runtime.debugReadingAgents"));
    const installedAgents = readInstalledAgentOptions(self.options.app);
    const localAgents = normalizeDesktopPetAgentOptions(self.options.listLocalAgents?.() ?? []);
    let platformAgents: DesktopPetAgentOption[] = [];
    try {
        platformAgents = normalizeDesktopPetAgentOptions(await withTimeout(() => self.options.assistantBridge.listAgents(), ASSISTANT_AGENT_LIST_TIMEOUT_MS, t("kanban.runtime.agentListTimeout")));
    }
    catch (error) {
        self.options.onDebug?.(t("kanban.runtime.debugAgentListFallback", {
            message: error instanceof Error ? error.message : String(error)
        }));
    }
    const agents = normalizeDesktopPetAgentOptions([
        ...installedAgents,
        ...platformAgents,
        ...localAgents
    ]);
    self.options.onDebug?.(t("kanban.runtime.debugAgentsReturned", {
        total: agents.length,
        installed: installedAgents.length,
        platform: platformAgents.length,
        cached: localAgents.length
    }));
    return agents;
}

export async function KanbanRuntime_startRemoteRun_13(self: KanbanRuntimeMethodContext, request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const currentUser = self.currentUser();
    let localIssueId = "";
    if (request.issue !== undefined) {
        const dispatchResult = upsertDispatchedDesktopKanbanIssue(self.options.app, currentUser, request.issue, request.revision ?? 0, "cloud_dispatch");
        self.notifyChanged();
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
    const startRun = self.options.assistantBridge.startRun(startRequest);
    const applyRunResult = (runResult: AssistantStartRunResult) => {
        if (runResult.ok && localIssueId) {
            updateDesktopKanbanIssueRuntimeState(self.options.app, currentUser, localIssueId, {
                status: "in_progress",
                chatId: runResult.chatId,
                runId: runResult.runId,
                runState: "running"
            });
            self.notifyChanged();
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
        updateDesktopKanbanIssueRuntimeState(self.options.app, currentUser, localIssueId, {
            status: "in_progress",
            chatId,
            runId: fallbackRunId,
            runState: "running"
        });
        self.notifyChanged();
    }
    void startRun.then((runResult) => {
        applyRunResult(runResult);
        if (!runResult.ok) {
            void self.handleRemoteStartFailure(fallbackRunId, chatId, runResult.message)
                .catch((error) => self.options.onDebug?.(error instanceof Error ? error.message : String(error)));
        }
    }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        void self.handleRemoteStartFailure(fallbackRunId, chatId, message)
            .catch((failureError) => self.options.onDebug?.(failureError instanceof Error ? failureError.message : String(failureError)));
        self.options.onDebug?.(t("kanban.runtime.debugBackgroundStartFailed", { message }));
    });
    self.options.onDebug?.(t("kanban.runtime.debugSlowStartRun"));
    return {
        ok: true,
        runId: fallbackRunId,
        chatId,
        message: t("kanban.runtime.dispatchedStarting")
    };
}
