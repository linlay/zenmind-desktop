import type { KanbanIssue, KanbanCurrentUser } from "../../../shared/contracts";
import {
  getDesktopKanbanIssue, listDesktopKanbanIssues, updateDesktopKanbanIssueByPredicate
} from "./local-store";
import {
  type KanbanRuntimeOptions, createKanbanRemoteChatId, createKanbanRemoteRunId,
  readKanbanSettings, buildDesktopKanbanRunPrompt
} from "./runtime.shared";
import { t } from "../../support/i18n/main-i18n";

const LOCAL_TODO_START_DELAY_MS = 2_000;

export function localIssueExecutor(issue: KanbanIssue): string {
  return issue.workerType === "human" ? "" : (issue.workerAgent || issue.assigneeAgentKey || "").trim();
}

export function isLocalIssueRunnable(issue: KanbanIssue): boolean {
  return issue.syncMode !== "cloud" && issue.status === "todo" && !!localIssueExecutor(issue)
    && !issue.automationEnabled && !issue.runId && !issue.activeRunId && issue.runState !== "running"
    && issue.runState !== "failed" && issue.runState !== "cancelled";
}

/** Main owns admission, including when no Kanban renderer exists. Platform owns capacity. */
export class LocalKanbanScheduler {
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private admissionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly eligibleAfter = new Map<string, number>();
  private readonly admitting = new Set<string>();
  private readonly retryAfter = new Map<string, number>();

  constructor(private readonly options: KanbanRuntimeOptions, private readonly user: () => KanbanCurrentUser,
    private readonly changed: () => void) {}

  start() {
    if (this.running) return;
    this.running = true;
    // Also catches executor/config changes, reconnection and mutations outside runtime entry points.
    this.timer = setInterval(() => this.wake(), 15_000);
    this.timer.unref?.();
    this.wake();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    clearTimeout(this.admissionTimer);
    this.eligibleAfter.clear();
    this.wakeTimer = undefined;
  }

  wake(capacityChanged = false) {
    if (capacityChanged) this.retryAfter.clear();
    if (!this.running || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      try { this.reconcile(); } catch (error) { this.debug(error); }
    }, 0);
    this.wakeTimer.unref?.();
  }

  private reconcile() {
    clearTimeout(this.admissionTimer);
    if (!this.running || !readKanbanSettings(this.options.app).enabled) return;
    const user = this.user();
    const issues = listDesktopKanbanIssues(this.options.app, user).issues
      .filter(isLocalIssueRunnable).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const eligibilityKey = (issue: KanbanIssue) => JSON.stringify([user.id, issue.id, issue.stageId, localIssueExecutor(issue)]);
    const currentKeys = new Set(issues.map(eligibilityKey));
    for (const key of this.eligibleAfter.keys()) if (!currentKeys.has(key)) this.eligibleAfter.delete(key);
    let nextAdmissionAt = Infinity;
    for (const issue of issues) {
      const issueKey = eligibilityKey(issue);
      const readyAt = this.eligibleAfter.get(issueKey) ?? Date.now() + LOCAL_TODO_START_DELAY_MS;
      this.eligibleAfter.set(issueKey, readyAt);
      // Keep Todo visible before requesting a Run, even when other events wake the scheduler.
      if (readyAt > Date.now()) {
        nextAdmissionAt = Math.min(nextAdmissionAt, readyAt);
        continue;
      }
      const agentKey = localIssueExecutor(issue);
      const key = JSON.stringify([user.id, agentKey]);
      if (this.admitting.has(key) || (this.retryAfter.get(key) ?? 0) > Date.now()) continue;
      // Serialize admission per Agent, not execution. Other Agents are independent.
      this.admitting.add(key);
      void this.admit(user, issue, agentKey, key).catch((error) => {
        this.retryAfter.set(key, Date.now() + 15_000);
        this.debug(error);
      }).finally(() => { this.admitting.delete(key); this.wake(); });
    }
    if (Number.isFinite(nextAdmissionAt)) {
      this.admissionTimer = setTimeout(() => this.wake(), Math.max(0, nextAdmissionAt - Date.now()));
      this.admissionTimer.unref?.();
    }
  }

  private async admit(user: KanbanCurrentUser, candidate: KanbanIssue, agentKey: string, key: string) {
    const issue = getDesktopKanbanIssue(this.options.app, user, candidate.id);
    if (!this.running || user.id !== this.user().id || !issue || !isLocalIssueRunnable(issue)) return;
    const chatId = issue.chatId?.trim()
      || (issue.attachments.length ? issue.attachmentChatId?.trim() : "") || createKanbanRemoteChatId();
    const runId = createKanbanRemoteRunId();
    // Persist identity before query: even a very fast run.started/finished must find its Issue.
    const reserved = updateDesktopKanbanIssueByPredicate(this.options.app, user,
      (current) => current.id === issue.id && isLocalIssueRunnable(current)
        && localIssueExecutor(current) === agentKey && current.updatedAt === issue.updatedAt,
      { chatId, runId, runState: "running" }, "Issue changed before admission");
    if (!reserved.ok) return;
    this.changed();
    try {
      const result = await this.options.assistantBridge.startRun({
        chatId, runId, requestId: runId, agentKey, source: "copilot", attachments: issue.attachments,
        message: buildLocalRunPrompt(issue)
      });
      if (!result.ok) {
        // Unknown acceptance must keep its identity; never blindly replay a possibly accepted query.
        if (/connection_lost_before_acceptance|time_contract_violation/.test(result.message)) {
          this.updateAttempt(user, issue.id, runId, {}, result.message);
          return;
        }
        this.retryAfter.set(key, Date.now() + 15_000);
        this.updateAttempt(user, issue.id, runId,
          { chatId: issue.chatId, runId: null, runState: null }, result.message, {
            lastRunId: issue.lastRunId, lastRunChatId: issue.lastRunChatId,
            runResultMessage: issue.runResultMessage, runStartedAt: issue.runStartedAt,
            runFinishedAt: issue.runFinishedAt
          });
        return;
      }
      // A terminal Push may already have cleared this identity or advanced the stage.
      this.updateAttempt(user, issue.id, runId, { status: "in_progress" });
    } catch (error) {
      // A thrown transport error gives no evidence that the query was rejected.
      this.updateAttempt(user, issue.id, runId, {}, String(error));
      this.debug(error);
    }
  }

  private updateAttempt(user: KanbanCurrentUser, issueId: string, runId: string,
    input: Parameters<typeof updateDesktopKanbanIssueByPredicate>[3], error: string | null = null,
    details: Parameters<typeof updateDesktopKanbanIssueByPredicate>[5] = {}) {
    const result = updateDesktopKanbanIssueByPredicate(this.options.app, user,
      (issue) => issue.id === issueId && issue.runId === runId && issue.runState === "running",
      input, "Run is no longer current", { ...details, runErrorMessage: error });
    if (result.ok) this.changed();
  }

  private debug(error: unknown) { this.options.onDebug?.(`Kanban local admission: ${String(error)}`); }
}

function buildLocalRunPrompt(issue: KanbanIssue) {
  const parts = [t("kanban.prompt.id", { value: issue.id }), buildDesktopKanbanRunPrompt(issue)];
  if (issue.localWorkflow) {
    parts.push(t("kanban.localWorkflow.runStage", { value: issue.stageName ?? "" }));
    const rollback = issue.localWorkflowRollbacks?.at(-1);
    if (rollback && rollback.toStageId === issue.stageId) parts.push(t("kanban.localWorkflow.rollbackContext", { value: rollback.reason }));
  }
  return parts.join("\n\n");
}
