import type { App } from "electron";
import type {
  KanbanIssue,
  KanbanIssueResult
} from "../../../shared/contracts";
import {
  completeDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanCommandReceiptByRunId,
  getDesktopKanbanManualRunByRunId,
  listDesktopKanbanIssues,
  updateDesktopKanbanIssue,
  updateDesktopKanbanManualRun
} from "./local-store";
import { t } from "../../support/i18n/main-i18n";
import { AgentPlatformCaller, KanbanRuntimeMethodContext, buildKanbanAutomationPayload, getRemoteIssueId, issueSyncMode, kanbanIssueFromAutomationPayload, optionalText, readText } from "./runtime.shared";



export async function KanbanRuntime_handleRemoteStartFailure_1(self: KanbanRuntimeMethodContext, runId: string, chatId: string, message: string) {
    const currentUser = self.currentUser();
    const manualReceipt = getDesktopKanbanManualRunByRunId(self.options.app, currentUser, runId);
    const commandReceipt = getDesktopKanbanCommandReceiptByRunId(self.options.app, currentUser, runId);
    const matchingCloudIssue = listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues.find((issue) => issueSyncMode(issue) === "cloud" && ((manualReceipt && getRemoteIssueId(issue) === manualReceipt.issueId) ||
        (commandReceipt && getRemoteIssueId(issue) === commandReceipt.issueId)));
    if (!matchingCloudIssue && !manualReceipt && !commandReceipt) {
        return;
    }
    if (manualReceipt) {
        updateDesktopKanbanManualRun(self.options.app, currentUser, runId, "failed", message);
    }
    await self.appendRunEvent({
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
        completeDesktopKanbanCommandReceiptByRunId(self.options.app, currentUser, runId, "failed");
    }
}

export function KanbanRuntime_notifyChanged_2(self: KanbanRuntimeMethodContext) {
    self.options.onChanged?.();
}

export async function KanbanRuntime_syncAutomationForIssue_3(self: KanbanRuntimeMethodContext, issue: KanbanIssue, callAgentPlatform: AgentPlatformCaller<App>): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
    const currentUser = self.currentUser();
    if (!issue.automationEnabled) {
        if (issue.automationId) {
            await callAgentPlatform(self.options.app, "/api/automation/delete", {
                method: "POST",
                body: { id: issue.automationId }
            });
        }
        return updateDesktopKanbanIssue(self.options.app, currentUser, issue.id, {
            automationId: null,
            automationEnabled: false
        });
    }
    if (!issue.assigneeAgentKey?.trim()) {
        return {
            ok: false,
            message: t("kanban.automation.assigneeRequired"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    if (!issue.automationCron?.trim()) {
        return {
            ok: false,
            message: t("kanban.automation.cronRequired"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    if (!issue.automationMessage?.trim()) {
        return {
            ok: false,
            message: t("kanban.automation.messageRequired"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    const payload = buildKanbanAutomationPayload(issue);
    const detail = issue.automationId
        ? await callAgentPlatform<{
            id?: string;
            scheduleId?: string;
        }>(self.options.app, "/api/automation/update", {
            method: "POST",
            body: { id: issue.automationId, ...payload }
        })
        : await callAgentPlatform<{
            id?: string;
            scheduleId?: string;
        }>(self.options.app, "/api/automation/create", {
            method: "POST",
            body: payload
        });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
        return {
            ok: false,
            message: t("kanban.automation.platformIdMissing"),
            issues: listDesktopKanbanIssues(self.options.app, currentUser, self.connectionState).issues
        };
    }
    return updateDesktopKanbanIssue(self.options.app, currentUser, issue.id, {
        automationId,
        automationEnabled: true
    });
}

export async function KanbanRuntime_syncRemoteAutomationPayload_4(self: KanbanRuntimeMethodContext, payload: unknown) {
    const issue = kanbanIssueFromAutomationPayload(payload);
    if (!issue) {
        return { ok: false, message: t("kanban.automation.payloadMissing") };
    }
    if (!issue.automationEnabled) {
        if (issue.automationId) {
            await self.options.callAgentPlatform(self.options.app, "/api/automation/delete", {
                method: "POST",
                body: { id: issue.automationId }
            });
        }
        return {
            ok: true,
            message: t("kanban.automation.disabled"),
            issue: {
                ...issue,
                automationId: null,
                automationEnabled: false
            }
        };
    }
    if (!issue.assigneeAgentKey?.trim()) {
        return { ok: false, message: t("kanban.automation.assigneeRequired") };
    }
    if (!issue.automationCron?.trim()) {
        return { ok: false, message: t("kanban.automation.cronRequired") };
    }
    if (!issue.automationMessage?.trim()) {
        return { ok: false, message: t("kanban.automation.messageRequired") };
    }
    const automationPayload = buildKanbanAutomationPayload(issue);
    const detail = issue.automationId
        ? await self.options.callAgentPlatform<{
            id?: string;
            scheduleId?: string;
        }>(self.options.app, "/api/automation/update", {
            method: "POST",
            body: { id: issue.automationId, ...automationPayload }
        })
        : await self.options.callAgentPlatform<{
            id?: string;
            scheduleId?: string;
        }>(self.options.app, "/api/automation/create", {
            method: "POST",
            body: automationPayload
        });
    const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
    if (!automationId) {
        return { ok: false, message: t("kanban.automation.platformIdMissing") };
    }
    const result = {
        ok: true,
        message: t("kanban.automation.synced"),
        issue: {
            ...issue,
            automationId,
            automationEnabled: true
        }
    };
    return {
        ok: result.ok,
        message: result.message,
        issue: result.issue
    };
}
