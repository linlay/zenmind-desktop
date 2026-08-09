import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  FlagOutlined,
  HistoryOutlined,
  HourglassOutlined,
  MessageOutlined,
  OrderedListOutlined,
  PlusOutlined,
  RobotOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserOutlined
} from "@ant-design/icons";
import type {
  AssistantAttachment,
  AssistantEvent,
  AssistantNavAgentItem,
  DesktopApi,
  DesktopPetAgentOption,
  KanbanCloudDetailData,
  KanbanCloudUser,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueUpdateInput,
  KanbanPriority,
  KanbanProject,
  KanbanStatus,
  KanbanWorkflowStage,
  KanbanWorkflowStatus
} from "../../../shared/contracts";
import { KANBAN_PRIORITIES, KANBAN_STATUSES } from "../../../shared/contracts";
import {
  createAgentWebclientAgentPath,
  createAgentWebclientRoute,
} from "../../../shared/agent-webclient-routes";
import type { SupportedLocale, TranslateFunction, TranslationKey } from "../../../shared/i18n";
import {
  getAssistantNavAgentRecentChats,
  normalizeAssistantNavAgents
} from "../../assistantNavigation";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";
import { useI18n } from "../../i18n/useI18n";
import { flattenKanbanProjectTree } from "./kanbanProjectTree";
import { ImportanceIcon, PriorityIcon } from "./StatusIcons";
import { KanbanIssueDetailDialog, type KanbanIssueDetailDraft } from "./KanbanIssueDetailDialog";

type MenuKind = "display" | "cloud" | null;
type SearchFilterMenuKind = "priority" | "severity" | "automation" | null;
type ModalMode = "create" | "edit";
type ThemeMode = "light" | "dark";
type KanbanAutomationPlan = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
type KanbanAutomationFilter = "all" | "scheduled" | "manual";
type AutomationMenuKind = "plan" | "time";
type ModalState = {
  mode: ModalMode;
  issue?: KanbanIssue;
};

type IssueFormState = {
  title: string;
  description: string;
  attachmentChatId: string;
  attachments: AssistantAttachment[];
  status: KanbanStatus;
  priority: KanbanPriority;
  assigneeAgentKey: string;
  automationEnabled: boolean;
  automationPreset: KanbanAutomationPlan;
  automationTime: string;
  automationCron: string;
  automationMessage: string;
  automationTimezone: string;
  syncToCloud: boolean;
};

type DisplayState = {
  priority: boolean;
};

type KanbanIssueOriginPresentation = {
  projectLabel: string;
  title: string;
};

type KanbanSeverity = NonNullable<KanbanIssue["severity"]>;

type IssueCardSignalTone = KanbanStatus | "running" | "awaiting" | "succeeded" | "failed" | "cancelled";

type IssueCardSignalIconName = "history" | "order" | "running" | "waiting" | "completed" | "failed" | "cancelled";

type IssueCardSignalPresentation = {
  label: string;
  tone: IssueCardSignalTone;
  icon: IssueCardSignalIconName;
};

type IssueCardDuePresentation = {
  label: string;
  title: string;
  overdue: boolean;
};

type IssueCardProgressPresentation = {
  color: string;
  percent: number;
  stageLabel: string;
};

type IssueCardPersonPresentation = {
  icon: ReactNode;
  label: string;
  rawLabel: string;
  avatarUrl?: string | null;
  kind: "assignee" | "worker" | "reviewer";
};

type Feedback = {
  tone: "success" | "error";
  message: string;
};

type KanbanPageProps = {
  hostTheme: ThemeMode;
};

type KanbanConnectionState = NonNullable<Awaited<ReturnType<DesktopApi["kanban"]["listIssues"]>>["connectionState"]>;

type KanbanChatModalRequest = {
  agentKey: string;
  chatId?: string;
  displayName?: string;
};

type KanbanContextMenu = {
  issueId: string;
  x: number;
  y: number;
};

const KANBAN_FEEDBACK_AUTO_CLOSE_MS = 3000;
const KANBAN_TODO_ASSIGNEE_START_DELAY_MS = 1000;
const KANBAN_COUNTDOWN_REFRESH_MS = 60_000;
const VISIBLE_KANBAN_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "completed"
] satisfies ReadonlyArray<KanbanStatus>;
const VISIBLE_KANBAN_STATUS_SET = new Set<KanbanStatus>(VISIBLE_KANBAN_STATUSES);

const ISSUE_STAGE_COLOR_PALETTE = [
  "#8b5cf6",
  "#3b82f6",
  "#f59e0b",
  "#22b8c7",
  "#ec4899",
  "#6366f1"
] as const;

const ISSUE_STAGE_FALLBACK_COLOR = "#86909c";

const STATUS_META: Record<KanbanStatus, { labelKey: TranslationKey; tone: string }> = {
  backlog: { labelKey: "kanban.status.backlog", tone: "neutral" },
  todo: { labelKey: "kanban.status.todo", tone: "muted" },
  in_progress: { labelKey: "kanban.status.inProgress", tone: "warning" },
  in_review: { labelKey: "kanban.status.inReview", tone: "review" },
  completed: { labelKey: "kanban.status.completed", tone: "info" }
};

const PRIORITY_META: Record<KanbanPriority, { labelKey: TranslationKey; shortLabelKey: TranslationKey; tone: string; bars: number }> = {
  P0: { labelKey: "kanban.priority.p0", shortLabelKey: "kanban.priority.p0", tone: "p0", bars: 4 },
  P1: { labelKey: "kanban.priority.p1", shortLabelKey: "kanban.priority.p1", tone: "p1", bars: 3 },
  P2: { labelKey: "kanban.priority.p2", shortLabelKey: "kanban.priority.p2", tone: "p2", bars: 2 },
  P3: { labelKey: "kanban.priority.p3", shortLabelKey: "kanban.priority.p3", tone: "p3", bars: 1 }
};

const SEVERITY_META: Record<KanbanSeverity, { labelKey: TranslationKey; shortLabelKey: TranslationKey; tone: string }> = {
  critical: { labelKey: "kanban.importance.critical", shortLabelKey: "kanban.importance.criticalShort", tone: "critical" },
  high: { labelKey: "kanban.importance.high", shortLabelKey: "kanban.importance.highShort", tone: "high" },
  medium: { labelKey: "kanban.importance.medium", shortLabelKey: "kanban.importance.mediumShort", tone: "medium" },
  low: { labelKey: "kanban.importance.low", shortLabelKey: "kanban.importance.lowShort", tone: "low" }
};

const KANBAN_DEMO_OWNER_KEYS = [
  "kanban.card.demoOwnerNina",
  "kanban.card.demoOwnerEvan",
  "kanban.card.demoOwnerMika"
] satisfies ReadonlyArray<TranslationKey>;

const KANBAN_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low"
] satisfies ReadonlyArray<KanbanSeverity>;

const DEFAULT_KANBAN_AUTOMATION_PLAN: KanbanAutomationPlan = "daily";
const DEFAULT_KANBAN_AUTOMATION_TIME = "09:00";
const DEFAULT_KANBAN_AUTOMATION_CRON = "0 9 * * *";

const KANBAN_AUTOMATION_PLANS = [
  { labelKey: "kanban.automation.hourly", value: "hourly" },
  { labelKey: "kanban.automation.daily", value: "daily" },
  { labelKey: "kanban.automation.weekdays", value: "weekdays" },
  { labelKey: "kanban.automation.weekly", value: "weekly" },
  { labelKey: "kanban.automation.custom", value: "custom" }
] satisfies ReadonlyArray<{ labelKey: TranslationKey; value: KanbanAutomationPlan }>;

const KANBAN_AUTOMATION_FILTER_OPTIONS = [
  { labelKey: "kanban.searchFilter.allAutomation", value: "all" },
  { labelKey: "kanban.searchFilter.hasAutomation", value: "scheduled" },
  { labelKey: "kanban.searchFilter.noAutomation", value: "manual" }
] satisfies ReadonlyArray<{ labelKey: TranslationKey; value: KanbanAutomationFilter }>;

const KANBAN_AUTOMATION_TIME_OPTIONS = buildAutomationTimeOptions();

const EMPTY_KANBAN_CLOUD_DETAILS: KanbanCloudDetailData = {
  users: [],
  issueTypes: [],
  issueFieldDefs: [],
  issueFieldContexts: [],
  issueFieldOptions: [],
  workflows: [],
  workflowStages: [],
  workflowStatuses: [],
  issueLabels: [],
  issueLabelLinks: [],
  issueDependencies: [],
  reviews: [],
  issueComments: [],
  recentEvents: []
};

const emptyForm: IssueFormState = {
  title: "",
  description: "",
  attachmentChatId: "",
  attachments: [],
  status: "backlog",
  priority: "P2",
  assigneeAgentKey: "",
  automationEnabled: false,
  automationPreset: DEFAULT_KANBAN_AUTOMATION_PLAN,
  automationTime: DEFAULT_KANBAN_AUTOMATION_TIME,
  automationCron: DEFAULT_KANBAN_AUTOMATION_CRON,
  automationMessage: "",
  automationTimezone: "Asia/Shanghai",
  syncToCloud: false
};

const defaultDisplayState: DisplayState = {
  priority: true
};

function getColumnId(status: KanbanStatus) {
  return `kanban-column:${status}`;
}

function getStatusFromColumnId(id: string): KanbanStatus | null {
  const status = id.replace(/^kanban-column:/u, "");
  return KANBAN_STATUSES.includes(status as KanbanStatus) ? status as KanbanStatus : null;
}

function detectKanbanCollisions(args: Parameters<CollisionDetection>[0]) {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  const intersectingCollisions = rectIntersection(args);
  if (intersectingCollisions.length > 0) {
    return intersectingCollisions;
  }

  return closestCenter(args);
}

function issueUpdatedTime(issue: KanbanIssue) {
  const timestamp = Date.parse(issue.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortIssues(issues: KanbanIssue[]) {
  const statusOrder = new Map(KANBAN_STATUSES.map((status, index) => [status, index]));
  return [...issues].sort((a, b) => {
    const statusDelta = (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
    if (a.position !== b.position) return a.position - b.position;
    const updatedDelta = issueUpdatedTime(b) - issueUpdatedTime(a);
    if (updatedDelta !== 0) return updatedDelta;
    return a.id.localeCompare(b.id);
  });
}

function padAutomationNumber(value: number) {
  return String(value).padStart(2, "0");
}

function isSameLocalDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatIssueUpdatedTime(updatedAt: string, currentDate = new Date()) {
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) {
    return "";
  }
  const time = `${padAutomationNumber(updatedDate.getHours())}:${padAutomationNumber(updatedDate.getMinutes())}`;
  if (isSameLocalDate(updatedDate, currentDate)) {
    return time;
  }
  const date = `${padAutomationNumber(updatedDate.getMonth() + 1)}/${padAutomationNumber(updatedDate.getDate())}`;
  if (updatedDate.getFullYear() !== currentDate.getFullYear()) {
    return `${updatedDate.getFullYear()}/${date}`;
  }
  return date;
}

function formatKanbanCompactDuration(value: string | null | undefined, now: Date) {
  const timestamp = Date.parse(value ?? "");
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTimestamp) || timestamp > nowTimestamp) {
    return "";
  }

  const totalMinutes = Math.floor((nowTimestamp - timestamp) / 60_000);
  if (totalMinutes < 1) {
    return "<1m";
  }

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function formatKanbanCompletionTime(value: string | null | undefined, locale: SupportedLocale) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function formatKanbanSortNumber(sortIndex: number | undefined, position: number) {
  if (typeof sortIndex === "number" && Number.isFinite(sortIndex) && sortIndex > 0) {
    return `#${Math.round(sortIndex)}`;
  }
  return Number.isFinite(position) ? `#${Math.max(1, Math.round(position))}` : "";
}

function buildAutomationTimeOptions() {
  const options: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      options.push(`${padAutomationNumber(hour)}:${padAutomationNumber(minute)}`);
    }
  }
  return options;
}

function normalizeAutomationTime(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{1,2})/u);
  if (!match) {
    return DEFAULT_KANBAN_AUTOMATION_TIME;
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  const roundedTotalMinutes = Math.min((23 * 60) + 45, Math.round(((hour * 60) + minute) / 15) * 15);
  return `${padAutomationNumber(Math.floor(roundedTotalMinutes / 60))}:${padAutomationNumber(roundedTotalMinutes % 60)}`;
}

function automationTimeParts(value: string) {
  const [hour, minute] = normalizeAutomationTime(value).split(":");
  return {
    hour: String(Number(hour)),
    minute: String(Number(minute))
  };
}

function buildAutomationCron(plan: KanbanAutomationPlan, time: string, customCron: string) {
  if (plan === "custom") {
    return customCron.trim();
  }
  const { hour, minute } = automationTimeParts(time);
  if (plan === "hourly") {
    return `${minute} * * * *`;
  }
  if (plan === "weekdays") {
    return `${minute} ${hour} * * 1-5`;
  }
  if (plan === "weekly") {
    return `${minute} ${hour} * * 1`;
  }
  return `${minute} ${hour} * * *`;
}

function isNumericCronPart(value: string) {
  return /^\d+$/u.test(value);
}

function isFifteenMinuteCronMinute(value: string) {
  if (!isNumericCronPart(value)) {
    return false;
  }
  const minute = Number(value);
  return minute >= 0 && minute <= 59 && minute % 15 === 0;
}

function isCronHour(value: string) {
  if (!isNumericCronPart(value)) {
    return false;
  }
  const hour = Number(value);
  return hour >= 0 && hour <= 23;
}

function formatAutomationTime(hour: string, minute: string) {
  return `${padAutomationNumber(Number(hour))}:${padAutomationNumber(Number(minute))}`;
}

function parseAutomationFormFromCron(value: string | null | undefined) {
  const automationCron = value?.trim() || DEFAULT_KANBAN_AUTOMATION_CRON;
  const parts = automationCron.split(/\s+/u);
  if (parts.length !== 5) {
    return {
      automationPreset: "custom" as KanbanAutomationPlan,
      automationTime: DEFAULT_KANBAN_AUTOMATION_TIME,
      automationCron
    };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!isFifteenMinuteCronMinute(minute)) {
    return {
      automationPreset: "custom" as KanbanAutomationPlan,
      automationTime: DEFAULT_KANBAN_AUTOMATION_TIME,
      automationCron
    };
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return {
      automationPreset: "hourly" as KanbanAutomationPlan,
      automationTime: formatAutomationTime("0", minute),
      automationCron
    };
  }
  if (!isCronHour(hour) || dayOfMonth !== "*" || month !== "*") {
    return {
      automationPreset: "custom" as KanbanAutomationPlan,
      automationTime: DEFAULT_KANBAN_AUTOMATION_TIME,
      automationCron
    };
  }
  if (dayOfWeek === "*") {
    return {
      automationPreset: "daily" as KanbanAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  if (dayOfWeek === "1-5") {
    return {
      automationPreset: "weekdays" as KanbanAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  if (dayOfWeek === "1") {
    return {
      automationPreset: "weekly" as KanbanAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  return {
    automationPreset: "custom" as KanbanAutomationPlan,
    automationTime: DEFAULT_KANBAN_AUTOMATION_TIME,
    automationCron
  };
}

function getAutomationPlanLabel(plan: KanbanAutomationPlan, t: TranslateFunction) {
  const labelKey = KANBAN_AUTOMATION_PLANS.find((candidate) => candidate.value === plan)?.labelKey ?? "kanban.automation.custom";
  return t(labelKey);
}

function buildCompactIssueTitle(description: string) {
  const firstLine = description
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return Array.from(firstLine).slice(0, 24).join("");
}

function buildAssistantPrompt(issue: KanbanIssue, t: TranslateFunction) {
  const parts = [
    t("kanban.prompt.intro"),
    t("kanban.prompt.rule"),
    t("kanban.prompt.id", { value: issue.remoteIssueId ?? issue.id }),
    t("kanban.prompt.title", { value: issue.title }),
    t("kanban.prompt.status", { value: t(STATUS_META[issue.status].labelKey) }),
    t("kanban.prompt.priority", { value: t(PRIORITY_META[issue.priority].labelKey) })
  ];
  if (issue.description.trim()) {
    parts.push(t("kanban.prompt.description", { value: issue.description.trim() }));
  }
  return parts.join("\n");
}

function computeDropPosition(targetIssues: KanbanIssue[], insertIndex: number) {
  const before = insertIndex > 0 ? targetIssues[insertIndex - 1] : null;
  const after = insertIndex < targetIssues.length ? targetIssues[insertIndex] : null;
  if (!before && !after) return 1;
  if (!before && after) return after.position - 1;
  if (before && !after) return before.position + 1;
  return (before!.position + after!.position) / 2;
}

function computeSortableDropPosition(
  issues: KanbanIssue[],
  activeId: string,
  overIssue: KanbanIssue | undefined,
  targetStatus: KanbanStatus
) {
  const targetIssues = sortIssues(issues).filter((issue) => issue.status === targetStatus);
  if (overIssue?.status === targetStatus) {
    const activeIndex = targetIssues.findIndex((issue) => issue.id === activeId);
    const overIndex = targetIssues.findIndex((issue) => issue.id === overIssue.id);
    if (activeIndex >= 0 && overIndex >= 0) {
      const reorderedIssues = arrayMove(targetIssues, activeIndex, overIndex);
      const insertIndex = reorderedIssues.findIndex((issue) => issue.id === activeId);
      return computeDropPosition(
        reorderedIssues.filter((issue) => issue.id !== activeId),
        insertIndex
      );
    }
  }

  const targetIssuesWithoutActive = targetIssues.filter((issue) => issue.id !== activeId);
  const overIndex = overIssue
    ? targetIssuesWithoutActive.findIndex((issue) => issue.id === overIssue.id)
    : targetIssuesWithoutActive.length;
  const insertIndex = overIssue && overIndex >= 0 ? overIndex : targetIssuesWithoutActive.length;
  return computeDropPosition(targetIssuesWithoutActive, insertIndex);
}

function createFormFromIssue(issue: KanbanIssue): IssueFormState {
  const automationForm = parseAutomationFormFromCron(issue.automationCron);
  return {
    title: issue.title,
    description: issue.description,
    attachmentChatId: issue.attachmentChatId ?? issue.chatId ?? createKanbanAttachmentChatId(issue.id),
    attachments: issue.attachments ?? [],
    status: issue.status,
    priority: issue.priority,
    assigneeAgentKey: issue.assigneeAgentKey ?? "",
    automationEnabled: issue.automationEnabled,
    automationPreset: automationForm.automationPreset,
    automationTime: automationForm.automationTime,
    automationCron: automationForm.automationCron,
    automationMessage: issue.automationMessage ?? "",
    automationTimezone: issue.automationTimezone ?? "Asia/Shanghai",
    syncToCloud: issue.syncMode === "cloud"
  };
}

function createKanbanAttachmentChatId(seed: string) {
  const safeSeed = seed.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return `kanban-${safeSeed}`;
}

function createKanbanDraftAttachmentChatId() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `kanban-draft-${Date.now().toString(36)}-${randomPart}`;
}

function getVisibleKanbanAttachments(attachments: AssistantAttachment[] | null | undefined) {
  return (attachments ?? []).filter((attachment) => !attachment.hidden);
}

function formatKanbanAttachmentSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  }
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

function mergeKanbanIssueAttachmentDraft(
  issue: KanbanIssue | undefined,
  attachmentChatId: string,
  attachments: AssistantAttachment[]
) {
  if (!issue) {
    return issue;
  }
  return {
    ...issue,
    attachmentChatId: attachments.length > 0 ? attachmentChatId : null,
    attachments
  };
}

function mergeKanbanIssuesAttachmentDraft(
  issues: KanbanIssue[],
  savedIssue: KanbanIssue | undefined
) {
  if (!savedIssue) {
    return issues;
  }
  return issues.map((issue) => issue.id === savedIssue.id ? savedIssue : issue);
}

function getAssigneeName(agentKey: string, agents: AssistantNavAgentItem[]) {
  if (!agentKey) return null;
  return agents.find((agent) => agent.agentKey === agentKey)?.displayName ?? agentKey;
}

function getAssigneeAgent(issue: KanbanIssue, agents: AssistantNavAgentItem[]) {
  const agentKey = issue.assigneeAgentKey?.trim();
  return agentKey ? agents.find((agent) => agent.agentKey === agentKey) : undefined;
}

function formatKanbanPersonLabel(value: string | null | undefined, fallback: string) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const deviceMatch = /^device:([0-9a-f]{8})/i.exec(raw);
  if (deviceMatch) {
    return `设备·${deviceMatch[1]}`;
  }
  const uuidMatch = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(raw);
  if (uuidMatch) {
    return raw.slice(0, 8);
  }
  if (raw.length > 14) {
    return `${raw.slice(0, 12)}…`;
  }
  return raw;
}

function getPersonInitials(label: string): string {
  const raw = label.trim();
  if (!raw) return "?";

  const chars = Array.from(raw);
  if (/^[\u4e00-\u9fa5]/.test(chars[0] ?? "")) {
    return chars.length >= 2 ? chars.slice(0, 2).join("") : chars[0]!;
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

function getKanbanCloudUser(userId: string | null | undefined, users: KanbanCloudUser[]) {
  const normalizedUserId = userId?.trim();
  return normalizedUserId ? users.find((user) => user.id === normalizedUserId) : undefined;
}

function getIssueCardAssigneePresentation(
  issue: KanbanIssue,
  agents: AssistantNavAgentItem[],
  users: KanbanCloudUser[],
  t: TranslateFunction
): IssueCardPersonPresentation | null {
  const cloudUser = getKanbanCloudUser(issue.assigneeId, users);
  const rawLabel = cloudUser?.displayName?.trim()
    || getAssigneeName(issue.assigneeAgentKey ?? "", agents)?.trim()
    || issue.assigneeId?.trim()
    || "";
  if (!rawLabel) {
    return canEditKanbanIssueBody(issue) ? {
      icon: <UserOutlined />,
      label: t("kanban.form.unassigned"),
      rawLabel: t("kanban.form.unassigned"),
      kind: "assignee"
    } : null;
  }
  return {
    icon: <UserOutlined />,
    label: formatKanbanPersonLabel(rawLabel, t("kanban.form.unassigned")),
    rawLabel,
    avatarUrl: cloudUser?.avatarUrl,
    kind: "assignee"
  };
}

function getIssueCardWorkerPresentation(
  issue: KanbanIssue,
  agents: AssistantNavAgentItem[],
  users: KanbanCloudUser[],
  t: TranslateFunction
): IssueCardPersonPresentation | null {
  if (issue.workerType === "agent" && issue.workerAgent?.trim()) {
    const rawLabel = issue.workerAgent.trim();
    return {
      icon: <RobotOutlined />,
      label: formatKanbanPersonLabel(getAssigneeName(rawLabel, agents), t("kanban.form.unassigned")),
      rawLabel,
      kind: "worker"
    };
  }
  if (issue.workerType === "human" && issue.workerId?.trim()) {
    const cloudUser = getKanbanCloudUser(issue.workerId, users);
    const rawLabel = cloudUser?.displayName?.trim() || issue.workerId.trim();
    return {
      icon: <UserOutlined />,
      label: formatKanbanPersonLabel(rawLabel, t("kanban.form.unassigned")),
      rawLabel,
      avatarUrl: cloudUser?.avatarUrl,
      kind: "worker"
    };
  }
  return null;
}

function getIssueCardReviewerPresentation(
  issue: KanbanIssue,
  users: KanbanCloudUser[],
  t: TranslateFunction
): IssueCardPersonPresentation | null {
  const cloudUser = getKanbanCloudUser(issue.reviewerId, users);
  const rawLabel = cloudUser?.displayName?.trim() || issue.reviewerId?.trim() || "";
  if (!rawLabel) {
    return null;
  }
  return {
    icon: <UserOutlined />,
    label: formatKanbanPersonLabel(rawLabel, t("kanban.form.unassigned")),
    rawLabel,
    avatarUrl: cloudUser?.avatarUrl,
    kind: "reviewer"
  };
}

function getIssueCardPeoplePresentation(
  issue: KanbanIssue,
  agents: AssistantNavAgentItem[],
  users: KanbanCloudUser[],
  t: TranslateFunction
) {
  const assignee = getIssueCardAssigneePresentation(issue, agents, users, t);
  const worker = getIssueCardWorkerPresentation(issue, agents, users, t);
  const reviewer = getIssueCardReviewerPresentation(issue, users, t);
  const normalizedAssignee = assignee?.rawLabel.trim().toLocaleLowerCase();
  const visibleWorker = worker?.rawLabel.trim().toLocaleLowerCase() === normalizedAssignee ? null : worker;
  const visibleReviewer = reviewer?.rawLabel.trim().toLocaleLowerCase() === normalizedAssignee ? null : reviewer;
  const people = issue.status === "in_review"
    ? [assignee, visibleReviewer]
    : issue.status === "todo" || issue.status === "in_progress"
      ? [assignee, visibleWorker]
      : [assignee];
  const visiblePeople = people.filter((person): person is IssueCardPersonPresentation => Boolean(person));
  return {
    people: visiblePeople,
    title: visiblePeople.map((person) => person.rawLabel).join(" -> ")
  };
}

function getIssueCardPeopleWithDevDemo(
  issue: KanbanIssue,
  presentation: ReturnType<typeof getIssueCardPeoplePresentation>,
  t: TranslateFunction
) {
  if (!import.meta.env.DEV || issue.syncMode !== "cloud") {
    return presentation;
  }

  const seed = Array.from(issue.id).reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0
  );
  const ownerLabel = t(KANBAN_DEMO_OWNER_KEYS[seed % KANBAN_DEMO_OWNER_KEYS.length]!);
  const collaboratorLabel = t(KANBAN_DEMO_OWNER_KEYS[(seed + 1) % KANBAN_DEMO_OWNER_KEYS.length]!);
  const demoByKind: Record<IssueCardPersonPresentation["kind"], IssueCardPersonPresentation> = {
    assignee: {
      icon: <UserOutlined />,
      label: ownerLabel,
      rawLabel: ownerLabel,
      kind: "assignee"
    },
    worker: seed % 2 === 0 ? {
      icon: <RobotOutlined />,
      label: t("kanban.card.demoAgent"),
      rawLabel: t("kanban.card.demoAgent"),
      kind: "worker"
    } : {
      icon: <UserOutlined />,
      label: collaboratorLabel,
      rawLabel: collaboratorLabel,
      kind: "worker"
    },
    reviewer: {
      icon: <UserOutlined />,
      label: collaboratorLabel,
      rawLabel: collaboratorLabel,
      kind: "reviewer"
    }
  };
  const visibleKinds: IssueCardPersonPresentation["kind"][] = issue.status === "in_review"
    ? ["assignee", "reviewer"]
    : issue.status === "todo" || issue.status === "in_progress"
      ? ["assignee", "worker"]
      : ["assignee"];
  const people = visibleKinds.map(
    (kind) => presentation.people.find((person) => person.kind === kind) ?? demoByKind[kind]
  );
  return {
    people,
    title: people.map((person) => person.rawLabel).join(" -> ")
  };
}

function sortWorkflowStages(stages: KanbanWorkflowStage[]) {
  return [...stages].sort((left, right) => {
    const positionDelta = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
    return positionDelta !== 0 ? positionDelta : left.id.localeCompare(right.id);
  });
}

function sortWorkflowStatuses(statuses: KanbanWorkflowStatus[]) {
  return [...statuses].sort((left, right) => {
    const positionDelta = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
    return positionDelta !== 0 ? positionDelta : left.id.localeCompare(right.id);
  });
}

function getKnownStagePaletteIndex(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLocaleLowerCase();
  if (!normalized) return -1;
  if (/review|评审|审查/u.test(normalized)) return 0;
  if (/develop|development|build|开发|构建/u.test(normalized)) return 1;
  if (/test|testing|qa|验收|测试/u.test(normalized)) return 2;
  if (/release|deploy|launch|production|上线|发布/u.test(normalized)) return 3;
  return -1;
}

function findIssueWorkflowStage(issue: KanbanIssue, details: KanbanCloudDetailData) {
  const workflowStages = issue.workflowId
    ? details.workflowStages.filter((stage) => stage.workflowId === issue.workflowId)
    : details.workflowStages;
  const stage = workflowStages.find((candidate) => candidate.id === issue.stageId)
    || workflowStages.find((candidate) => candidate.key === issue.stageKey)
    || workflowStages.find((candidate) => candidate.name === issue.stageName);
  const orderedStages = sortWorkflowStages(stage
    ? details.workflowStages.filter((candidate) => candidate.workflowId === stage.workflowId)
    : workflowStages);
  return { stage, orderedStages };
}

function getIssueCardProgressPresentation(
  issue: KanbanIssue,
  details: KanbanCloudDetailData
): IssueCardProgressPresentation {
  const { stage, orderedStages } = findIssueWorkflowStage(issue, details);
  const fallbackStageLabel = issue.stageName?.trim() || issue.stageKey?.trim() || "";
  const stageLabel = stage?.name?.trim() || fallbackStageLabel;
  const catalogStageIndex = stage ? orderedStages.findIndex((candidate) => candidate.id === stage.id) : -1;
  const knownStageIndex = getKnownStagePaletteIndex(`${stage?.key ?? issue.stageKey ?? ""} ${stageLabel}`);
  const stageIndex = catalogStageIndex >= 0 ? catalogStageIndex : knownStageIndex;
  const stageCount = orderedStages.length > 0 ? orderedStages.length : stageIndex >= 0 ? 4 : 1;
  const stageStatuses = stage
    ? sortWorkflowStatuses(details.workflowStatuses.filter((status) => status.stageId === stage.id))
    : [];
  const statusIndexById = stageStatuses.findIndex((status) => status.id === issue.statusId);
  const statusIndexByKey = stageStatuses.findIndex((status) => status.key === issue.statusKey);
  const statusIndexByColumn = stageStatuses.findIndex((status) => (
    status.columnKey === issue.columnKey || status.columnKey === issue.status
  ));
  const catalogStatusIndex = statusIndexById >= 0
    ? statusIndexById
    : statusIndexByKey >= 0
      ? statusIndexByKey
      : statusIndexByColumn;
  const fallbackStatusIndex = Math.max(0, VISIBLE_KANBAN_STATUSES.indexOf(issue.status));
  const statusIndex = catalogStatusIndex >= 0 ? catalogStatusIndex : fallbackStatusIndex;
  const statusCount = stageStatuses.length > 0 ? stageStatuses.length : VISIBLE_KANBAN_STATUSES.length;
  const stageProgress = Math.min(1, Math.max(0.08, (statusIndex + 1) / Math.max(1, statusCount)));
  const workflowProgress = stageIndex >= 0
    ? ((stageIndex + stageProgress) / Math.max(1, stageCount)) * 100
    : stageProgress * 100;
  const paletteIndex = catalogStageIndex >= 0 ? catalogStageIndex : knownStageIndex;
  return {
    color: paletteIndex >= 0
      ? ISSUE_STAGE_COLOR_PALETTE[paletteIndex % ISSUE_STAGE_COLOR_PALETTE.length]!
      : ISSUE_STAGE_FALLBACK_COLOR,
    percent: Math.min(100, Math.max(4, Math.round(workflowProgress))),
    stageLabel
  };
}

function getIssueCardShellClassName(issue: KanbanIssue, extra: string[] = []) {
  return [
    "issue-card",
    `is-${issue.status}`,
    `is-priority-${issue.priority}`,
    issue.assigneeAgentKey?.trim() ? "has-agent" : "",
    issue.runState === "running" || issue.runId ? "is-running-state" : "",
    ...extra
  ].filter(Boolean).join(" ");
}

function isFiveFieldCron(value: string) {
  return value.trim().split(/\s+/u).length === 5;
}

function hasIssueAutomation(issue: Pick<KanbanIssue, "automationEnabled" | "automationCron">) {
  return issue.automationEnabled && Boolean(issue.automationCron?.trim());
}

function shouldShowIssueForAutomationFilter(
  issue: Pick<KanbanIssue, "automationEnabled" | "automationCron">,
  filter: KanbanAutomationFilter
) {
  if (filter === "all") {
    return true;
  }
  const hasAutomation = hasIssueAutomation(issue);
  return filter === "scheduled" ? hasAutomation : !hasAutomation;
}

function getIssueGranularStatusTone(issue: KanbanIssue): IssueCardSignalTone {
  const granularStatusLabel = issue.statusName?.trim() || "";
  const granularStatusKey = `${issue.statusKey ?? ""} ${granularStatusLabel}`.toLocaleLowerCase();
  if (/failed|failure|error|失败|异常/u.test(granularStatusKey)) {
    return "failed";
  }
  if (/cancelled|canceled|interrupted|中断|取消/u.test(granularStatusKey)) {
    return "cancelled";
  }
  if (/success|succeeded|completed|成功|完成/u.test(granularStatusKey)) {
    return "succeeded";
  }
  if (/review|approval|verify|test|审查|确认|验收|测试/u.test(granularStatusKey)) {
    return "in_review";
  }
  return issue.status;
}

function getIssueGranularStatusLabel(issue: KanbanIssue, t: TranslateFunction) {
  const label = issue.statusName?.trim() || "";
  if (!label) {
    return "";
  }
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[\s_-]+/gu, "");
  const normalizedLabel = normalize(label);
  const columnLabels = new Set([
    normalize(issue.status),
    normalize(t(STATUS_META[issue.status].labelKey)),
    "backlog",
    "todo",
    "inprogress",
    "inreview",
    "completed",
    "待办池",
    "待办",
    "进行中",
    "评审中",
    "审核中",
    "待审查",
    "已完成"
  ]);
  return columnLabels.has(normalizedLabel) ? "" : label;
}

function getIssueCardStatusPresentation(issue: KanbanIssue, t: TranslateFunction) {
  const granularLabel = getIssueGranularStatusLabel(issue, t);
  return {
    label: granularLabel || t(STATUS_META[issue.status].labelKey),
    tone: granularLabel ? getIssueGranularStatusTone(issue) : issue.status
  };
}

function getIssueDescriptionPreview(description: string) {
  return description.trim().replace(/\s+/gu, " ");
}

function getIssueCardDuePresentation(
  issue: KanbanIssue,
  locale: SupportedLocale,
  now: Date,
  t: TranslateFunction
): IssueCardDuePresentation | null {
  if (issue.dueAt === undefined || issue.dueAt === null) {
    return null;
  }
  const dueDate = new Date(issue.dueAt);
  const sameYear = dueDate.getFullYear() === now.getFullYear();
  const compactTime = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit"
  }).format(issue.dueAt);
  const fullTime = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(issue.dueAt);
  const overdue = issue.status !== "completed" && issue.runState !== "completed" && issue.dueAt < now.getTime();
  const labelKey: TranslationKey = overdue ? "kanban.card.overdueAt" : "kanban.card.dueAt";
  return {
    label: t(labelKey, { time: compactTime }),
    title: t(labelKey, { time: fullTime }),
    overdue
  };
}

function getIssueCardSignalPresentation(
  issue: KanbanIssue,
  options: {
    locale: SupportedLocale;
    now: Date;
  },
  t: TranslateFunction
): IssueCardSignalPresentation {
  if (issue.status === "in_progress") {
    const duration = formatKanbanCompactDuration(issue.runStartedAt || issue.createdAt, options.now);
    return {
      label: duration ? t("kanban.card.runningFor", { duration }) : t("kanban.run.running"),
      tone: "running",
      icon: "running"
    };
  }
  if (issue.status === "completed" || issue.runState === "completed") {
    const completedTime = formatKanbanCompletionTime(issue.runFinishedAt || issue.updatedAt, options.locale);
    return {
      label: completedTime ? t("kanban.card.completedAt", { time: completedTime }) : "",
      tone: "succeeded",
      icon: "completed"
    };
  }
  if (issue.status === "in_review") {
    const duration = formatKanbanCompactDuration(issue.runStartedAt || issue.createdAt, options.now);
    return {
      label: duration
        ? t("kanban.card.runningFor", { duration })
        : t("kanban.status.inReview"),
      tone: "in_review",
      icon: "running"
    };
  }
  const updatedTime = formatIssueUpdatedTime(issue.updatedAt, options.now);
  return {
    label: updatedTime ? t("kanban.card.updatedAt", { time: updatedTime }) : "",
    tone: issue.status,
    icon: "history"
  };
}

function getIssueCardOperationalStatePresentation(
  issue: KanbanIssue,
  awaitingConfirmation: boolean,
  t: TranslateFunction
): IssueCardSignalPresentation | null {
  if (issue.runState === "cancelled") {
    return { label: t("kanban.run.cancelled"), tone: "cancelled", icon: "cancelled" };
  }
  if (issue.runState === "failed") {
    return { label: t("kanban.run.failed"), tone: "failed", icon: "failed" };
  }
  if (awaitingConfirmation && issue.status === "in_progress") {
    return { label: t("kanban.run.awaitingApproval"), tone: "awaiting", icon: "waiting" };
  }
  if (issue.status === "in_progress" && (issue.runState === "running" || Boolean(issue.runId))) {
    return { label: t("kanban.run.running"), tone: "running", icon: "running" };
  }
  return null;
}

function getKanbanEmptyHint(status: KanbanStatus, t: TranslateFunction) {
  const hintKey: Record<KanbanStatus, TranslationKey> = {
    backlog: "kanban.column.emptyBacklog",
    todo: "kanban.column.emptyTodo",
    in_progress: "kanban.column.emptyInProgress",
    in_review: "kanban.column.emptyInReview",
    completed: "kanban.column.emptyCompleted"
  };
  return t(hintKey[status]);
}

function createNavigationAgentFromOption(agent: DesktopPetAgentOption): AssistantNavAgentItem {
  return {
    agentKey: agent.agentKey,
    displayName: agent.displayName || agent.agentKey,
    role: agent.role,
    icon: agent.icon,
    unreadCount: agent.unreadCount,
    unreadChatCount: 0,
    chatCount: 0,
    hasPendingAwaiting: false,
    latestChatId: null,
    latestPreview: "",
    recentChats: []
  };
}

function hasKanbanAgentIcon(icon: AssistantNavAgentItem["icon"] | null | undefined) {
  if (typeof icon === "string") {
    return icon.trim().length > 0;
  }
  if (icon && typeof icon === "object") {
    return Boolean(icon.name?.trim() || icon.color?.trim());
  }
  return false;
}

function mergeKanbanAgentIcons(currentAgents: AssistantNavAgentItem[], nextAgents: AssistantNavAgentItem[]) {
  const previousIcons = new Map(
    currentAgents
      .filter((agent) => hasKanbanAgentIcon(agent.icon))
      .map((agent) => [agent.agentKey, agent.icon] as const)
  );
  return nextAgents.map((agent) => {
    const previousIcon = previousIcons.get(agent.agentKey);
    return previousIcon ? { ...agent, icon: previousIcon } : agent;
  });
}

async function hydrateKanbanAgentIcons(items: AssistantNavAgentItem[]) {
  if (!items.some((agent) => !hasKanbanAgentIcon(agent.icon))) {
    return items;
  }
  const agentOptions = await window.electronAPI.assistant.listAgents();
  const fallbackItems = agentOptions.map(createNavigationAgentFromOption);
  return mergeKanbanAgentIcons(fallbackItems, items);
}

async function loadKanbanAgents(): Promise<AssistantNavAgentItem[]> {
  const navigationResult = await window.electronAPI.assistant.listNavigationAgents();
  if (navigationResult.ok && navigationResult.items.length > 0) {
    const navigationItems = normalizeAssistantNavAgents(navigationResult.items);
    return await hydrateKanbanAgentIcons(navigationItems);
  }
  const agentOptions = await window.electronAPI.assistant.listAgents();
  return agentOptions.map(createNavigationAgentFromOption);
}

function isCancelledAssistantRunEvent(event: AssistantEvent) {
  const eventStatus = String(event.status ?? "");
  return (
    event.type === "run.cancel" ||
    event.type === "task.cancel" ||
    event.type === "stopped" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    eventStatus === "cancelled" ||
    eventStatus === "canceled" ||
    eventStatus === "stopped"
  );
}

function resolveAssistantRunStatus(event: AssistantEvent, t: TranslateFunction): {
  status: KanbanStatus | null;
  runState: KanbanIssue["runState"];
  tone: Feedback["tone"];
  message: string;
} | null {
  if (event.type === "done" || event.type === "run.complete") {
    return {
      status: "completed",
      runState: "completed",
      tone: "success",
      message: t("kanban.feedback.agentDone")
    };
  }
  if (isCancelledAssistantRunEvent(event)) {
    return {
      status: null,
      runState: "cancelled",
      tone: "error",
      message: t("kanban.feedback.agentCancelled")
    };
  }
  if (
    event.type === "error" ||
    event.type === "run.error" ||
    event.type === "run.expired" ||
    event.status === "error" ||
    event.status === "timeout"
  ) {
    return {
      status: null,
      runState: "failed",
      tone: "error",
      message: t("kanban.feedback.agentIncomplete")
    };
  }
  return null;
}

function readKanbanApi(): DesktopApi["kanban"] | null {
  if (typeof window === "undefined") {
    return null;
  }
  const api = (window.electronAPI as Partial<DesktopApi> | undefined)?.kanban;
  return api && typeof api.listIssues === "function" ? api : null;
}

function getKanbanConnectionTone(state: KanbanConnectionState) {
  if (state === "open") return "success";
  if (state === "connecting") return "pending";
  if (state === "error") return "error";
  return "muted";
}

function getKanbanConnectionLabel(state: KanbanConnectionState, t: TranslateFunction) {
  if (state === "open") return t("kanban.cloud.status.open");
  if (state === "connecting") return t("kanban.cloud.status.connecting");
  if (state === "closed") return t("kanban.cloud.status.closed");
  if (state === "error") return t("kanban.cloud.status.error");
  return t("kanban.cloud.status.disabled");
}

function getKanbanProjectOptionLabel(project: KanbanProject) {
  const path = project.path.trim();
  if (path && path !== project.name) {
    return `${project.name} · ${path}`;
  }
  return project.name;
}

function sortKanbanProjectOptions(projects: KanbanProject[]) {
  return [...projects]
    .filter((project) => project.id.trim())
    .sort((left, right) => {
      const leftLabel = left.path || left.name || left.id;
      const rightLabel = right.path || right.name || right.id;
      return leftLabel.localeCompare(rightLabel, "zh-Hans-CN");
    });
}

function buildKanbanProjectChildrenMap(projects: KanbanProject[]) {
  const projectIds = new Set(projects.map((project) => project.id));
  const childrenByParentId = new Map<string, string[]>();
  for (const project of projects) {
    const parentId = project.parentId?.trim() ?? "";
    if (!parentId || !projectIds.has(parentId)) {
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(project.id);
    childrenByParentId.set(parentId, children);
  }
  return childrenByParentId;
}

function collectKanbanProjectAndDescendantIds(projectId: string, childrenByParentId: Map<string, string[]>, output: Set<string>) {
  if (output.has(projectId)) {
    return;
  }
  output.add(projectId);
  for (const childId of childrenByParentId.get(projectId) ?? []) {
    collectKanbanProjectAndDescendantIds(childId, childrenByParentId, output);
  }
}

function getKanbanProjectFilterIds(projects: KanbanProject[], selectedProjectIds: string[]) {
  const selected = selectedProjectIds.filter(Boolean);
  if (selected.length === 0) {
    return null;
  }
  const childrenByParentId = buildKanbanProjectChildrenMap(projects);
  const filterIds = new Set<string>();
  for (const projectId of selected) {
    collectKanbanProjectAndDescendantIds(projectId, childrenByParentId, filterIds);
  }
  return filterIds;
}

function getKanbanProjectFilterLabel(
  selectedProjectIds: string[],
  projects: KanbanProject[],
  t: TranslateFunction
) {
  if (selectedProjectIds.length === 0) {
    return t("kanban.projectFilter.all");
  }
  if (selectedProjectIds.length === 1) {
    const project = projects.find((candidate) => candidate.id === selectedProjectIds[0]);
    return project ? getKanbanProjectOptionLabel(project) : selectedProjectIds[0];
  }
  return t("kanban.projectFilter.selectedCount", { count: selectedProjectIds.length });
}

function isIssueDragLocked(issue: KanbanIssue | null | undefined) {
  return Boolean(issue?.runId);
}

function canEditKanbanIssueBody(issue: KanbanIssue | null | undefined) {
  return issue?.syncMode !== "cloud";
}

function canCreateIssueFromColumnDoubleClick(status: KanbanStatus) {
  return status === "backlog" || status === "todo";
}

function shouldCreateIssueFromColumnDoubleClick(event: MouseEvent<HTMLElement>, status: KanbanStatus) {
  if (!canCreateIssueFromColumnDoubleClick(status)) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return event.currentTarget === target;
  }
  return !target.closest(".issue-card");
}

function normalizeIssueSeverity(severity: KanbanIssue["severity"]): KanbanSeverity {
  return severity === "critical" || severity === "high" || severity === "low" ? severity : "medium";
}

function issueHasPendingAwaiting(issue: KanbanIssue, agents: AssistantNavAgentItem[]) {
  const chatId = issue.chatId?.trim();
  if (issue.status !== "in_progress" || !chatId) {
    return false;
  }

  return agents.some((agent) => {
    const matchingChat = getAssistantNavAgentRecentChats(agent).find((chat) => chat.chatId === chatId);
    return matchingChat?.hasPendingAwaiting === true;
  });
}

function truncateKanbanProjectLabel(value: string, maxLength = 16) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${Array.from(trimmed).slice(0, Math.max(1, maxLength - 3)).join("")}...`;
}

function getKanbanIssueOriginPresentation(
  issue: KanbanIssue,
  projectsById: Map<string, KanbanProject>,
  t: TranslateFunction
): KanbanIssueOriginPresentation {
  const projectId = issue.projectId?.trim() || "default";
  const project = projectsById.get(projectId);
  const projectName = project?.name.trim() || projectId;
  const projectPath = project?.path.trim() || "";
  const issueId = issue.remoteIssueId?.trim()
    ? `${issue.remoteIssueId.trim()} / ${issue.id}`
    : issue.id;
  const titleParts = [
    t("kanban.card.project", { value: projectName }),
    projectPath ? t("kanban.card.projectPath", { value: projectPath }) : null,
    t("kanban.card.issueId", { value: issueId })
  ].filter((value): value is string => Boolean(value));
  return {
    projectLabel: truncateKanbanProjectLabel(projectName),
    title: titleParts.join("\n")
  };
}

function formatKanbanLastSyncedAt(value: string | null | undefined, t: TranslateFunction) {
  if (!value) {
    return t("kanban.cloud.neverSynced");
  }
  const formatted = formatIssueUpdatedTime(value);
  return formatted ? t("kanban.cloud.lastSyncedAt", { time: formatted }) : t("kanban.cloud.neverSynced");
}

function resolveIssueAgentKey(issue: KanbanIssue, agents: AssistantNavAgentItem[]) {
  if (issue.assigneeAgentKey?.trim()) {
    return issue.assigneeAgentKey.trim();
  }
  const chatId = issue.chatId?.trim();
  if (!chatId) {
    return "";
  }
  const matchedAgent = agents.find((agent) =>
    agent.latestChatId === chatId ||
    getAssistantNavAgentRecentChats(agent).some((chat) => chat.chatId === chatId)
  );
  return matchedAgent?.agentKey ?? "";
}

function buildKanbanChatEmbedPath(request: KanbanChatModalRequest) {
  const agentKey = request.agentKey.trim();
  const chatId = request.chatId?.trim() ?? "";
  if (!agentKey) {
    if (!chatId) {
      return "/copilot";
    }
    const params = new URLSearchParams();
    params.set("chatId", chatId);
    return `/copilot?${params.toString()}`;
  }

  if (!chatId) {
    return createAgentWebclientAgentPath(agentKey);
  }

  return createAgentWebclientRoute({ agentKey, chatId });
}

export function KanbanPage({ hostTheme }: KanbanPageProps) {
  const { locale, t } = useI18n();
  const [issues, setIssues] = useState<KanbanIssue[]>([]);
  const [cloudDetails, setCloudDetails] = useState<KanbanCloudDetailData>(EMPTY_KANBAN_CLOUD_DETAILS);
  const [agents, setAgents] = useState<AssistantNavAgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setBusyIssueId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [query, setQuery] = useState("");
  const [cloudProjects, setCloudProjects] = useState<KanbanProject[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<KanbanConnectionState>("disabled");
  const [cloudResyncing, setCloudResyncing] = useState(false);
  const [priorityFilters, setPriorityFilters] = useState<KanbanPriority[]>([]);
  const [severityFilters, setSeverityFilters] = useState<KanbanSeverity[]>([]);
  const [automationFilter, setAutomationFilter] = useState<KanbanAutomationFilter>("all");
  const [searchFilterMenu, setSearchFilterMenu] = useState<SearchFilterMenuKind>(null);
  const [kanbanCountdownNow, setKanbanCountdownNow] = useState(() => Date.now());
  const [display, setDisplay] = useState<DisplayState>(defaultDisplayState);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null);
  const [detailInitialEditStatus, setDetailInitialEditStatus] = useState<KanbanStatus | null>(null);
  const [chatModalRequest, setChatModalRequest] = useState<KanbanChatModalRequest | null>(null);
  const [form, setForm] = useState<IssueFormState>(emptyForm);
  const [formCompact, setFormCompact] = useState(true);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [automationMenuOpen, setAutomationMenuOpen] = useState<AutomationMenuKind | null>(null);
  const [activeDragIssueId, setActiveDragIssueId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<KanbanContextMenu | null>(null);
  const activeDragIssueIdRef = useRef<string | null>(null);
  const issuesRef = useRef<KanbanIssue[]>([]);
  const selectedAutomationTimeRef = useRef<HTMLButtonElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const kanbanReady = readKanbanApi() !== null;
  const missingKanbanApiMessage = t("kanban.missingApi", { appName: t("app.name") });
  const cloudProjectOptions = useMemo(() => sortKanbanProjectOptions(cloudProjects), [cloudProjects]);
  const kanbanProjectsById = useMemo(() => new Map(cloudProjects.map((project) => [project.id, project])), [cloudProjects]);
  const projectFilterIds = useMemo(
    () => getKanbanProjectFilterIds(cloudProjects, selectedProjectIds),
    [cloudProjects, selectedProjectIds]
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const kanbanApi = readKanbanApi();
      if (!kanbanApi) {
        if (!cancelled) {
          setIssues([]);
          setFeedback({ tone: "error", message: missingKanbanApiMessage });
          setLoading(false);
        }
        return;
      }
      try {
        const [issueResult, agentResult] = await Promise.all([
          kanbanApi.listIssues(),
          loadKanbanAgents()
        ]);
        if (cancelled) return;
        setIssues(sortIssues(issueResult.issues));
        setCloudProjects(issueResult.projects ?? []);
        setCloudDetails(issueResult.cloudDetails ?? EMPTY_KANBAN_CLOUD_DETAILS);
        setConnectionState(issueResult.connectionState ?? "disabled");
        setAgents(agentResult);
      } catch (error) {
        if (!cancelled) {
          setFeedback({
            tone: "error",
            message: error instanceof Error ? error.message : t("kanban.feedback.loadFailed")
          });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [missingKanbanApiMessage, t]);

  async function reloadKanban() {
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) return;
    const issueResult = await kanbanApi.listIssues();
    setIssues(sortIssues(issueResult.issues));
    setCloudProjects(issueResult.projects ?? []);
    setCloudDetails(issueResult.cloudDetails ?? EMPTY_KANBAN_CLOUD_DETAILS);
    setConnectionState(issueResult.connectionState ?? "disabled");
  }

  async function resyncCloudBoard() {
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return;
    }
    if (typeof kanbanApi.resyncCloudBoard !== "function") {
      setFeedback({ tone: "error", message: t("kanban.cloud.preloadOutdated") });
      return;
    }
    setCloudResyncing(true);
    try {
      const result = await kanbanApi.resyncCloudBoard();
      setIssues(sortIssues(result.issues));
      setCloudProjects(result.projects ?? []);
      setCloudDetails(result.cloudDetails ?? EMPTY_KANBAN_CLOUD_DETAILS);
      setConnectionState(result.connectionState ?? "disabled");
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("kanban.cloud.resyncFailed")
      });
    } finally {
      setCloudResyncing(false);
    }
  }

  useEffect(() => {
    const unsubscribe = window.electronAPI.assistant.onNavigationAgentsChanged((result) => {
      if (result.ok) {
        setAgents((currentAgents) => mergeKanbanAgentIcons(currentAgents, normalizeAssistantNavAgents(result.items)));
        return;
      }
      void loadKanbanAgents().then((items) => {
        if (items.length > 0) {
          setAgents((currentAgents) => mergeKanbanAgentIcons(currentAgents, items));
        }
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  useEffect(() => {
    const kanbanApi = readKanbanApi();
    if (!kanbanApi || typeof kanbanApi.onChanged !== "function") {
      return undefined;
    }
    return kanbanApi.onChanged(() => {
      void reloadKanban();
    });
  }, []);

  useEffect(() => {
    const projectIds = new Set(cloudProjects.map((project) => project.id));
    setSelectedProjectIds((current) => current.filter((projectId) => projectIds.has(projectId)));
  }, [cloudProjects]);

  useEffect(() => {
    activeDragIssueIdRef.current = activeDragIssueId;
  }, [activeDragIssueId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setKanbanCountdownNow(Date.now());
    }, KANBAN_COUNTDOWN_REFRESH_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (activeDragIssueIdRef.current) {
        return;
      }
      void reloadKanban();
    }, 15_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!contextMenu || typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    const closeContextMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };
    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!feedback || feedback.tone !== "success") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFeedback((current) => (current === feedback ? null : current));
    }, KANBAN_FEEDBACK_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [feedback]);

  useEffect(() => {
    if (automationMenuOpen === "time") {
      selectedAutomationTimeRef.current?.scrollIntoView({ block: "center" });
    }
  }, [form.automationTime, automationMenuOpen]);

  useEffect(() => {
    if (!chatModalRequest || typeof document === "undefined") {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatModalRequest(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [chatModalRequest]);

  useEffect(() => {
    const removeAssistantEventListener = window.electronAPI.assistant.onAssistantEvent(async (event) => {
      const nextRunStatus = resolveAssistantRunStatus(event, t);
      if (!nextRunStatus) {
        return;
      }
      const issue = issuesRef.current.find((candidate) => candidate.runId === event.runId);
      if (!issue) {
        return;
      }
      const kanbanApi = readKanbanApi();
      if (!kanbanApi) {
        return;
      }
      try {
        const issueUpdate: KanbanIssueUpdateInput = {
          chatId: event.chatId || issue.chatId,
          runId: null,
          runState: nextRunStatus.runState
        };
        if (nextRunStatus.status) {
          issueUpdate.status = nextRunStatus.status;
        }
        const result = await kanbanApi.updateIssue(issue.id, issueUpdate);
        setIssues(sortIssues(result.issues));
        setFeedback({ tone: nextRunStatus.tone, message: nextRunStatus.message });
      } catch (error) {
        setFeedback({
          tone: "error",
          message: error instanceof Error ? error.message : t("kanban.feedback.statusWritebackFailed")
        });
      }
    });

    return removeAssistantEventListener;
  }, [t]);

  const visibleIssues = useMemo(
    () => issues.filter((issue) => VISIBLE_KANBAN_STATUS_SET.has(issue.status)),
    [issues]
  );

  const cloudSyncSummary = useMemo(() => {
    const cloudIssues = visibleIssues.filter((issue) => issue.syncMode === "cloud");
    const errorCount = cloudIssues.filter((issue) => issue.syncState === "error").length;
    const syncingCount = cloudIssues.filter((issue) => issue.syncState === "syncing").length;
    const lastSyncedAt = cloudIssues
      .map((issue) => issue.lastSyncedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    return {
      cloudCount: cloudIssues.length,
      errorCount,
      syncingCount,
      lastSyncedAt
    };
  }, [visibleIssues]);

  const filteredIssues = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return sortIssues(visibleIssues).filter((issue) => {
      if (priorityFilters.length > 0 && !priorityFilters.includes(issue.priority)) {
        return false;
      }
      if (severityFilters.length > 0 && !severityFilters.includes(normalizeIssueSeverity(issue.severity))) {
        return false;
      }
      if (projectFilterIds && !projectFilterIds.has(issue.projectId ?? "")) {
        return false;
      }
      if (!shouldShowIssueForAutomationFilter(issue, automationFilter)) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = [
        issue.id,
        issue.remoteIssueId ?? "",
        issue.title,
        issue.description,
        issue.assigneeAgentKey ?? "",
        getAssigneeName(issue.assigneeAgentKey ?? "", agents) ?? "",
        ...getVisibleKanbanAttachments(issue.attachments).map((attachment) => attachment.name)
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [agents, automationFilter, priorityFilters, projectFilterIds, query, severityFilters, visibleIssues]);

  const issuesByStatus = useMemo(() => {
    const grouped = {
      backlog: [] as KanbanIssue[],
      todo: [] as KanbanIssue[],
      in_progress: [] as KanbanIssue[],
      in_review: [] as KanbanIssue[],
      completed: [] as KanbanIssue[]
    };
    for (const issue of filteredIssues) {
      grouped[issue.status].push(issue);
    }
    return grouped;
  }, [filteredIssues]);

  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const detailIssue = detailIssueId ? issueMap.get(detailIssueId) ?? null : null;
  const filteredCount = filteredIssues.length;
  const totalCount = visibleIssues.length;
  const activeDragIssue = activeDragIssueId ? issueMap.get(activeDragIssueId) ?? null : null;

  const openCreateModal = useCallback((status: KanbanStatus = "backlog") => {
    if (!readKanbanApi()) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return;
    }
    setForm({ ...emptyForm, status, attachmentChatId: createKanbanDraftAttachmentChatId() });
    setFormCompact(true);
    setAttachmentBusy(false);
    setAutomationMenuOpen(null);
    setModal({ mode: "create" });
  }, [missingKanbanApiMessage]);

  const createIssueHandlersByStatus = useMemo(
    () => Object.fromEntries(
      VISIBLE_KANBAN_STATUSES.map((status) => [status, () => openCreateModal(status)])
    ) as Record<KanbanStatus, () => void>,
    [openCreateModal]
  );

  const openEditModal = useCallback((issue: KanbanIssue) => {
    setContextMenu(null);
    setDetailInitialEditStatus(null);
    setDetailIssueId(issue.id);
  }, []);

  function openInProgressAssignmentModal(issue: KanbanIssue) {
    setDetailInitialEditStatus("in_progress");
    setDetailIssueId(issue.id);
    setFeedback({ tone: "error", message: t("kanban.feedback.assigneeRequiredForProgress") });
  }

  function toggleFormCompactMode() {
    if (formCompact) {
      setForm((current) => {
        if (current.title.trim()) {
          return current;
        }
        return {
          ...current,
          title: buildCompactIssueTitle(current.description)
        };
      });
    }
    setAutomationMenuOpen(null);
    setFormCompact((current) => !current);
  }

  function toggleAutomationMenu(menuName: AutomationMenuKind) {
    setAutomationMenuOpen((current) => current === menuName ? null : menuName);
  }

  function updateAutomationPlan(plan: KanbanAutomationPlan) {
    setForm((current) => ({
      ...current,
      automationPreset: plan,
      automationCron: buildAutomationCron(plan, current.automationTime, current.automationCron)
    }));
    setAutomationMenuOpen(null);
  }

  function updateAutomationTime(time: string) {
    const nextTime = normalizeAutomationTime(time);
    setForm((current) => ({
      ...current,
      automationTime: nextTime,
      automationCron: buildAutomationCron(current.automationPreset, nextTime, current.automationCron)
    }));
    setAutomationMenuOpen(null);
  }

  async function addKanbanAttachments() {
    if (attachmentBusy) {
      return;
    }
    const fallbackChatId = modal?.issue
      ? createKanbanAttachmentChatId(modal.issue.id)
      : createKanbanDraftAttachmentChatId();
    const attachmentChatId = form.attachmentChatId || fallbackChatId;
    setAttachmentBusy(true);
    setForm((current) => ({
      ...current,
      attachmentChatId: current.attachmentChatId || attachmentChatId
    }));
    try {
      const result = await window.electronAPI.assistant.pickAttachments(attachmentChatId);
      if (result.cancelled) {
        return;
      }
      if (!result.ok && result.attachments.length === 0) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setForm((current) => ({
        ...current,
        attachmentChatId: result.chatId || attachmentChatId,
        attachments: [...current.attachments, ...result.attachments]
      }));
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("kanban.feedback.attachmentUploadFailed")
      });
    } finally {
      setAttachmentBusy(false);
    }
  }

  function removeKanbanAttachment(attachmentId: string) {
    setForm((current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) =>
        attachment.id !== attachmentId && attachment.sourceAttachmentId !== attachmentId
      )
    }));
  }

  async function openKanbanAttachment(attachment: AssistantAttachment) {
    const chatId = form.attachmentChatId.trim();
    if (!chatId) {
      setFeedback({ tone: "error", message: t("kanban.feedback.attachmentLocationMissing") });
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(chatId, attachment.id);
    setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return;
    }
    const title = formCompact && modal?.mode === "create"
      ? buildCompactIssueTitle(form.description)
      : form.title.trim();
    if (!title) {
      setFeedback({ tone: "error", message: formCompact ? t("kanban.feedback.descriptionRequired") : t("kanban.feedback.titleRequired") });
      return;
    }
    const resolvedAutomationCron = buildAutomationCron(form.automationPreset, form.automationTime, form.automationCron);
    const resolvedAutomationMessage = form.automationMessage.trim() || form.description.trim() || title;
    const shouldRunAfterSave = form.status === "in_progress" && !form.automationEnabled && !modal?.issue?.runId;
    const shouldRunTodoAssigneeAfterDelay = form.status === "todo" && !form.automationEnabled && Boolean(form.assigneeAgentKey) && !modal?.issue?.runId;
    if (shouldRunAfterSave && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.assigneeRequiredForProgress") });
      return;
    }
    if (form.automationEnabled && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.assigneeRequiredForAutomation") });
      return;
    }
    if (form.automationEnabled && !isFiveFieldCron(resolvedAutomationCron)) {
      setFeedback({ tone: "error", message: t("kanban.feedback.invalidCron") });
      return;
    }
    if (form.automationEnabled && !resolvedAutomationMessage) {
      setFeedback({ tone: "error", message: t("kanban.feedback.automationMessageRequired") });
      return;
    }
    const savedStatus = shouldRunAfterSave ? modal?.issue?.status ?? "todo" : form.status;
    const payload: KanbanIssueInput | KanbanIssueUpdateInput = {
      title,
      description: form.description,
      status: savedStatus,
      priority: form.priority,
      assigneeAgentKey: form.assigneeAgentKey || null,
      automationId: modal?.issue?.automationId ?? null,
      automationEnabled: form.automationEnabled,
      automationCron: form.automationEnabled ? resolvedAutomationCron : null,
      automationMessage: form.automationEnabled ? resolvedAutomationMessage : null,
      automationTimezone: form.automationEnabled ? form.automationTimezone : null,
      attachmentChatId: form.attachments.length > 0 ? form.attachmentChatId : null,
      attachments: form.attachments,
      syncToCloud: form.syncToCloud
    };

    try {
      const result = modal?.mode === "edit" && modal.issue
        ? await kanbanApi.updateIssue(modal.issue.id, payload)
        : await kanbanApi.createIssue(payload as KanbanIssueInput);
      let savedIssue = mergeKanbanIssueAttachmentDraft(
        result.issue,
        form.attachmentChatId,
        form.attachments
      );
      let nextIssues = mergeKanbanIssuesAttachmentDraft(result.issues, savedIssue);
      let nextMessage = result.message;
      let nextTone: Feedback["tone"] = result.ok ? "success" : "error";
      if (result.ok && savedIssue && (form.automationEnabled || savedIssue.automationId)) {
        const automationResult = await kanbanApi.syncIssueAutomation(savedIssue.id);
        savedIssue = mergeKanbanIssueAttachmentDraft(
          automationResult.issue ?? savedIssue,
          form.attachmentChatId,
          form.attachments
        );
        nextIssues = mergeKanbanIssuesAttachmentDraft(automationResult.issues, savedIssue);
        nextTone = automationResult.ok ? "success" : "error";
        nextMessage = automationResult.ok ? t("kanban.feedback.issueAndAutomationSaved") : automationResult.message;
      }
      setIssues(sortIssues(nextIssues));
      setFeedback({ tone: nextTone, message: nextMessage });
      if (result.ok && nextTone === "success") {
        setModal(null);
        if (shouldRunAfterSave && savedIssue) {
          void assignIssueToAssistant(savedIssue, form.assigneeAgentKey);
        } else if (shouldRunTodoAssigneeAfterDelay && savedIssue) {
          const savedAgentKey = form.assigneeAgentKey;
          window.setTimeout(() => {
            void assignIssueToAssistant(savedIssue, savedAgentKey);
          }, KANBAN_TODO_ASSIGNEE_START_DELAY_MS);
        }
      }
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("kanban.feedback.saveFailed")
      });
    }
  }

  async function saveIssueDetail(issue: KanbanIssue, draft: KanbanIssueDetailDraft) {
    const kanbanApi = readKanbanApi();
    if (!kanbanApi || !canEditKanbanIssueBody(issue)) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return false;
    }
    const title = draft.title.trim();
    if (!title) {
      setFeedback({ tone: "error", message: t("kanban.feedback.titleRequired") });
      return false;
    }
    const resolvedAutomationMessage = draft.automationMessage.trim() || draft.description.trim() || title;
    const shouldRunAfterSave = draft.status === "in_progress" && !draft.automationEnabled && !issue.runId;
    const shouldRunTodoAssigneeAfterDelay = draft.status === "todo" && !draft.automationEnabled && Boolean(draft.assigneeAgentKey) && !issue.runId;
    if (shouldRunAfterSave && !draft.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.assigneeRequiredForProgress") });
      return false;
    }
    if (draft.automationEnabled && !draft.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.assigneeRequiredForAutomation") });
      return false;
    }
    if (draft.automationEnabled && !isFiveFieldCron(draft.automationCron)) {
      setFeedback({ tone: "error", message: t("kanban.feedback.invalidCron") });
      return false;
    }
    if (draft.automationEnabled && !resolvedAutomationMessage) {
      setFeedback({ tone: "error", message: t("kanban.feedback.automationMessageRequired") });
      return false;
    }
    const payload: KanbanIssueUpdateInput = {
      title,
      description: draft.description,
      status: shouldRunAfterSave ? issue.status : draft.status,
      priority: draft.priority,
      assigneeAgentKey: draft.assigneeAgentKey || null,
      automationId: issue.automationId,
      automationEnabled: draft.automationEnabled,
      automationCron: draft.automationEnabled ? draft.automationCron.trim() : null,
      automationMessage: draft.automationEnabled ? resolvedAutomationMessage : null,
      automationTimezone: draft.automationEnabled ? draft.automationTimezone.trim() || "Asia/Shanghai" : null,
      attachmentChatId: draft.attachments.length > 0 ? draft.attachmentChatId : null,
      attachments: draft.attachments,
      syncToCloud: draft.syncToCloud
    };

    try {
      const result = await kanbanApi.updateIssue(issue.id, payload);
      let savedIssue = mergeKanbanIssueAttachmentDraft(result.issue, draft.attachmentChatId, draft.attachments);
      let nextIssues = mergeKanbanIssuesAttachmentDraft(result.issues, savedIssue);
      let nextMessage = result.message;
      let nextTone: Feedback["tone"] = result.ok ? "success" : "error";
      if (result.ok && savedIssue && (draft.automationEnabled || savedIssue.automationId)) {
        const automationResult = await kanbanApi.syncIssueAutomation(savedIssue.id);
        savedIssue = mergeKanbanIssueAttachmentDraft(automationResult.issue ?? savedIssue, draft.attachmentChatId, draft.attachments);
        nextIssues = mergeKanbanIssuesAttachmentDraft(automationResult.issues, savedIssue);
        nextTone = automationResult.ok ? "success" : "error";
        nextMessage = automationResult.ok ? t("kanban.feedback.issueAndAutomationSaved") : automationResult.message;
      }
      setIssues(sortIssues(nextIssues));
      setFeedback({ tone: nextTone, message: nextMessage });
      if (!result.ok || nextTone !== "success" || !savedIssue) return false;
      if (shouldRunAfterSave) {
        void assignIssueToAssistant(savedIssue, draft.assigneeAgentKey);
      } else if (shouldRunTodoAssigneeAfterDelay) {
        const savedAgentKey = draft.assigneeAgentKey;
        window.setTimeout(() => {
          void assignIssueToAssistant(savedIssue, savedAgentKey);
        }, KANBAN_TODO_ASSIGNEE_START_DELAY_MS);
      }
      return true;
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("kanban.feedback.saveFailed")
      });
      return false;
    }
  }

  const deleteIssue = useCallback(async (issue: KanbanIssue) => {
    setContextMenu(null);
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return false;
    }
    if (!window.confirm(t("kanban.confirm.delete", { title: issue.title }))) {
      return false;
    }
    const result = await kanbanApi.deleteIssue(issue.id);
    setIssues(sortIssues(result.issues));
    setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    if (result.ok) {
      setModal(null);
      setDetailIssueId(null);
    }
    return result.ok;
  }, [missingKanbanApiMessage, t]);

  const openIssueContextMenu = useCallback((issue: KanbanIssue, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const viewportWidth = typeof window === "undefined" ? event.clientX : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? event.clientY : window.innerHeight;
    setContextMenu({
      issueId: issue.id,
      x: Math.min(event.clientX, Math.max(8, viewportWidth - 176)),
      y: Math.min(event.clientY, Math.max(8, viewportHeight - 48))
    });
  }, []);

  async function getAvailableAgents() {
    if (agents.length > 0) {
      return agents;
    }
    const nextAgents = await loadKanbanAgents();
    if (nextAgents.length > 0) {
      setAgents((currentAgents) => mergeKanbanAgentIcons(currentAgents, nextAgents));
    }
    return nextAgents;
  }

  async function assignIssueToAssistant(issue: KanbanIssue, selectedAgentKey?: string) {
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return;
    }
    const availableAgents = await getAvailableAgents();
    const agentKey = selectedAgentKey ?? issue.assigneeAgentKey ?? availableAgents[0]?.agentKey ?? "";
    if (!agentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.noAgents") });
      return;
    }

    setBusyIssueId(issue.id);
    try {
      const runResult = await window.electronAPI.assistant.startRun({
        ...(issue.attachmentChatId && issue.attachments.length > 0 ? { chatId: issue.attachmentChatId } : {}),
        agentKey,
        message: buildAssistantPrompt(issue, t),
        source: "copilot",
        attachments: issue.attachments
      });
      if (!runResult.ok) {
        setFeedback({ tone: "error", message: runResult.message || t("kanban.feedback.assistantStartFailed") });
        return;
      }
      const updateResult = await kanbanApi.updateIssue(issue.id, {
        status: "in_progress",
        assigneeAgentKey: agentKey,
        chatId: runResult.chatId,
        runId: runResult.runId,
        runState: "running"
      });
      setIssues(sortIssues(updateResult.issues));
      setFeedback({ tone: "success", message: t("kanban.feedback.assignedToAssistant") });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("kanban.feedback.assistantStartFailed")
      });
    } finally {
      setBusyIssueId(null);
    }
  }

  const openAssistantIssueChat = useCallback(async (issue: KanbanIssue) => {
    const chatId = issue.chatId?.trim() ?? "";
    if (!chatId) {
      setFeedback({ tone: "error", message: t("kanban.feedback.noChat") });
      return;
    }
    const agentKey = resolveIssueAgentKey(issue, agents);
    if (!agentKey) {
      setFeedback({ tone: "error", message: t("kanban.feedback.noBoundAgent") });
      return;
    }
    setChatModalRequest({
      agentKey,
      chatId,
      displayName: getAssigneeName(agentKey, agents) ?? undefined
    });
  }, [agents, t]);

  function handleDragStart(event: DragStartEvent) {
    const activeIssue = issueMap.get(String(event.active.id));
    if (isIssueDragLocked(activeIssue)) {
      setActiveDragIssueId(null);
      setFeedback({ tone: "error", message: t("kanban.feedback.dragLocked") });
      return;
    }
    setActiveDragIssueId(String(event.active.id));
  }

  function clearActiveDrag() {
    setActiveDragIssueId(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    clearActiveDrag();
    const kanbanApi = readKanbanApi();
    if (!kanbanApi) {
      setFeedback({ tone: "error", message: missingKanbanApiMessage });
      return;
    }
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : "";
    if (!overId || activeId === overId) {
      return;
    }

    const activeIssue = issueMap.get(activeId);
    if (!activeIssue) {
      return;
    }
    if (isIssueDragLocked(activeIssue)) {
      setFeedback({ tone: "error", message: t("kanban.feedback.dragLocked") });
      return;
    }

    const overIssue = issueMap.get(overId);
    const targetStatus = getStatusFromColumnId(overId) ?? overIssue?.status ?? null;
    if (!targetStatus) {
      return;
    }

    if (targetStatus === "in_progress" && activeIssue.status !== "in_progress") {
      if (activeIssue.assigneeAgentKey?.trim()) {
        void assignIssueToAssistant(activeIssue, activeIssue.assigneeAgentKey);
      } else {
        void getAvailableAgents();
        openInProgressAssignmentModal(activeIssue);
      }
      return;
    }

    const nextPosition = computeSortableDropPosition(issues, activeId, overIssue, targetStatus);

    if (activeIssue.status === targetStatus && activeIssue.position === nextPosition) {
      return;
    }

    const todoAssigneeAgentKey = targetStatus === "todo" && activeIssue.status !== "todo"
      ? activeIssue.assigneeAgentKey?.trim() ?? ""
      : "";
    const previousIssues = issues;
    const optimisticIssue = {
      ...activeIssue,
      status: targetStatus,
      position: nextPosition,
      updatedAt: new Date().toISOString()
    };
    setIssues(sortIssues(issues.map((issue) => issue.id === activeId ? optimisticIssue : issue)));
    const result = await kanbanApi.moveIssue({
      id: activeId,
      status: targetStatus,
      position: nextPosition
    });
    if (result.ok) {
      setIssues(sortIssues(result.issues));
      setFeedback({ tone: "success", message: result.message });
      if (todoAssigneeAgentKey && result.issue) {
        const savedIssue = result.issue;
        window.setTimeout(() => {
          void assignIssueToAssistant(savedIssue, todoAssigneeAgentKey);
        }, KANBAN_TODO_ASSIGNEE_START_DELAY_MS);
      }
    } else {
      setIssues(previousIssues);
      setFeedback({ tone: "error", message: result.message });
    }
  }

  function togglePriority(priority: KanbanPriority) {
    setPriorityFilters((current) =>
      current.includes(priority)
        ? current.filter((item) => item !== priority)
        : [...current, priority]
    );
  }

  function toggleSeverity(severity: KanbanSeverity) {
    setSeverityFilters((current) =>
      current.includes(severity)
        ? current.filter((item) => item !== severity)
        : [...current, severity]
    );
  }

  function toggleProjectFilter(projectId: string) {
    setSelectedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((item) => item !== projectId)
        : [...current, projectId]
    );
  }

  const modalReadOnly = modal?.mode === "edit" && !canEditKanbanIssueBody(modal.issue);
  const modalStatusLocked = modalReadOnly || (modal?.mode === "edit" && Boolean(modal.issue?.runId));
  const modalSyncLocked = modalReadOnly || (modal?.mode === "edit" && modal.issue?.syncMode === "cloud");
  const visibleFormAttachments = getVisibleKanbanAttachments(form.attachments);

  return (
    <section className="kanban-page" aria-label={t("kanban.title")}>
      <div className="kanban-toolbar">
        <div className="kanban-toolbar-start">
          <KanbanProjectFilter
            projects={cloudProjectOptions}
            selectedProjectIds={selectedProjectIds}
            filteredCount={filteredCount}
            totalCount={totalCount}
            open={projectFilterOpen}
            t={t}
            onOpenChange={(open) => {
              setProjectFilterOpen(open);
              if (open) {
                setMenu(null);
                setSearchFilterMenu(null);
              }
            }}
            onToggleProject={toggleProjectFilter}
            onClear={() => setSelectedProjectIds([])}
          />
        </div>
        <div className="kanban-toolbar-center">
          <div className="kanban-search-wrap">
            <KanbanIcon kind="search" />
            <input
              className="kanban-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("kanban.search.placeholder")}
              aria-label={t("kanban.search.ariaLabel")}
            />
            <KanbanSearchFilters
              openMenu={searchFilterMenu}
              priorityFilters={priorityFilters}
              severityFilters={severityFilters}
              automationFilter={automationFilter}
              t={t}
              onOpenMenuChange={(nextMenu) => {
                setSearchFilterMenu(nextMenu);
                if (nextMenu) {
                  setMenu(null);
                  setProjectFilterOpen(false);
                }
              }}
              onTogglePriority={togglePriority}
              onClearPriority={() => setPriorityFilters([])}
              onToggleSeverity={toggleSeverity}
              onClearSeverity={() => setSeverityFilters([])}
              onAutomationFilterChange={setAutomationFilter}
            />
          </div>
        </div>
        <div className="kanban-toolbar-end">
          <button
            type="button"
            className={`kanban-tool kanban-cloud-status is-${getKanbanConnectionTone(connectionState)} ${menu === "cloud" ? "is-active" : ""}`}
            aria-label={t("kanban.cloud.configure")}
            title={t("kanban.cloud.configure")}
            onClick={() => {
              setProjectFilterOpen(false);
              setSearchFilterMenu(null);
              setMenu(menu === "cloud" ? null : "cloud");
            }}
          >
            <span className="kanban-cloud-dot" aria-hidden="true" />
            <span className="kanban-tool-label">{getKanbanConnectionLabel(connectionState, t)}</span>
            {cloudSyncSummary.errorCount > 0 ? (
              <span className="kanban-cloud-error-count" title={t("kanban.cloud.syncErrors", { count: cloudSyncSummary.errorCount })}>
                {cloudSyncSummary.errorCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={`kanban-tool is-icon-only ${menu === "display" ? "is-active" : ""}`}
            aria-label={t("kanban.toolbar.display")}
            title={t("kanban.toolbar.display")}
            onClick={() => {
              setProjectFilterOpen(false);
              setSearchFilterMenu(null);
              setMenu(menu === "display" ? null : "display");
            }}
          >
            <KanbanIcon kind="display" />
            <span className="kanban-tool-label">{t("kanban.toolbar.display")}</span>
          </button>
        </div>
      </div>

      {menu ? (
        <div className={`kanban-menu-panel is-${menu}`}>
          {menu === "display" ? (
            <>
              <strong>{t("kanban.display.cardFields")}</strong>
              {Object.entries({
                priority: t("kanban.display.priority")
              } satisfies Record<keyof DisplayState, string>).map(([key, label]) => (
                <label key={key} className="kanban-check-row">
                  <input
                    type="checkbox"
                    checked={display[key as keyof DisplayState]}
                    onChange={() => {
                      const displayKey = key as keyof DisplayState;
                      setDisplay((current) => ({ ...current, [displayKey]: !current[displayKey] }));
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </>
          ) : (
            <div className="kanban-cloud-form">
              <div className="kanban-cloud-form-head">
                <strong>{t("kanban.cloud.title")}</strong>
                <span className={`kanban-cloud-state is-${getKanbanConnectionTone(connectionState)}`}>
                  {getKanbanConnectionLabel(connectionState, t)}
                </span>
              </div>
              <div className="kanban-cloud-summary">
                <span>{t("kanban.cloud.syncedIssues", { count: cloudSyncSummary.cloudCount })}</span>
                <span>{formatKanbanLastSyncedAt(cloudSyncSummary.lastSyncedAt, t)}</span>
                {cloudSyncSummary.syncingCount > 0 ? <span>{t("kanban.cloud.syncingIssues", { count: cloudSyncSummary.syncingCount })}</span> : null}
                {cloudSyncSummary.errorCount > 0 ? <span className="is-error">{t("kanban.cloud.syncErrors", { count: cloudSyncSummary.errorCount })}</span> : null}
              </div>
              <div className="kanban-cloud-actions">
                <button
                  type="button"
                  className="kanban-primary-button"
                  disabled={cloudResyncing || connectionState !== "open"}
                  onClick={() => void resyncCloudBoard()}
                >
                  {cloudResyncing ? t("kanban.cloud.resyncing") : t("kanban.cloud.resync")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {feedback ? (
        <div className={`kanban-feedback is-${feedback.tone}`}>
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label={t("kanban.notice.close")}>×</button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={detectKanbanCollisions}
        onDragStart={handleDragStart}
        onDragCancel={clearActiveDrag}
        onDragEnd={handleDragEnd}
      >
        <div
          className="kanban-columns"
          aria-busy={loading}
        >
          {VISIBLE_KANBAN_STATUSES.map((status) => {
            const columnIssues = issuesByStatus[status] ?? [];
            return (
              <KanbanColumn
                key={status}
                status={status}
                issues={columnIssues}
                agents={agents}
                cloudDetails={cloudDetails}
                projectsById={kanbanProjectsById}
                display={display}
                locale={locale}
                now={new Date(kanbanCountdownNow)}
                t={t}
                canAdd={kanbanReady}
                onAdd={createIssueHandlersByStatus[status]}
                onEdit={openEditModal}
                onDelete={async (issue) => { await deleteIssue(issue); }}
                onOpenChat={openAssistantIssueChat}
                onOpenContextMenu={openIssueContextMenu}
              />
            );
          })}
        </div>

        {typeof document !== "undefined" ? createPortal(
          <DragOverlay adjustScale={false} className="kanban-drag-overlay" dropAnimation={null} zIndex={120}>
            {activeDragIssue ? (
              <article className={getIssueCardShellClassName(activeDragIssue, ["issue-drag-overlay-card"])}>
                <IssueCardContent
                  issue={activeDragIssue}
                  awaitingConfirmation={false}
                  agents={agents}
                  cloudDetails={cloudDetails}
                  projectsById={kanbanProjectsById}
                  display={display}
                  locale={locale}
                  now={new Date(kanbanCountdownNow)}
                  t={t}
                  interactive={false}
                  onEdit={() => undefined}
                  onDelete={() => undefined}
                  onOpenChat={() => undefined}
                />
              </article>
            ) : null}
          </DragOverlay>,
          document.body
        ) : null}
      </DndContext>

      {contextMenu ? (() => {
        const issue = issueMap.get(contextMenu.issueId);
        if (!issue || !canEditKanbanIssueBody(issue)) {
          return null;
        }
        const menu = (
          <div
            className="issue-card-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="issue-card-context-danger"
              onClick={() => void deleteIssue(issue)}
            >
              {t("kanban.context.delete")}
            </button>
          </div>
        );
        return typeof document !== "undefined" ? createPortal(menu, document.body) : menu;
      })() : null}

      {detailIssue ? (
        <KanbanIssueDetailDialog
          key={detailIssue.id}
          issue={detailIssue}
          issues={issues}
          projects={cloudProjects}
          cloudDetails={cloudDetails}
          agents={agents.map((agent) => ({ agentKey: agent.agentKey, displayName: agent.displayName }))}
          locale={locale}
          t={t}
          initialEditStatus={detailInitialEditStatus}
          onClose={() => {
            setDetailIssueId(null);
            setDetailInitialEditStatus(null);
          }}
          onSave={(draft) => saveIssueDetail(detailIssue, draft)}
          onDelete={() => deleteIssue(detailIssue)}
          onOpenChat={() => void openAssistantIssueChat(detailIssue)}
          onFeedback={(tone, message) => setFeedback({ tone, message })}
        />
      ) : null}

      {modal ? (
        <div className="kanban-modal-layer" role="presentation" onMouseDown={() => setModal(null)}>
          <form
            className={`kanban-modal ${formCompact ? "is-compact" : "is-advanced"} ${modalReadOnly ? "is-readonly" : ""}`}
            onSubmit={(event) => {
              if (modalReadOnly) {
                event.preventDefault();
                return;
              }
              void submitForm(event);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            aria-readonly={modalReadOnly || undefined}
            noValidate
          >
            <div className="kanban-modal-head">
              <strong>
                {modalReadOnly
                  ? t("kanban.modal.detailTitle")
                  : modal.mode === "edit" ? t("kanban.modal.editTitle") : t("kanban.modal.createTitle")}
              </strong>
              <div className="kanban-modal-head-actions">
                {!modalReadOnly ? (
                  <button
                    type="button"
                    className="kanban-modal-mode-button"
                    onClick={toggleFormCompactMode}
                  >
                    {formCompact ? t("kanban.modal.advancedMode") : t("kanban.modal.compactMode")}
                  </button>
                ) : null}
                <button type="button" className="kanban-modal-close-button" onClick={() => setModal(null)} aria-label={t("kanban.modal.close")}>×</button>
              </div>
            </div>
            {!formCompact ? (
              <label className="kanban-field">
                <span>{t("kanban.form.title")}</span>
                <input
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  autoFocus={!formCompact}
                  disabled={modalReadOnly}
                  required
                />
              </label>
            ) : null}
            <div className="kanban-field">
              <div className="kanban-field-head">
                <span>{t("kanban.form.description")}</span>
                {!modalReadOnly ? (
                  <button
                    type="button"
                    className="kanban-attachment-add-button"
                    onClick={() => void addKanbanAttachments()}
                    disabled={attachmentBusy}
                  >
                    {attachmentBusy ? t("kanban.form.uploading") : t("kanban.form.addAttachment")}
                  </button>
                ) : null}
              </div>
              <textarea
                value={form.description}
                onChange={(event) => {
                  const value = event.target.value;
                  setForm((current) => ({
                    ...current,
                    description: value,
                    automationMessage: current.automationEnabled && !current.automationMessage.trim()
                      ? value.trim() || current.title.trim()
                      : current.automationMessage
                  }));
                }}
                rows={formCompact ? 5 : 4}
                autoFocus={formCompact}
                disabled={modalReadOnly}
              />
              {visibleFormAttachments.length > 0 ? (
                <div className="kanban-attachment-list" aria-label={t("kanban.form.attachments")}>
                  {visibleFormAttachments.map((attachment) => {
                    const sizeLabel = formatKanbanAttachmentSize(attachment.sizeBytes);
                    return (
                      <div key={attachment.id} className="kanban-attachment-chip">
                        <button
                          type="button"
                          className="kanban-attachment-open"
                          onClick={() => void openKanbanAttachment(attachment)}
                          title={sizeLabel ? `${attachment.name} · ${sizeLabel}` : attachment.name}
                        >
                          <span className="kanban-attachment-icon" aria-hidden="true">⌘</span>
                          <span className="kanban-attachment-name">{attachment.name}</span>
                          {sizeLabel ? <span className="kanban-attachment-size">{sizeLabel}</span> : null}
                        </button>
                        {!modalReadOnly ? (
                          <button
                            type="button"
                            className="kanban-attachment-remove"
                            onClick={() => removeKanbanAttachment(attachment.id)}
                            aria-label={t("kanban.form.removeAttachment", { name: attachment.name })}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {!formCompact ? (
              <div className="kanban-field-grid">
                <label className="kanban-field">
                  <span>{t("kanban.form.status")}</span>
                  <select
                    value={form.status}
                    disabled={modalStatusLocked}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      status: event.target.value as KanbanStatus
                    }))}
                  >
                    {KANBAN_STATUSES.map((status) => (
                      <option key={status} value={status}>{t(STATUS_META[status].labelKey)}</option>
                    ))}
                  </select>
                </label>
                <label className="kanban-field">
                  <span>{t("kanban.form.priority")}</span>
                  <select
                    value={form.priority}
                    disabled={modalReadOnly}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      priority: event.target.value as KanbanPriority
                    }))}
                  >
                    {KANBAN_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>{t(PRIORITY_META[priority].labelKey)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            <label className="kanban-field">
              <span>{t("kanban.form.assignee")}</span>
              <select
                value={form.assigneeAgentKey}
                disabled={modalReadOnly}
                onChange={(event) => {
                  const assigneeAgentKey = event.target.value;
                  setForm((current) => ({
                    ...current,
                    assigneeAgentKey
                  }));
                }}
              >
                <option value="">{t("kanban.form.unassigned")}</option>
                {agents.map((agent) => (
                  <option key={agent.agentKey} value={agent.agentKey}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="kanban-check-row kanban-sync-toggle">
              <input
                type="checkbox"
                checked={form.syncToCloud}
                disabled={modalSyncLocked}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  syncToCloud: event.target.checked
                }))}
              />
              <span>{t("kanban.form.syncToCloud")}</span>
            </label>
            {!formCompact ? (
              <section className="kanban-automation-panel" aria-label={t("kanban.form.automationPanel")}>
                <label className="kanban-check-row kanban-automation-toggle">
                  <input
                    type="checkbox"
                    checked={form.automationEnabled}
                    disabled={modalReadOnly}
                    onChange={(event) => setForm((current) => {
                      const enabled = event.target.checked;
                      return {
                        ...current,
                        automationEnabled: enabled,
                        automationCron: enabled
                          ? buildAutomationCron(current.automationPreset, current.automationTime, current.automationCron)
                          : current.automationCron,
                        automationMessage: enabled && !current.automationMessage.trim()
                          ? current.description.trim() || current.title.trim()
                          : current.automationMessage
                      };
                    })}
                  />
                  <span>{t("kanban.form.automationEnabled")}</span>
                </label>
                {form.automationEnabled ? (
                  <div className="kanban-automation-popover">
                    <span className="kanban-automation-panel-title">{t("kanban.form.automationPlan")}</span>
                    <div className="kanban-field kanban-automation-select-field">
                      <span>{t("kanban.form.automationFrequency")}</span>
                      <div className={`kanban-automation-menu ${automationMenuOpen === "plan" ? "is-open" : ""}`}>
                        <button
                          type="button"
                          className="kanban-automation-menu-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={automationMenuOpen === "plan"}
                          disabled={modalReadOnly}
                          onClick={() => toggleAutomationMenu("plan")}
                        >
                          <span>{getAutomationPlanLabel(form.automationPreset, t)}</span>
                          <span className="kanban-automation-menu-arrow" aria-hidden="true">⌄</span>
                        </button>
                        {automationMenuOpen === "plan" ? (
                          <div className="kanban-automation-menu-list" role="listbox" aria-label={t("kanban.form.automationFrequencyList")}>
                            {KANBAN_AUTOMATION_PLANS.map((plan) => (
                              <button
                                key={plan.value}
                                type="button"
                                className={plan.value === form.automationPreset ? "is-selected" : ""}
                                role="option"
                                aria-selected={plan.value === form.automationPreset}
                                disabled={modalReadOnly}
                                onClick={() => updateAutomationPlan(plan.value)}
                              >
                                {t(plan.labelKey)}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {form.automationPreset === "custom" ? (
                      <label className="kanban-field">
                        <span>{t("kanban.form.cron")}</span>
                        <input
                          value={form.automationCron}
                          disabled={modalReadOnly}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            automationCron: event.target.value
                          }))}
                          placeholder="0 9 * * *"
                        />
                      </label>
                    ) : (
                      <div className="kanban-automation-time-control">
                        <div className="kanban-field kanban-automation-select-field">
                          <span>{t("kanban.form.automationTime")}</span>
                          <div className={`kanban-automation-menu ${automationMenuOpen === "time" ? "is-open" : ""}`}>
                            <button
                              type="button"
                              className="kanban-automation-menu-trigger"
                              aria-haspopup="listbox"
                              aria-expanded={automationMenuOpen === "time"}
                              disabled={modalReadOnly}
                              onClick={() => toggleAutomationMenu("time")}
                            >
                              <span>{form.automationTime}</span>
                              <span className="kanban-automation-menu-arrow" aria-hidden="true">⌄</span>
                            </button>
                            {automationMenuOpen === "time" ? (
                              <div className="kanban-automation-menu-list is-time-list" role="listbox" aria-label={t("kanban.form.automationTimeList")}>
                                {KANBAN_AUTOMATION_TIME_OPTIONS.map((time) => (
                                  <button
                                    key={time}
                                    ref={time === form.automationTime ? selectedAutomationTimeRef : null}
                                    type="button"
                                    className={time === form.automationTime ? "is-selected" : ""}
                                    role="option"
                                    aria-selected={time === form.automationTime}
                                    disabled={modalReadOnly}
                                    onClick={() => updateAutomationTime(time)}
                                  >
                                    {time}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </section>
            ) : null}
            <div className="kanban-modal-actions">
              {modal.mode === "edit" && modal.issue && !modalReadOnly ? (
                <button
                  type="button"
                  className="kanban-danger-button"
                  onClick={() => void deleteIssue(modal.issue!)}
                >
                  {t("kanban.form.delete")}
                </button>
              ) : null}
              <button type="button" className="kanban-secondary-button" onClick={() => setModal(null)}>
                {modalReadOnly ? t("kanban.modal.close") : t("kanban.form.cancel")}
              </button>
              {!modalReadOnly ? (
                <button type="submit" className="kanban-primary-button" disabled={!kanbanReady}>
                  {t("kanban.form.save")}
                </button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      {chatModalRequest ? (
        <div className="kanban-modal-layer kanban-chat-modal-layer" role="presentation" onMouseDown={() => setChatModalRequest(null)}>
          <section
            className="kanban-chat-modal"
            role="dialog"
            aria-modal="true"
            aria-label={chatModalRequest.displayName ? t("kanban.chat.modalLabel", { name: chatModalRequest.displayName }) : t("kanban.chat.defaultModalLabel")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ServiceWebviewSurface
              key={`kanban-chat:${chatModalRequest.agentKey}:${chatModalRequest.chatId}`}
              active
              hostTheme={hostTheme}
              serviceId="agent-webclient"
              surfaceId="agent-webclient-kanban-chat"
              surfaceLabel={t("kanban.chat.surfaceLabel")}
              embedPath={buildKanbanChatEmbedPath(chatModalRequest)}
              skipContextRegistration
              loadInitialEmbeddedUrlDirectly
              suppressInitialLoadingCopy
            />
            <button
              type="button"
              className="kanban-chat-modal-close"
              aria-label={t("kanban.chat.close")}
              title={t("kanban.modal.close")}
              onClick={() => setChatModalRequest(null)}
            >
              ×
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

const KanbanColumn = memo(function KanbanColumn({
  status,
  issues,
  agents,
  cloudDetails,
  projectsById,
  display,
  locale,
  now,
  t,
  canAdd,
  onAdd,
  onEdit,
  onDelete,
  onOpenChat,
  onOpenContextMenu
}: {
  status: KanbanStatus;
  issues: KanbanIssue[];
  agents: AssistantNavAgentItem[];
  cloudDetails: KanbanCloudDetailData;
  projectsById: Map<string, KanbanProject>;
  display: DisplayState;
  locale: SupportedLocale;
  now: Date;
  t: TranslateFunction;
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (issue: KanbanIssue) => void;
  onDelete: (issue: KanbanIssue) => void | Promise<void>;
  onOpenChat: (issue: KanbanIssue) => void | Promise<void>;
  onOpenContextMenu: (issue: KanbanIssue, event: MouseEvent<HTMLElement>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getColumnId(status) });
  const meta = STATUS_META[status];
  const label = t(meta.labelKey);
  return (
    <section
      ref={setNodeRef}
      className={`kanban-column is-${status} is-${meta.tone} ${isOver ? "is-over" : ""}`}
    >
      <header className="kanban-column-head">
        <div className="kanban-column-title">
          <strong>{label}</strong>
          <span>{issues.length}</span>
        </div>
        <div className="kanban-column-actions">
          <button
            type="button"
            aria-label={t("kanban.column.addTo", { status: label })}
            disabled={!canAdd}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <PlusOutlined />
          </button>
        </div>
      </header>
      <div
        className="kanban-column-body"
        onDoubleClick={(event) => {
          if (shouldCreateIssueFromColumnDoubleClick(event, status)) {
            onAdd();
          }
        }}
      >
        <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue, index) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              sortIndex={index + 1}
              awaitingConfirmation={issueHasPendingAwaiting(issue, agents)}
              agents={agents}
              cloudDetails={cloudDetails}
              projectsById={projectsById}
              display={display}
              locale={locale}
              now={now}
              t={t}
              onEdit={() => onEdit(issue)}
              onDelete={() => void onDelete(issue)}
              onOpenChat={() => void onOpenChat(issue)}
              onOpenContextMenu={(event) => onOpenContextMenu(issue, event)}
            />
          ))}
        </SortableContext>
        {issues.length === 0 ? (
          <div className="kanban-empty-column">
            <strong>{t("kanban.column.empty")}</strong>
            <span>{getKanbanEmptyHint(status, t)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
});

const IssueCard = memo(function IssueCard({
  issue,
  sortIndex,
  awaitingConfirmation,
  agents,
  cloudDetails,
  projectsById,
  display,
  locale,
  now,
  t,
  onEdit,
  onDelete,
  onOpenChat,
  onOpenContextMenu
}: {
  issue: KanbanIssue;
  sortIndex: number;
  awaitingConfirmation: boolean;
  agents: AssistantNavAgentItem[];
  cloudDetails: KanbanCloudDetailData;
  projectsById: Map<string, KanbanProject>;
  display: DisplayState;
  locale: SupportedLocale;
  now: Date;
  t: TranslateFunction;
  onEdit: () => void;
  onDelete: () => void;
  onOpenChat: () => void;
  onOpenContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const dragLocked = isIssueDragLocked(issue);
  const sortable = useSortable({ id: issue.id, disabled: dragLocked });
  const style = {
    transform: sortable.isDragging ? undefined : CSS.Transform.toString(sortable.transform),
    transition: sortable.isDragging ? undefined : sortable.transition
  };
  function handleContextMenu(event: MouseEvent<HTMLElement>) {
    onOpenContextMenu(event);
  }

  return (
    <article
      ref={sortable.setNodeRef}
      style={style}
      className={getIssueCardShellClassName(issue, [
        sortable.isDragging ? "is-dragging-source" : "",
        dragLocked ? "is-drag-locked" : "",
        awaitingConfirmation ? "is-awaiting-confirmation" : ""
      ])}
      data-drag-locked={dragLocked ? "true" : undefined}
      {...sortable.attributes}
      aria-disabled={undefined}
      onContextMenu={handleContextMenu}
      onClick={(event) => event.stopPropagation()}
      {...(dragLocked ? {} : sortable.listeners)}
    >
      <IssueCardContent
        issue={issue}
        sortIndex={sortIndex}
        awaitingConfirmation={awaitingConfirmation}
        agents={agents}
        cloudDetails={cloudDetails}
        projectsById={projectsById}
        display={display}
        locale={locale}
        now={now}
        t={t}
        interactive
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenChat={onOpenChat}
      />
    </article>
  );
});

const IssueCardContent = memo(function IssueCardContent({
  issue,
  sortIndex,
  awaitingConfirmation,
  agents,
  cloudDetails,
  projectsById,
  display,
  locale,
  now,
  t,
  interactive,
  onEdit,
  onDelete,
  onOpenChat
}: {
  issue: KanbanIssue;
  sortIndex?: number;
  awaitingConfirmation: boolean;
  agents: AssistantNavAgentItem[];
  cloudDetails: KanbanCloudDetailData;
  projectsById: Map<string, KanbanProject>;
  display: DisplayState;
  locale: SupportedLocale;
  now: Date;
  t: TranslateFunction;
  interactive: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpenChat: () => void;
}) {
  const severity = normalizeIssueSeverity(issue.severity);
  const cardStatus = getIssueCardStatusPresentation(issue, t);
  const cardSignal = getIssueCardSignalPresentation(issue, {
    locale,
    now,
  }, t);
  const operationalState = getIssueCardOperationalStatePresentation(issue, awaitingConfirmation, t);
  const descriptionPreview = getIssueDescriptionPreview(issue.description);
  const duePresentation = getIssueCardDuePresentation(issue, locale, now, t);
  const peopleLine = getIssueCardPeopleWithDevDemo(
    issue,
    getIssueCardPeoplePresentation(issue, agents, cloudDetails.users, t),
    t
  );
  const hasPeople = peopleLine.people.length > 0;
  const progress = getIssueCardProgressPresentation(issue, cloudDetails);
  const issueOrigin = getKanbanIssueOriginPresentation(issue, projectsById, t);
  const canOpenIssueDetails = interactive;
  const canDeleteIssue = interactive && canEditKanbanIssueBody(issue);
  const canOpenIssueChat = interactive && Boolean(issue.chatId?.trim());
  const actionCount = interactive ? 1 + Number(canOpenIssueChat) + Number(canDeleteIssue) : 0;
  const queueRank = issue.status === "todo" ? formatKanbanSortNumber(sortIndex, issue.position) : "";
  const showDescription = issue.status === "backlog" && Boolean(descriptionPreview);
  const showPriorityImportance = display.priority && (issue.status === "backlog" || issue.status === "todo");
  const priorityImportance = showPriorityImportance ? (
    <IssueCardPriorityImportance priority={issue.priority} severity={severity} t={t} />
  ) : null;
  const due = duePresentation ? (
    <span
      className={`issue-card-due ${duePresentation.overdue ? "is-overdue" : ""}`}
      title={duePresentation.title}
    >
      <ClockCircleOutlined aria-hidden="true" />
      <span>{duePresentation.label}</span>
    </span>
  ) : null;
  const people = peopleLine.people.length > 0 ? (
    <IssueCardPeople people={peopleLine.people} title={peopleLine.title} t={t} />
  ) : <span className="issue-card-people-spacer" aria-hidden="true" />;
  const timingSignal = cardSignal.label ? (
    <span className={`issue-card-signal is-${cardSignal.tone}`} title={cardSignal.label}>
      <IssueCardSignalIcon kind={cardSignal.icon} />
      <span>{cardSignal.label}</span>
    </span>
  ) : null;
  const stateSignal = operationalState ? (
    <span className={`issue-card-signal issue-card-operational-state is-${operationalState.tone}`} title={operationalState.label}>
      <span className="issue-card-state-dot" aria-hidden="true" />
      <span>{operationalState.label}</span>
    </span>
  ) : null;
  const actions = interactive ? (
    <span className="issue-card-actions">
      <button
        type="button"
        className="issue-card-action"
        aria-label={t("kanban.card.viewDetails")}
        title={t("kanban.card.viewDetails")}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
      >
        <EyeOutlined />
      </button>
      {canOpenIssueChat ? (
        <button
          type="button"
          className="issue-card-action"
          aria-label={t("kanban.chat.view")}
          title={t("kanban.chat.view")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChat();
          }}
        >
          <MessageOutlined />
        </button>
      ) : null}
      {canDeleteIssue ? (
        <button
          type="button"
          className="issue-card-action is-danger"
          aria-label={t("kanban.context.delete")}
          title={t("kanban.context.delete")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <DeleteOutlined />
        </button>
      ) : null}
    </span>
  ) : null;
  const actionSlot = (signal: ReactNode = null) => (
    <span className={`issue-card-footer-end has-${actionCount}-actions ${signal ? "has-signal" : "has-no-signal"}`}>
      {signal ? <span className="issue-card-footer-signal">{signal}</span> : null}
      {actions}
    </span>
  );
  const mainContent = (
    <>
      <div
        className="issue-card-workflow-progress"
        role="progressbar"
        aria-label={t("kanban.card.workflowProgress", { stage: progress.stageLabel || t("kanban.card.stageUnknown") })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        title={progress.stageLabel ? t("kanban.card.stage", { value: progress.stageLabel }) : undefined}
      >
        <span style={{ width: `${progress.percent}%`, backgroundColor: progress.color }} />
      </div>
      <section className="issue-card-section issue-card-context">
        <div className="issue-card-context-line is-primary">
          <span className="issue-card-project" title={issueOrigin.title}>
            {issueOrigin.projectLabel}
          </span>
          <span
            className={`issue-card-status is-${cardStatus.tone}`}
            title={t("kanban.card.status", { value: cardStatus.label })}
          >
            <span className="issue-card-status-mark" style={{ backgroundColor: progress.color }} aria-hidden="true" />
            <span>{cardStatus.label}</span>
          </span>
        </div>
      </section>
      <section className="issue-card-section issue-card-title-block">
        <span className="issue-card-title" title={issue.title}>
          {queueRank ? <span className="issue-card-queue-rank">{queueRank}</span> : null}
          <span className="issue-card-title-text">{issue.title}</span>
        </span>
        {showDescription ? (
          <span className="issue-card-description" title={descriptionPreview}>
            {descriptionPreview}
          </span>
        ) : null}
      </section>
    </>
  );

  return (
    <>
      {canOpenIssueDetails ? (
        <div
          className="issue-card-main"
          role="button"
          tabIndex={0}
          onClick={onEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onEdit();
            }
          }}
        >
          {mainContent}
        </div>
      ) : (
        <div className={`issue-card-main ${interactive ? "is-readonly" : ""}`} aria-hidden={interactive ? undefined : "true"}>
          {mainContent}
        </div>
      )}
      <footer className="issue-card-section issue-card-foot">
        {issue.status === "backlog" ? (
          <>
            {(priorityImportance || due) ? <div className="issue-card-footer-row">{priorityImportance}<span className="issue-card-footer-row-end">{due}</span></div> : null}
            <div className="issue-card-footer-row">{people}{actionSlot(timingSignal)}</div>
          </>
        ) : issue.status === "todo" ? (
          hasPeople ? (
            <>
              {(priorityImportance || due) ? <div className="issue-card-footer-row">{priorityImportance}<span className="issue-card-footer-row-end">{due}</span></div> : null}
              <div className="issue-card-footer-row">{people}{actionSlot()}</div>
            </>
          ) : (priorityImportance || due) ? (
            <div className="issue-card-footer-row">
              {priorityImportance}
              <span className="issue-card-footer-row-end">{due}</span>
              {actionSlot()}
            </div>
          ) : null
        ) : issue.status === "in_progress" || issue.status === "in_review" ? (
          <>
            {hasPeople ? <div className="issue-card-footer-row">{people}</div> : null}
            <div className="issue-card-footer-row is-timing">
              {timingSignal}
              <span className="issue-card-footer-row-end">{due}</span>
              {actionSlot(stateSignal)}
            </div>
          </>
        ) : (
          hasPeople ? (
            <>
              <div className="issue-card-footer-row">{timingSignal}</div>
              <div className="issue-card-footer-row">{people}{actionSlot()}</div>
            </>
          ) : (
            <div className="issue-card-footer-row">{timingSignal}{actionSlot()}</div>
          )
        )}
      </footer>
    </>
  );
});

function IssueCardSignalIcon({ kind }: { kind: IssueCardSignalIconName }) {
  const Icon = {
    history: HistoryOutlined,
    order: OrderedListOutlined,
    running: ClockCircleOutlined,
    waiting: HourglassOutlined,
    completed: CheckCircleOutlined,
    failed: CloseCircleOutlined,
    cancelled: StopOutlined
  }[kind];
  return <Icon aria-hidden="true" />;
}

/* Card descriptions are display-only previews; full content stays in the detail surface. */

function KanbanProjectFilter({
  projects,
  selectedProjectIds,
  filteredCount,
  totalCount,
  open,
  t,
  onOpenChange,
  onToggleProject,
  onClear
}: {
  projects: KanbanProject[];
  selectedProjectIds: string[];
  filteredCount: number;
  totalCount: number;
  open: boolean;
  t: TranslateFunction;
  onOpenChange: (open: boolean) => void;
  onToggleProject: (projectId: string) => void;
  onClear: () => void;
}) {
  const filterRef = useRef<HTMLDivElement | null>(null);
  const treeItems = useMemo(() => flattenKanbanProjectTree(projects), [projects]);
  const label = getKanbanProjectFilterLabel(selectedProjectIds, projects, t);
  const countLabel = t("kanban.toolbar.issueCount", { filtered: filteredCount, total: totalCount });

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return undefined;
    }
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && filterRef.current?.contains(target)) {
        return;
      }
      onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenChange, open]);

  return (
    <div className="kanban-project-filter" ref={filterRef}>
      <button
        type="button"
        className={`kanban-project-filter-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={`${t("kanban.projectFilter.ariaLabel")}: ${label}; ${countLabel}`}
        title={`${label} · ${countLabel}`}
        onClick={() => onOpenChange(!open)}
      >
        <KanbanIcon kind="project" />
        <span className="kanban-project-filter-label">{label}</span>
        <span className="kanban-project-filter-count" aria-hidden="true">{countLabel}</span>
      </button>
      {open ? (
        <div className="kanban-project-filter-menu" role="tree" aria-label={t("kanban.projectFilter.ariaLabel")}>
          <button
            type="button"
            className={`kanban-project-filter-all ${selectedProjectIds.length === 0 ? "is-active" : ""}`}
            onClick={onClear}
          >
            {t("kanban.projectFilter.all")}
          </button>
          {treeItems.length > 0 ? (
            <div className="kanban-project-filter-tree">
              {treeItems.map(({ project, level }) => (
                <label
                  key={project.id}
                  className="kanban-project-filter-row"
                  role="treeitem"
                  aria-level={level + 1}
                  style={{ paddingLeft: `${8 + (level * 14)}px` }}
                  title={getKanbanProjectOptionLabel(project)}
                >
                  <input
                    type="checkbox"
                    checked={selectedProjectIds.includes(project.id)}
                    onChange={() => onToggleProject(project.id)}
                  />
                  <span className="kanban-project-filter-name">{project.name}</span>
                  {project.path && project.path !== project.name ? (
                    <span className="kanban-project-filter-path">{project.path}</span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : (
            <span className="kanban-project-filter-empty">{t("kanban.projectFilter.empty")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function KanbanSearchFilters({
  openMenu,
  priorityFilters,
  severityFilters,
  automationFilter,
  t,
  onOpenMenuChange,
  onTogglePriority,
  onClearPriority,
  onToggleSeverity,
  onClearSeverity,
  onAutomationFilterChange
}: {
  openMenu: SearchFilterMenuKind;
  priorityFilters: KanbanPriority[];
  severityFilters: KanbanSeverity[];
  automationFilter: KanbanAutomationFilter;
  t: TranslateFunction;
  onOpenMenuChange: (menu: SearchFilterMenuKind) => void;
  onTogglePriority: (priority: KanbanPriority) => void;
  onClearPriority: () => void;
  onToggleSeverity: (severity: KanbanSeverity) => void;
  onClearSeverity: () => void;
  onAutomationFilterChange: (filter: KanbanAutomationFilter) => void;
}) {
  const filterRef = useRef<HTMLDivElement | null>(null);
  const hasPriorityFilter = priorityFilters.length > 0;
  const hasSeverityFilter = severityFilters.length > 0;
  const hasAutomationFilter = automationFilter !== "all";

  useEffect(() => {
    if (!openMenu || typeof document === "undefined") {
      return undefined;
    }
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && filterRef.current?.contains(target)) {
        return;
      }
      onOpenMenuChange(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenMenuChange(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenMenuChange, openMenu]);

  function toggleMenu(menu: Exclude<SearchFilterMenuKind, null>) {
    onOpenMenuChange(openMenu === menu ? null : menu);
  }

  return (
    <div className="kanban-search-filters" ref={filterRef}>
      <button
        type="button"
        className={`kanban-search-filter-button ${openMenu === "priority" ? "is-open" : ""} ${hasPriorityFilter ? "is-active" : ""}`}
        aria-label={t("kanban.searchFilter.priority")}
        aria-haspopup="true"
        aria-expanded={openMenu === "priority"}
        title={t("kanban.searchFilter.priority")}
        onClick={() => toggleMenu("priority")}
      >
        <ThunderboltOutlined />
      </button>
      <button
        type="button"
        className={`kanban-search-filter-button ${openMenu === "severity" ? "is-open" : ""} ${hasSeverityFilter ? "is-active" : ""}`}
        aria-label={t("kanban.searchFilter.severity")}
        aria-haspopup="true"
        aria-expanded={openMenu === "severity"}
        title={t("kanban.searchFilter.severity")}
        onClick={() => toggleMenu("severity")}
      >
        <FlagOutlined />
      </button>
      <button
        type="button"
        className={`kanban-search-filter-button ${openMenu === "automation" ? "is-open" : ""} ${hasAutomationFilter ? "is-active" : ""}`}
        aria-label={t("kanban.searchFilter.automation")}
        aria-haspopup="true"
        aria-expanded={openMenu === "automation"}
        title={t("kanban.searchFilter.automation")}
        onClick={() => toggleMenu("automation")}
      >
        <KanbanIcon kind="clock" />
      </button>
      {openMenu ? (
        <div
          className={`kanban-search-filter-menu is-${openMenu}`}
          aria-label={
            openMenu === "priority"
              ? t("kanban.searchFilter.priority")
              : openMenu === "severity"
                ? t("kanban.searchFilter.severity")
                : t("kanban.searchFilter.automation")
          }
        >
          {openMenu === "priority" ? (
            <>
              <button
                type="button"
                className={`kanban-search-filter-all ${!hasPriorityFilter ? "is-active" : ""}`}
                onClick={onClearPriority}
              >
                {t("kanban.searchFilter.allPriorities")}
              </button>
              {KANBAN_PRIORITIES.map((priority) => (
                <label key={priority} className="kanban-check-row kanban-search-filter-row">
                  <input
                    type="checkbox"
                    checked={priorityFilters.includes(priority)}
                    onChange={() => onTogglePriority(priority)}
                  />
                  <PriorityBadge priority={priority} t={t} />
                </label>
              ))}
            </>
          ) : openMenu === "severity" ? (
            <>
              <button
                type="button"
                className={`kanban-search-filter-all ${!hasSeverityFilter ? "is-active" : ""}`}
                onClick={onClearSeverity}
              >
                {t("kanban.searchFilter.allSeverities")}
              </button>
              {KANBAN_SEVERITIES.map((severity) => (
                <label key={severity} className="kanban-check-row kanban-search-filter-row">
                  <input
                    type="checkbox"
                    checked={severityFilters.includes(severity)}
                    onChange={() => onToggleSeverity(severity)}
                  />
                  <IssueSeverityBadge severity={severity} t={t} />
                </label>
              ))}
            </>
          ) : (
            <>
              {KANBAN_AUTOMATION_FILTER_OPTIONS.map((option) => (
                <label key={option.value} className="kanban-check-row kanban-search-filter-row">
                  <input
                    type="radio"
                    name="kanban-automation-filter"
                    checked={automationFilter === option.value}
                    onChange={() => onAutomationFilterChange(option.value)}
                  />
                  <span>{t(option.labelKey)}</span>
                </label>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function KanbanIcon({ kind }: { kind: "attachment" | "clock" | "display" | "filter" | "project" | "search" }) {
  const paths: Record<typeof kind, ReactNode> = {
    attachment: (
      <path d="M7.5 11.5 12 7a2.1 2.1 0 0 1 3 3l-6 6a3.1 3.1 0 0 1-4.4-4.4l6.4-6.4" />
    ),
    clock: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="M10 6.8V10l2.3 1.4" />
      </>
    ),
    display: (
      <>
        <path d="M4 6h12" />
        <path d="M4 10h12" />
        <path d="M4 14h12" />
        <path d="M7 4v4" />
        <path d="M13 8v4" />
      </>
    ),
    filter: (
      <>
        <path d="M4 5h12" />
        <path d="M6.5 10h7" />
        <path d="M9 15h2" />
      </>
    ),
    project: (
      <>
        <path d="M3.8 6.2h5l1.4 1.6h6v7.4H3.8z" />
        <path d="M3.8 6.2V4.8h4.4l1.2 1.4" />
      </>
    ),
    search: (
      <>
        <circle cx="8.5" cy="8.5" r="4.5" />
        <path d="m12 12 3.5 3.5" />
      </>
    )
  };
  return (
    <svg className="kanban-icon" viewBox="0 0 20 20" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function IssueCardPriorityImportance({
  priority,
  severity,
  t
}: {
  priority: KanbanPriority;
  severity: KanbanSeverity;
  t: TranslateFunction;
}) {
  const priorityMeta = PRIORITY_META[priority];
  const priorityLabel = t(priorityMeta.shortLabelKey);
  const importanceLabel = t(SEVERITY_META[severity].shortLabelKey);
  return (
    <span
      className={`issue-card-priority-importance is-${priorityMeta.tone} is-importance-${severity}`}
      title={`${t("kanban.card.priority", { value: t(PRIORITY_META[priority].labelKey) })} · ${t("kanban.card.severity", { value: t(SEVERITY_META[severity].labelKey) })}`}
    >
      <span>{priorityLabel}</span>
      <span className="issue-card-priority-divider" aria-hidden="true">｜</span>
      <span>{importanceLabel}</span>
    </span>
  );
}

function IssueCardPeople({
  people,
  title,
  t
}: {
  people: IssueCardPersonPresentation[];
  title: string;
  t: TranslateFunction;
}) {
  return (
    <span className="issue-card-people" title={title}>
      {people.map((person, index) => (
        <span className="issue-card-person-group" key={`${person.kind}:${person.rawLabel}`}>
          {index > 0 ? <span className="issue-card-person-arrow" aria-hidden="true">→</span> : null}
          <span
            className={`issue-card-person is-${person.kind}`}
            title={person.kind === "worker" ? t("kanban.card.worker", { value: person.rawLabel }) : person.rawLabel}
          >
            {person.avatarUrl ? (
              <img className="issue-card-person-avatar" src={person.avatarUrl} alt="" aria-hidden="true" />
            ) : person.kind === "worker" && person.icon ? (
              <span className="issue-card-worker-icon" aria-hidden="true">{person.icon}</span>
            ) : person.rawLabel === t("kanban.form.unassigned") ? (
              <span className="issue-card-worker-icon" aria-hidden="true">{person.icon}</span>
            ) : (
              <span className="issue-card-person-avatar is-initials" aria-hidden="true">{getPersonInitials(person.label)}</span>
            )}
            <span>{person.label}</span>
          </span>
        </span>
      ))}
    </span>
  );
}

function IssuePriorityBadge({ priority, t }: { priority: KanbanPriority; t: TranslateFunction }) {
  const meta = PRIORITY_META[priority];
  const label = t(meta.labelKey);
  const shortLabel = t(meta.shortLabelKey);
  return (
    <span className="kanban-priority-badge" title={t("kanban.card.priority", { value: label })}>
      <PriorityIcon priority={priority} />
      <span className="kanban-priority-text">{shortLabel}</span>
    </span>
  );
}

function IssueSeverityBadge({ severity, t }: { severity: KanbanSeverity; t: TranslateFunction }) {
  const meta = SEVERITY_META[severity];
  const label = t(meta.labelKey);
  const shortLabel = t(meta.shortLabelKey);
  return (
    <span className="kanban-severity-badge" title={t("kanban.card.severity", { value: label })}>
      <ImportanceIcon severity={severity} />
      <span className="kanban-severity-text">{shortLabel}</span>
    </span>
  );
}

function PriorityBadge({ priority, t }: { priority: KanbanPriority; t: TranslateFunction }) {
  const meta = PRIORITY_META[priority];
  return (
    <span className={`kanban-priority is-${meta.tone}`}>
      <span className="kanban-priority-bars" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <span key={index} className={index < meta.bars ? "is-on" : ""} />
        ))}
      </span>
      {t(meta.labelKey)}
    </span>
  );
}
