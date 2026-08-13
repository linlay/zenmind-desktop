import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApartmentOutlined,
  ArrowRightOutlined,
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
  KanbanSeverity,
  KanbanStatus
} from "../../../shared/contracts";
import { KANBAN_PRIORITIES, KANBAN_STATUSES } from "../../../shared/contracts";
import { createAgentWebclientRoute } from "../../../shared/agent-webclient-routes";
import type { SupportedLocale, TranslateFunction } from "../../../shared/i18n";
import { useDebugMode } from "../../debug/DebugModeContext";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";
import { resolveKanbanIssueRuns, resolveKanbanStatusTimeline } from "./issueDetailHistory";
import { resolveKanbanIssueFields } from "./issueFieldResolution";

export type KanbanIssueDetailDraft = {
  title: string;
  projectVersion: string;
  dueDate: string;
  resolution: string;
  reporterId: string;
  componentKeys: string[];
  originalEstimateHours: string;
  remainingEstimateHours: string;
  timeSpentHours: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority | null;
  severity: KanbanSeverity | null;
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
  hostTheme: "light" | "dark";
  t: TranslateFunction;
  onClose: () => void;
  onSave: (draft: KanbanIssueDetailDraft) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onOpenChat: () => string | null;
  cloudAction?: "claim" | "run" | null;
  cloudActionBusy?: boolean;
  onClaim?: () => void;
  onRun?: () => void;
  onBindHumanReferenceChat?: (chatId: string) => Promise<{ ok: boolean; message?: string }>;
  onUnbindHumanReferenceChat?: (issueChatId: string) => Promise<{ ok: boolean; message?: string }>;
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

const DETAIL_PRIORITY_LABELS: Record<KanbanPriority, "kanban.priority.p0" | "kanban.priority.p1" | "kanban.priority.p2" | "kanban.priority.p3"> = {
  P0: "kanban.priority.p0",
  P1: "kanban.priority.p1",
  P2: "kanban.priority.p2",
  P3: "kanban.priority.p3"
};

function createDetailDraft(issue: KanbanIssue): KanbanIssueDetailDraft {
  return {
    title: issue.title,
    projectVersion: issue.projectVersion ?? "",
    dueDate: issue.dueDate ?? "",
    resolution: issue.resolution ?? "",
    reporterId: issue.reporterId ?? "",
    componentKeys: issue.componentKeys ?? [],
    originalEstimateHours: secondsToHoursInput(issue.originalEstimate),
    remainingEstimateHours: secondsToHoursInput(issue.remainingEstimate),
    timeSpentHours: secondsToHoursInput(issue.timeSpent),
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    severity: issue.severity,
    assigneeAgentKey: issue.assigneeAgentKey ?? "",
    automationEnabled: issue.automationEnabled,
    automationCron: issue.automationCron ?? "",
    automationMessage: issue.automationMessage ?? "",
    automationTimezone: issue.automationTimezone ?? "",
    attachmentChatId: issue.attachmentChatId ?? "",
    attachments: issue.attachments ?? [],
    syncToCloud: issue.syncMode === "cloud"
  };
}

function secondsToHoursInput(value: number | null | undefined) {
  if (!value) return "";
  return String(Math.round((value / 3600) * 100) / 100);
}

function formatEffort(value: number | null | undefined, t: TranslateFunction) {
  if (!value) return t("kanban.detail.notSet");
  return t("kanban.detail.hours", { value: Math.round((value / 3600) * 100) / 100 });
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

function appendMarkdown(value: string, markdown: string) {
  const current = value.trimEnd();
  return current ? `${current}\n\n${markdown}` : markdown;
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

function formatDynamicCopyValue(
  field: KanbanResolvedIssueField,
  value: unknown,
  usersById: Map<string, string>,
  issuesByRemoteId: Map<string, KanbanIssue>,
  t: TranslateFunction
) {
  if (value === undefined || value === null || value === "") {
    return t("kanban.detail.notSet");
  }
  const valueType = field.def.valueType.toLowerCase();
  if (valueType === "boolean") {
    return value === true ? t("kanban.detail.yes") : value === false ? t("kanban.detail.no") : String(value);
  }
  if (valueType === "json") {
    return safeJson(value);
  }
  const rawValues = Array.isArray(value) ? value : [value];
  const formatted = rawValues.map((item) => {
    if (valueType.includes("user")) return usersById.get(String(item)) ?? String(item);
    if (valueType.includes("issue")) return issuesByRemoteId.get(String(item))?.title ?? String(item);
    if (valueType.includes("select")) return optionForValue(field.options, item)?.name ?? String(item);
    return String(item);
  });
  const result = formatted.join(", ");
  return field.def.unit ? `${result} ${field.def.unit}` : result;
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

function DetailSection({ title, meta, icon, children, className = "", sectionId }: {
  title: string;
  meta?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  sectionId?: string;
}) {
  return (
    <section id={sectionId} className={`kanban-detail-section ${className}`}>
      <header className="kanban-detail-section-head">
        <div className="kanban-detail-section-heading">
          {icon ? <span className="kanban-detail-section-icon">{icon}</span> : null}
          <div><h2>{title}</h2></div>
        </div>
        {meta ? <span className="kanban-detail-section-meta">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

function DetailProperty({
  label,
  value,
  editing = false,
  editor,
  copyValue,
  copyTitle,
  onCopy
}: {
  label: ReactNode;
  value: ReactNode;
  editing?: boolean;
  editor?: ReactNode;
  copyValue?: string | number | null;
  copyTitle?: string;
  onCopy?: (value: string) => void | Promise<void>;
}) {
  const showEditor = editing && editor !== undefined;
  const inferredCopyValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const resolvedCopyValue = copyValue === undefined || copyValue === null ? inferredCopyValue : String(copyValue);
  const canCopy = !showEditor && Boolean(resolvedCopyValue.trim()) && Boolean(onCopy);
  const copy = () => {
    if (canCopy) void onCopy?.(resolvedCopyValue);
  };
  return (
    <div className={showEditor ? "is-editing" : undefined}>
      <dt>{label}</dt>
      <dd onDoubleClick={copy} title={canCopy ? copyTitle : undefined}>
        {showEditor
          ? <span className="kanban-detail-property-editor">{editor}</span>
          : <span className="kanban-detail-property-value"><span>{value}</span></span>}
      </dd>
    </div>
  );
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return <div className="kanban-detail-empty"><FileTextOutlined /><span>{children}</span></div>;
}

function transformMarkdownUrl(url: string, key: string) {
  if (key === "src" && /^data:image\/(?:gif|jpeg|png|svg\+xml|webp);base64,/iu.test(url)) {
    return url;
  }
  return defaultUrlTransform(url);
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.electronAPI.shell.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" decoding="async" />
};

function currentMermaidTheme(): "default" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

function MermaidDiagram({ source, t }: { source: string; t: TranslateFunction }) {
  const reactId = useId();
  const renderSequenceRef = useRef(0);
  const [theme, setTheme] = useState(currentMermaidTheme);
  const [svg, setSvg] = useState("");
  const [renderFailed, setRenderFailed] = useState(false);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(currentMermaidTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    const sequence = ++renderSequenceRef.current;
    const diagramId = `kanban-mermaid-${reactId.replace(/[^a-z0-9_-]/giu, "")}-${sequence}`;
    setSvg("");
    setRenderFailed(false);
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          maxTextSize: 50_000,
          maxEdges: 500,
          htmlLabels: false,
          theme,
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
        });
        const parsed = await mermaid.parse(source, { suppressErrors: true });
        if (!parsed) throw new Error("Invalid Mermaid syntax");
        const result = await mermaid.render(diagramId, source);
        if (!cancelled) setSvg(result.svg);
      } catch {
        if (!cancelled) setRenderFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reactId, source, theme]);

  if (renderFailed) {
    return (
      <div className="kanban-detail-mermaid is-error">
        <p role="alert">{t("kanban.detail.mermaidRenderFailed")}</p>
        <pre><code className="language-mermaid">{source}</code></pre>
      </div>
    );
  }
  if (!svg) {
    return <div className="kanban-detail-mermaid is-loading" role="status">{t("kanban.detail.mermaidLoading")}</div>;
  }
  return (
    <figure className="kanban-detail-mermaid" aria-label={t("kanban.detail.mermaidLabel")}>
      <div className="kanban-detail-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  );
}

function MarkdownPreview({
  value,
  emptyText,
  variant,
  t
}: {
  value: string;
  emptyText?: string;
  variant: "description" | "comment";
  t: TranslateFunction;
}) {
  const components = useMemo<Components>(() => ({
    ...MARKDOWN_COMPONENTS,
    pre: ({ node: _node, children, ...props }) => {
      const codeElement = Children.toArray(children)[0];
      if (isValidElement<{ className?: string; children?: ReactNode }>(codeElement)
        && /(?:^|\s)language-mermaid(?:\s|$)/iu.test(codeElement.props.className ?? "")) {
        const source = String(codeElement.props.children ?? "").replace(/\n$/u, "");
        return <MermaidDiagram source={source} t={t} />;
      }
      return <pre {...props}>{children}</pre>;
    }
  }), [t]);
  if (!value.trim()) {
    return emptyText ? <div className={`kanban-detail-markdown is-${variant} is-empty`}>{emptyText}</div> : null;
  }
  return (
    <div className={`kanban-detail-markdown is-${variant}`}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={transformMarkdownUrl}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function resizeTextareaToContent(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const borderHeight = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
}

export function KanbanIssueDetailDialog({
  issue,
  issues,
  projects,
  cloudDetails,
  agents,
  locale,
  hostTheme,
  t,
  onClose,
  onSave,
  onDelete,
  onOpenChat,
  cloudAction = null,
  cloudActionBusy = false,
  onClaim,
  onRun,
  onBindHumanReferenceChat,
  onUnbindHumanReferenceChat,
  onFeedback,
  initialEditStatus = null
}: KanbanIssueDetailDialogProps) {
  const debugMode = useDebugMode();
  const isCloud = issue.syncMode === "cloud";
  const [localDeviceId, setLocalDeviceId] = useState("");
  const [availableLocalChats, setAvailableLocalChats] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedReferenceChatId, setSelectedReferenceChatId] = useState("");
  const [referenceChatBusy, setReferenceChatBusy] = useState(false);
  const [editing, setEditing] = useState(!isCloud && Boolean(initialEditStatus));
  const [saving, setSaving] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [chatEmbedPath, setChatEmbedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => ({
    ...createDetailDraft(issue),
    status: initialEditStatus ?? issue.status
  }));
  const descriptionEditorRef = useRef<HTMLTextAreaElement>(null);
  const remoteId = issueExternalId(issue);
  const project = projects.find((candidate) => candidate.id === issue.projectId);
  const projectVersions = Array.from(new Set([
    ...(issue.projectVersion?.trim() ? [issue.projectVersion.trim()] : []),
    ...(project?.versions ?? [])
  ]));
  const projectComponents = Array.from(new Set([
    ...issue.componentKeys,
    ...(project?.components ?? [])
  ]));
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
    issue.issueTypeKey ?? issue.typeId ?? "",
    issue.workflowId ?? ""
  ), [cloudDetails.issueFieldContexts, cloudDetails.issueFieldDefs, cloudDetails.issueFieldOptions, issue.issueTypeKey, issue.projectId, issue.typeId, issue.workflowId, projects]);
  const labelIds = new Set(cloudDetails.issueLabelLinks.filter((link) => link.issueId === remoteId).map((link) => link.labelId));
  const labels = cloudDetails.issueLabels.filter((label) => labelIds.has(label.id));
  const issueIdentityIds = new Set([issue.id, remoteId]);
  const parentIssueId = issue.parentIssueId?.trim() ?? "";
  const parentIssue = parentIssueId ? issuesByRemoteId.get(parentIssueId) : undefined;
  const subtasks = issues.filter((candidate) => candidate.parentIssueId && issueIdentityIds.has(candidate.parentIssueId));
  const dependencies = cloudDetails.issueDependencies.filter((dependency) => dependency.fromIssueId === remoteId || dependency.toIssueId === remoteId);
  const reviews = cloudDetails.reviews.filter((review) => review.issueId === remoteId);
  const issueRuns = cloudDetails.issueRuns.filter((run) => run.issueId === remoteId);
  const currentRunWorker = cloudDetails.issueStageWorkers.find((worker) => worker.issueId === remoteId && worker.stageId === issue.stageId && worker.workerRole === "run");
  const issueChatsById = new Map(cloudDetails.issueChats.filter((chat) => chat.issueId === remoteId).map((chat) => [chat.id, chat]));
  const localReferenceChats = cloudDetails.issueChats.filter((chat) => chat.issueId === remoteId && chat.deviceId === localDeviceId && chat.purpose === "human_reference");
  const comments = cloudDetails.issueComments.filter((comment) => comment.issueId === remoteId);
  const events = cloudDetails.recentEvents.filter((event) => event.issueId === remoteId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const runs = issueRuns.length > 0 ? issueRuns.map((run) => {
    const chat = run.issueChatId ? issueChatsById.get(run.issueChatId) : undefined;
    return {
      id: run.id,
      issueId: run.issueId,
      workerAgent: run.workerAgent,
      chatId: chat?.chatId,
      runId: run.externalRunId || run.id,
      status: run.state,
      startedAt: run.startedAt || run.createdAt,
      finishedAt: run.finishedAt || undefined,
      resultMessage: run.resultMessage || undefined,
      errorMessage: run.errorMessage || undefined,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      deviceId: run.deviceId,
      stageId: run.stageId,
      statusId: run.statusId,
      workerRole: run.workerRole
    };
  }) : resolveKanbanIssueRuns(issue, events);
  const statusTimeline = resolveKanbanStatusTimeline(issue, events, cloudDetails.workflowStatuses, {
    backlog: t("kanban.status.backlog"),
    todo: t("kanban.status.todo"),
    in_progress: t("kanban.status.inProgress"),
    in_review: t("kanban.status.inReview"),
    completed: t("kanban.status.completed")
  });
  const timelineEventsByRevision = new Map(events.map((event) => [event.revision, event]));
  const relatedItemCount = (parentIssueId ? 1 : 0) + subtasks.length + dependencies.length + reviews.length + runs.length;
  const visibleAttachments = draft.attachments.filter((attachment) => !attachment.hidden);
  const agentLabel = agents.find((agent) => agent.agentKey === (draft.assigneeAgentKey || issue.runAgentKey || issue.workerAgent))?.displayName
    ?? draft.assigneeAgentKey
    ?? issue.runAgentKey
    ?? issue.workerAgent
    ?? t("kanban.form.unassigned");
  const assigneeUser = issue.assigneeId ? usersDetailById.get(issue.assigneeId) : undefined;
  const statusLabel = workflowStatus?.name || issue.statusName || t(DETAIL_STATUS_LABELS[issue.status]);
  const priorityLabel = issue.priority ? t(DETAIL_PRIORITY_LABELS[issue.priority]) : "—";
  const severityLabel = issue.severity ? t(`kanban.importance.${issue.severity}` as "kanban.importance.medium") : "—";
  const projectLabel = project?.name || issue.projectName || issue.projectId || "—";
  const issueTypeLabel = issueType?.name || issue.issueTypeKey || issue.typeId || "—";
  const workflowLabel = workflow?.name || issue.workflowId || "—";
  const stageLabel = stage?.name || issue.stageName || issue.stageKey || "—";
  const createdAtLabel = formatDateTime(issue.createdAt, locale);
  const updatedAtLabel = formatDateTime(issue.updatedAt, locale);
  const createdByLabel = usersById.get(issue.createdBy ?? "") || issue.createdByAgent || issue.createdBy || "—";
  const updatedByLabel = usersById.get(issue.updatedBy ?? "") || issue.updatedByAgent || issue.updatedBy || "—";
  const ownerLabel = assigneeUser?.displayName || issue.assigneeId || t("kanban.form.unassigned");
  const reporterLabel = usersById.get(issue.reporterId ?? "") || issue.reporterId || t("kanban.detail.notSet");
  const copyBehavior = {
    copyTitle: t("kanban.detail.doubleClickToCopy"),
    onCopy: copyPropertyValue
  };
  useEffect(() => {
    let active = true;
    void window.electronAPI.settings.getDeviceIdentity().then((identity) => {
      if (active) setLocalDeviceId(identity.deviceId || "");
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!isCloud) return;
    let active = true;
    void window.electronAPI.assistant.listChats().then((items) => {
      if (active) setAvailableLocalChats(items.map((chat) => ({ id: chat.id, title: chat.title || chat.id })));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [isCloud, remoteId]);
  useLayoutEffect(() => {
    resizeTextareaToContent(descriptionEditorRef.current);
  }, [draft.description, editing]);
  useEffect(() => {
    const textarea = descriptionEditorRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let previousWidth = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      resizeTextareaToContent(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [editing]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  useEffect(() => {
    if (!copyNotice) return undefined;
    const timeoutId = window.setTimeout(() => setCopyNotice(null), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copyNotice]);

  async function copyPropertyValue(value: string) {
    try {
      const result = await window.electronAPI.clipboard.writeText(value);
      setCopyNotice({
        tone: result.ok ? "success" : "error",
        message: result.ok ? t("kanban.detail.valueCopied") : t("kanban.detail.copyFailed")
      });
    } catch {
      setCopyNotice({ tone: "error", message: t("kanban.detail.copyFailed") });
    }
  }

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

  function openChat() {
    const embedPath = onOpenChat();
    if (embedPath) setChatEmbedPath(embedPath);
  }

  function openIssueChat(agentKey: string, chatId: string) {
    if (!agentKey || !chatId) return;
    setChatEmbedPath(createAgentWebclientRoute({ agentKey, chatId }));
  }

  async function bindHumanReferenceChat() {
    if (!selectedReferenceChatId || !onBindHumanReferenceChat) return;
    setReferenceChatBusy(true);
    try {
      const result = await onBindHumanReferenceChat(selectedReferenceChatId);
      onFeedback(result.ok ? "success" : "error", result.message || (result.ok ? "已关联本机对话。" : "关联本机对话失败。"));
      if (result.ok) setSelectedReferenceChatId("");
    } finally {
      setReferenceChatBusy(false);
    }
  }

  async function addAttachment(insertImages = false) {
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
      const patch: Partial<KanbanIssueDetailDraft> = {
        attachmentChatId: result.chatId || chatId,
        attachments: [...draft.attachments, ...result.attachments]
      };
      if (insertImages) {
        const markdownImages = result.attachments
          .filter((attachment) => attachment.mimeType.startsWith("image/") && (attachment.dataUrl || attachment.url))
          .map((attachment) => `![${attachment.name}](${attachment.dataUrl || attachment.url})`);
        if (markdownImages.length > 0) {
          patch.description = appendMarkdown(draft.description, markdownImages.join("\n\n"));
        }
      }
      updateDraft(patch);
      onFeedback(result.ok ? "success" : "error", result.message);
    } catch (error) {
      onFeedback("error", error instanceof Error ? error.message : t("kanban.feedback.attachmentUploadFailed"));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function openAttachment(attachment: AssistantAttachment) {
    if (attachment.url && /^https?:\/\//iu.test(attachment.url)) {
      const result = await window.electronAPI.shell.openExternal(attachment.url);
      if (!result.ok) onFeedback("error", result.error || t("kanban.feedback.attachmentLocationMissing"));
      return;
    }
    const chatId = draft.attachmentChatId.trim();
    if (!chatId) {
      onFeedback("error", t("kanban.feedback.attachmentLocationMissing"));
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(chatId, attachment.id);
    onFeedback(result.ok ? "success" : "error", result.message);
  }

  function insertMermaid() {
    updateDraft({
      description: appendMarkdown(draft.description, [
        "```mermaid",
        "flowchart LR",
        "  A[开始] --> B{检查条件}",
        "  B -->|通过| C[完成]",
        "  B -->|失败| D[回退]",
        "```"
      ].join("\n"))
    });
  }

  const dialog = (
    <div className="kanban-detail-layer" role="presentation" onMouseDown={onClose}>
      <section
        className={`kanban-detail-dialog ${chatEmbedPath ? "is-chat-view" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={chatEmbedPath ? t("kanban.chat.surfaceLabel") : undefined}
        aria-labelledby={chatEmbedPath ? undefined : "kanban-detail-title"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {copyNotice ? <div className={`kanban-detail-copy-notice is-${copyNotice.tone}`} role="status">{copyNotice.message}</div> : null}
        <header className="kanban-detail-header">
          <div className="kanban-detail-header-context">
            <div className="kanban-detail-breadcrumb"><ApartmentOutlined /><span>{project?.path || project?.name || issue.projectName || issue.projectId || "—"}</span></div>
            {isCloud ? <span className="kanban-detail-pill is-origin is-cloud"><CloudOutlined />{t("kanban.detail.cloudOrigin")}</span> : null}
          </div>
          <div className="kanban-detail-window-actions">
            {issue.chatId ? (
              <button type="button" className="kanban-detail-secondary-button" onClick={chatEmbedPath ? () => setChatEmbedPath(null) : openChat}>
                {chatEmbedPath ? <FileTextOutlined /> : <MessageOutlined />}
                {chatEmbedPath ? t("kanban.chat.viewIssue") : t("kanban.chat.view")}
              </button>
            ) : null}
            {!chatEmbedPath ? editing ? (
              <>
                <button type="button" className="kanban-detail-secondary-button" onClick={() => { setDraft(createDetailDraft(issue)); setEditing(false); }}>{t("kanban.form.cancel")}</button>
                <button type="button" className="kanban-detail-primary-button" disabled={saving} onClick={() => void saveDraft()}><SaveOutlined />{saving ? t("kanban.detail.saving") : t("kanban.form.save")}</button>
              </>
            ) : !isCloud ? (
              <button type="button" className="kanban-detail-secondary-button" onClick={() => setEditing(true)}><EditOutlined />{t("kanban.detail.editIssue")}</button>
            ) : null : null}
            <button className="kanban-detail-close" type="button" onClick={onClose} aria-label={t("kanban.modal.close")}><CloseOutlined /></button>
          </div>
        </header>

        {chatEmbedPath ? (
          <div className="kanban-detail-chat-surface">
            <ServiceWebviewSurface
              key={`kanban-chat:${issue.id}:${chatEmbedPath}`}
              active
              surfaceOwnershipActive={false}
              hostTheme={hostTheme}
              serviceId="agent-webclient"
              surfaceId="agent-webclient-kanban-chat"
              surfaceLabel={t("kanban.chat.surfaceLabel")}
              embedPath={chatEmbedPath}
              skipContextRegistration
              loadInitialEmbeddedUrlDirectly
              suppressInitialLoadingCopy
            />
          </div>
        ) : <div className="kanban-detail-body">
          <main className="kanban-detail-content">
            <div className="kanban-detail-issue-heading">
              <div className="kanban-detail-heading-row">
                <div className="kanban-detail-heading-copy">
                  <input id="kanban-detail-title" className={`kanban-detail-title-input ${editing ? "is-editing" : ""}`} value={draft.title} disabled={!editing} onChange={(event) => updateDraft({ title: event.target.value })} autoFocus={editing} />
                </div>
                <div className="kanban-detail-header-actions">
                  {cloudAction === "claim" ? <button type="button" className="kanban-detail-primary-button" disabled={cloudActionBusy} onClick={onClaim}><UserOutlined />{cloudActionBusy ? t("kanban.cloud.actionWorking") : t("kanban.cloud.claim")}</button> : null}
                  {cloudAction === "run" ? <button type="button" className="kanban-detail-primary-button" disabled={cloudActionBusy} onClick={onRun}><RobotOutlined />{cloudActionBusy ? t("kanban.cloud.actionWorking") : t("kanban.cloud.startProcessing")}</button> : null}
                </div>
              </div>
            </div>

            <DetailSection title={t("kanban.detail.descriptionTitle")} icon={<FileTextOutlined />}>
              {editing ? <>
                <div className="kanban-detail-markdown-toolbar">
                  <span>Markdown</span>
                  <button type="button" onClick={() => void addAttachment(true)}><PaperClipOutlined />{t("kanban.form.addAttachment")}</button><button type="button" onClick={insertMermaid}>Mermaid</button>
                </div>
                <textarea ref={descriptionEditorRef} className="kanban-detail-description-editor is-editing" value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} rows={12} placeholder={t("kanban.detail.noDescription")} />
              </> : <MarkdownPreview value={draft.description} emptyText={t("kanban.detail.noDescription")} variant="description" t={t} />}
            </DetailSection>

            <DetailSection title={t("kanban.detail.attachmentsTitle")} icon={<PaperClipOutlined />} meta={t("kanban.detail.itemCount", { count: visibleAttachments.length })}>
              {visibleAttachments.length > 0 ? <div className="kanban-detail-attachment-list">{visibleAttachments.map((attachment) => (
                <article key={attachment.id}><span className="kanban-detail-file-icon"><FileTextOutlined /></span><span><strong>{attachment.name}</strong><small>{attachment.mimeType || t("kanban.detail.file")} {formatFileSize(attachment.sizeBytes) ? `· ${formatFileSize(attachment.sizeBytes)}` : ""}</small></span><button type="button" onClick={() => void openAttachment(attachment)}>{t("kanban.detail.open")}</button>{editing ? <button type="button" className="is-remove" aria-label={t("kanban.form.removeAttachment", { name: attachment.name })} onClick={() => updateDraft({ attachments: draft.attachments.filter((item) => item.id !== attachment.id && item.sourceAttachmentId !== attachment.id) })}><CloseOutlined /></button> : null}</article>
              ))}</div> : <EmptyBlock>{t("kanban.detail.noAttachments")}</EmptyBlock>}
              {editing ? <button type="button" className="kanban-detail-dashed-button" disabled={attachmentBusy} onClick={() => void addAttachment()}><PaperClipOutlined />{attachmentBusy ? t("kanban.form.uploading") : t("kanban.form.addAttachment")}</button> : null}
            </DetailSection>

            <DetailSection title={t("kanban.detail.commentsTitle")} icon={<MessageOutlined />} meta={t("kanban.detail.itemCount", { count: comments.length })}>
              {comments.length > 0 ? <div className="kanban-detail-comment-list">{comments.map((comment) => {
                const author = usersDetailById.get(comment.authorUserId ?? "");
                const name = author?.displayName || comment.authorAgent || comment.authorUserId || t("kanban.detail.unknownActor");
                return <article key={comment.id}><DetailAvatar label={name} avatarUrl={author?.avatarUrl} agent={Boolean(comment.authorAgent)} /><div><p className="kanban-detail-comment-meta"><strong>{name}</strong><time>{formatDateTime(comment.createdAt, locale)}</time></p><MarkdownPreview value={comment.body} variant="comment" t={t} /></div></article>;
              })}</div> : <EmptyBlock>{t("kanban.detail.noComments")}</EmptyBlock>}
            </DetailSection>
          </main>

          <aside className="kanban-detail-rail" aria-label={t("kanban.detail.properties")}>
            <nav className="kanban-detail-anchor-nav" aria-label={t("kanban.detail.properties")}>
              {[
                ["kanban-detail-basic", t("kanban.detail.basicTitle")],
                ["kanban-detail-people", t("kanban.detail.peopleTitle")],
                ["kanban-detail-related", t("kanban.detail.relatedTitle")],
                ["kanban-detail-activity", t("kanban.detail.activityTitle")]
              ].map(([sectionId, label]) => <button key={sectionId} type="button" onClick={() => document.getElementById(sectionId)?.scrollIntoView({ block: "start" })}>{label}</button>)}
            </nav>

            <DetailSection sectionId="kanban-detail-basic" title={t("kanban.detail.basicTitle")} icon={<FileTextOutlined />}>
              <dl className="kanban-detail-properties">
                <DetailProperty {...copyBehavior} label={t("kanban.detail.issueId")} value={remoteId} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.project")} value={projectLabel} />
                <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.form.version")}
                  value={issue.projectVersion || t("kanban.detail.notSet")}
                  editing={editing}
                  editor={<select value={draft.projectVersion} onChange={(event) => updateDraft({ projectVersion: event.target.value })}><option value="">{t("kanban.detail.notSet")}</option>{projectVersions.map((version) => <option key={version} value={version}>{version}</option>)}</select>}
                />
                <DetailProperty {...copyBehavior} label={t("kanban.form.dueDate")} value={issue.dueDate || t("kanban.detail.notSet")} editing={editing} editor={<input type="date" value={draft.dueDate} onChange={(event) => updateDraft({ dueDate: event.target.value })} />} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.dueRisk")} value={issue.dueRisk || t("kanban.detail.notSet")} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.resolution")} value={issue.resolution || t("kanban.detail.notSet")} editing={editing} editor={<input maxLength={200} value={draft.resolution} onChange={(event) => updateDraft({ resolution: event.target.value })} />} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.components")} value={issue.componentKeys.join(", ") || t("kanban.detail.notSet")} editing={editing} editor={<select multiple value={draft.componentKeys} onChange={(event) => updateDraft({ componentKeys: [...event.target.selectedOptions].map((option) => option.value) })}>{projectComponents.map((component) => <option key={component} value={component}>{component}</option>)}</select>} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.originalEstimate")} value={formatEffort(issue.originalEstimate, t)} editing={editing} editor={<input type="number" min={0} step="0.25" value={draft.originalEstimateHours} onChange={(event) => updateDraft({ originalEstimateHours: event.target.value })} />} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.remainingEstimate")} value={formatEffort(issue.remainingEstimate, t)} editing={editing} editor={<input type="number" min={0} step="0.25" value={draft.remainingEstimateHours} onChange={(event) => updateDraft({ remainingEstimateHours: event.target.value })} />} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.timeSpent")} value={formatEffort(issue.timeSpent, t)} editing={editing} editor={<input type="number" min={0} step="0.25" value={draft.timeSpentHours} onChange={(event) => updateDraft({ timeSpentHours: event.target.value })} />} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.securityLevel")} value={issue.securityLevelKey || t("kanban.detail.notSet")} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.issueType")} value={issueTypeLabel} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.workflow")} value={workflowLabel} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.stage")} value={stageLabel} />
                <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.form.status")}
                  value={statusLabel}
                  editing={editing}
                  editor={<select value={draft.status} disabled={Boolean(issue.runId)} onChange={(event) => updateDraft({ status: event.target.value as KanbanStatus })}>{KANBAN_STATUSES.map((status) => <option key={status} value={status}>{t(DETAIL_STATUS_LABELS[status])}</option>)}</select>}
                />
                <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.form.priority")}
                  value={priorityLabel}
                  editing={editing}
                  editor={<select value={draft.priority ?? ""} onChange={(event) => updateDraft({ priority: event.target.value ? event.target.value as KanbanPriority : null })}><option value="">{t("kanban.detail.notSet")}</option>{KANBAN_PRIORITIES.map((priority) => <option key={priority} value={priority}>{t(DETAIL_PRIORITY_LABELS[priority])}</option>)}</select>}
                />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.severity")} value={severityLabel} editing={editing} editor={<select value={draft.severity ?? ""} onChange={(event) => updateDraft({ severity: event.target.value ? event.target.value as KanbanSeverity : null })}><option value="">{t("kanban.detail.notSet")}</option>{(["critical", "high", "medium", "low"] as const).map((severity) => <option key={severity} value={severity}>{t(`kanban.importance.${severity}` as "kanban.importance.medium")}</option>)}</select>} />
                {labels.length > 0 ? <DetailProperty {...copyBehavior} copyValue={labels.map((label) => label.name || label.key).join(", ")} label={t("kanban.detail.labelsTitle")} value={<span className="kanban-detail-labels">{labels.map((label) => <span key={label.id} style={label.color ? { borderColor: label.color, color: label.color } : undefined}>{label.name || label.key}</span>)}</span>} /> : null}
                {resolvedFields.map((field) => {
                  const value = issue.customFields?.[field.def.key] ?? field.context.defaultValue;
                  return <DetailProperty {...copyBehavior} copyValue={formatDynamicCopyValue(field, value, usersById, issuesByRemoteId, t)} key={field.def.id} label={<>{field.def.name}{field.context.required ? " *" : ""}</>} value={renderDynamicValue(field, value, usersById, issuesByRemoteId, t)} />;
                })}
                <DetailProperty {...copyBehavior} copyValue={createdAtLabel} label={t("kanban.detail.createdAt")} value={<><CalendarOutlined /> {createdAtLabel}</>} />
                <DetailProperty {...copyBehavior} copyValue={updatedAtLabel} label={t("kanban.detail.updatedAt")} value={<><CalendarOutlined /> {updatedAtLabel}</>} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.createdBy")} value={createdByLabel} />
                <DetailProperty {...copyBehavior} label={t("kanban.detail.updatedBy")} value={updatedByLabel} />
                {!isCloud ? <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.form.syncToCloud")}
                  value={draft.syncToCloud ? t("kanban.detail.yes") : t("kanban.detail.no")}
                  editing={editing}
                  editor={<label className="kanban-detail-toggle-editor"><input type="checkbox" checked={draft.syncToCloud} onChange={(event) => updateDraft({ syncToCloud: event.target.checked })} /><span>{draft.syncToCloud ? t("kanban.detail.yes") : t("kanban.detail.no")}</span></label>}
                /> : null}
                {debugMode ? <DetailProperty {...copyBehavior} label={t("kanban.detail.revision")} value={issue.revision ?? issue.lastRemoteRevision ?? "—"} /> : null}
              </dl>
              {!isCloud ? <button type="button" className="kanban-detail-danger-button" onClick={() => void onDelete()}><DeleteOutlined />{t("kanban.form.delete")}</button> : null}
            </DetailSection>

            <DetailSection sectionId="kanban-detail-people" title={t("kanban.detail.peopleTitle")} icon={<UserOutlined />}>
              <dl className="kanban-detail-properties">
                <DetailProperty {...copyBehavior} label={t("kanban.detail.owner")} value={ownerLabel} />
                <DetailProperty {...copyBehavior} label={t("kanban.form.reporter")} value={reporterLabel} editing={editing} editor={<select value={draft.reporterId} onChange={(event) => updateDraft({ reporterId: event.target.value })}><option value="">{t("kanban.detail.notSet")}</option>{cloudDetails.users.map((user) => <option key={user.id} value={user.id}>{user.displayName || user.email || user.id}</option>)}</select>} />
                <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.detail.executor")}
                  value={agentLabel}
                  editing={editing}
                  editor={<select value={draft.assigneeAgentKey} onChange={(event) => updateDraft({ assigneeAgentKey: event.target.value })}><option value="">{t("kanban.form.unassigned")}</option>{agents.map((agent) => <option key={agent.agentKey} value={agent.agentKey}>{agent.displayName}</option>)}</select>}
                />
                <DetailProperty
                  {...copyBehavior}
                  label={t("kanban.form.automationEnabled")}
                  value={draft.automationEnabled ? t("kanban.detail.enabled") : t("kanban.detail.disabled")}
                  editing={editing}
                  editor={<label className="kanban-detail-toggle-editor"><input type="checkbox" checked={draft.automationEnabled} onChange={(event) => updateDraft({ automationEnabled: event.target.checked })} /><span>{draft.automationEnabled ? t("kanban.detail.enabled") : t("kanban.detail.disabled")}</span></label>}
                />
                {draft.automationEnabled ? <>
                  <DetailProperty {...copyBehavior} label={t("kanban.form.cron")} value={draft.automationCron || t("kanban.detail.noSchedule")} editing={editing} editor={<input value={draft.automationCron} onChange={(event) => updateDraft({ automationCron: event.target.value })} />} />
                  <DetailProperty {...copyBehavior} label={t("kanban.detail.timezone")} value={draft.automationTimezone || "—"} editing={editing} editor={<input value={draft.automationTimezone} onChange={(event) => updateDraft({ automationTimezone: event.target.value })} />} />
                  <DetailProperty {...copyBehavior} label={t("kanban.detail.automationMessage")} value={draft.automationMessage || "—"} editing={editing} editor={<textarea value={draft.automationMessage} onChange={(event) => updateDraft({ automationMessage: event.target.value })} rows={3} />} />
                </> : null}
              </dl>
              {isCloud && issue.status === "in_progress" && currentRunWorker?.workerType === "human" && onBindHumanReferenceChat ? <div className="kanban-detail-owner-action"><label>关联本机对话</label><select value={selectedReferenceChatId} onChange={(event) => setSelectedReferenceChatId(event.target.value)}><option value="">选择本机已有对话</option>{availableLocalChats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select><button type="button" disabled={referenceChatBusy || !selectedReferenceChatId} onClick={() => void bindHumanReferenceChat()}>{referenceChatBusy ? "关联中…" : "关联"}</button>{localReferenceChats.map((chat) => <span key={chat.id}>{chat.chatId}<button type="button" disabled={referenceChatBusy} onClick={() => void onUnbindHumanReferenceChat?.(chat.id).then((result) => onFeedback(result.ok ? "success" : "error", result.message || (result.ok ? "已解除关联。" : "解除关联失败。")))}>解除</button></span>)}</div> : null}
            </DetailSection>

            <DetailSection sectionId="kanban-detail-related" title={t("kanban.detail.relatedTitle")} icon={<LinkOutlined />} meta={t("kanban.detail.itemCount", { count: relatedItemCount })}>
              {relatedItemCount > 0 ? <div className="kanban-detail-related-groups">
                {parentIssueId ? <div><h3>{t("kanban.detail.parentTitle")}</h3><div className="kanban-detail-related-list"><article><FileTextOutlined /><span><strong>{parentIssue?.title || parentIssueId}</strong><small>{parentIssueId}{parentIssue ? ` · ${parentIssue.statusName || t(DETAIL_STATUS_LABELS[parentIssue.status])}` : ""}</small></span></article></div></div> : null}
                {subtasks.length > 0 ? <div><h3>{t("kanban.detail.subtasksTitle")}</h3><div className="kanban-detail-related-list">{subtasks.map((subtask) => <article key={subtask.id}><CheckCircleFilled className={subtask.status === "completed" ? "is-complete" : ""} /><span><strong>{subtask.title}</strong><small>{issueExternalId(subtask)} · {subtask.statusName || t(DETAIL_STATUS_LABELS[subtask.status])}</small></span></article>)}</div></div> : null}
                {dependencies.length > 0 ? <div><h3>{t("kanban.detail.dependenciesTitle")}</h3><div className="kanban-detail-dependency-list">{dependencies.map((dependency) => {
                  const outbound = dependency.fromIssueId === remoteId;
                  const relatedId = outbound ? dependency.toIssueId : dependency.fromIssueId;
                  const related = issuesByRemoteId.get(relatedId);
                  return <article key={dependency.id}><span>{outbound ? dependency.type : t("kanban.detail.dependedBy")}</span><div><strong>{related?.title || relatedId}</strong><small>{relatedId}{related ? ` · ${related.statusName || t(DETAIL_STATUS_LABELS[related.status])}` : ""}</small></div></article>;
                })}</div></div> : null}
                {reviews.length > 0 ? <div><h3>{t("kanban.detail.reviewsTitle")}</h3><div className="kanban-detail-review-list">{reviews.map((review) => <article key={review.id}><span className={`kanban-detail-review-status is-${review.status}`}>{review.status}</span><div><strong>{review.summary || review.reviewType}</strong><small>{usersById.get(review.reviewerId ?? "") || review.reviewerId || t("kanban.form.unassigned")} · {formatDateTime(review.submittedAt || review.requestedAt, locale)}</small></div></article>)}</div></div> : null}
                {runs.length > 0 ? <div><h3><RobotOutlined />{t("kanban.detail.runsTitle")}</h3><div className="kanban-detail-run-list">{runs.map((run) => <div key={run.id} className="kanban-detail-run-card"><span className="kanban-detail-run-icon"><RobotOutlined /></span><div><strong>{run.workerAgent || "—"}{run.status ? <em className={`is-${run.status}`}>{t(`kanban.run.${run.status}` as "kanban.run.running")}</em> : null}</strong><p>{run.runId || t("kanban.detail.runIdMissing")}</p><small>{"stageId" in run ? `${run.stageId} → ${run.statusId} · ${run.deviceId} · ${run.workerRole === "review" ? "Review" : "Run"} · ` : ""}{formatDateTime(run.startedAt, locale)}{run.finishedAt ? ` — ${formatDateTime(run.finishedAt, locale)}` : ""}</small>{run.resultMessage ? <blockquote>{run.resultMessage}</blockquote> : null}{run.errorMessage ? <blockquote className="is-error">{run.errorMessage}</blockquote> : null}</div>{run.chatId && "deviceId" in run && run.deviceId === localDeviceId ? <button type="button" onClick={() => openIssueChat(run.workerAgent || "", run.chatId || "")}>{t("kanban.chat.view")}</button> : run.chatId && !("deviceId" in run) && run.chatId === issue.chatId ? <button type="button" onClick={openChat}>{t("kanban.chat.view")}</button> : null}</div>)}</div></div> : null}
              </div> : <EmptyBlock>{t("kanban.detail.noRelated")}</EmptyBlock>}
            </DetailSection>

            <DetailSection sectionId="kanban-detail-activity" title={t("kanban.detail.activityTitle")} icon={<HistoryOutlined />} meta={t("kanban.detail.itemCount", { count: statusTimeline.length })}>
              {statusTimeline.length > 0 ? <ol className="kanban-detail-timeline is-status-timeline">{statusTimeline.map((entry, index) => {
                const event = timelineEventsByRevision.get(entry.revision);
                return <li key={`${entry.key}:${entry.revision}`}><span>{index === 0 ? <CheckCircleFilled /> : <ClockCircleOutlined />}</span><div><strong className="kanban-detail-timeline-transition"><span>{entry.fromLabel || t("kanban.detail.notSet")}</span><ArrowRightOutlined /><span>{entry.toLabel}</span></strong><small>{usersById.get(entry.actor) || entry.actor || t("kanban.detail.unknownActor")} · {formatDateTime(entry.createdAt, locale)}</small>{debugMode && event?.payload && Object.keys(event.payload).length > 0 ? <details><summary>{t("kanban.detail.eventPayload")}</summary><pre>{safeJson(event.payload)}</pre></details> : null}</div></li>;
              })}</ol> : <EmptyBlock>{t("kanban.detail.noActivity")}</EmptyBlock>}
            </DetailSection>

            {isCloud ? <div className="kanban-detail-readonly-note"><LockOutlined /><span>{t("kanban.detail.cloudReadonlyCompact")}</span></div> : null}
          </aside>
        </div>}

      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
