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

import { appendKanbanWsLog } from "../../support/logging/desktop";import { AgentPlatformCaller, DEFAULT_SELECTED_PROJECT_ID, KanbanRuntimeMethodContext, buildDesktopKanbanRunPrompt, createKanbanRemoteChatId, createKanbanRemoteRunId, getKanbanConfigPath, getRemoteIssueId, issueSyncMode, readKanbanCloudConfig, readKanbanSettings, readText, saveKanbanSettings, stableClientEventId, writeKanbanCloudConfig } from "./runtime.shared";



export function KanbanRuntime_start_1(self: KanbanRuntimeMethodContext) {
    self.refreshConnection();
}

export function KanbanRuntime_stop_2(self: KanbanRuntimeMethodContext) {
    if (self.commandReceiptRetryTimer) {
        clearTimeout(self.commandReceiptRetryTimer);
        self.commandReceiptRetryTimer = null;
    }
    self.connectionFallbackState = "disabled";
    self.negotiatedContractVersion = "";
    self.negotiatedCapabilities = [];
    self.wsClient.stop();
}

export function KanbanRuntime_refreshDeviceInfo_3(self: KanbanRuntimeMethodContext) {
    self.refreshConnection({ forceReconnect: true });
    self.notifyChanged();
}

export function KanbanRuntime_listIssues_4(self: KanbanRuntimeMethodContext): KanbanListResult {
    self.refreshConnection();
    return {
        ...listDesktopKanbanIssues(self.options.app, self.currentUser(), self.connectionState),
        cloudCapabilities: self.negotiatedContractVersion.startsWith("1.")
            ? [
                ...(self.negotiatedCapabilities.includes("issue.claim") ? ["issue.claim"] : []),
                ...(self.negotiatedCapabilities.includes("run.event.append") ? ["run.event.append"] : []),
                ...(self.negotiatedCapabilities.includes("issue.chat.bind") ? ["issue.chat.bind"] : [])
            ]
            : []
    };
}

export function KanbanRuntime_getCloudConfig_5(self: KanbanRuntimeMethodContext): KanbanCloudConfigResult {
    self.refreshConnection();
    return {
        ok: true,
        message: t("kanban.runtime.cloudConfigLoaded"),
        config: readKanbanCloudConfig(self.options.app),
        configPath: getKanbanConfigPath(self.options.app),
        connectionState: self.connectionState
    };
}

export function KanbanRuntime_getSettings_6(self: KanbanRuntimeMethodContext): KanbanSettingsResult {
    self.refreshConnection();
    return {
        ok: true,
        message: t("kanban.runtime.settingsLoaded"),
        settings: readKanbanSettings(self.options.app),
        configPath: getKanbanConfigPath(self.options.app),
        connectionState: self.connectionState
    };
}

export async function KanbanRuntime_resyncCloudBoard_7(self: KanbanRuntimeMethodContext): Promise<KanbanListResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    if (!self.wsClient.isOpen()) {
        return {
            ...listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState),
            ok: false,
            message: t("kanban.cloudSync.notConnected")
        };
    }
    try {
        await self.wsClient.resyncFromCloud();
        return listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState);
    }
    catch (error) {
        return {
            ...listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState),
            ok: false,
            message: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function KanbanRuntime_listLocalProjects_8(self: KanbanRuntimeMethodContext): Promise<{ ok: boolean; projects: KanbanProject[]; message: string }> {
    const result = self.listIssues();
    return {
        ok: true,
        projects: result.projects ?? [],
        message: t("kanban.runtime.localProjectsLoaded")
    };
}

export async function KanbanRuntime_listSyncLocalProjects_9(self: KanbanRuntimeMethodContext): Promise<KanbanDesktopSyncLocalProject[]> {
    const deviceId = getDesktopDeviceId(self.options.app);
    let result = self.listIssues();
    let bindings = (result.projectBindings ?? []).filter((binding) => binding.deviceId === deviceId &&
        binding.status === "active");
    if (bindings.length === 0) {
        const cloud = readKanbanCloudConfig(self.options.app);
        if (cloud.remoteControlEnabled) {
            ensureDesktopKanbanDefaultBinding(self.options.app, self.currentUser(), deviceId, readText(process.env.DESKTOP_KANBAN_PROJECT_ID) || DEFAULT_SELECTED_PROJECT_ID);
            result = self.listIssues();
            bindings = (result.projectBindings ?? []).filter((binding) => binding.deviceId === deviceId && binding.status === "active");
        }
    }
    if (bindings.length > 0) {
        return bindings.map((binding) => ({
            projectId: binding.projectId,
            localProjectId: binding.localProjectId,
            localDisplayName: binding.localDisplayName || binding.localProjectId,
            controlMode: binding.controlMode === "disabled"
                ? "disabled"
                : binding.controlMode === "observe" ? "readonly" : "execute"
        }));
    }
    return [];
}

export function KanbanRuntime_saveCloudConfig_10(self: KanbanRuntimeMethodContext, input: KanbanCloudConfig): KanbanCloudConfigResult {
    const config = writeKanbanCloudConfig(self.options.app, input);
    self.refreshConnection({ forceReconnect: true });
    return {
        ok: true,
        message: config.serverUrl ? t("kanban.runtime.cloudConfigSavedReconnect") : t("kanban.runtime.cloudConfigSavedClosed"),
        config,
        configPath: getKanbanConfigPath(self.options.app),
        connectionState: self.connectionState
    };
}

export function KanbanRuntime_saveSettings_11(self: KanbanRuntimeMethodContext, input: KanbanSettingsInput): KanbanSettingsResult {
    const settings = saveKanbanSettings(self.options.app, input);
    self.refreshConnection({ forceReconnect: true });
    const requestedEnable = input.enabled === true;
    return {
        ok: true,
        message: requestedEnable && !settings.enabled
            ? t("kanban.runtime.settingsNeedsCloudConfig")
            : settings.enabled
                ? t("kanban.runtime.settingsSaved")
                : t("kanban.runtime.disabled"),
        settings,
        configPath: getKanbanConfigPath(self.options.app),
        connectionState: self.connectionState
    };
}

export async function KanbanRuntime_createIssue_12(self: KanbanRuntimeMethodContext, input: KanbanIssueInput): Promise<KanbanIssueResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    if (input.syncToCloud !== true) {
        return createLocalDesktopKanbanIssue(self.options.app, currentUser, input);
    }
    return self.cloudIssueReadOnlyResult();
}

export async function KanbanRuntime_updateIssue_13(self: KanbanRuntimeMethodContext, issueId: string, input: KanbanIssueUpdateInput): Promise<KanbanIssueResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, issueId);
    if (!issue) {
        return {
            ok: false,
            message: t("kanban.runtime.missing"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    if (issueSyncMode(issue) === "local") {
        if (input.syncToCloud === true) {
            return self.cloudIssueReadOnlyResult();
        }
        return updateDesktopKanbanIssue(self.options.app, currentUser, issue.id, input);
    }
    return self.cloudIssueReadOnlyResult();
}

export async function KanbanRuntime_moveIssue_14(self: KanbanRuntimeMethodContext, input: KanbanIssueMoveInput): Promise<KanbanIssueResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, input.id);
    if (!issue) {
        return {
            ok: false,
            message: t("kanban.runtime.missing"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    if (issueSyncMode(issue) === "local") {
        return moveDesktopKanbanIssue(self.options.app, currentUser, input);
    }
    return self.cloudIssueReadOnlyResult();
}

export async function KanbanRuntime_deleteIssueWithAutomation_15(self: KanbanRuntimeMethodContext, issueId: string, callAgentPlatform: AgentPlatformCaller<App> = self.options.callAgentPlatform): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, issueId);
    const currentIssues = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues;
    if (!issue) {
        return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
    }
    if (issueSyncMode(issue) === "cloud") {
        return self.cloudIssueReadOnlyDeleteResult(currentIssues);
    }
    if (issue.automationId) {
        try {
            await callAgentPlatform(self.options.app, "/api/automation/delete", {
                method: "POST",
                body: { id: issue.automationId }
            });
        }
        catch (error) {
            return {
                ok: false,
                message: t("kanban.automation.deleteFailed", { message: error instanceof Error ? error.message : String(error) }),
                issues: currentIssues
            };
        }
    }
    if (issueSyncMode(issue) === "local") {
        return deleteDesktopKanbanIssue(self.options.app, currentUser, issue.id);
    }
    return deleteDesktopKanbanIssue(self.options.app, currentUser, issue.id);
}

export async function KanbanRuntime_syncIssueAutomation_16(self: KanbanRuntimeMethodContext, issueId: string, callAgentPlatform: AgentPlatformCaller<App> = self.options.callAgentPlatform): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, issueId);
    if (!issue) {
        return {
            ok: false,
            message: t("kanban.runtime.missing"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    if (issueSyncMode(issue) === "cloud") {
        return self.cloudIssueReadOnlyResult();
    }
    const localResult = await self.syncAutomationForIssue(issue, callAgentPlatform);
    if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "local") {
        return localResult;
    }
    return localResult;
}

export async function KanbanRuntime_claimIssue_17(self: KanbanRuntimeMethodContext, issueId: string): Promise<KanbanIssueResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, issueId);
    const issues = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues;
    if (!issue || issueSyncMode(issue) !== "cloud") {
        return { ok: false, message: t("kanban.runtime.missing"), issues };
    }
    if (!self.negotiatedContractVersion.startsWith("1.") || !self.negotiatedCapabilities.includes("issue.claim")) {
        return { ok: false, message: t("kanban.cloud.claimUnsupported"), issues };
    }
    if (!self.wsClient.isOpen()) {
        return { ok: false, message: t("kanban.cloudSync.notConnected"), issues };
    }
    const remoteIssueId = getRemoteIssueId(issue);
    const projectId = readText(issue.projectId) || DEFAULT_SELECTED_PROJECT_ID;
    const requestId = stableClientEventId(getDesktopDeviceId(self.options.app), ["claim", remoteIssueId, issue.revision ?? issue.lastRemoteRevision ?? 0]);
    const payload = { id: remoteIssueId, baseIssueRevision: issue.revision ?? issue.lastRemoteRevision ?? 0 };
    recordDesktopKanbanCloudMutation(self.options.app, currentUser, {
        id: requestId,
        requestType: "issue.claim",
        projectId,
        issueId: remoteIssueId,
        payload
    });
    const result = await self.sendCloudMutation({ id: requestId, requestType: "issue.claim", projectId, issueId: remoteIssueId, payload, attemptCount: 0, lastError: null });
    return {
        ok: result.ok,
        message: result.message,
        issue: result.issue,
        issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
    };
}

export async function KanbanRuntime_runIssue_18(self: KanbanRuntimeMethodContext, input: KanbanRunIssueInput): Promise<KanbanRunIssueResult> {
    self.refreshConnection();
    const currentUser = self.currentUser();
    const issue = getDesktopKanbanIssue(self.options.app, currentUser, readText(input?.issueId));
    const currentIssues = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues;
    if (!issue || issueSyncMode(issue) !== "cloud") {
        return { ok: false, message: t("kanban.runtime.missing"), issues: currentIssues };
    }
    if (!self.negotiatedContractVersion.startsWith("1.") || !self.negotiatedCapabilities.includes("run.event.append") || !self.wsClient.isOpen()) {
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
    const availableAgents = await self.listAgents();
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
        prepared = await self.wsClient.request("issue.run.prepare", {
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
    if (preferredChatId && self.options.assistantBridge.getChat) {
        try {
            if (!await self.options.assistantBridge.getChat(preferredChatId)) {
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
    recordDesktopKanbanManualRun(self.options.app, currentUser, { issueRunId, runId, chatId, issueId: remoteIssueId, projectId, agentKey });
    const failPreparedRun = async (message: string) => {
        updateDesktopKanbanManualRun(self.options.app, currentUser, runId, "failed", message);
        await self.appendRunEvent({
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
        runResult = await self.options.assistantBridge.startRun({
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
        await self.options.assistantBridge.stopRun?.(readText(runResult.runId) || runId).catch(() => undefined);
        const message = t("kanban.run.identityMismatch");
        await failPreparedRun(message);
        return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
    }
    updateDesktopKanbanManualRun(self.options.app, currentUser, runId, "started");
    try {
        const appended = await self.appendRunEvent({
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
            updateDesktopKanbanManualRun(self.options.app, currentUser, runId, "failed", appended.message);
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
        await self.options.assistantBridge.stopRun?.(runId).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        await failPreparedRun(message);
        return { ok: false, message, issues: currentIssues, chatId, runId, agentKey };
    }
}

export async function KanbanRuntime_bindHumanReferenceChat_19(self: KanbanRuntimeMethodContext, input: { issueId: string; stageId: string; statusId: string; chatId: string }) {
    self.refreshConnection();
    if (!self.wsClient.isOpen() || !self.negotiatedContractVersion.startsWith("1.")) {
        return { ok: false, message: t("kanban.cloudSync.notConnected") };
    }
    try {
        const result = await self.wsClient.request<{
            ok: boolean;
            message?: string;
        }>("issue.chat.bind", input);
        if (result.ok)
            await self.resyncCloudBoard();
        return result;
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}

export async function KanbanRuntime_unbindHumanReferenceChat_20(self: KanbanRuntimeMethodContext, issueChatId: string) {
    self.refreshConnection();
    if (!self.wsClient.isOpen() || !self.negotiatedContractVersion.startsWith("1.")) {
        return { ok: false, message: t("kanban.cloudSync.notConnected") };
    }
    try {
        const result = await self.wsClient.request<{
            ok: boolean;
            message?: string;
        }>("issue.chat.unbind", { issueChatId });
        if (result.ok)
            await self.resyncCloudBoard();
        return result;
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
