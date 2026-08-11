import type { KanbanIssue, KanbanRecentEvent, KanbanRunState, KanbanWorkflowStatus } from "../../../shared/contracts";

type EventIssueSnapshot = Partial<KanbanIssue> & {
  runAgentKey?: string | null;
  runStartedAt?: string | null;
  runFinishedAt?: string | null;
  runResultMessage?: string | null;
  runErrorMessage?: string | null;
};

export type KanbanIssueRunRecord = {
  id: string;
  runId: string | null;
  chatId: string | null;
  status: KanbanRunState | null;
  workerAgent: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  resultMessage: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export type KanbanStatusTimelineEntry = {
  key: string;
  fromKey: string | null;
  fromLabel: string | null;
  toKey: string;
  toLabel: string;
  actor: string;
  createdAt: string;
  revision: number;
};

export function resolveKanbanIssueRuns(issue: KanbanIssue, events: KanbanRecentEvent[]): KanbanIssueRunRecord[] {
  const runs = new Map<string, KanbanIssueRunRecord>();
  const orderedEvents = events
    .filter((event) => event.issueId === issue.remoteIssueId || event.issueId === issue.id)
    .sort((left, right) => eventOrder(left) - eventOrder(right));

  for (const event of orderedEvents) {
    const snapshot = eventIssueSnapshot(event);
    const runId = textValue(snapshot.runId) || textValue(snapshot.activeRunId);
    const chatId = textValue(snapshot.chatId);
    const status = normalizeRunState(snapshot.runState);
    if (!runId && !chatId && !status) continue;

    const key = runKey(runId, chatId, `event-${event.id}`);
    const previous = runs.get(key);
    const startedAt = nullableText(snapshot.runStartedAt) || previous?.startedAt || (status === "running" ? event.createdAt : null);
    const finishedAt = nullableText(snapshot.runFinishedAt) || previous?.finishedAt || (status && status !== "running" ? event.createdAt : null);
    runs.set(key, {
      id: previous?.id || key,
      runId: runId || previous?.runId || null,
      chatId: chatId || previous?.chatId || null,
      status: status || previous?.status || null,
      workerAgent: nullableText(snapshot.runAgentKey) || nullableText(snapshot.workerAgent) || previous?.workerAgent || null,
      startedAt,
      finishedAt,
      resultMessage: nullableText(snapshot.runResultMessage) || previous?.resultMessage || null,
      errorMessage: nullableText(snapshot.runErrorMessage) || previous?.errorMessage || null,
      updatedAt: event.createdAt
    });
  }

  const issueRunId = textValue(issue.runId) || textValue(issue.activeRunId);
  const issueStatus = normalizeRunState(issue.runState);
  if (issueRunId || issue.chatId || issueStatus) {
    const key = runKey(issueRunId, issue.chatId, `issue-${issue.id}`);
    const previous = runs.get(key);
    runs.set(key, {
      id: previous?.id || key,
      runId: issueRunId || previous?.runId || null,
      chatId: issue.chatId || previous?.chatId || null,
      status: issueStatus || previous?.status || null,
      workerAgent: issue.runAgentKey || issue.workerAgent || previous?.workerAgent || null,
      startedAt: issue.runStartedAt || previous?.startedAt || null,
      finishedAt: issue.runFinishedAt || previous?.finishedAt || null,
      resultMessage: issue.runResultMessage || previous?.resultMessage || null,
      errorMessage: issue.runErrorMessage || previous?.errorMessage || null,
      updatedAt: issue.updatedAt
    });
  }

  return [...runs.values()].sort((left, right) => dateOrder(right.updatedAt) - dateOrder(left.updatedAt));
}

export function resolveKanbanStatusTimeline(
  issue: KanbanIssue,
  events: KanbanRecentEvent[],
  statuses: KanbanWorkflowStatus[],
  categoryLabels: Partial<Record<KanbanIssue["status"], string>>
): KanbanStatusTimelineEntry[] {
  const entries: KanbanStatusTimelineEntry[] = [];
  const orderedEvents = events
    .filter((event) => event.issueId === issue.remoteIssueId || event.issueId === issue.id)
    .sort((left, right) => eventOrder(left) - eventOrder(right));
  let previousSnapshot: EventIssueSnapshot | null = null;

  for (const event of orderedEvents) {
    const transition = eventStatusTransition(event);
    const snapshot = transition.to ?? eventIssueSnapshot(event);
    const toKey = statusKey(snapshot);
    if (!toKey) continue;
    const fromSnapshot = transition.from ?? previousSnapshot;
    const fromKey = fromSnapshot ? statusKey(fromSnapshot) || null : null;
    previousSnapshot = snapshot;
    const isExplicitTransition = Boolean(transition.to);
    const isCreatedEvent = event.eventType === "issue.created" || textValue(event.payload?.reason) === "created";
    if (!fromSnapshot && !isExplicitTransition && !isCreatedEvent) continue;
    if (fromKey === toKey || entries.at(-1)?.toKey === toKey) continue;
    entries.push({
      key: `${fromKey || "unset"}:${toKey}`,
      fromKey,
      fromLabel: fromSnapshot && fromKey ? statusName(fromSnapshot, statuses, categoryLabels) || fromKey : null,
      toKey,
      toLabel: statusName(snapshot, statuses, categoryLabels) || toKey,
      actor: event.actorAgent || event.actorId || "",
      createdAt: event.createdAt,
      revision: event.revision
    });
  }

  const currentKey = issue.statusId || issue.status;
  const previousEntry = entries.at(-1);
  const baselineKey = previousEntry?.toKey ?? (previousSnapshot ? statusKey(previousSnapshot) : null);
  if (currentKey && baselineKey !== currentKey) {
    entries.push({
      key: `${baselineKey || "unset"}:${currentKey}`,
      fromKey: baselineKey,
      fromLabel: previousEntry?.toLabel ?? (previousSnapshot && baselineKey ? statusName(previousSnapshot, statuses, categoryLabels) || baselineKey : null),
      toKey: currentKey,
      toLabel: statusName(issue, statuses, categoryLabels) || currentKey,
      actor: issue.updatedByAgent || issue.updatedBy || issue.createdByAgent || issue.createdBy || "",
      createdAt: previousSnapshot ? issue.updatedAt : issue.createdAt,
      revision: issue.revision ?? issue.lastRemoteRevision ?? 0
    });
  }
  return entries.reverse();
}

export function kanbanIssueActivityLabel(event: KanbanRecentEvent) {
  return textValue(event.payload?.summary) || event.eventType;
}

function eventIssueSnapshot(event: KanbanRecentEvent): EventIssueSnapshot {
  const nested = event.payload?.issue;
  return isRecord(nested) ? nested as EventIssueSnapshot : (event.payload ?? {}) as EventIssueSnapshot;
}

function eventStatusTransition(event: KanbanRecentEvent): { from: EventIssueSnapshot | null; to: EventIssueSnapshot | null } {
  const transition = event.payload?.statusTransition;
  if (!isRecord(transition)) return { from: null, to: null };
  return {
    from: isRecord(transition.from) ? transition.from as EventIssueSnapshot : null,
    to: isRecord(transition.to) ? transition.to as EventIssueSnapshot : null
  };
}

function statusKey(snapshot: EventIssueSnapshot) {
  return textValue(snapshot.statusId)
    || textValue(snapshot.statusKey)
    || textValue(snapshot.columnKey)
    || textValue(snapshot.status);
}

function statusName(
  snapshot: EventIssueSnapshot,
  statuses: KanbanWorkflowStatus[],
  categoryLabels: Partial<Record<KanbanIssue["status"], string>>
) {
  const explicit = textValue(snapshot.statusName);
  if (explicit) return explicit;
  const statusId = textValue(snapshot.statusId);
  if (statusId) {
    const status = statuses.find((candidate) => candidate.id === statusId);
    if (status) return status.name || status.key;
  }
  const category = (textValue(snapshot.columnKey) || textValue(snapshot.status)) as KanbanIssue["status"];
  return categoryLabels[category] || category;
}

function normalizeRunState(value: unknown): KanbanRunState | null {
  const normalized = textValue(value).toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "completed" || normalized === "succeeded") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return null;
}

function runKey(runId?: string | null, chatId?: string | null, fallback = "run") {
  if (runId) return `run:${runId}`;
  if (chatId) return `chat:${chatId}`;
  return fallback;
}

function eventOrder(event: KanbanRecentEvent) {
  return event.revision || dateOrder(event.createdAt);
}

function dateOrder(value?: string | null) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableText(value: unknown) {
  return textValue(value) || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
