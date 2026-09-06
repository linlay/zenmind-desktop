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

import { appendKanbanWsLog } from "../../support/logging/desktop";import { KanbanRuntimeMethodContext, buildDesktopKanbanRunPrompt, getKanbanDeviceInfo, getRemoteIssueId, issueEventIssueId, issueEventIssuePayload, issueSyncMode, optionalText, readText, resolveKanbanRunFinishedPush, resolveKanbanWsConnection, stableClientEventId } from "./runtime.shared";



export async function KanbanRuntime_sendCloudMutation_1(self: KanbanRuntimeMethodContext, item: ReturnType<typeof listDesktopKanbanCloudMutations>[number]): Promise<{ ok: boolean; message: string; issue?: KanbanIssue }> {
    const currentUser = self.currentUser();
    try {
        const result = await self.wsClient.requestWithId<{
            ok?: boolean;
            message?: string;
            issue?: unknown;
            revision?: number;
        }>(item.requestType, item.payload, item.id, undefined, item.projectId);
        if (result.ok === false) {
            deleteDesktopKanbanCloudMutation(self.options.app, currentUser, item.id);
            return { ok: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: item.requestType }) };
        }
        let issue: KanbanIssue | undefined;
        if (result.issue) {
            const applied = upsertDispatchedDesktopKanbanIssue(self.options.app, currentUser, result.issue, Number(result.revision) || 0, "cloud_dispatch");
            issue = applied.issue;
        }
        deleteDesktopKanbanCloudMutation(self.options.app, currentUser, item.id);
        self.notifyChanged();
        return { ok: true, message: readText(result.message) || t("kanban.claim.succeeded"), issue };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof KanbanDesktopRequestError) {
            deleteDesktopKanbanCloudMutation(self.options.app, currentUser, item.id);
        }
        else {
            markDesktopKanbanCloudMutationAttempt(self.options.app, currentUser, item.id, message);
        }
        return { ok: false, message };
    }
}

export async function KanbanRuntime_flushCloudOutboxes_2(self: KanbanRuntimeMethodContext) {
    await self.flushCloudMutationOutbox();
    await self.flushRunEventOutbox();
}

export async function KanbanRuntime_flushCloudMutationOutbox_3(self: KanbanRuntimeMethodContext) {
    if (self.cloudMutationProcessing || !self.wsClient.isOpen())
        return;
    self.cloudMutationProcessing = true;
    try {
        for (const item of listDesktopKanbanCloudMutations(self.options.app, self.currentUser())) {
            const result = await self.sendCloudMutation(item);
            if (!result.ok && !self.wsClient.isOpen())
                break;
        }
    }
    finally {
        self.cloudMutationProcessing = false;
    }
}

export async function KanbanRuntime_flushRunEventOutbox_4(self: KanbanRuntimeMethodContext) {
    if (self.runEventProcessing || !self.wsClient.isOpen())
        return;
    self.runEventProcessing = true;
    try {
        for (const item of listDesktopKanbanRunEvents(self.options.app, self.currentUser())) {
            const result = await self.sendRunEventOutboxItem(item);
            if (!result.accepted && !result.queued) {
                await self.handleRejectedRunEvent(item, result.message);
                continue;
            }
            if (result.queued)
                break;
        }
    }
    finally {
        self.runEventProcessing = false;
    }
}

export async function KanbanRuntime_sendRunEventOutboxItem_5(self: KanbanRuntimeMethodContext, item: ReturnType<typeof listDesktopKanbanRunEvents>[number]) {
    const currentUser = self.currentUser();
    if (!self.wsClient.isOpen()) {
        return { accepted: false, queued: true, message: t("kanban.cloudSync.notConnected") };
    }
    try {
        const result = await self.wsClient.requestWithId<{
            ok?: boolean;
            message?: string;
        }>("run.event.append", {
            deviceId: getDesktopDeviceId(self.options.app),
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
            deleteDesktopKanbanRunEvent(self.options.app, currentUser, item.clientEventId);
            return { accepted: false, queued: false, message: readText(result.message) || t("kanban.ws.operationFailed", { type: "run.event.append" }) };
        }
        deleteDesktopKanbanRunEvent(self.options.app, currentUser, item.clientEventId);
        return { accepted: true, queued: false, message: readText(result?.message) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof KanbanDesktopRequestError) {
            deleteDesktopKanbanRunEvent(self.options.app, currentUser, item.clientEventId);
            return { accepted: false, queued: false, message };
        }
        markDesktopKanbanRunEventAttempt(self.options.app, currentUser, item.clientEventId, message);
        return { accepted: false, queued: true, message };
    }
}

export async function KanbanRuntime_handleRejectedRunEvent_6(self: KanbanRuntimeMethodContext, item: ReturnType<typeof listDesktopKanbanRunEvents>[number], message: string) {
    if (item.eventType !== "run.started" || readText(item.payload.source) !== "desktop_manual")
        return;
    await self.options.assistantBridge.stopRun?.(item.runId).catch(() => undefined);
    updateDesktopKanbanManualRun(self.options.app, self.currentUser(), item.runId, "failed", message);
}

export async function KanbanRuntime_recoverPendingManualRuns_7(self: KanbanRuntimeMethodContext) {
    if (!self.wsClient.isOpen())
        return;
    const currentUser = self.currentUser();
    const issues = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues;
    for (const receipt of listPendingDesktopKanbanManualRuns(self.options.app, currentUser)) {
        const recovery = await self.inspectReceiptRun(receipt.chatId, receipt.runId);
        const issue = issues.find((candidate) => issueSyncMode(candidate) === "cloud" && getRemoteIssueId(candidate) === receipt.issueId);
        if (recovery.terminalEventType) {
            await self.appendRunEvent({
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
            updateDesktopKanbanManualRun(self.options.app, currentUser, receipt.runId, recovery.terminalEventType === "run.completed" ? "completed" : recovery.terminalEventType === "run.cancelled" ? "cancelled" : "failed", recovery.error ?? null);
            continue;
        }
        if (!recovery.exists && receipt.state === "starting") {
            if (!issue) {
                updateDesktopKanbanManualRun(self.options.app, currentUser, receipt.runId, "failed", t("kanban.runtime.missing"));
                continue;
            }
            const result = await self.options.assistantBridge.startRun({
                agentKey: receipt.agentKey,
                chatId: receipt.chatId,
                runId: receipt.runId,
                requestId: receipt.runId,
                message: buildDesktopKanbanRunPrompt(issue),
                source: "sidebar"
            });
            if (!result.ok) {
                updateDesktopKanbanManualRun(self.options.app, currentUser, receipt.runId, "failed", result.message);
                await self.appendRunEvent({
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
            updateDesktopKanbanManualRun(self.options.app, currentUser, receipt.runId, "started");
        }
        const started = await self.appendRunEvent({
            projectId: receipt.projectId,
            issueId: receipt.issueId,
            issueRunId: receipt.issueRunId,
            runId: receipt.runId,
            chatId: receipt.chatId,
            eventType: "run.started",
            payload: { source: "desktop_manual", status: "running", agentKey: receipt.agentKey, runId: receipt.runId, chatId: receipt.chatId }
        });
        if (!started.accepted && !started.queued) {
            await self.handleRejectedRunEvent({
                clientEventId: stableClientEventId(getDesktopDeviceId(self.options.app), [receipt.issueId, receipt.runId, "run.started"]),
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

export function KanbanRuntime_sendNavigationPushEvent_8(self: KanbanRuntimeMethodContext, event: AssistantNavigationPushEvent) {
    self.refreshConnection();
    const runId = event.runId?.trim() ?? "";
    const semanticTime = event.type === "run.started" ? event.startedAt : event.finishedAt;
    if (event.frame !== "push" ||
        (event.type !== "run.started" && event.type !== "run.finished") ||
        !runId ||
        !isAgentPlatformEpochMilliseconds(semanticTime)) {
        self.options.onDebug?.(`ignored invalid navigation push: frame=${event.frame || ""} type=${event.type || ""} runId=${runId} semanticTime=${String(semanticTime ?? "")}`);
        return;
    }
    const currentUser = self.currentUser();
    const issues = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues;
    const matchingLocalIssue = issues.find((issue) => issueSyncMode(issue) !== "cloud" && (issue.runId === runId || issue.activeRunId === runId));
    if (event.type === "run.started") {
        if (!matchingLocalIssue) {
            return;
        }
        const result = updateDesktopKanbanIssueRuntimeState(self.options.app, currentUser, matchingLocalIssue.id, {
            status: "in_progress",
            chatId: event.chatId || matchingLocalIssue.chatId,
            runId,
            runState: "running",
        });
        if (result.ok) {
            self.notifyChanged();
        }
        return;
    }
    const terminal = resolveKanbanRunFinishedPush(event);
    if (!terminal) {
        self.options.onDebug?.(`ignored invalid run.finished protocol: runId=${runId} status=${event.status || ""} finishReason=${event.finishReason || ""}`);
        return;
    }
    self.options.onDebug?.(`accepted navigation run.finished: runId=${runId} status=${event.status} finishReason=${event.finishReason} runState=${terminal.runState}`);
    if (matchingLocalIssue) {
        const result = updateDesktopKanbanIssueRuntimeState(self.options.app, currentUser, matchingLocalIssue.id, {
            status: terminal.status,
            chatId: event.chatId || matchingLocalIssue.chatId,
            runId: null,
            runState: terminal.runState,
        });
        if (result.ok) {
            self.notifyChanged();
        }
        return;
    }
    const manualReceipt = getDesktopKanbanManualRunByRunId(self.options.app, currentUser, runId);
    const commandReceipt = getDesktopKanbanCommandReceiptByRunId(self.options.app, currentUser, runId);
    const matchingCloudIssue = issues.find((issue) => issueSyncMode(issue) === "cloud" && ((manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
        (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)));
    if (matchingCloudIssue || manualReceipt || commandReceipt) {
        const commandId = commandReceipt?.commandId || readText(matchingCloudIssue?.dispatchCommandId);
        if (manualReceipt) {
            updateDesktopKanbanManualRun(self.options.app, currentUser, runId, terminal.runState === "completed" ? "completed" : terminal.runState === "cancelled" ? "cancelled" : "failed", null);
        }
        void (async () => {
            const reviewResult = commandReceipt?.commandType === "review" && terminal.terminalEventType === "run.completed"
                ? await self.readStructuredReviewResult(commandReceipt.chatId, runId)
                : undefined;
            await self.appendRunEvent({
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
                completeDesktopKanbanCommandReceiptByRunId(self.options.app, currentUser, runId, terminal.runState === "completed" ? "completed" : "failed");
            }
        })().catch((error) => self.options.onDebug?.(error instanceof Error ? error.message : String(error)));
    }
}

export function KanbanRuntime_currentUser_9(self: KanbanRuntimeMethodContext): KanbanCurrentUser {
    const user = self.options.canUseDesktopSsoCredentials?.() === false
        ? null
        : readDesktopSsoAccessTokenUser(self.options.app);
    if (user?.sub?.trim()) {
        return {
            id: user.sub.trim(),
            name: user.name?.trim() || user.email?.trim() || user.sub.trim(),
            email: user.email?.trim() || "",
            source: "sso"
        };
    }
    const deviceId = getDesktopDeviceId(self.options.app);
    const deviceInfo = getKanbanDeviceInfo(self.options.app);
    return {
        id: `device:${deviceId}`,
        name: deviceInfo.deviceName,
        email: "",
        source: "device"
    };
}

export function KanbanRuntime_refreshConnection_10(self: KanbanRuntimeMethodContext, options: { forceReconnect?: boolean } = {}) {
    const resolution = resolveKanbanWsConnection(self.options.app, self.options.canUseDesktopSsoCredentials?.() !== false);
    self.connectionFallbackState = resolution.fallbackState;
    self.wsClient.start(resolution.config, options.forceReconnect ? { forceReconnect: true } : undefined);
    self.connectionState = resolution.config ? self.wsClient.getState() : resolution.fallbackState;
}

export function KanbanRuntime_applySnapshot_11(self: KanbanRuntimeMethodContext, snapshot: KanbanCloudSnapshot) {
    applyDesktopKanbanCloudSnapshot(self.options.app, self.currentUser(), snapshot);
    self.notifyChanged();
}

export function KanbanRuntime_applyDispatch_12(self: KanbanRuntimeMethodContext, issue: unknown, revision: number): KanbanIssueResult {
    const result = upsertDispatchedDesktopKanbanIssue(self.options.app, self.currentUser(), issue, revision, "cloud_dispatch");
    self.notifyChanged();
    return result;
}

export function KanbanRuntime_cloudIssueReadOnlyResult_13(self: KanbanRuntimeMethodContext): KanbanIssueResult {
    return {
        ok: false,
        message: t("kanban.runtime.cloudReadOnly"),
        issues: listDesktopKanbanIssues(self.options.app, self.currentUser(), self.connectionState).issues
    };
}

export function KanbanRuntime_cloudIssueReadOnlyDeleteResult_14(self: KanbanRuntimeMethodContext, issues: KanbanIssue[]): { ok: false; message: string; issues: KanbanIssue[] } {
    return {
        ok: false,
        message: t("kanban.runtime.cloudReadOnly"),
        issues
    };
}

export async function KanbanRuntime_applyIssueEvent_15(self: KanbanRuntimeMethodContext, event: KanbanDesktopIssueEvent): Promise<KanbanDesktopIssueEventApplyResult> {
    const currentUser = self.currentUser();
    const cursor = readDesktopKanbanSyncCursor(self.options.app, currentUser);
    const seq = Math.max(0, Math.floor(event.seq));
    if (seq <= 0) {
        return { ok: false, message: t("kanban.ws.unsupportedBusiness", { type: event.eventType || "unknown" }) };
    }
    if (seq <= cursor.lastAppliedRevision) {
        return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
    }
    const issuePayload = issueEventIssuePayload(event);
    const scopedTombstone = !issuePayload && Boolean(event.deletedIssueId || event.issueId);
    if (event.eventType === "issue.deleted" || scopedTombstone || (event.toProjectId && !hasDesktopKanbanCloudProject(self.options.app, currentUser, event.toProjectId))) {
        tombstoneDesktopKanbanCloudIssue(self.options.app, currentUser, issueEventIssueId(event), seq);
    }
    else {
        const issue = issuePayload;
        if (!issue) {
            return { ok: false, message: t("kanban.runtime.dispatchInvalid") };
        }
        const result = upsertDispatchedDesktopKanbanIssue(self.options.app, currentUser, issue, seq, "cloud_dispatch");
        if (!result.ok) {
            return { ok: false, message: result.message };
        }
    }
    writeDesktopKanbanSyncCursor(self.options.app, currentUser, { lastAppliedRevision: seq });
    self.notifyChanged();
    return {
        ok: true,
        lastAppliedRevision: Math.max(cursor.lastAppliedRevision, seq)
    };
}
