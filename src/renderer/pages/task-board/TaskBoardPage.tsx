import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
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
import type {
  AssistantAttachment,
  AssistantEvent,
  AssistantNavAgentItem,
  DesktopApi,
  DesktopPetAgentOption,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueUpdateInput,
  TaskBoardPriority,
  TaskBoardStatus
} from "../../../shared/contracts";
import { TASK_BOARD_PRIORITIES, TASK_BOARD_STATUSES } from "../../../shared/contracts";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";
import {
  getAssistantNavAgentRecentChats,
  normalizeAssistantNavAgents
} from "../../assistantNavigation";
import { AgentIcon } from "../../app-shell/navigation/AgentIcon";
import { useI18n } from "../../i18n/useI18n";
import { PluginPage } from "../plugin/PluginPage";

type MenuKind = "filter" | "display" | null;
type ModalMode = "create" | "edit";
type ThemeMode = "light" | "dark";
type TaskBoardAutomationPlan = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
type TaskBoardTodoAutomationFilter = "all" | "scheduled" | "manual";
type AutomationMenuKind = "plan" | "time";
type ModalState = {
  mode: ModalMode;
  issue?: TaskBoardIssue;
};

type IssueFormState = {
  title: string;
  description: string;
  attachmentChatId: string;
  attachments: AssistantAttachment[];
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  assigneeAgentKey: string;
  automationEnabled: boolean;
  automationPreset: TaskBoardAutomationPlan;
  automationTime: string;
  automationCron: string;
  automationMessage: string;
  automationTimezone: string;
};

type DisplayState = {
  description: boolean;
  assignee: boolean;
  priority: boolean;
};

type TaskBoardCardPresentation = {
  assigneeLabel: string;
  assigneeTitle: string;
};

type TaskBoardCardStatusPresentation = {
  label: string;
  tone: TaskBoardStatus | "running" | "awaiting" | "succeeded" | "failed" | "cancelled";
  updatedTime: string;
};

type Feedback = {
  tone: "success" | "error";
  message: string;
};

type TaskBoardPageProps = {
  hostTheme: ThemeMode;
};

type TaskBoardChatModalRequest = {
  agentKey: string;
  chatId?: string;
  displayName?: string;
};

type TaskBoardContextMenu = {
  issueId: string;
  x: number;
  y: number;
};

const TASK_BOARD_FEEDBACK_AUTO_CLOSE_MS = 3000;
const TASK_BOARD_TODO_ASSIGNEE_START_DELAY_MS = 1000;
const TASK_BOARD_COUNTDOWN_REFRESH_MS = 60_000;
const VISIBLE_TASK_BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "completed"
] satisfies ReadonlyArray<TaskBoardStatus>;
const VISIBLE_TASK_BOARD_STATUS_SET = new Set<TaskBoardStatus>(VISIBLE_TASK_BOARD_STATUSES);

const STATUS_META: Record<TaskBoardStatus, { labelKey: TranslationKey; tone: string }> = {
  backlog: { labelKey: "taskBoard.status.backlog", tone: "neutral" },
  todo: { labelKey: "taskBoard.status.todo", tone: "muted" },
  in_progress: { labelKey: "taskBoard.status.inProgress", tone: "warning" },
  completed: { labelKey: "taskBoard.status.completed", tone: "info" }
};

const PRIORITY_META: Record<TaskBoardPriority, { labelKey: TranslationKey; tone: string; bars: number }> = {
  high: { labelKey: "taskBoard.priority.high", tone: "high", bars: 3 },
  medium: { labelKey: "taskBoard.priority.medium", tone: "medium", bars: 2 },
  low: { labelKey: "taskBoard.priority.low", tone: "low", bars: 1 }
};

const DEFAULT_TASK_BOARD_AUTOMATION_PLAN: TaskBoardAutomationPlan = "daily";
const DEFAULT_TASK_BOARD_AUTOMATION_TIME = "09:00";
const DEFAULT_TASK_BOARD_AUTOMATION_CRON = "0 9 * * *";

const TASK_BOARD_AUTOMATION_PLANS = [
  { labelKey: "taskBoard.automation.hourly", value: "hourly" },
  { labelKey: "taskBoard.automation.daily", value: "daily" },
  { labelKey: "taskBoard.automation.weekdays", value: "weekdays" },
  { labelKey: "taskBoard.automation.weekly", value: "weekly" },
  { labelKey: "taskBoard.automation.custom", value: "custom" }
] satisfies ReadonlyArray<{ labelKey: TranslationKey; value: TaskBoardAutomationPlan }>;

const TASK_BOARD_TODO_AUTOMATION_FILTERS = [
  { labelKey: "taskBoard.filter.all", value: "all" },
  { labelKey: "taskBoard.filter.scheduledOnly", value: "scheduled" },
  { labelKey: "taskBoard.filter.manualOnly", value: "manual" }
] satisfies ReadonlyArray<{ labelKey: TranslationKey; value: TaskBoardTodoAutomationFilter }>;

const TASK_BOARD_AUTOMATION_TIME_OPTIONS = buildAutomationTimeOptions();

const emptyForm: IssueFormState = {
  title: "",
  description: "",
  attachmentChatId: "",
  attachments: [],
  status: "backlog",
  priority: "medium",
  assigneeAgentKey: "",
  automationEnabled: false,
  automationPreset: DEFAULT_TASK_BOARD_AUTOMATION_PLAN,
  automationTime: DEFAULT_TASK_BOARD_AUTOMATION_TIME,
  automationCron: DEFAULT_TASK_BOARD_AUTOMATION_CRON,
  automationMessage: "",
  automationTimezone: "Asia/Shanghai"
};

const defaultDisplayState: DisplayState = {
  description: true,
  assignee: true,
  priority: true
};

function getColumnId(status: TaskBoardStatus) {
  return `task-board-column:${status}`;
}

function getStatusFromColumnId(id: string): TaskBoardStatus | null {
  const status = id.replace(/^task-board-column:/u, "");
  return TASK_BOARD_STATUSES.includes(status as TaskBoardStatus) ? status as TaskBoardStatus : null;
}

function detectTaskBoardCollisions(args: Parameters<CollisionDetection>[0]) {
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

function issueUpdatedTime(issue: TaskBoardIssue) {
  const timestamp = Date.parse(issue.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortIssues(issues: TaskBoardIssue[]) {
  const statusOrder = new Map(TASK_BOARD_STATUSES.map((status, index) => [status, index]));
  return [...issues].sort((a, b) => {
    const statusDelta = (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
    if (a.position !== b.position) return a.position - b.position;
    const updatedDelta = issueUpdatedTime(b) - issueUpdatedTime(a);
    if (updatedDelta !== 0) return updatedDelta;
    return a.id.localeCompare(b.id);
  });
}

function descriptionPreview(description: string) {
  return description.replace(/\s+/gu, " ").trim();
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

function formatIssueUpdatedTime(updatedAt: string) {
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) {
    return "";
  }
  const time = `${padAutomationNumber(updatedDate.getHours())}:${padAutomationNumber(updatedDate.getMinutes())}`;
  if (isSameLocalDate(updatedDate, new Date())) {
    return time;
  }
  return `${padAutomationNumber(updatedDate.getMonth() + 1)}/${padAutomationNumber(updatedDate.getDate())} ${time}`;
}

function formatTaskBoardSortNumber(sortIndex: number | undefined, position: number) {
  if (typeof sortIndex === "number" && Number.isFinite(sortIndex) && sortIndex > 0) {
    return `#${Math.round(sortIndex)}`;
  }
  return Number.isFinite(position) ? `#${Math.max(1, Math.round(position))}` : "";
}

function getNextTaskBoardAutomationTime(issue: Pick<TaskBoardIssue, "automationEnabled" | "automationCron">, now: Date) {
  if (!hasIssueAutomation(issue)) {
    return null;
  }
  const automationForm = parseAutomationFormFromCron(issue.automationCron);
  if (automationForm.automationPreset === "custom") {
    return null;
  }
  const { hour, minute } = automationTimeParts(automationForm.automationTime);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  if (automationForm.automationPreset === "hourly") {
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(numericMinute);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setHours(candidate.getHours() + 1);
    }
    return candidate;
  }

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + dayOffset);
    candidate.setHours(numericHour, numericMinute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      continue;
    }
    const dayOfWeek = candidate.getDay();
    if (automationForm.automationPreset === "weekdays" && (dayOfWeek === 0 || dayOfWeek === 6)) {
      continue;
    }
    if (automationForm.automationPreset === "weekly" && dayOfWeek !== 1) {
      continue;
    }
    return candidate;
  }
  return null;
}

function formatTaskBoardAutomationCountdown(issue: Pick<TaskBoardIssue, "automationEnabled" | "automationCron">, now: Date, t: TranslateFunction) {
  const nextTime = getNextTaskBoardAutomationTime(issue, now);
  if (!nextTime) {
    return "";
  }
  const totalMinutes = Math.max(1, Math.ceil((nextTime.getTime() - now.getTime()) / 60_000));
  if (totalMinutes < 60) {
    return t("taskBoard.countdown.minutes", { minutes: totalMinutes });
  }
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) {
    return t("taskBoard.countdown.hours", { hours: totalHours });
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours > 0) {
    return t("taskBoard.countdown.daysHours", { days, hours });
  }
  return t("taskBoard.countdown.days", { days });
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
    return DEFAULT_TASK_BOARD_AUTOMATION_TIME;
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

function buildAutomationCron(plan: TaskBoardAutomationPlan, time: string, customCron: string) {
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
  const automationCron = value?.trim() || DEFAULT_TASK_BOARD_AUTOMATION_CRON;
  const parts = automationCron.split(/\s+/u);
  if (parts.length !== 5) {
    return {
      automationPreset: "custom" as TaskBoardAutomationPlan,
      automationTime: DEFAULT_TASK_BOARD_AUTOMATION_TIME,
      automationCron
    };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!isFifteenMinuteCronMinute(minute)) {
    return {
      automationPreset: "custom" as TaskBoardAutomationPlan,
      automationTime: DEFAULT_TASK_BOARD_AUTOMATION_TIME,
      automationCron
    };
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return {
      automationPreset: "hourly" as TaskBoardAutomationPlan,
      automationTime: formatAutomationTime("0", minute),
      automationCron
    };
  }
  if (!isCronHour(hour) || dayOfMonth !== "*" || month !== "*") {
    return {
      automationPreset: "custom" as TaskBoardAutomationPlan,
      automationTime: DEFAULT_TASK_BOARD_AUTOMATION_TIME,
      automationCron
    };
  }
  if (dayOfWeek === "*") {
    return {
      automationPreset: "daily" as TaskBoardAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  if (dayOfWeek === "1-5") {
    return {
      automationPreset: "weekdays" as TaskBoardAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  if (dayOfWeek === "1") {
    return {
      automationPreset: "weekly" as TaskBoardAutomationPlan,
      automationTime: formatAutomationTime(hour, minute),
      automationCron
    };
  }
  return {
    automationPreset: "custom" as TaskBoardAutomationPlan,
    automationTime: DEFAULT_TASK_BOARD_AUTOMATION_TIME,
    automationCron
  };
}

function getAutomationPlanLabel(plan: TaskBoardAutomationPlan, t: TranslateFunction) {
  const labelKey = TASK_BOARD_AUTOMATION_PLANS.find((candidate) => candidate.value === plan)?.labelKey ?? "taskBoard.automation.custom";
  return t(labelKey);
}

function buildCompactTaskTitle(description: string) {
  const firstLine = description
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return Array.from(firstLine).slice(0, 24).join("");
}

function buildAssistantPrompt(issue: TaskBoardIssue, t: TranslateFunction) {
  const parts = [
    t("taskBoard.prompt.intro"),
    t("taskBoard.prompt.rule"),
    t("taskBoard.prompt.id", { value: issue.id }),
    t("taskBoard.prompt.title", { value: issue.title }),
    t("taskBoard.prompt.status", { value: t(STATUS_META[issue.status].labelKey) }),
    t("taskBoard.prompt.priority", { value: t(PRIORITY_META[issue.priority].labelKey) })
  ];
  if (issue.description.trim()) {
    parts.push(t("taskBoard.prompt.description", { value: issue.description.trim() }));
  }
  return parts.join("\n");
}

function computeDropPosition(targetIssues: TaskBoardIssue[], insertIndex: number) {
  const before = insertIndex > 0 ? targetIssues[insertIndex - 1] : null;
  const after = insertIndex < targetIssues.length ? targetIssues[insertIndex] : null;
  if (!before && !after) return 1;
  if (!before && after) return after.position - 1;
  if (before && !after) return before.position + 1;
  return (before!.position + after!.position) / 2;
}

function computeSortableDropPosition(
  issues: TaskBoardIssue[],
  activeId: string,
  overIssue: TaskBoardIssue | undefined,
  targetStatus: TaskBoardStatus
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

function createFormFromIssue(issue: TaskBoardIssue): IssueFormState {
  const automationForm = parseAutomationFormFromCron(issue.automationCron);
  return {
    title: issue.title,
    description: issue.description,
    attachmentChatId: issue.attachmentChatId ?? issue.chatId ?? createTaskBoardAttachmentChatId(issue.id),
    attachments: issue.attachments ?? [],
    status: issue.status,
    priority: issue.priority,
    assigneeAgentKey: issue.assigneeAgentKey ?? "",
    automationEnabled: issue.automationEnabled,
    automationPreset: automationForm.automationPreset,
    automationTime: automationForm.automationTime,
    automationCron: automationForm.automationCron,
    automationMessage: issue.automationMessage ?? "",
    automationTimezone: issue.automationTimezone ?? "Asia/Shanghai"
  };
}

function createTaskBoardAttachmentChatId(seed: string) {
  const safeSeed = seed.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return `task-board-${safeSeed}`;
}

function createTaskBoardDraftAttachmentChatId() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `task-board-draft-${Date.now().toString(36)}-${randomPart}`;
}

function getVisibleTaskBoardAttachments(attachments: AssistantAttachment[] | null | undefined) {
  return (attachments ?? []).filter((attachment) => !attachment.hidden);
}

function formatTaskBoardAttachmentSize(sizeBytes: number) {
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

function mergeTaskBoardIssueAttachmentDraft(
  issue: TaskBoardIssue | undefined,
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

function mergeTaskBoardIssuesAttachmentDraft(
  issues: TaskBoardIssue[],
  savedIssue: TaskBoardIssue | undefined
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

function getAssigneeAgent(issue: TaskBoardIssue, agents: AssistantNavAgentItem[]) {
  const agentKey = issue.assigneeAgentKey?.trim();
  return agentKey ? agents.find((agent) => agent.agentKey === agentKey) : undefined;
}

function getVisibleAssigneeName(issue: TaskBoardIssue, agents: AssistantNavAgentItem[]) {
  const trimmed = getAssigneeName(issue.assigneeAgentKey ?? "", agents)?.trim() ?? "";
  return trimmed;
}

function truncateTaskBoardAssigneeName(name: string) {
  return Array.from(name.trim()).slice(0, 4).join("");
}

function getIssueCardAssigneeAvatarLabel(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "";
}

function isFiveFieldCron(value: string) {
  return value.trim().split(/\s+/u).length === 5;
}

function hasIssueAutomation(issue: Pick<TaskBoardIssue, "automationEnabled" | "automationCron">) {
  return issue.automationEnabled && Boolean(issue.automationCron?.trim());
}

function shouldShowIssueForTodoAutomationFilter(
  issue: Pick<TaskBoardIssue, "status" | "automationEnabled" | "automationCron">,
  filter: TaskBoardTodoAutomationFilter
) {
  if (issue.status !== "todo" || filter === "all") {
    return true;
  }
  const automated = hasIssueAutomation(issue);
  return filter === "scheduled" ? automated : !automated;
}

function getAutomationDisplayLabel(issue: TaskBoardIssue, t: TranslateFunction) {
  if (!hasIssueAutomation(issue)) {
    return "";
  }
  const automationForm = parseAutomationFormFromCron(issue.automationCron);
  if (automationForm.automationPreset === "custom") {
    return issue.automationCron;
  }
  if (automationForm.automationPreset === "hourly") {
    const minute = Number(automationForm.automationTime.split(":")[1]);
    return t("taskBoard.automation.hourlyAtMinute", { minute: padAutomationNumber(minute) });
  }
  return `${getAutomationPlanLabel(automationForm.automationPreset, t)} ${automationForm.automationTime}`;
}

function getIssueCardAssigneeLabel(
  visibleAssigneeName: string,
  displayAssignee: boolean,
  t: TranslateFunction
) {
  if (!displayAssignee) {
    return "";
  }
  if (!visibleAssigneeName) {
    return t("taskBoard.form.unassigned");
  }
  return truncateTaskBoardAssigneeName(visibleAssigneeName);
}

function getIssueCardPresentation(
  options: {
    displayAssignee: boolean;
    visibleAssigneeName: string;
  },
  t: TranslateFunction
): TaskBoardCardPresentation {
  const assigneeLabel = getIssueCardAssigneeLabel(options.visibleAssigneeName, options.displayAssignee, t);
  return {
    assigneeLabel,
    assigneeTitle: options.visibleAssigneeName || assigneeLabel
  };
}

function getIssueCardStatusPresentation(
  issue: TaskBoardIssue,
  options: {
    awaitingConfirmation: boolean;
    now: Date;
    sortIndex?: number;
  },
  t: TranslateFunction
): TaskBoardCardStatusPresentation {
  if (issue.runState === "cancelled") {
    return { label: t("taskBoard.run.cancelled"), tone: "cancelled", updatedTime: "" };
  }
  if (issue.runState === "failed") {
    return { label: t("taskBoard.run.failed"), tone: "failed", updatedTime: "" };
  }
  if (issue.runState === "completed" || issue.status === "completed") {
    return { label: t("taskBoard.run.succeeded"), tone: "succeeded", updatedTime: "" };
  }
  if (options.awaitingConfirmation && issue.status === "in_progress") {
    return { label: t("taskBoard.run.awaitingApproval"), tone: "awaiting", updatedTime: "" };
  }
  if (issue.runState === "running" || (issue.status === "in_progress" && Boolean(issue.runId))) {
    return { label: t("taskBoard.run.running"), tone: "running", updatedTime: "" };
  }
  if (issue.status === "backlog") {
    return {
      label: formatIssueUpdatedTime(issue.updatedAt),
      tone: "backlog",
      updatedTime: ""
    };
  }
  if (issue.status === "todo") {
    const automationCountdown = hasIssueAutomation(issue)
      ? formatTaskBoardAutomationCountdown(issue, options.now, t) || getAutomationDisplayLabel(issue, t)
      : "";
    return {
      label: automationCountdown || formatTaskBoardSortNumber(options.sortIndex, issue.position),
      tone: "todo",
      updatedTime: ""
    };
  }
  return {
    label: t(STATUS_META[issue.status].labelKey),
    tone: issue.status,
    updatedTime: ""
  };
}

function getTaskBoardColumnSummary(status: TaskBoardStatus, count: number, t: TranslateFunction) {
  const detailKey: Record<TaskBoardStatus, TranslationKey> = {
    backlog: "taskBoard.column.summary.backlog",
    todo: "taskBoard.column.summary.todo",
    in_progress: "taskBoard.column.summary.inProgress",
    completed: "taskBoard.column.summary.completed"
  };
  return {
    count: t("taskBoard.column.summary.count", { count }),
    detail: t(detailKey[status])
  };
}

function getTaskBoardEmptyHint(status: TaskBoardStatus, t: TranslateFunction) {
  if (status === "in_progress") {
    return t("taskBoard.column.emptyInProgress");
  }
  return t("taskBoard.column.emptyDefault");
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
    updatedAt: "",
    recentChats: []
  };
}

function hasTaskBoardAgentIcon(icon: AssistantNavAgentItem["icon"] | null | undefined) {
  if (typeof icon === "string") {
    return icon.trim().length > 0;
  }
  if (icon && typeof icon === "object") {
    return Boolean(icon.name?.trim() || icon.color?.trim());
  }
  return false;
}

function mergeTaskBoardAgentIcons(currentAgents: AssistantNavAgentItem[], nextAgents: AssistantNavAgentItem[]) {
  const previousIcons = new Map(
    currentAgents
      .filter((agent) => hasTaskBoardAgentIcon(agent.icon))
      .map((agent) => [agent.agentKey, agent.icon] as const)
  );
  return nextAgents.map((agent) => {
    const previousIcon = previousIcons.get(agent.agentKey);
    return previousIcon ? { ...agent, icon: previousIcon } : agent;
  });
}

async function hydrateTaskBoardAgentIcons(items: AssistantNavAgentItem[]) {
  if (!items.some((agent) => !hasTaskBoardAgentIcon(agent.icon))) {
    return items;
  }
  const agentOptions = await window.electronAPI.assistant.listAgents();
  const fallbackItems = agentOptions.map(createNavigationAgentFromOption);
  return mergeTaskBoardAgentIcons(fallbackItems, items);
}

async function loadTaskBoardAgents(): Promise<AssistantNavAgentItem[]> {
  const navigationResult = await window.electronAPI.assistant.listNavigationAgents();
  if (navigationResult.ok && navigationResult.items.length > 0) {
    const navigationItems = normalizeAssistantNavAgents(navigationResult.items);
    return await hydrateTaskBoardAgentIcons(navigationItems);
  }
  const agentOptions = await window.electronAPI.assistant.listAgents();
  return agentOptions.map(createNavigationAgentFromOption);
}

function isCancelledAssistantTaskEvent(event: AssistantEvent) {
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

function resolveAssistantTaskStatus(event: AssistantEvent, t: TranslateFunction): {
  status: TaskBoardStatus | null;
  runState: TaskBoardIssue["runState"];
  tone: Feedback["tone"];
  message: string;
} | null {
  if (event.type === "done" || event.type === "run.complete") {
    return {
      status: "completed",
      runState: "completed",
      tone: "success",
      message: t("taskBoard.feedback.agentDone")
    };
  }
  if (isCancelledAssistantTaskEvent(event)) {
    return {
      status: null,
      runState: "cancelled",
      tone: "error",
      message: t("taskBoard.feedback.agentCancelled")
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
      message: t("taskBoard.feedback.agentIncomplete")
    };
  }
  return null;
}

function readTaskBoardApi(): DesktopApi["taskBoard"] | null {
  if (typeof window === "undefined") {
    return null;
  }
  const api = (window.electronAPI as Partial<DesktopApi> | undefined)?.taskBoard;
  return api && typeof api.listIssues === "function" ? api : null;
}

function isIssueDragLocked(issue: TaskBoardIssue | null | undefined) {
  return Boolean(issue?.runId);
}

function canCreateIssueFromColumnDoubleClick(status: TaskBoardStatus) {
  return status === "backlog" || status === "todo";
}

function shouldCreateIssueFromColumnDoubleClick(event: MouseEvent<HTMLElement>, status: TaskBoardStatus) {
  if (!canCreateIssueFromColumnDoubleClick(status)) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return event.currentTarget === target;
  }
  return !target.closest(".task-board-card");
}

function isIssueChatViewable(issue: TaskBoardIssue) {
  return Boolean(issue.chatId && (
    issue.status === "in_progress" ||
    issue.status === "completed"
  ));
}

function getIssueChatActionLabel(issue: TaskBoardIssue, t: TranslateFunction) {
  if (!isIssueChatViewable(issue)) {
    return null;
  }
  return issue.status === "in_progress" ? t("taskBoard.chat.viewOrConfirm") : t("taskBoard.chat.view");
}

function issueHasPendingAwaiting(issue: TaskBoardIssue, agents: AssistantNavAgentItem[]) {
  const chatId = issue.chatId?.trim();
  if (issue.status !== "in_progress" || !chatId) {
    return false;
  }

  return agents.some((agent) => {
    const matchingChat = getAssistantNavAgentRecentChats(agent).find((chat) => chat.chatId === chatId);
    return matchingChat?.hasPendingAwaiting === true;
  });
}

function resolveIssueAgentKey(issue: TaskBoardIssue, agents: AssistantNavAgentItem[]) {
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

function buildTaskBoardChatEmbedPath(request: TaskBoardChatModalRequest) {
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
    return `/agent/${encodeURIComponent(agentKey)}`;
  }

  const params = new URLSearchParams();
  params.set("chatId", chatId);
  return `/agent/${encodeURIComponent(agentKey)}?${params.toString()}`;
}

export function TaskBoardPage({ hostTheme }: TaskBoardPageProps) {
  const { t } = useI18n();
  const [issues, setIssues] = useState<TaskBoardIssue[]>([]);
  const [agents, setAgents] = useState<AssistantNavAgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setBusyIssueId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [query, setQuery] = useState("");
  const [priorityFilters, setPriorityFilters] = useState<TaskBoardPriority[]>([]);
  const [todoAutomationFilter, setTodoAutomationFilter] = useState<TaskBoardTodoAutomationFilter>("all");
  const [taskBoardCountdownNow, setTaskBoardCountdownNow] = useState(() => Date.now());
  const [display, setDisplay] = useState<DisplayState>(defaultDisplayState);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [chatModalRequest, setChatModalRequest] = useState<TaskBoardChatModalRequest | null>(null);
  const [form, setForm] = useState<IssueFormState>(emptyForm);
  const [formCompact, setFormCompact] = useState(true);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [automationMenuOpen, setAutomationMenuOpen] = useState<AutomationMenuKind | null>(null);
  const [activeDragIssueId, setActiveDragIssueId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TaskBoardContextMenu | null>(null);
  const [backlogExpanded, setBacklogExpanded] = useState(false);
  const issuesRef = useRef<TaskBoardIssue[]>([]);
  const selectedAutomationTimeRef = useRef<HTMLButtonElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const taskBoardReady = readTaskBoardApi() !== null;
  const missingTaskBoardApiMessage = t("taskBoard.missingApi", { appName: t("app.name") });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const taskBoardApi = readTaskBoardApi();
      if (!taskBoardApi) {
        if (!cancelled) {
          setIssues([]);
          setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
          setLoading(false);
        }
        return;
      }
      try {
        const [issueResult, agentResult] = await Promise.all([
          taskBoardApi.listIssues(),
          loadTaskBoardAgents()
        ]);
        if (cancelled) return;
        setIssues(sortIssues(issueResult.issues));
        setAgents(agentResult);
      } catch (error) {
        if (!cancelled) {
          setFeedback({
            tone: "error",
            message: error instanceof Error ? error.message : t("taskBoard.feedback.loadFailed")
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
  }, [missingTaskBoardApiMessage, t]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.assistant.onNavigationAgentsChanged((result) => {
      if (result.ok) {
        setAgents((currentAgents) => mergeTaskBoardAgentIcons(currentAgents, normalizeAssistantNavAgents(result.items)));
        return;
      }
      void loadTaskBoardAgents().then((items) => {
        if (items.length > 0) {
          setAgents((currentAgents) => mergeTaskBoardAgentIcons(currentAgents, items));
        }
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTaskBoardCountdownNow(Date.now());
    }, TASK_BOARD_COUNTDOWN_REFRESH_MS);
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
    }, TASK_BOARD_FEEDBACK_AUTO_CLOSE_MS);

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
      const nextTaskStatus = resolveAssistantTaskStatus(event, t);
      if (!nextTaskStatus) {
        return;
      }
      const issue = issuesRef.current.find((candidate) => candidate.runId === event.runId);
      if (!issue) {
        return;
      }
      const taskBoardApi = readTaskBoardApi();
      if (!taskBoardApi) {
        return;
      }
      try {
        const issueUpdate: TaskBoardIssueUpdateInput = {
          chatId: event.chatId || issue.chatId,
          runId: null,
          runState: nextTaskStatus.runState
        };
        if (nextTaskStatus.status) {
          issueUpdate.status = nextTaskStatus.status;
        }
        const result = await taskBoardApi.updateIssue(issue.id, issueUpdate);
        setIssues(sortIssues(result.issues));
        setFeedback({ tone: nextTaskStatus.tone, message: nextTaskStatus.message });
      } catch (error) {
        setFeedback({
          tone: "error",
          message: error instanceof Error ? error.message : t("taskBoard.feedback.statusWritebackFailed")
        });
      }
    });

    return removeAssistantEventListener;
  }, [t]);

  const visibleIssues = useMemo(
    () => issues.filter((issue) => VISIBLE_TASK_BOARD_STATUS_SET.has(issue.status)),
    [issues]
  );

  const filteredIssues = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return sortIssues(visibleIssues).filter((issue) => {
      if (priorityFilters.length > 0 && !priorityFilters.includes(issue.priority)) {
        return false;
      }
      if (!shouldShowIssueForTodoAutomationFilter(issue, todoAutomationFilter)) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = [
        issue.id,
        issue.title,
        issue.description,
        issue.assigneeAgentKey ?? "",
        getAssigneeName(issue.assigneeAgentKey ?? "", agents) ?? "",
        ...getVisibleTaskBoardAttachments(issue.attachments).map((attachment) => attachment.name)
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [agents, priorityFilters, query, todoAutomationFilter, visibleIssues]);

  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const filteredCount = filteredIssues.length;
  const totalCount = visibleIssues.length;
  const activeDragIssue = activeDragIssueId ? issueMap.get(activeDragIssueId) ?? null : null;

  function openCreateModal(status: TaskBoardStatus = "backlog") {
    if (!readTaskBoardApi()) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    setForm({ ...emptyForm, status, attachmentChatId: createTaskBoardDraftAttachmentChatId() });
    setFormCompact(true);
    setAttachmentBusy(false);
    setAutomationMenuOpen(null);
    setModal({ mode: "create" });
  }

  function openEditModal(issue: TaskBoardIssue) {
    setContextMenu(null);
    setForm(createFormFromIssue(issue));
    setFormCompact(!hasIssueAutomation(issue));
    setAttachmentBusy(false);
    setAutomationMenuOpen(null);
    setModal({ mode: "edit", issue });
  }

  function openInProgressAssignmentModal(issue: TaskBoardIssue) {
    setForm({
      ...createFormFromIssue(issue),
      status: "in_progress"
    });
    setFormCompact(true);
    setAttachmentBusy(false);
    setAutomationMenuOpen(null);
    setModal({ mode: "edit", issue });
    setFeedback({ tone: "error", message: t("taskBoard.feedback.assigneeRequiredForProgress") });
  }

  function toggleFormCompactMode() {
    if (formCompact) {
      setForm((current) => {
        if (current.title.trim()) {
          return current;
        }
        return {
          ...current,
          title: buildCompactTaskTitle(current.description)
        };
      });
    }
    setAutomationMenuOpen(null);
    setFormCompact((current) => !current);
  }

  function toggleAutomationMenu(menuName: AutomationMenuKind) {
    setAutomationMenuOpen((current) => current === menuName ? null : menuName);
  }

  function updateAutomationPlan(plan: TaskBoardAutomationPlan) {
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

  async function addTaskBoardAttachments() {
    if (attachmentBusy) {
      return;
    }
    const fallbackChatId = modal?.issue
      ? createTaskBoardAttachmentChatId(modal.issue.id)
      : createTaskBoardDraftAttachmentChatId();
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
        message: error instanceof Error ? error.message : t("taskBoard.feedback.attachmentUploadFailed")
      });
    } finally {
      setAttachmentBusy(false);
    }
  }

  function removeTaskBoardAttachment(attachmentId: string) {
    setForm((current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) =>
        attachment.id !== attachmentId && attachment.sourceAttachmentId !== attachmentId
      )
    }));
  }

  async function openTaskBoardAttachment(attachment: AssistantAttachment) {
    const chatId = form.attachmentChatId.trim();
    if (!chatId) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.attachmentLocationMissing") });
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(chatId, attachment.id);
    setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    const title = formCompact && modal?.mode === "create"
      ? buildCompactTaskTitle(form.description)
      : form.title.trim();
    if (!title) {
      setFeedback({ tone: "error", message: formCompact ? t("taskBoard.feedback.descriptionRequired") : t("taskBoard.feedback.titleRequired") });
      return;
    }
    const resolvedAutomationCron = buildAutomationCron(form.automationPreset, form.automationTime, form.automationCron);
    const resolvedAutomationMessage = form.automationMessage.trim() || form.description.trim() || title;
    const shouldRunAfterSave = form.status === "in_progress" && !form.automationEnabled && !modal?.issue?.runId;
    const shouldRunTodoAssigneeAfterDelay = form.status === "todo" && !form.automationEnabled && Boolean(form.assigneeAgentKey) && !modal?.issue?.runId;
    if (shouldRunAfterSave && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.assigneeRequiredForProgress") });
      return;
    }
    if (form.automationEnabled && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.assigneeRequiredForAutomation") });
      return;
    }
    if (form.automationEnabled && !isFiveFieldCron(resolvedAutomationCron)) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.invalidCron") });
      return;
    }
    if (form.automationEnabled && !resolvedAutomationMessage) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.automationMessageRequired") });
      return;
    }
    const savedStatus = shouldRunAfterSave ? modal?.issue?.status ?? "todo" : form.status;
    const payload: TaskBoardIssueInput | TaskBoardIssueUpdateInput = {
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
      attachments: form.attachments
    };

    try {
      const result = modal?.mode === "edit" && modal.issue
        ? await taskBoardApi.updateIssue(modal.issue.id, payload)
        : await taskBoardApi.createIssue(payload as TaskBoardIssueInput);
      let savedIssue = mergeTaskBoardIssueAttachmentDraft(
        result.issue,
        form.attachmentChatId,
        form.attachments
      );
      let nextIssues = mergeTaskBoardIssuesAttachmentDraft(result.issues, savedIssue);
      let nextMessage = result.message;
      let nextTone: Feedback["tone"] = result.ok ? "success" : "error";
      if (result.ok && savedIssue && (form.automationEnabled || savedIssue.automationId)) {
        const automationResult = await taskBoardApi.syncIssueAutomation(savedIssue.id);
        savedIssue = mergeTaskBoardIssueAttachmentDraft(
          automationResult.issue ?? savedIssue,
          form.attachmentChatId,
          form.attachments
        );
        nextIssues = mergeTaskBoardIssuesAttachmentDraft(automationResult.issues, savedIssue);
        nextTone = automationResult.ok ? "success" : "error";
        nextMessage = automationResult.ok ? t("taskBoard.feedback.taskAndAutomationSaved") : automationResult.message;
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
          }, TASK_BOARD_TODO_ASSIGNEE_START_DELAY_MS);
        }
      }
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("taskBoard.feedback.saveFailed")
      });
    }
  }

  async function deleteIssue(issue: TaskBoardIssue) {
    setContextMenu(null);
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    if (!window.confirm(t("taskBoard.confirm.delete", { title: issue.title }))) {
      return;
    }
    const result = await taskBoardApi.deleteIssue(issue.id);
    setIssues(sortIssues(result.issues));
    setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    if (result.ok) {
      setModal(null);
    }
  }

  function openIssueContextMenu(issue: TaskBoardIssue, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const viewportWidth = typeof window === "undefined" ? event.clientX : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? event.clientY : window.innerHeight;
    setContextMenu({
      issueId: issue.id,
      x: Math.min(event.clientX, Math.max(8, viewportWidth - 176)),
      y: Math.min(event.clientY, Math.max(8, viewportHeight - 48))
    });
  }

  async function getAvailableAgents() {
    if (agents.length > 0) {
      return agents;
    }
    const nextAgents = await loadTaskBoardAgents();
    if (nextAgents.length > 0) {
      setAgents((currentAgents) => mergeTaskBoardAgentIcons(currentAgents, nextAgents));
    }
    return nextAgents;
  }

  async function assignIssueToAssistant(issue: TaskBoardIssue, selectedAgentKey?: string) {
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    const availableAgents = await getAvailableAgents();
    const agentKey = selectedAgentKey ?? issue.assigneeAgentKey ?? availableAgents[0]?.agentKey ?? "";
    if (!agentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.noAgents") });
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
        setFeedback({ tone: "error", message: runResult.message || t("taskBoard.feedback.assistantStartFailed") });
        return;
      }
      const updateResult = await taskBoardApi.updateIssue(issue.id, {
        status: "in_progress",
        assigneeAgentKey: agentKey,
        chatId: runResult.chatId,
        runId: runResult.runId,
        runState: "running"
      });
      setIssues(sortIssues(updateResult.issues));
      setFeedback({ tone: "success", message: t("taskBoard.feedback.assignedToAssistant") });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : t("taskBoard.feedback.assistantStartFailed")
      });
    } finally {
      setBusyIssueId(null);
    }
  }

  async function openAssistantIssueChat(issue: TaskBoardIssue) {
    const chatId = issue.chatId?.trim() ?? "";
    if (!chatId) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.noChat") });
      return;
    }
    const agentKey = resolveIssueAgentKey(issue, agents);
    if (!agentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.noBoundAgent") });
      return;
    }
    setChatModalRequest({
      agentKey,
      chatId,
      displayName: getAssigneeName(agentKey, agents) ?? undefined
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const activeIssue = issueMap.get(String(event.active.id));
    if (isIssueDragLocked(activeIssue)) {
      setActiveDragIssueId(null);
      setFeedback({ tone: "error", message: t("taskBoard.feedback.dragLocked") });
      return;
    }
    setActiveDragIssueId(String(event.active.id));
  }

  function clearActiveDrag() {
    setActiveDragIssueId(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    clearActiveDrag();
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
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
      setFeedback({ tone: "error", message: t("taskBoard.feedback.dragLocked") });
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
    const result = await taskBoardApi.moveIssue({
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
        }, TASK_BOARD_TODO_ASSIGNEE_START_DELAY_MS);
      }
    } else {
      setIssues(previousIssues);
      setFeedback({ tone: "error", message: result.message });
    }
  }

  function togglePriority(priority: TaskBoardPriority) {
    setPriorityFilters((current) =>
      current.includes(priority)
        ? current.filter((item) => item !== priority)
        : [...current, priority]
    );
  }

  const modalStatusLocked = modal?.mode === "edit" && Boolean(modal.issue?.runId);
  const visibleFormAttachments = getVisibleTaskBoardAttachments(form.attachments);

  return (
    <section className="task-board-page" aria-label={t("taskBoard.title")}>
      <div className="task-board-toolbar">
        <div className="task-board-toolbar-left">
          <div className="task-board-search-wrap">
            <TaskBoardIcon kind="search" />
            <input
              className="task-board-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("taskBoard.search.placeholder")}
              aria-label={t("taskBoard.search.ariaLabel")}
            />
          </div>
          <button
            type="button"
            className={`task-board-tool is-icon-only ${menu === "filter" ? "is-active" : ""}`}
            aria-label={t("taskBoard.toolbar.filter")}
            title={t("taskBoard.toolbar.filter")}
            onClick={() => setMenu(menu === "filter" ? null : "filter")}
          >
            <TaskBoardIcon kind="filter" />
            <span className="task-board-tool-label">{t("taskBoard.toolbar.filter")}</span>
          </button>
        </div>
        <div className="task-board-toolbar-right">
          <span className="task-board-count">{t("taskBoard.toolbar.issueCount", { filtered: filteredCount, total: totalCount })}</span>
          <button
            type="button"
            className={`task-board-tool is-icon-only ${menu === "display" ? "is-active" : ""}`}
            aria-label={t("taskBoard.toolbar.display")}
            title={t("taskBoard.toolbar.display")}
            onClick={() => setMenu(menu === "display" ? null : "display")}
          >
            <TaskBoardIcon kind="display" />
            <span className="task-board-tool-label">{t("taskBoard.toolbar.display")}</span>
          </button>
        </div>
      </div>

      {menu ? (
        <div className={`task-board-menu-panel is-${menu}`}>
          {menu === "filter" ? (
            <>
              <strong>{t("taskBoard.filter.priority")}</strong>
              <div className="task-board-menu-grid">
                {TASK_BOARD_PRIORITIES.map((priority) => (
                  <label key={priority} className="task-board-check-row">
                    <input
                      type="checkbox"
                      checked={priorityFilters.includes(priority)}
                      onChange={() => togglePriority(priority)}
                    />
                    <PriorityBadge priority={priority} t={t} />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <strong>{t("taskBoard.display.cardFields")}</strong>
              {Object.entries({
                description: t("taskBoard.display.description"),
                assignee: t("taskBoard.display.assignee"),
                priority: t("taskBoard.display.priority")
              } satisfies Record<keyof DisplayState, string>).map(([key, label]) => (
                <label key={key} className="task-board-check-row">
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
          )}
        </div>
      ) : null}

      {feedback ? (
        <div className={`task-board-feedback is-${feedback.tone}`}>
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label={t("taskBoard.notice.close")}>×</button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={detectTaskBoardCollisions}
        onDragStart={handleDragStart}
        onDragCancel={clearActiveDrag}
        onDragEnd={handleDragEnd}
      >
        <div
          className={`task-board-columns ${backlogExpanded ? "is-backlog-expanded" : ""}`}
          aria-busy={loading}
          onClick={() => setBacklogExpanded(false)}
        >
          {VISIBLE_TASK_BOARD_STATUSES.map((status) => {
            const columnIssues = filteredIssues.filter((issue) => issue.status === status);
            return (
              <TaskBoardColumn
                key={status}
                status={status}
                issues={columnIssues}
                agents={agents}
                display={display}
                todoAutomationFilter={todoAutomationFilter}
                now={new Date(taskBoardCountdownNow)}
                t={t}
                canAdd={taskBoardReady}
                onAdd={() => openCreateModal(status)}
                onSelectColumn={() => setBacklogExpanded(status === "backlog")}
                onTodoAutomationFilterChange={setTodoAutomationFilter}
                onEdit={openEditModal}
                onOpenChat={openAssistantIssueChat}
                onOpenContextMenu={openIssueContextMenu}
              />
            );
          })}
        </div>

        {typeof document !== "undefined" ? createPortal(
          <DragOverlay adjustScale={false} dropAnimation={null} zIndex={120}>
            {activeDragIssue ? (
              <article className={`task-board-card task-board-drag-overlay-card is-${activeDragIssue.status}`}>
                <TaskBoardCardContent
                  issue={activeDragIssue}
                  awaitingConfirmation={false}
                  agents={agents}
                  display={display}
                  t={t}
                  interactive={false}
                  onEdit={() => undefined}
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
        if (!issue) {
          return null;
        }
        return (
          <div
            className="task-board-card-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="task-board-card-context-danger"
              onClick={() => void deleteIssue(issue)}
            >
              {t("taskBoard.context.delete")}
            </button>
          </div>
        );
      })() : null}

      {modal ? (
        <div className="task-board-modal-layer" role="presentation" onMouseDown={() => setModal(null)}>
          <form
            className={`task-board-modal ${formCompact ? "is-compact" : "is-advanced"}`}
            onSubmit={submitForm}
            onMouseDown={(event) => event.stopPropagation()}
            noValidate
          >
            <div className="task-board-modal-head">
              <strong>{modal.mode === "edit" ? t("taskBoard.modal.editTitle") : t("taskBoard.modal.createTitle")}</strong>
              <div className="task-board-modal-head-actions">
                <button
                  type="button"
                  className="task-board-modal-mode-button"
                  onClick={toggleFormCompactMode}
                >
                  {formCompact ? t("taskBoard.modal.advancedMode") : t("taskBoard.modal.compactMode")}
                </button>
                <button type="button" className="task-board-modal-close-button" onClick={() => setModal(null)} aria-label={t("taskBoard.modal.close")}>×</button>
              </div>
            </div>
            {!formCompact ? (
              <label className="task-board-field">
                <span>{t("taskBoard.form.title")}</span>
                <input
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  autoFocus={!formCompact}
                  required
                />
              </label>
            ) : null}
            <div className="task-board-field">
              <div className="task-board-field-head">
                <span>{t("taskBoard.form.description")}</span>
                <button
                  type="button"
                  className="task-board-attachment-add-button"
                  onClick={() => void addTaskBoardAttachments()}
                  disabled={attachmentBusy}
                >
                  {attachmentBusy ? t("taskBoard.form.uploading") : t("taskBoard.form.addAttachment")}
                </button>
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
              />
              {visibleFormAttachments.length > 0 ? (
                <div className="task-board-attachment-list" aria-label={t("taskBoard.form.attachments")}>
                  {visibleFormAttachments.map((attachment) => {
                    const sizeLabel = formatTaskBoardAttachmentSize(attachment.sizeBytes);
                    return (
                      <div key={attachment.id} className="task-board-attachment-chip">
                        <button
                          type="button"
                          className="task-board-attachment-open"
                          onClick={() => void openTaskBoardAttachment(attachment)}
                          title={sizeLabel ? `${attachment.name} · ${sizeLabel}` : attachment.name}
                        >
                          <span className="task-board-attachment-icon" aria-hidden="true">⌘</span>
                          <span className="task-board-attachment-name">{attachment.name}</span>
                          {sizeLabel ? <span className="task-board-attachment-size">{sizeLabel}</span> : null}
                        </button>
                        <button
                          type="button"
                          className="task-board-attachment-remove"
                          onClick={() => removeTaskBoardAttachment(attachment.id)}
                          aria-label={t("taskBoard.form.removeAttachment", { name: attachment.name })}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {!formCompact ? (
              <div className="task-board-field-grid">
                <label className="task-board-field">
                  <span>{t("taskBoard.form.status")}</span>
                  <select
                    value={form.status}
                    disabled={modalStatusLocked}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      status: event.target.value as TaskBoardStatus
                    }))}
                  >
                    {TASK_BOARD_STATUSES.map((status) => (
                      <option key={status} value={status}>{t(STATUS_META[status].labelKey)}</option>
                    ))}
                  </select>
                </label>
                <label className="task-board-field">
                  <span>{t("taskBoard.form.priority")}</span>
                  <select
                    value={form.priority}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      priority: event.target.value as TaskBoardPriority
                    }))}
                  >
                    {TASK_BOARD_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>{t(PRIORITY_META[priority].labelKey)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            <label className="task-board-field">
              <span>{t("taskBoard.form.assignee")}</span>
              <select
                value={form.assigneeAgentKey}
                onChange={(event) => {
                  const assigneeAgentKey = event.target.value;
                  setForm((current) => ({
                    ...current,
                    assigneeAgentKey
                  }));
                }}
              >
                <option value="">{t("taskBoard.form.unassigned")}</option>
                {agents.map((agent) => (
                  <option key={agent.agentKey} value={agent.agentKey}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
            {!formCompact ? (
              <section className="task-board-automation-panel" aria-label={t("taskBoard.form.automationPanel")}>
                <label className="task-board-check-row task-board-automation-toggle">
                  <input
                    type="checkbox"
                    checked={form.automationEnabled}
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
                  <span>{t("taskBoard.form.automationEnabled")}</span>
                </label>
                {form.automationEnabled ? (
                  <div className="task-board-automation-popover">
                    <span className="task-board-automation-panel-title">{t("taskBoard.form.automationPlan")}</span>
                    <div className="task-board-field task-board-automation-select-field">
                      <span>{t("taskBoard.form.automationFrequency")}</span>
                      <div className={`task-board-automation-menu ${automationMenuOpen === "plan" ? "is-open" : ""}`}>
                        <button
                          type="button"
                          className="task-board-automation-menu-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={automationMenuOpen === "plan"}
                          onClick={() => toggleAutomationMenu("plan")}
                        >
                          <span>{getAutomationPlanLabel(form.automationPreset, t)}</span>
                          <span className="task-board-automation-menu-arrow" aria-hidden="true">⌄</span>
                        </button>
                        {automationMenuOpen === "plan" ? (
                          <div className="task-board-automation-menu-list" role="listbox" aria-label={t("taskBoard.form.automationFrequencyList")}>
                            {TASK_BOARD_AUTOMATION_PLANS.map((plan) => (
                              <button
                                key={plan.value}
                                type="button"
                                className={plan.value === form.automationPreset ? "is-selected" : ""}
                                role="option"
                                aria-selected={plan.value === form.automationPreset}
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
                      <label className="task-board-field">
                        <span>{t("taskBoard.form.cron")}</span>
                        <input
                          value={form.automationCron}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            automationCron: event.target.value
                          }))}
                          placeholder="0 9 * * *"
                        />
                      </label>
                    ) : (
                      <div className="task-board-automation-time-control">
                        <div className="task-board-field task-board-automation-select-field">
                          <span>{t("taskBoard.form.automationTime")}</span>
                          <div className={`task-board-automation-menu ${automationMenuOpen === "time" ? "is-open" : ""}`}>
                            <button
                              type="button"
                              className="task-board-automation-menu-trigger"
                              aria-haspopup="listbox"
                              aria-expanded={automationMenuOpen === "time"}
                              onClick={() => toggleAutomationMenu("time")}
                            >
                              <span>{form.automationTime}</span>
                              <span className="task-board-automation-menu-arrow" aria-hidden="true">⌄</span>
                            </button>
                            {automationMenuOpen === "time" ? (
                              <div className="task-board-automation-menu-list is-time-list" role="listbox" aria-label={t("taskBoard.form.automationTimeList")}>
                                {TASK_BOARD_AUTOMATION_TIME_OPTIONS.map((time) => (
                                  <button
                                    key={time}
                                    ref={time === form.automationTime ? selectedAutomationTimeRef : null}
                                    type="button"
                                    className={time === form.automationTime ? "is-selected" : ""}
                                    role="option"
                                    aria-selected={time === form.automationTime}
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
            <div className="task-board-modal-actions">
              {modal.mode === "edit" && modal.issue ? (
                <button
                  type="button"
                  className="task-board-danger-button"
                  onClick={() => void deleteIssue(modal.issue!)}
                >
                  {t("taskBoard.form.delete")}
                </button>
              ) : null}
              <button type="button" className="task-board-secondary-button" onClick={() => setModal(null)}>
                {t("taskBoard.form.cancel")}
              </button>
              <button type="submit" className="task-board-primary-button" disabled={!taskBoardReady}>
                {t("taskBoard.form.save")}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {chatModalRequest ? (
        <div className="task-board-modal-layer task-board-chat-modal-layer" role="presentation" onMouseDown={() => setChatModalRequest(null)}>
          <section
            className="task-board-chat-modal"
            role="dialog"
            aria-modal="true"
            aria-label={chatModalRequest.displayName ? t("taskBoard.chat.modalLabel", { name: chatModalRequest.displayName }) : t("taskBoard.chat.defaultModalLabel")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <PluginPage
              key={`task-board-chat:${chatModalRequest.agentKey}:${chatModalRequest.chatId}`}
              active
              hostTheme={hostTheme}
              pluginId="agent-webclient"
              surfaceLabel={t("taskBoard.chat.surfaceLabel")}
              embedPath={buildTaskBoardChatEmbedPath(chatModalRequest)}
              skipContextRegistration
              loadInitialEmbeddedUrlDirectly
              suppressInitialLoadingCopy
            />
            <button
              type="button"
              className="task-board-chat-modal-close"
              aria-label={t("taskBoard.chat.close")}
              title={t("taskBoard.modal.close")}
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

function TaskBoardColumn({
  status,
  issues,
  agents,
  display,
  todoAutomationFilter,
  now,
  t,
  canAdd,
  onAdd,
  onSelectColumn,
  onTodoAutomationFilterChange,
  onEdit,
  onOpenChat,
  onOpenContextMenu
}: {
  status: TaskBoardStatus;
  issues: TaskBoardIssue[];
  agents: AssistantNavAgentItem[];
  display: DisplayState;
  todoAutomationFilter: TaskBoardTodoAutomationFilter;
  now: Date;
  t: TranslateFunction;
  canAdd: boolean;
  onAdd: () => void;
  onSelectColumn: () => void;
  onTodoAutomationFilterChange: (filter: TaskBoardTodoAutomationFilter) => void;
  onEdit: (issue: TaskBoardIssue) => void;
  onOpenChat: (issue: TaskBoardIssue) => void | Promise<void>;
  onOpenContextMenu: (issue: TaskBoardIssue, event: MouseEvent<HTMLElement>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getColumnId(status) });
  const meta = STATUS_META[status];
  const label = t(meta.labelKey);
  const summary = getTaskBoardColumnSummary(status, issues.length, t);
  return (
    <section
      ref={setNodeRef}
      className={`task-board-column is-${status} is-${meta.tone} ${isOver ? "is-over" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelectColumn();
      }}
    >
      <header className="task-board-column-head">
        <div className="task-board-column-title">
          <span className={`task-board-status-dot is-${meta.tone}`} aria-hidden="true" />
          <strong>{label}</strong>
          <span>{issues.length}</span>
        </div>
        <div className="task-board-column-actions">
          <button
            type="button"
            aria-label={t("taskBoard.column.addTo", { status: label })}
            disabled={!canAdd}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            +
          </button>
        </div>
      </header>
      {status === "todo" ? (
        <div className="task-board-column-filter" aria-label={t("taskBoard.filter.todoAutomation")} onClick={(event) => event.stopPropagation()}>
          {TASK_BOARD_TODO_AUTOMATION_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={todoAutomationFilter === option.value ? "is-active" : ""}
              onClick={() => onTodoAutomationFilterChange(option.value)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="task-board-column-body"
        onDoubleClick={(event) => {
          if (shouldCreateIssueFromColumnDoubleClick(event, status)) {
            onAdd();
          }
        }}
      >
        <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue, index) => (
            <TaskBoardCard
              key={issue.id}
              issue={issue}
              sortIndex={index + 1}
              awaitingConfirmation={issueHasPendingAwaiting(issue, agents)}
              agents={agents}
              display={display}
              now={now}
              t={t}
              onEdit={() => onEdit(issue)}
              onOpenChat={() => void onOpenChat(issue)}
              onOpenContextMenu={(event) => onOpenContextMenu(issue, event)}
            />
          ))}
        </SortableContext>
        {issues.length === 0 ? (
          <div className="task-board-empty-column">
            <span className="task-board-empty-illustration" aria-hidden="true" />
            <strong>{t("taskBoard.column.empty")}</strong>
            <span>{getTaskBoardEmptyHint(status, t)}</span>
          </div>
        ) : null}
      </div>
      <footer className="task-board-column-summary">
        <span className="task-board-column-summary-icon" aria-hidden="true" />
        <span className="task-board-column-summary-text">
          <strong>{summary.count}</strong>
          <span>{summary.detail}</span>
        </span>
      </footer>
    </section>
  );
}

function TaskBoardCard({
  issue,
  sortIndex,
  awaitingConfirmation,
  agents,
  display,
  now,
  t,
  onEdit,
  onOpenChat,
  onOpenContextMenu
}: {
  issue: TaskBoardIssue;
  sortIndex: number;
  awaitingConfirmation: boolean;
  agents: AssistantNavAgentItem[];
  display: DisplayState;
  now: Date;
  t: TranslateFunction;
  onEdit: () => void;
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
      className={[
        "task-board-card",
        `is-${issue.status}`,
        sortable.isDragging ? "is-dragging-source" : "",
        dragLocked ? "is-drag-locked" : "",
        awaitingConfirmation ? "is-awaiting-confirmation" : ""
      ].filter(Boolean).join(" ")}
      data-drag-locked={dragLocked ? "true" : undefined}
      {...sortable.attributes}
      aria-disabled={undefined}
      onContextMenu={handleContextMenu}
      onClick={(event) => event.stopPropagation()}
      {...(dragLocked ? {} : sortable.listeners)}
    >
      <TaskBoardCardContent
        issue={issue}
        sortIndex={sortIndex}
        awaitingConfirmation={awaitingConfirmation}
        agents={agents}
        display={display}
        now={now}
        t={t}
        interactive
        onEdit={onEdit}
        onOpenChat={onOpenChat}
      />
    </article>
  );
}

function TaskBoardCardContent({
  issue,
  sortIndex,
  awaitingConfirmation,
  agents,
  display,
  now,
  t,
  interactive,
  onEdit,
  onOpenChat
}: {
  issue: TaskBoardIssue;
  sortIndex?: number;
  awaitingConfirmation: boolean;
  agents: AssistantNavAgentItem[];
  display: DisplayState;
  now: Date;
  t: TranslateFunction;
  interactive: boolean;
  onEdit: () => void;
  onOpenChat: () => void;
}) {
  const chatActionLabel = getIssueChatActionLabel(issue, t);
  const visibleChatActionLabel = awaitingConfirmation ? t("taskBoard.chat.awaitingConfirmation") : chatActionLabel;
  const assigneeAgent = getAssigneeAgent(issue, agents);
  const assigneeIcon = hasTaskBoardAgentIcon(assigneeAgent?.icon) ? assigneeAgent?.icon : undefined;
  const visibleAssigneeName = getVisibleAssigneeName(issue, agents);
  const automationLabel = getAutomationDisplayLabel(issue, t);
  const visibleAttachments = getVisibleTaskBoardAttachments(issue.attachments);
  const hasVisibleAttachment = visibleAttachments.length > 0;
  const description = display.description ? descriptionPreview(issue.description) : "";
  const cardStatus = getIssueCardStatusPresentation(issue, {
    awaitingConfirmation,
    now,
    sortIndex
  }, t);
  const cardPresentation = getIssueCardPresentation(
    {
      displayAssignee: display.assignee,
      visibleAssigneeName
    },
    t
  );
  const mainContent = (
    <>
      <div className="task-board-card-line task-board-card-line-top">
        <span className="task-board-card-id-group">
          <span className="task-board-card-id">{issue.id}</span>
          {display.priority ? <PriorityBadge priority={issue.priority} t={t} /> : null}
        </span>
        <span
          className={`task-board-card-status is-${cardStatus.tone}`}
          title={cardStatus.updatedTime ? `${cardStatus.label} · ${cardStatus.updatedTime}` : cardStatus.label}
        >
          {cardStatus.tone !== "backlog" && cardStatus.tone !== "todo" ? <span className="task-board-run-dot" aria-hidden="true" /> : null}
          <span className="task-board-card-status-label">{cardStatus.label}</span>
          <span className="task-board-card-status-time">{cardStatus.updatedTime}</span>
        </span>
      </div>
      <strong title={description || issue.title}>{issue.title}</strong>
    </>
  );

  return (
    <>
      {interactive ? (
        <div
          className="task-board-card-main"
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
        <div className="task-board-card-main" aria-hidden="true">
          {mainContent}
        </div>
      )}
      <footer className="task-board-card-foot">
        {cardPresentation.assigneeLabel ? (
          <span
            className={`task-board-card-assignee ${visibleAssigneeName ? "" : "is-unassigned"}`}
            title={cardPresentation.assigneeTitle || undefined}
          >
            {visibleAssigneeName ? (
              <span
                className={`task-board-card-assignee-avatar${assigneeIcon ? " has-icon" : ""}`}
                aria-hidden="true"
              >
                {assigneeIcon ? (
                  <AgentIcon
                    icon={assigneeIcon}
                    className="task-board-card-assignee-icon"
                    size={18}
                  />
                ) : (
                  <span className="task-board-card-assignee-avatar-label">
                    {getIssueCardAssigneeAvatarLabel(visibleAssigneeName)}
                  </span>
                )}
              </span>
            ) : null}
            <span className="task-board-card-assignee-name">{cardPresentation.assigneeLabel}</span>
          </span>
        ) : <span className="task-board-card-assignee" aria-hidden="true" />}
        <span className="task-board-card-foot-actions">
          {automationLabel ? (
            <span className="task-board-automation-badge" title={automationLabel}>
              <TaskBoardIcon kind="clock" />
              <span className="task-board-automation-label">{automationLabel}</span>
            </span>
          ) : null}
          {hasVisibleAttachment ? (
            <span className="task-board-attachment-badge" title={t("taskBoard.form.attachments")}>
              <TaskBoardIcon kind="attachment" />
            </span>
          ) : null}
          {chatActionLabel ? (
            <button
              type="button"
              className={[
                "task-board-chat-action",
                issue.status === "in_progress" ? "is-awaiting" : "",
                awaitingConfirmation ? "is-human-loop" : ""
              ].filter(Boolean).join(" ")}
              disabled={!interactive}
              tabIndex={interactive ? 0 : -1}
              aria-label={
                awaitingConfirmation
                  ? t("taskBoard.chat.openWithConfirmation", { id: issue.id })
                  : t("taskBoard.chat.open", { id: issue.id })
              }
              title={visibleChatActionLabel ?? undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (interactive) {
                  onOpenChat();
                }
              }}
            >
              <TaskBoardIcon kind="message" />
            </button>
          ) : null}
        </span>
      </footer>
    </>
  );
}

function TaskBoardIcon({ kind }: { kind: "attachment" | "clock" | "display" | "filter" | "message" | "search" }) {
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
    message: (
      <>
        <path d="M5 5.5h10v7H9l-3.5 2.7v-2.7H5z" />
        <path d="M7.5 8h5" />
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
    <svg className="task-board-icon" viewBox="0 0 20 20" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function PriorityBadge({ priority, t }: { priority: TaskBoardPriority; t: TranslateFunction }) {
  const meta = PRIORITY_META[priority];
  return (
    <span className={`task-board-priority is-${meta.tone}`}>
      <span className="task-board-priority-bars" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <span key={index} className={index < meta.bars ? "is-on" : ""} />
        ))}
      </span>
      {t(meta.labelKey)}
    </span>
  );
}
