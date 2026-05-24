import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
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
import { useI18n } from "../../i18n/useI18n";
import { PluginPage } from "../plugin/PluginPage";

type MenuKind = "filter" | "display" | null;
type ModalMode = "create" | "edit";
type ThemeMode = "light" | "dark";
type TaskBoardSchedulePlan = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
type ScheduleMenuKind = "plan" | "time";
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
  scheduleEnabled: boolean;
  schedulePreset: TaskBoardSchedulePlan;
  scheduleTime: string;
  scheduleCron: string;
  scheduleMessage: string;
  scheduleTimezone: string;
};

type DisplayState = {
  description: boolean;
  assignee: boolean;
  priority: boolean;
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

const STATUS_META: Record<TaskBoardStatus, { labelKey: TranslationKey; tone: string }> = {
  backlog: { labelKey: "taskBoard.status.backlog", tone: "neutral" },
  todo: { labelKey: "taskBoard.status.todo", tone: "muted" },
  in_progress: { labelKey: "taskBoard.status.inProgress", tone: "warning" },
  blocked: { labelKey: "taskBoard.status.blocked", tone: "danger" },
  in_review: { labelKey: "taskBoard.status.inReview", tone: "success" },
  done: { labelKey: "taskBoard.status.done", tone: "info" }
};

const PRIORITY_META: Record<TaskBoardPriority, { labelKey: TranslationKey; tone: string; bars: number }> = {
  urgent: { labelKey: "taskBoard.priority.urgent", tone: "danger", bars: 4 },
  high: { labelKey: "taskBoard.priority.high", tone: "high", bars: 3 },
  medium: { labelKey: "taskBoard.priority.medium", tone: "medium", bars: 2 },
  low: { labelKey: "taskBoard.priority.low", tone: "low", bars: 1 },
  none: { labelKey: "taskBoard.priority.none", tone: "none", bars: 0 }
};

const DEFAULT_TASK_BOARD_SCHEDULE_PLAN: TaskBoardSchedulePlan = "daily";
const DEFAULT_TASK_BOARD_SCHEDULE_TIME = "09:00";
const DEFAULT_TASK_BOARD_SCHEDULE_CRON = "0 9 * * *";

const TASK_BOARD_SCHEDULE_PLANS = [
  { labelKey: "taskBoard.schedule.hourly", value: "hourly" },
  { labelKey: "taskBoard.schedule.daily", value: "daily" },
  { labelKey: "taskBoard.schedule.weekdays", value: "weekdays" },
  { labelKey: "taskBoard.schedule.weekly", value: "weekly" },
  { labelKey: "taskBoard.schedule.custom", value: "custom" }
] satisfies ReadonlyArray<{ labelKey: TranslationKey; value: TaskBoardSchedulePlan }>;

const TASK_BOARD_SCHEDULE_TIME_OPTIONS = buildScheduleTimeOptions();

const emptyForm: IssueFormState = {
  title: "",
  description: "",
  attachmentChatId: "",
  attachments: [],
  status: "backlog",
  priority: "medium",
  assigneeAgentKey: "",
  scheduleEnabled: false,
  schedulePreset: DEFAULT_TASK_BOARD_SCHEDULE_PLAN,
  scheduleTime: DEFAULT_TASK_BOARD_SCHEDULE_TIME,
  scheduleCron: DEFAULT_TASK_BOARD_SCHEDULE_CRON,
  scheduleMessage: "",
  scheduleTimezone: "Asia/Shanghai"
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
    const updatedDelta = issueUpdatedTime(b) - issueUpdatedTime(a);
    if (updatedDelta !== 0) return updatedDelta;
    if (a.position !== b.position) return a.position - b.position;
    return a.number - b.number;
  });
}

function descriptionPreview(description: string) {
  return description.replace(/\s+/gu, " ").trim();
}

function padScheduleNumber(value: number) {
  return String(value).padStart(2, "0");
}

function buildScheduleTimeOptions() {
  const options: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      options.push(`${padScheduleNumber(hour)}:${padScheduleNumber(minute)}`);
    }
  }
  return options;
}

function normalizeScheduleTime(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{1,2})/u);
  if (!match) {
    return DEFAULT_TASK_BOARD_SCHEDULE_TIME;
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  const roundedTotalMinutes = Math.min((23 * 60) + 45, Math.round(((hour * 60) + minute) / 15) * 15);
  return `${padScheduleNumber(Math.floor(roundedTotalMinutes / 60))}:${padScheduleNumber(roundedTotalMinutes % 60)}`;
}

function scheduleTimeParts(value: string) {
  const [hour, minute] = normalizeScheduleTime(value).split(":");
  return {
    hour: String(Number(hour)),
    minute: String(Number(minute))
  };
}

function buildScheduleCron(plan: TaskBoardSchedulePlan, time: string, customCron: string) {
  if (plan === "custom") {
    return customCron.trim();
  }
  const { hour, minute } = scheduleTimeParts(time);
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

function formatScheduleTime(hour: string, minute: string) {
  return `${padScheduleNumber(Number(hour))}:${padScheduleNumber(Number(minute))}`;
}

function parseScheduleFormFromCron(value: string | null | undefined) {
  const scheduleCron = value?.trim() || DEFAULT_TASK_BOARD_SCHEDULE_CRON;
  const parts = scheduleCron.split(/\s+/u);
  if (parts.length !== 5) {
    return {
      schedulePreset: "custom" as TaskBoardSchedulePlan,
      scheduleTime: DEFAULT_TASK_BOARD_SCHEDULE_TIME,
      scheduleCron
    };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!isFifteenMinuteCronMinute(minute)) {
    return {
      schedulePreset: "custom" as TaskBoardSchedulePlan,
      scheduleTime: DEFAULT_TASK_BOARD_SCHEDULE_TIME,
      scheduleCron
    };
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return {
      schedulePreset: "hourly" as TaskBoardSchedulePlan,
      scheduleTime: formatScheduleTime("0", minute),
      scheduleCron
    };
  }
  if (!isCronHour(hour) || dayOfMonth !== "*" || month !== "*") {
    return {
      schedulePreset: "custom" as TaskBoardSchedulePlan,
      scheduleTime: DEFAULT_TASK_BOARD_SCHEDULE_TIME,
      scheduleCron
    };
  }
  if (dayOfWeek === "*") {
    return {
      schedulePreset: "daily" as TaskBoardSchedulePlan,
      scheduleTime: formatScheduleTime(hour, minute),
      scheduleCron
    };
  }
  if (dayOfWeek === "1-5") {
    return {
      schedulePreset: "weekdays" as TaskBoardSchedulePlan,
      scheduleTime: formatScheduleTime(hour, minute),
      scheduleCron
    };
  }
  if (dayOfWeek === "1") {
    return {
      schedulePreset: "weekly" as TaskBoardSchedulePlan,
      scheduleTime: formatScheduleTime(hour, minute),
      scheduleCron
    };
  }
  return {
    schedulePreset: "custom" as TaskBoardSchedulePlan,
    scheduleTime: DEFAULT_TASK_BOARD_SCHEDULE_TIME,
    scheduleCron
  };
}

function getSchedulePlanLabel(plan: TaskBoardSchedulePlan, t: TranslateFunction) {
  const labelKey = TASK_BOARD_SCHEDULE_PLANS.find((candidate) => candidate.value === plan)?.labelKey ?? "taskBoard.schedule.custom";
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
    t("taskBoard.prompt.identifier", { value: issue.identifier }),
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

function createFormFromIssue(issue: TaskBoardIssue): IssueFormState {
  const scheduleForm = parseScheduleFormFromCron(issue.scheduleCron);
  return {
    title: issue.title,
    description: issue.description,
    attachmentChatId: issue.attachmentChatId ?? issue.chatId ?? createTaskBoardAttachmentChatId(issue.id),
    attachments: issue.attachments ?? [],
    status: issue.status,
    priority: issue.priority,
    assigneeAgentKey: issue.assigneeAgentKey ?? "",
    scheduleEnabled: issue.scheduleEnabled,
    schedulePreset: scheduleForm.schedulePreset,
    scheduleTime: scheduleForm.scheduleTime,
    scheduleCron: scheduleForm.scheduleCron,
    scheduleMessage: issue.scheduleMessage ?? "",
    scheduleTimezone: issue.scheduleTimezone ?? "Asia/Shanghai"
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

function getVisibleAssigneeName(name: string | null | undefined) {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "";
  return Array.from(trimmed).length <= 4 ? trimmed : "";
}

function isFiveFieldCron(value: string) {
  return value.trim().split(/\s+/u).length === 5;
}

function getScheduleDisplayLabel(issue: TaskBoardIssue, t: TranslateFunction) {
  if (!issue.scheduleEnabled || !issue.scheduleCron) {
    return "";
  }
  const scheduleForm = parseScheduleFormFromCron(issue.scheduleCron);
  if (scheduleForm.schedulePreset === "custom") {
    return issue.scheduleCron;
  }
  if (scheduleForm.schedulePreset === "hourly") {
    const minute = Number(scheduleForm.scheduleTime.split(":")[1]);
    return t("taskBoard.schedule.hourlyAtMinute", { minute: padScheduleNumber(minute) });
  }
  return `${getSchedulePlanLabel(scheduleForm.schedulePreset, t)} ${scheduleForm.scheduleTime}`;
}

function createNavigationAgentFromOption(agent: DesktopPetAgentOption): AssistantNavAgentItem {
  return {
    agentKey: agent.agentKey,
    displayName: agent.displayName || agent.agentKey,
    role: agent.role,
    icon: undefined,
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

async function loadTaskBoardAgents(): Promise<AssistantNavAgentItem[]> {
  const navigationResult = await window.electronAPI.assistant.listNavigationAgents();
  if (navigationResult.ok && navigationResult.items.length > 0) {
    return navigationResult.items;
  }
  const fallbackAgents = await window.electronAPI.assistant.listAgents();
  return fallbackAgents.map(createNavigationAgentFromOption);
}

function resolveAssistantTaskStatus(event: AssistantEvent, t: TranslateFunction): {
  status: TaskBoardStatus;
  tone: Feedback["tone"];
  message: string;
} | null {
  if (event.type === "done" || event.type === "run.complete") {
    return {
      status: "in_review",
      tone: "success",
      message: t("taskBoard.feedback.agentDone")
    };
  }
  if (
    event.type === "error" ||
    event.type === "stopped" ||
    event.type === "run.error" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.type === "run.expired" ||
    event.status === "error" ||
    event.status === "cancelled" ||
    event.status === "timeout" ||
    event.status === "stopped"
  ) {
    return {
      status: "blocked",
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
    issue.status === "blocked" ||
    issue.status === "in_review" ||
    issue.status === "done"
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
    const matchingChat = agent.recentChats.find((chat) => chat.chatId === chatId);
    if (matchingChat) {
      return matchingChat.hasPendingAwaiting;
    }
    return agent.latestChatId === chatId && agent.hasPendingAwaiting;
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
    agent.recentChats.some((chat) => chat.chatId === chatId)
  );
  return matchedAgent?.agentKey ?? "";
}

function buildTaskBoardChatEmbedPath(request: TaskBoardChatModalRequest) {
  const chatId = request.chatId?.trim() ?? "";
  if (!chatId) {
    return `/agent/${encodeURIComponent(request.agentKey)}`;
  }
  const params = new URLSearchParams();
  params.set("chatId", chatId);
  return `/agent/${encodeURIComponent(request.agentKey)}?${params.toString()}`;
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
  const [display, setDisplay] = useState<DisplayState>(defaultDisplayState);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [chatModalRequest, setChatModalRequest] = useState<TaskBoardChatModalRequest | null>(null);
  const [form, setForm] = useState<IssueFormState>(emptyForm);
  const [formCompact, setFormCompact] = useState(true);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState<ScheduleMenuKind | null>(null);
  const [activeDragIssueId, setActiveDragIssueId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TaskBoardContextMenu | null>(null);
  const issuesRef = useRef<TaskBoardIssue[]>([]);
  const selectedScheduleTimeRef = useRef<HTMLButtonElement | null>(null);
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
        setAgents(result.items);
        return;
      }
      void loadTaskBoardAgents().then((items) => {
        if (items.length > 0) {
          setAgents(items);
        }
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

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
    if (scheduleMenuOpen === "time") {
      selectedScheduleTimeRef.current?.scrollIntoView({ block: "center" });
    }
  }, [form.scheduleTime, scheduleMenuOpen]);

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
        const result = await taskBoardApi.updateIssue(issue.id, {
          status: nextTaskStatus.status,
          chatId: event.chatId || issue.chatId,
          runId: null
        });
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

  const filteredIssues = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return sortIssues(issues).filter((issue) => {
      if (priorityFilters.length > 0 && !priorityFilters.includes(issue.priority)) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = [
        issue.identifier,
        issue.title,
        issue.description,
        issue.assigneeName ?? "",
        ...getVisibleTaskBoardAttachments(issue.attachments).map((attachment) => attachment.name)
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [issues, priorityFilters, query]);

  const issueMap = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const filteredCount = filteredIssues.length;
  const totalCount = issues.length;
  const activeDragIssue = activeDragIssueId ? issueMap.get(activeDragIssueId) ?? null : null;

  function openCreateModal(status: TaskBoardStatus = "backlog") {
    if (!readTaskBoardApi()) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    setForm({ ...emptyForm, status, attachmentChatId: createTaskBoardDraftAttachmentChatId() });
    setFormCompact(true);
    setAttachmentBusy(false);
    setScheduleMenuOpen(null);
    setModal({ mode: "create" });
  }

  function openEditModal(issue: TaskBoardIssue) {
    setContextMenu(null);
    setForm(createFormFromIssue(issue));
    setFormCompact(true);
    setAttachmentBusy(false);
    setScheduleMenuOpen(null);
    setModal({ mode: "edit", issue });
  }

  function openInProgressAssignmentModal(issue: TaskBoardIssue) {
    setForm({
      ...createFormFromIssue(issue),
      status: "in_progress"
    });
    setFormCompact(true);
    setAttachmentBusy(false);
    setScheduleMenuOpen(null);
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
    setScheduleMenuOpen(null);
    setFormCompact((current) => !current);
  }

  function toggleScheduleMenu(menuName: ScheduleMenuKind) {
    setScheduleMenuOpen((current) => current === menuName ? null : menuName);
  }

  function updateSchedulePlan(plan: TaskBoardSchedulePlan) {
    setForm((current) => ({
      ...current,
      schedulePreset: plan,
      scheduleCron: buildScheduleCron(plan, current.scheduleTime, current.scheduleCron)
    }));
    setScheduleMenuOpen(null);
  }

  function updateScheduleTime(time: string) {
    const nextTime = normalizeScheduleTime(time);
    setForm((current) => ({
      ...current,
      scheduleTime: nextTime,
      scheduleCron: buildScheduleCron(current.schedulePreset, nextTime, current.scheduleCron)
    }));
    setScheduleMenuOpen(null);
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
    const resolvedScheduleCron = buildScheduleCron(form.schedulePreset, form.scheduleTime, form.scheduleCron);
    const resolvedScheduleMessage = form.scheduleMessage.trim() || form.description.trim() || title;
    const shouldRunAfterSave = form.status === "in_progress" && !modal?.issue?.runId;
    if (shouldRunAfterSave && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.assigneeRequiredForProgress") });
      return;
    }
    if (form.scheduleEnabled && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.assigneeRequiredForSchedule") });
      return;
    }
    if (form.scheduleEnabled && !isFiveFieldCron(resolvedScheduleCron)) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.invalidCron") });
      return;
    }
    if (form.scheduleEnabled && !resolvedScheduleMessage) {
      setFeedback({ tone: "error", message: t("taskBoard.feedback.scheduleMessageRequired") });
      return;
    }
    const assigneeName = getAssigneeName(form.assigneeAgentKey, agents);
    const savedStatus = shouldRunAfterSave ? modal?.issue?.status ?? "todo" : form.status;
    const payload: TaskBoardIssueInput | TaskBoardIssueUpdateInput = {
      title,
      description: form.description,
      status: savedStatus,
      priority: form.priority,
      assigneeAgentKey: form.assigneeAgentKey || null,
      assigneeName,
      scheduleId: modal?.issue?.scheduleId ?? null,
      scheduleEnabled: form.scheduleEnabled,
      scheduleCron: form.scheduleEnabled ? resolvedScheduleCron : null,
      scheduleMessage: form.scheduleEnabled ? resolvedScheduleMessage : null,
      scheduleTimezone: form.scheduleEnabled ? form.scheduleTimezone : null,
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
      if (result.ok && savedIssue && (form.scheduleEnabled || savedIssue.scheduleId)) {
        const scheduleResult = await taskBoardApi.syncIssueSchedule(savedIssue.id);
        savedIssue = mergeTaskBoardIssueAttachmentDraft(
          scheduleResult.issue ?? savedIssue,
          form.attachmentChatId,
          form.attachments
        );
        nextIssues = mergeTaskBoardIssuesAttachmentDraft(scheduleResult.issues, savedIssue);
        nextTone = scheduleResult.ok ? "success" : "error";
        nextMessage = scheduleResult.ok ? t("taskBoard.feedback.taskAndScheduleSaved") : scheduleResult.message;
      }
      setIssues(sortIssues(nextIssues));
      setFeedback({ tone: nextTone, message: nextMessage });
      if (result.ok && nextTone === "success") {
        setModal(null);
        if (shouldRunAfterSave && savedIssue) {
          void assignIssueToAssistant(savedIssue, form.assigneeAgentKey);
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
      setAgents(nextAgents);
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
        assigneeName: getAssigneeName(agentKey, availableAgents),
        chatId: runResult.chatId,
        runId: runResult.runId
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
      displayName: getAssigneeName(agentKey, agents) ?? issue.assigneeName ?? undefined
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

    const targetIssues = sortIssues(issues)
      .filter((issue) => issue.status === targetStatus && issue.id !== activeId);
    const overIndex = overIssue
      ? Math.max(0, targetIssues.findIndex((issue) => issue.id === overIssue.id))
      : targetIssues.length;
    const insertIndex = overIssue && overIndex >= 0 ? overIndex : targetIssues.length;
    const nextPosition = computeDropPosition(targetIssues, insertIndex);

    if (activeIssue.status === targetStatus && activeIssue.position === nextPosition) {
      return;
    }

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
          <button type="button" className="task-board-tool is-active">
            <span className="task-board-tool-icon" aria-hidden="true">▦</span>
            {t("taskBoard.toolbar.board")}
          </button>
          <button
            type="button"
            className={`task-board-tool ${menu === "filter" ? "is-active" : ""}`}
            onClick={() => setMenu(menu === "filter" ? null : "filter")}
          >
            <span className="task-board-tool-icon" aria-hidden="true">⌕</span>
            {t("taskBoard.toolbar.filter")}
          </button>
          <button
            type="button"
            className={`task-board-tool ${menu === "display" ? "is-active" : ""}`}
            onClick={() => setMenu(menu === "display" ? null : "display")}
          >
            <span className="task-board-tool-icon" aria-hidden="true">☷</span>
            {t("taskBoard.toolbar.display")}
          </button>
          <input
            className="task-board-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("taskBoard.search.placeholder")}
            aria-label={t("taskBoard.search.ariaLabel")}
          />
        </div>
        <div className="task-board-toolbar-right">
          <span className="task-board-count">{t("taskBoard.toolbar.issueCount", { filtered: filteredCount, total: totalCount })}</span>
        </div>
      </div>

      {menu ? (
        <div className="task-board-menu-panel">
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
        <div className="task-board-columns" aria-busy={loading}>
          {TASK_BOARD_STATUSES.map((status) => {
            const columnIssues = filteredIssues.filter((issue) => issue.status === status);
            return (
              <TaskBoardColumn
                key={status}
                status={status}
                issues={columnIssues}
                agents={agents}
                display={display}
                t={t}
                canAdd={taskBoardReady}
                onAdd={() => openCreateModal(status)}
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
              <article className="task-board-card task-board-drag-overlay-card">
                <TaskBoardCardContent
                  issue={activeDragIssue}
                  awaitingConfirmation={false}
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
                    scheduleMessage: current.scheduleEnabled && !current.scheduleMessage.trim()
                      ? value.trim() || current.title.trim()
                      : current.scheduleMessage
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
                    assigneeAgentKey,
                    status: current.status === "todo" && assigneeAgentKey ? "in_progress" : current.status
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
              <section className="task-board-schedule-panel" aria-label={t("taskBoard.form.schedulePanel")}>
                <label className="task-board-check-row task-board-schedule-toggle">
                  <input
                    type="checkbox"
                    checked={form.scheduleEnabled}
                    onChange={(event) => setForm((current) => {
                      const enabled = event.target.checked;
                      return {
                        ...current,
                        scheduleEnabled: enabled,
                        scheduleCron: enabled
                          ? buildScheduleCron(current.schedulePreset, current.scheduleTime, current.scheduleCron)
                          : current.scheduleCron,
                        scheduleMessage: enabled && !current.scheduleMessage.trim()
                          ? current.description.trim() || current.title.trim()
                          : current.scheduleMessage
                      };
                    })}
                  />
                  <span>{t("taskBoard.form.scheduleEnabled")}</span>
                </label>
                {form.scheduleEnabled ? (
                  <div className="task-board-schedule-popover">
                    <span className="task-board-schedule-panel-title">{t("taskBoard.form.schedulePlan")}</span>
                    <div className="task-board-field task-board-schedule-select-field">
                      <span>{t("taskBoard.form.scheduleFrequency")}</span>
                      <div className={`task-board-schedule-menu ${scheduleMenuOpen === "plan" ? "is-open" : ""}`}>
                        <button
                          type="button"
                          className="task-board-schedule-menu-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={scheduleMenuOpen === "plan"}
                          onClick={() => toggleScheduleMenu("plan")}
                        >
                          <span>{getSchedulePlanLabel(form.schedulePreset, t)}</span>
                          <span className="task-board-schedule-menu-arrow" aria-hidden="true">⌄</span>
                        </button>
                        {scheduleMenuOpen === "plan" ? (
                          <div className="task-board-schedule-menu-list" role="listbox" aria-label={t("taskBoard.form.scheduleFrequencyList")}>
                            {TASK_BOARD_SCHEDULE_PLANS.map((plan) => (
                              <button
                                key={plan.value}
                                type="button"
                                className={plan.value === form.schedulePreset ? "is-selected" : ""}
                                role="option"
                                aria-selected={plan.value === form.schedulePreset}
                                onClick={() => updateSchedulePlan(plan.value)}
                              >
                                {t(plan.labelKey)}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {form.schedulePreset === "custom" ? (
                      <label className="task-board-field">
                        <span>{t("taskBoard.form.cron")}</span>
                        <input
                          value={form.scheduleCron}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            scheduleCron: event.target.value
                          }))}
                          placeholder="0 9 * * *"
                        />
                      </label>
                    ) : (
                      <div className="task-board-schedule-time-control">
                        <div className="task-board-field task-board-schedule-select-field">
                          <span>{t("taskBoard.form.scheduleTime")}</span>
                          <div className={`task-board-schedule-menu ${scheduleMenuOpen === "time" ? "is-open" : ""}`}>
                            <button
                              type="button"
                              className="task-board-schedule-menu-trigger"
                              aria-haspopup="listbox"
                              aria-expanded={scheduleMenuOpen === "time"}
                              onClick={() => toggleScheduleMenu("time")}
                            >
                              <span>{form.scheduleTime}</span>
                              <span className="task-board-schedule-menu-arrow" aria-hidden="true">⌄</span>
                            </button>
                            {scheduleMenuOpen === "time" ? (
                              <div className="task-board-schedule-menu-list is-time-list" role="listbox" aria-label={t("taskBoard.form.scheduleTimeList")}>
                                {TASK_BOARD_SCHEDULE_TIME_OPTIONS.map((time) => (
                                  <button
                                    key={time}
                                    ref={time === form.scheduleTime ? selectedScheduleTimeRef : null}
                                    type="button"
                                    className={time === form.scheduleTime ? "is-selected" : ""}
                                    role="option"
                                    aria-selected={time === form.scheduleTime}
                                    onClick={() => updateScheduleTime(time)}
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
  t,
  canAdd,
  onAdd,
  onEdit,
  onOpenChat,
  onOpenContextMenu
}: {
  status: TaskBoardStatus;
  issues: TaskBoardIssue[];
  agents: AssistantNavAgentItem[];
  display: DisplayState;
  t: TranslateFunction;
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (issue: TaskBoardIssue) => void;
  onOpenChat: (issue: TaskBoardIssue) => void | Promise<void>;
  onOpenContextMenu: (issue: TaskBoardIssue, event: MouseEvent<HTMLElement>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getColumnId(status) });
  const meta = STATUS_META[status];
  const label = t(meta.labelKey);
  return (
    <section ref={setNodeRef} className={`task-board-column is-${meta.tone} ${isOver ? "is-over" : ""}`}>
      <header className="task-board-column-head">
        <div className="task-board-column-title">
          <span className={`task-board-status-dot is-${meta.tone}`} aria-hidden="true" />
          <strong>{label}</strong>
          <span>{issues.length}</span>
        </div>
        <div className="task-board-column-actions">
          <button type="button" aria-label={t("taskBoard.column.addTo", { status: label })} disabled={!canAdd} onClick={onAdd}>+</button>
        </div>
      </header>
      <div
        className="task-board-column-body"
        onDoubleClick={(event) => {
          if (shouldCreateIssueFromColumnDoubleClick(event, status)) {
            onAdd();
          }
        }}
      >
        <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue) => (
            <TaskBoardCard
              key={issue.id}
              issue={issue}
              awaitingConfirmation={issueHasPendingAwaiting(issue, agents)}
              display={display}
              t={t}
              onEdit={() => onEdit(issue)}
              onOpenChat={() => void onOpenChat(issue)}
              onOpenContextMenu={(event) => onOpenContextMenu(issue, event)}
            />
          ))}
        </SortableContext>
        {issues.length === 0 ? (
          <p className="task-board-empty-column">{t("taskBoard.column.empty")}</p>
        ) : null}
      </div>
    </section>
  );
}

function TaskBoardCard({
  issue,
  awaitingConfirmation,
  display,
  t,
  onEdit,
  onOpenChat,
  onOpenContextMenu
}: {
  issue: TaskBoardIssue;
  awaitingConfirmation: boolean;
  display: DisplayState;
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
        sortable.isDragging ? "is-dragging-source" : "",
        dragLocked ? "is-drag-locked" : "",
        awaitingConfirmation ? "is-awaiting-confirmation" : ""
      ].filter(Boolean).join(" ")}
      data-drag-locked={dragLocked ? "true" : undefined}
      {...sortable.attributes}
      aria-disabled={undefined}
      onContextMenu={handleContextMenu}
      {...(dragLocked ? {} : sortable.listeners)}
    >
      <TaskBoardCardContent
        issue={issue}
        awaitingConfirmation={awaitingConfirmation}
        display={display}
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
  awaitingConfirmation,
  display,
  t,
  interactive,
  onEdit,
  onOpenChat
}: {
  issue: TaskBoardIssue;
  awaitingConfirmation: boolean;
  display: DisplayState;
  t: TranslateFunction;
  interactive: boolean;
  onEdit: () => void;
  onOpenChat: () => void;
}) {
  const preview = descriptionPreview(issue.description);
  const chatActionLabel = getIssueChatActionLabel(issue, t);
  const visibleChatActionLabel = awaitingConfirmation ? t("taskBoard.chat.awaitingConfirmation") : chatActionLabel;
  const visibleAssigneeName = getVisibleAssigneeName(issue.assigneeName);
  const scheduleLabel = getScheduleDisplayLabel(issue, t);
  const shouldShowFooter = Boolean(
    (display.assignee && visibleAssigneeName) ||
    display.priority ||
    scheduleLabel ||
    chatActionLabel
  );
  const mainContent = (
    <>
      <span className="task-board-card-id">{issue.identifier}</span>
      <strong>{issue.title}</strong>
      {display.description && preview ? <span className="task-board-card-description">{preview}</span> : null}
    </>
  );

  return (
    <>
      {issue.runId ? (
        <span className="task-board-run-dot" aria-label={t("taskBoard.run.running")} title={t("taskBoard.run.running")} />
      ) : null}
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
      {shouldShowFooter ? (
        <footer className="task-board-card-foot">
          {display.assignee && visibleAssigneeName ? (
            <span className="task-board-avatar" title={issue.assigneeName ?? undefined}>
              {visibleAssigneeName}
            </span>
          ) : null}
          {display.priority ? <PriorityBadge priority={issue.priority} t={t} /> : null}
          {scheduleLabel ? (
            <span className="task-board-schedule-badge" title={issue.scheduleCron ?? undefined}>
              {scheduleLabel}
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
                  ? t("taskBoard.chat.openWithConfirmation", { identifier: issue.identifier })
                  : t("taskBoard.chat.open", { identifier: issue.identifier })
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (interactive) {
                  onOpenChat();
                }
              }}
            >
              {visibleChatActionLabel}
            </button>
          ) : null}
        </footer>
      ) : null}
    </>
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
