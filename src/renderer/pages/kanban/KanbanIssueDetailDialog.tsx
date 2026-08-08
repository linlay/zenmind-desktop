import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ApartmentOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseOutlined,
  CloudOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LinkOutlined,
  LockOutlined,
  MessageOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SaveOutlined,
  TagsOutlined,
  UserOutlined
} from "@ant-design/icons";
import type {
  AssistantAttachment,
  KanbanCloudDetailData,
  KanbanIssue,
  KanbanIssueFieldOption,
  KanbanPriority,
  KanbanProject,
  KanbanResolvedIssueField,
  KanbanStatus
} from "../../../shared/contracts";
import { KANBAN_PRIORITIES, KANBAN_STATUSES } from "../../../shared/contracts";
import type { SupportedLocale, TranslateFunction } from "../../../shared/i18n";
import { resolveKanbanIssueFields } from "./issueFieldResolution";

export type KanbanIssueDetailDraft = {
  title: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority;
  assigneeAgentKey: string;
  automationEnabled: boolean;
  automationCron: string;
  automationMessage: string;
  automationTimezone: string;
  attachmentChatId: string;
  attachments: AssistantAttachment[];
  syncToCloud: boolean;
};

type KanbanIssueDetailDialogProps = {
  issue: KanbanIssue;
  issues: KanbanIssue[];
  projects: KanbanProject[];
  cloudDetails: KanbanCloudDetailData;
  agents: Array<{ agentKey: string; displayName: string }>;
  locale: SupportedLocale;
  t: TranslateFunction;
  onClose: () => void;
  onSave: (draft: KanbanIssueDetailDraft) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onOpenChat: () => void;
  onFeedback: (tone: "success" | "error", message: string) => void;
  initialEditStatus?: KanbanStatus | null;
};

const DETAIL_STATUS_LABELS: Record<KanbanStatus, "kanban.status.backlog" | "kanban.status.todo" | "kanban.status.inProgress" | "kanban.status.inReview" | "kanban.status.completed"> = {
  backlog: "kanban.status.backlog",
  todo: "kanban.status.todo",
  in_progress: "kanban.status.inProgress",
  in_review: "kanban.status.inReview",
  completed: "kanban.status.completed"
};

const DETAIL_PRIORITY_LABELS: Record<KanbanPriority, "kanban.priority.high" | "kanban.priority.medium" | "kanban.priority.low"> = {
  high: "kanban.priority.high",
  medium: "kanban.priority.medium",
  low: "kanban.priority.low"
};

function createDetailDraft(issue: KanbanIssue): KanbanIssueDetailDraft {
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentKey: issue.assigneeAgentKey ?? "",
    automationEnabled: issue.automationEnabled,
    automationCron: issue.automationCron ?? "0 9 * * *",
    automationMessage: issue.automationMessage ?? "",
    automationTimezone: issue.automationTimezone ?? "Asia/Shanghai",
    attachmentChatId: issue.attachmentChatId ?? "",
    attachments: issue.attachments ?? [],
    syncToCloud: issue.syncMode === "cloud"
  };
}

function issueExternalId(issue: KanbanIssue) {
  return issue.remoteIssueId?.trim() || issue.id;
}

function formatDateTime(value: string | null | undefined, locale: SupportedLocale) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function optionForValue(options: KanbanIssueFieldOption[], value: unknown) {
  return options.find((option) => {
    if (option.key === String(value)) return true;
    if (option.value === value) return true;
    return safeJson(option.value) === safeJson(value);
  });
}

function renderDynamicValue(
  field: KanbanResolvedIssueField,
  value: unknown,
  usersById: Map<string, string>,
  issuesByRemoteId: Map<string, KanbanIssue>,
  t: TranslateFunction
): ReactNode {
  if (value === undefined || value === null || value === "") {
    return <span className="kanban-detail-empty-value">{t("kanban.detail.notSet")}</span>;
  }
  const valueType = field.def.valueType.toLowerCase();
  if (valueType === "boolean") {
    return value === true ? t("kanban.detail.yes") : value === false ? t("kanban.detail.no") : String(value);
  }
  if (valueType === "json") {
    return <pre className="kanban-detail-json-value">{safeJson(value)}</pre>;
  }
  const rawValues = Array.isArray(value) ? value : [value];
  const formatted = rawValues.map((item) => {
    if (valueType.includes("user")) return usersById.get(String(item)) ?? String(item);
    if (valueType.includes("issue")) return issuesByRemoteId.get(String(item))?.title ?? String(item);
    if (valueType.includes("select")) return optionForValue(field.options, item)?.name ?? String(item);
    return String(item);
  });
  if (Array.isArray(value)) {
    return <span className="kanban-detail-value-tags">{formatted.map((item, index) => <span key={`${item}:${index}`}>{item}</span>)}</span>;
  }
  return <>{formatted[0]}{field.def.unit ? <small className="kanban-detail-value-unit">{field.def.unit}</small> : null}</>;
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase()
    : Array.from(value.trim()).slice(0, 2).join("").toUpperCase();
}

function DetailAvatar({ label, avatarUrl, agent = false }: { label: string; avatarUrl?: string | null; agent?: boolean }) {
  return (
    <span className={`kanban-detail-avatar ${agent ? "is-agent" : ""}`}>
      {avatarUrl ? <img src={avatarUrl} alt="" /> : agent ? <RobotOutlined /> : initials(label) || <UserOutlined />}
    </span>
  );
}

function DetailSection({ title, description, meta, icon, children, className = "" }: {
  title: string;
  description?: string;
  meta?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`kanban-detail-section ${className}`}>
      <header className="kanban-detail-section-head">
        <div className="kanban-detail-section-heading">
          {icon ? <span className="kanban-detail-section-icon">{icon}</span> : null}
          <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
        </div>
        {meta ? <span className="kanban-detail-section-meta">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return <div className="kanban-detail-empty"><FileTextOutlined /><span>{children}</span></div>;
}

export function KanbanIssueDetailDialog({
  issue,
  issues,
  projects,
  cloudDetails,
  agents,
  locale,
  t,
  onClose,
  onSave,
  onDelete,
  onOpenChat,
  onFeedback,
  initialEditStatus = null
}: KanbanIssueDetailDialogProps) {
  const [editing, setEditing] = useState(Boolean(initialEditStatus));
  const [saving, setSaving] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [draft, setDraft] = useState(() => ({
    ...createDetailDraft(issue),
    status: initialEditStatus ?? issue.status
  }));
  const isCloud = issue.syncMode === "cloud";
  const remoteId = issueExternalId(issue);
  const project = projects.find((candidate) => candidate.id === issue.projectId);
  const issueType = cloudDetails.issueTypes.find((candidate) => candidate.key === (issue.issueTypeKey || issue.typeId));
  const workflow = cloudDetails.workflows.find((candidate) => candidate.id === issue.workflowId);
  const stage = cloudDetails.workflowStages.find((candidate) => candidate.id === issue.stageId);
  const workflowStatus = cloudDetails.workflowStatuses.find((candidate) => candidate.id === issue.statusId);
  const usersById = useMemo(() => new Map(cloudDetails.users.map((user) => [user.id, user.displayName || user.email || user.id])), [cloudDetails.users]);
  const usersDetailById = useMemo(() => new Map(cloudDetails.users.map((user) => [user.id, user])), [cloudDetails.users]);
  const issuesByRemoteId = useMemo(() => new Map(issues.flatMap((candidate) => [[candidate.id, candidate], [issueExternalId(candidate), candidate]])), [issues]);
  const resolvedFields = useMemo(() => resolveKanbanIssueFields(
    cloudDetails.issueFieldDefs,
    cloudDetails.issueFieldContexts,
    cloudDetails.issueFieldOptions,
    projects,
    issue.projectId ?? "",
    issue.issueTypeKey ?? issue.typeId ?? "task",
    issue.workflowId ?? ""
  ), [cloudDetails.issueFieldContexts, cloudDetails.issueFieldDefs, cloudDetails.issueFieldOptions, issue.issueTypeKey, issue.projectId, issue.typeId, issue.workflowId, projects]);
  const labelIds = new Set(cloudDetails.issueLabelLinks.filter((link) => link.issueId === remoteId).map((link) => link.labelId));
  const labels = cloudDetails.issueLabels.filter((label) => labelIds.has(label.id));
  const subtasks = issues.filter((candidate) => candidate.parentIssueId === remoteId);
  const dependencies = cloudDetails.issueDependencies.filter((dependency) => dependency.fromIssueId === remoteId || dependency.toIssueId === remoteId);
  const reviews = cloudDetails.reviews.filter((review) => review.issueId === remoteId);
  const comments = cloudDetails.issueComments.filter((comment) => comment.issueId === remoteId);
  const events = cloudDetails.recentEvents.filter((event) => event.issueId === remoteId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const runEvents = events.filter((event) => /run|dispatch|agent/iu.test(event.eventType));
  const visibleAttachments = draft.attachments.filter((attachment) => !attachment.hidden);
  const agentLabel = agents.find((agent) => agent.agentKey === (draft.assigneeAgentKey || issue.runAgentKey || issue.workerAgent))?.displayName
    ?? draft.assigneeAgentKey
    ?? issue.runAgentKey
    ?? issue.workerAgent
    ?? t("kanban.form.unassigned");
  const assigneeUser = issue.assigneeId ? usersDetailById.get(issue.assigneeId) : undefined;
  const reviewerUser = issue.reviewerId ? usersDetailById.get(issue.reviewerId) : undefined;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function updateDraft(patch: Partial<KanbanIssueDetailDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function saveDraft() {
    setSaving(true);
    try {
      if (await onSave(draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function addAttachment() {
    if (attachmentBusy) return;
    const chatId = draft.attachmentChatId || `kanban-issue-${issue.id}`;
    setAttachmentBusy(true);
    try {
      const result = await window.electronAPI.assistant.pickAttachments(chatId);
      if (result.cancelled) return;
      if (!result.ok && result.attachments.length === 0) {
        onFeedback("error", result.message);
        return;
      }
      updateDraft({ attachmentChatId: result.chatId || chatId, attachments: [...draft.attachments, ...result.attachments] });
      onFeedback(result.ok ? "success" : "error", result.message);
    } catch (error) {
      onFeedback("error", error instanceof Error ? error.message : t("kanban.feedback.attachmentUploadFailed"));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function openAttachment(attachment: AssistantAttachment) {
    const chatId = draft.attachmentChatId.trim();
    if (!chatId) {
      onFeedback("error", t("kanban.feedback.attachmentLocationMissing"));
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(chatId, attachment.id);
    onFeedback(result.ok ? "success" : "error", result.message);
  }

  const dialog = (
    <div className="kanban-detail-layer" role="presentation" onMouseDown={onClose}>
      <section className="kanban-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="kanban-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="kanban-detail-header">
          <div className="kanban-detail-breadcrumb"><ApartmentOutlined /><span>{project?.path || project?.name || issue.projectName || t("kanban.projectFilter.all")}</span></div>
          <button className="kanban-detail-close" type="button" onClick={onClose} aria-label={t("kanban.modal.close")}><CloseOutlined /></button>
        </header>

        <div className="kanban-detail-body">
          <main className="kanban-detail-content">
            <div className="kanban-detail-issue-heading">
              <div className="kanban-detail-kicker">
                <span>{remoteId}</span>
                <span className={`kanban-detail-pill is-status is-${issue.status}`}>{issue.statusName || t(DETAIL_STATUS_LABELS[issue.status])}</span>
                <span className={`kanban-detail-pill is-priority is-${issue.priority}`}>{t(DETAIL_PRIORITY_LABELS[issue.priority])}</span>
                <span className={`kanban-detail-pill is-origin ${isCloud ? "is-cloud" : "is-local"}`}>{isCloud ? <CloudOutlined /> : <ApartmentOutlined />}{isCloud ? t("kanban.detail.cloudOrigin") : t("kanban.detail.localOrigin")}</span>
              </div>
              <div className="kanban-detail-heading-row">
                <div className="kanban-detail-heading-copy">
                  {editing ? <input className="kanban-detail-title-input" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} autoFocus /> : <h1 id="kanban-detail-title">{issue.title}</h1>}
                </div>
                <div className="kanban-detail-header-actions">
                  {issue.chatId ? <button type="button" className="kanban-detail-secondary-button" onClick={onOpenChat}><MessageOutlined />{t("kanban.chat.view")}</button> : null}
                  {editing ? (
                    <>
                      <button type="button" className="kanban-detail-secondary-button" onClick={() => { setDraft(createDetailDraft(issue)); setEditing(false); }}>{t("kanban.form.cancel")}</button>
                      <button type="button" className="kanban-detail-primary-button" disabled={saving} onClick={() => void saveDraft()}><SaveOutlined />{saving ? t("kanban.detail.saving") : t("kanban.form.save")}</button>
                    </>
                  ) : !isCloud ? <button type="button" className="kanban-detail-secondary-button" onClick={() => setEditing(true)}><EditOutlined />{t("kanban.detail.editIssue")}</button> : null}
                </div>
              </div>
            </div>

            <DetailSection title={t("kanban.detail.descriptionTitle")} description={t("kanban.detail.descriptionHint")} icon={<FileTextOutlined />} meta={issueType?.name || issue.issueTypeKey || issue.typeId || "Issue"}>
              {editing ? <textarea className="kanban-detail-description-editor" value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} rows={7} /> : issue.description ? <div className="kanban-detail-prose">{issue.description}</div> : <EmptyBlock>{t("kanban.detail.noDescription")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.attachmentsTitle")} description={t("kanban.detail.attachmentsHint")} icon={<PaperClipOutlined />} meta={t("kanban.detail.itemCount", { count: visibleAttachments.length })}>
              {visibleAttachments.length > 0 ? <div className="kanban-detail-attachment-list">{visibleAttachments.map((attachment) => (
                <article key={attachment.id}><span className="kanban-detail-file-icon"><FileTextOutlined /></span><span><strong>{attachment.name}</strong><small>{attachment.mimeType || t("kanban.detail.file")} {formatFileSize(attachment.sizeBytes) ? `· ${formatFileSize(attachment.sizeBytes)}` : ""}</small></span><button type="button" onClick={() => void openAttachment(attachment)}>{t("kanban.detail.open")}</button>{editing ? <button type="button" className="is-remove" aria-label={t("kanban.form.removeAttachment", { name: attachment.name })} onClick={() => updateDraft({ attachments: draft.attachments.filter((item) => item.id !== attachment.id && item.sourceAttachmentId !== attachment.id) })}><CloseOutlined /></button> : null}</article>
              ))}</div> : <EmptyBlock>{t("kanban.detail.noAttachments")}</EmptyBlock>}
              {editing ? <button type="button" className="kanban-detail-dashed-button" disabled={attachmentBusy} onClick={() => void addAttachment()}><PaperClipOutlined />{attachmentBusy ? t("kanban.form.uploading") : t("kanban.form.addAttachment")}</button> : null}
            </DetailSection>

            <DetailSection title={t("kanban.detail.commentsTitle")} description={t("kanban.detail.commentsHint")} icon={<MessageOutlined />} meta={t("kanban.detail.itemCount", { count: comments.length })}>
              {comments.length > 0 ? <div className="kanban-detail-comment-list">{comments.map((comment) => {
                const author = usersDetailById.get(comment.authorUserId ?? "");
                const name = author?.displayName || comment.authorAgent || comment.authorUserId || t("kanban.detail.unknownActor");
                return <article key={comment.id}><DetailAvatar label={name} avatarUrl={author?.avatarUrl} agent={Boolean(comment.authorAgent)} /><div><p><strong>{name}</strong><time>{formatDateTime(comment.createdAt, locale)}</time></p><span>{comment.body}</span></div></article>;
              })}</div> : <EmptyBlock>{t("kanban.detail.noComments")}</EmptyBlock>}
            </DetailSection>
          </main>

          <aside className="kanban-detail-rail" aria-label={t("kanban.detail.properties")}>
            <DetailSection title={t("kanban.detail.scopeTitle")} description={t("kanban.detail.scopeHint")} icon={<ApartmentOutlined />}>
              <dl className="kanban-detail-properties">
                <div><dt>{t("kanban.detail.project")}</dt><dd>{project?.name || issue.projectName || issue.projectId || "—"}</dd></div>
                <div><dt>{t("kanban.detail.issueType")}</dt><dd>{issueType?.name || issue.issueTypeKey || issue.typeId || "—"}</dd></div>
                <div><dt>{t("kanban.detail.workflow")}</dt><dd>{workflow?.name || issue.workflowId || "—"}</dd></div>
                <div><dt>{t("kanban.detail.stage")}</dt><dd>{stage?.name || issue.stageName || issue.stageKey || "—"}</dd></div>
              </dl>
              <div className="kanban-detail-control-grid">
                <label><span>{t("kanban.form.status")}</span>{editing ? <select value={draft.status} disabled={Boolean(issue.runId)} onChange={(event) => updateDraft({ status: event.target.value as KanbanStatus })}>{KANBAN_STATUSES.map((status) => <option key={status} value={status}>{t(DETAIL_STATUS_LABELS[status])}</option>)}</select> : <strong>{workflowStatus?.name || issue.statusName || t(DETAIL_STATUS_LABELS[issue.status])}</strong>}</label>
                <label><span>{t("kanban.form.priority")}</span>{editing ? <select value={draft.priority} onChange={(event) => updateDraft({ priority: event.target.value as KanbanPriority })}>{KANBAN_PRIORITIES.map((priority) => <option key={priority} value={priority}>{t(DETAIL_PRIORITY_LABELS[priority])}</option>)}</select> : <strong>{t(DETAIL_PRIORITY_LABELS[issue.priority])}</strong>}</label>
              </div>
              <dl className="kanban-detail-properties is-compact"><div><dt>{t("kanban.detail.severity")}</dt><dd>{issue.severity ? t(`kanban.severity.${issue.severity}` as "kanban.severity.medium") : "—"}</dd></div></dl>
            </DetailSection>

            <DetailSection title={t("kanban.detail.peopleTitle")} description={t("kanban.detail.peopleHint")} icon={<UserOutlined />}>
              {editing ? <label className="kanban-detail-control"><span>{t("kanban.form.assignee")}</span><select value={draft.assigneeAgentKey} onChange={(event) => updateDraft({ assigneeAgentKey: event.target.value })}><option value="">{t("kanban.form.unassigned")}</option>{agents.map((agent) => <option key={agent.agentKey} value={agent.agentKey}>{agent.displayName}</option>)}</select></label> : null}
              <div className="kanban-detail-people">
                <div><DetailAvatar label={assigneeUser?.displayName || issue.assigneeId || t("kanban.form.unassigned")} avatarUrl={assigneeUser?.avatarUrl} /><p><small>{t("kanban.detail.owner")}</small><strong>{assigneeUser?.displayName || issue.assigneeId || t("kanban.form.unassigned")}</strong></p></div>
                <div><DetailAvatar label={agentLabel} agent /><p><small>{t("kanban.detail.executor")}</small><strong>{agentLabel}</strong></p></div>
                <div><DetailAvatar label={reviewerUser?.displayName || issue.reviewerId || t("kanban.form.unassigned")} avatarUrl={reviewerUser?.avatarUrl} /><p><small>{t("kanban.detail.reviewer")}</small><strong>{reviewerUser?.displayName || issue.reviewerId || t("kanban.form.unassigned")}</strong></p></div>
              </div>
            </DetailSection>

            <DetailSection title={t("kanban.detail.customFieldsTitle")} description={t("kanban.detail.customFieldsHint")} icon={<ApartmentOutlined />} meta={t("kanban.detail.resolvedFields", { count: resolvedFields.length })}>
              {resolvedFields.length > 0 ? <div className="kanban-detail-field-grid">{resolvedFields.map((field) => (
                <div className="kanban-detail-field-value" key={field.def.id}>
                  <span>{field.def.name}{field.context.required ? " *" : ""}</span>
                  <strong>{renderDynamicValue(field, issue.customFields?.[field.def.key] ?? field.context.defaultValue, usersById, issuesByRemoteId, t)}</strong>
                  {field.def.description ? <small>{field.def.description}</small> : null}
                </div>
              ))}</div> : <EmptyBlock>{t("kanban.detail.noCustomFields")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.labelsTitle")} description={t("kanban.detail.labelsHint")} icon={<TagsOutlined />} meta={t("kanban.detail.itemCount", { count: labels.length })}>
              {labels.length > 0 ? <div className="kanban-detail-labels">{labels.map((label) => <span key={label.id} style={label.color ? { borderColor: label.color, color: label.color } : undefined}>{label.name || label.key}</span>)}</div> : <EmptyBlock>{t("kanban.detail.noLabels")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.automationTitle")} description={isCloud ? t("kanban.detail.automationCloudHint") : t("kanban.detail.automationHint")} icon={<ClockCircleOutlined />}>
              <div className="kanban-detail-automation-summary"><span className={`kanban-detail-switch ${draft.automationEnabled ? "is-on" : ""}`}><span /></span><div><strong>{draft.automationEnabled ? t("kanban.detail.enabled") : t("kanban.detail.disabled")}</strong><small>{issue.automationCron || t("kanban.detail.noSchedule")}</small></div></div>
              {editing ? <div className="kanban-detail-automation-form"><label className="kanban-detail-check"><input type="checkbox" checked={draft.automationEnabled} onChange={(event) => updateDraft({ automationEnabled: event.target.checked })} /><span>{t("kanban.form.automationEnabled")}</span></label>{draft.automationEnabled ? <><label className="kanban-detail-control"><span>{t("kanban.form.cron")}</span><input value={draft.automationCron} onChange={(event) => updateDraft({ automationCron: event.target.value })} /></label><label className="kanban-detail-control"><span>{t("kanban.detail.timezone")}</span><input value={draft.automationTimezone} onChange={(event) => updateDraft({ automationTimezone: event.target.value })} /></label><label className="kanban-detail-control"><span>{t("kanban.detail.automationMessage")}</span><textarea value={draft.automationMessage} onChange={(event) => updateDraft({ automationMessage: event.target.value })} rows={3} /></label></> : null}</div> : null}
            </DetailSection>

            <DetailSection title={t("kanban.detail.subtasksTitle")} description={t("kanban.detail.subtasksHint")} icon={<CheckCircleFilled />} meta={t("kanban.detail.itemCount", { count: subtasks.length })}>
              {subtasks.length > 0 ? <div className="kanban-detail-related-list">{subtasks.map((subtask) => <article key={subtask.id}><CheckCircleFilled className={subtask.status === "completed" ? "is-complete" : ""} /><span><strong>{subtask.title}</strong><small>{issueExternalId(subtask)} · {subtask.statusName || t(DETAIL_STATUS_LABELS[subtask.status])}</small></span></article>)}</div> : <EmptyBlock>{t("kanban.detail.noSubtasks")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.dependenciesTitle")} description={t("kanban.detail.dependenciesHint")} icon={<LinkOutlined />} meta={t("kanban.detail.itemCount", { count: dependencies.length })}>
              {dependencies.length > 0 ? <div className="kanban-detail-dependency-list">{dependencies.map((dependency) => {
                const outbound = dependency.fromIssueId === remoteId;
                const relatedId = outbound ? dependency.toIssueId : dependency.fromIssueId;
                const related = issuesByRemoteId.get(relatedId);
                return <article key={dependency.id}><span>{outbound ? dependency.type : t("kanban.detail.dependedBy")}</span><div><strong>{related?.title || relatedId}</strong><small>{relatedId}{related ? ` · ${related.statusName || t(DETAIL_STATUS_LABELS[related.status])}` : ""}</small></div></article>;
              })}</div> : <EmptyBlock>{t("kanban.detail.noDependencies")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.reviewsTitle")} description={t("kanban.detail.reviewsHint")} icon={<CheckCircleFilled />} meta={t("kanban.detail.itemCount", { count: reviews.length })}>
              {reviews.length > 0 ? <div className="kanban-detail-review-list">{reviews.map((review) => <article key={review.id}><span className={`kanban-detail-review-status is-${review.status}`}>{review.status}</span><div><strong>{review.summary || review.reviewType}</strong><small>{usersById.get(review.reviewerId ?? "") || review.reviewerId || t("kanban.form.unassigned")} · {formatDateTime(review.submittedAt || review.requestedAt, locale)}</small></div></article>)}</div> : <EmptyBlock>{t("kanban.detail.noReviews")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.runsTitle")} description={t("kanban.detail.runsHint")} icon={<RobotOutlined />} meta={issue.runState ? t(`kanban.run.${issue.runState}` as "kanban.run.running") : t("kanban.detail.noCurrentRun")}>
              {issue.runId || issue.runState || issue.runResultMessage || issue.runErrorMessage ? <div className="kanban-detail-run-card"><span className="kanban-detail-run-icon"><RobotOutlined /></span><div><strong>{issue.runAgentKey || agentLabel}</strong><p>{issue.runId || issue.activeRunId || t("kanban.detail.runIdMissing")}</p><small>{formatDateTime(issue.runStartedAt, locale)}{issue.runFinishedAt ? ` — ${formatDateTime(issue.runFinishedAt, locale)}` : ""}</small>{issue.runResultMessage ? <blockquote>{issue.runResultMessage}</blockquote> : null}{issue.runErrorMessage ? <blockquote className="is-error">{issue.runErrorMessage}</blockquote> : null}</div>{issue.chatId ? <button type="button" onClick={onOpenChat}>{t("kanban.chat.view")}</button> : null}</div> : <EmptyBlock>{t("kanban.detail.noRuns")}</EmptyBlock>}
              {runEvents.length > 0 ? <div className="kanban-detail-run-events">{runEvents.map((event) => <article key={event.id}><CheckCircleFilled /><span><strong>{event.eventType}</strong><small>{formatDateTime(event.createdAt, locale)}</small></span></article>)}</div> : null}
            </DetailSection>

            <DetailSection title={t("kanban.detail.activityTitle")} description={t("kanban.detail.activityHint")} icon={<HistoryOutlined />} meta={t("kanban.detail.itemCount", { count: events.length })}>
              {events.length > 0 ? <ol className="kanban-detail-timeline">{events.map((event) => <li key={event.id}><span><ClockCircleOutlined /></span><div><strong>{event.eventType}</strong><small>{usersById.get(event.actorId ?? "") || event.actorAgent || t("kanban.detail.systemActor")} · {formatDateTime(event.createdAt, locale)}</small>{event.payload && Object.keys(event.payload).length > 0 ? <details><summary>{t("kanban.detail.eventPayload")}</summary><pre>{safeJson(event.payload)}</pre></details> : null}</div></li>)}</ol> : <EmptyBlock>{t("kanban.detail.noActivity")}</EmptyBlock>}
            </DetailSection>

            <DetailSection title={t("kanban.detail.sourceTitle")} description={isCloud ? t("kanban.detail.cloudCache") : t("kanban.detail.localIssue")} icon={isCloud ? <CloudOutlined /> : <ApartmentOutlined />}>
              {isCloud ? <div className="kanban-detail-readonly-banner is-rail"><LockOutlined /><span><strong>{t("kanban.detail.cloudReadonly")}</strong>{t("kanban.detail.cloudReadonlyHint")}</span></div> : null}
              <dl className="kanban-detail-properties">
                <div><dt>{t("kanban.detail.syncMode")}</dt><dd><LockOutlined /> {isCloud ? t("kanban.detail.readonly") : t("kanban.detail.editable")}</dd></div>
                <div><dt>{t("kanban.detail.revision")}</dt><dd>{issue.revision ?? issue.lastRemoteRevision ?? 0}</dd></div>
                <div><dt>{t("kanban.detail.createdAt")}</dt><dd><CalendarOutlined /> {formatDateTime(issue.createdAt, locale)}</dd></div>
                <div><dt>{t("kanban.detail.updatedAt")}</dt><dd><CalendarOutlined /> {formatDateTime(issue.updatedAt, locale)}</dd></div>
                <div><dt>{t("kanban.detail.createdBy")}</dt><dd>{usersById.get(issue.createdBy ?? "") || issue.createdByAgent || issue.createdBy || "—"}</dd></div>
                <div><dt>{t("kanban.detail.updatedBy")}</dt><dd>{usersById.get(issue.updatedBy ?? "") || issue.updatedByAgent || issue.updatedBy || "—"}</dd></div>
              </dl>
              {editing ? <label className="kanban-detail-check"><input type="checkbox" checked={draft.syncToCloud} onChange={(event) => updateDraft({ syncToCloud: event.target.checked })} /><span>{t("kanban.form.syncToCloud")}</span></label> : null}
            </DetailSection>
          </aside>
        </div>

        <footer className="kanban-detail-footer">
          <span><CheckCircleFilled />{editing ? t("kanban.detail.unsavedChanges") : t("kanban.detail.savedState")}</span>
          <div>{!isCloud ? <button type="button" className="kanban-detail-danger-button" onClick={() => void onDelete()}><DeleteOutlined />{t("kanban.form.delete")}</button> : null}<button type="button" className="kanban-detail-secondary-button" onClick={onClose}>{t("kanban.modal.close")}</button></div>
        </footer>
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
