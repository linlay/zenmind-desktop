import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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

const missingTaskBoardApiMessage = "任务看板 Desktop API 未加载。请退出并重新启动 ZenMind Desktop，让新的 preload 生效。";

const STATUS_META: Record<TaskBoardStatus, { label: string; shortLabel: string; tone: string }> = {
  backlog: { label: "Backlog", shortLabel: "待整理", tone: "neutral" },
  todo: { label: "Todo", shortLabel: "待办", tone: "muted" },
  in_progress: { label: "In Progress", shortLabel: "进行中", tone: "warning" },
  in_review: { label: "In Review", shortLabel: "评审中", tone: "success" },
  done: { label: "Done", shortLabel: "已完成", tone: "info" }
};

const PRIORITY_META: Record<TaskBoardPriority, { label: string; tone: string; bars: number }> = {
  urgent: { label: "Urgent", tone: "danger", bars: 4 },
  high: { label: "High", tone: "high", bars: 3 },
  medium: { label: "Medium", tone: "medium", bars: 2 },
  low: { label: "Low", tone: "low", bars: 1 },
  none: { label: "No priority", tone: "none", bars: 0 }
};

const DEFAULT_TASK_BOARD_SCHEDULE_PLAN: TaskBoardSchedulePlan = "daily";
const DEFAULT_TASK_BOARD_SCHEDULE_TIME = "09:00";
const DEFAULT_TASK_BOARD_SCHEDULE_CRON = "0 9 * * *";

const TASK_BOARD_SCHEDULE_PLANS = [
  { label: "每小时", value: "hourly" },
  { label: "每天", value: "daily" },
  { label: "工作日", value: "weekdays" },
  { label: "每周", value: "weekly" },
  { label: "自定义", value: "custom" }
] satisfies ReadonlyArray<{ label: string; value: TaskBoardSchedulePlan }>;

const TASK_BOARD_SCHEDULE_TIME_OPTIONS = buildScheduleTimeOptions();

const emptyForm: IssueFormState = {
  title: "",
  description: "",
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

function sortIssues(issues: TaskBoardIssue[]) {
  const statusOrder = new Map(TASK_BOARD_STATUSES.map((status, index) => [status, index]));
  return [...issues].sort((a, b) => {
    const statusDelta = (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
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

function getSchedulePlanLabel(plan: TaskBoardSchedulePlan) {
  return TASK_BOARD_SCHEDULE_PLANS.find((candidate) => candidate.value === plan)?.label ?? "自定义";
}

function buildCompactTaskTitle(description: string) {
  const firstLine = description
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return Array.from(firstLine).slice(0, 24).join("");
}

function buildAssistantPrompt(issue: TaskBoardIssue) {
  const parts = [
    "请你处理下面这个 ZenMind 任务看板任务，并在完成后总结结果。",
    "不要直接修改任务看板文件或任务状态；Desktop 会在你完成后自动把任务更新到 In Review。",
    `任务编号：${issue.identifier}`,
    `标题：${issue.title}`,
    `状态：${STATUS_META[issue.status].label}`,
    `优先级：${PRIORITY_META[issue.priority].label}`
  ];
  if (issue.description.trim()) {
    parts.push(`描述：${issue.description.trim()}`);
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

function getScheduleDisplayLabel(issue: TaskBoardIssue) {
  if (!issue.scheduleEnabled || !issue.scheduleCron) {
    return "";
  }
  const scheduleForm = parseScheduleFormFromCron(issue.scheduleCron);
  if (scheduleForm.schedulePreset === "custom") {
    return issue.scheduleCron;
  }
  if (scheduleForm.schedulePreset === "hourly") {
    const minute = Number(scheduleForm.scheduleTime.split(":")[1]);
    return `每小时 ${padScheduleNumber(minute)} 分`;
  }
  return `${getSchedulePlanLabel(scheduleForm.schedulePreset)} ${scheduleForm.scheduleTime}`;
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

function resolveAssistantTaskStatus(event: AssistantEvent): {
  status: TaskBoardStatus;
  tone: Feedback["tone"];
  message: string;
} | null {
  if (event.type === "done" || event.type === "run.complete") {
    return {
      status: "in_review",
      tone: "success",
      message: "智能体已处理完成，任务已更新为 In Review。"
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
      status: "todo",
      tone: "error",
      message: "智能体处理未完成，任务已退回 Todo。"
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

function isIssueChatViewable(issue: TaskBoardIssue) {
  return Boolean(issue.chatId && (
    issue.status === "in_progress" ||
    issue.status === "in_review" ||
    issue.status === "done"
  ));
}

function getIssueChatActionLabel(issue: TaskBoardIssue) {
  if (!isIssueChatViewable(issue)) {
    return null;
  }
  return issue.status === "in_progress" ? "查看/确认" : "查看聊天";
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
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState<ScheduleMenuKind | null>(null);
  const [activeDragIssueId, setActiveDragIssueId] = useState<string | null>(null);
  const issuesRef = useRef<TaskBoardIssue[]>([]);
  const selectedScheduleTimeRef = useRef<HTMLButtonElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const taskBoardReady = readTaskBoardApi() !== null;

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
            message: error instanceof Error ? error.message : "任务看板加载失败。"
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
  }, []);

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
      const nextTaskStatus = resolveAssistantTaskStatus(event);
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
          message: error instanceof Error ? error.message : "任务状态回写失败。"
        });
      }
    });

    return removeAssistantEventListener;
  }, []);

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
        issue.assigneeName ?? ""
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
    setForm({ ...emptyForm, status });
    setFormCompact(true);
    setScheduleMenuOpen(null);
    setModal({ mode: "create" });
  }

  function openEditModal(issue: TaskBoardIssue) {
    setForm(createFormFromIssue(issue));
    setFormCompact(true);
    setScheduleMenuOpen(null);
    setModal({ mode: "edit", issue });
  }

  function openInProgressAssignmentModal(issue: TaskBoardIssue) {
    setForm({
      ...createFormFromIssue(issue),
      status: "in_progress"
    });
    setFormCompact(true);
    setScheduleMenuOpen(null);
    setModal({ mode: "edit", issue });
    setFeedback({ tone: "error", message: "请选择智能体后再进入 In Progress。" });
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
      setFeedback({ tone: "error", message: formCompact ? "请输入任务描述。" : "请输入任务标题。" });
      return;
    }
    const resolvedScheduleCron = buildScheduleCron(form.schedulePreset, form.scheduleTime, form.scheduleCron);
    const resolvedScheduleMessage = form.scheduleMessage.trim() || form.description.trim() || title;
    const shouldRunAfterSave = form.status === "in_progress" && !modal?.issue?.runId;
    if (shouldRunAfterSave && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: "请选择智能体后再进入 In Progress。" });
      return;
    }
    if (form.scheduleEnabled && !form.assigneeAgentKey) {
      setFeedback({ tone: "error", message: "请选择智能体后再启用定时任务。" });
      return;
    }
    if (form.scheduleEnabled && !isFiveFieldCron(resolvedScheduleCron)) {
      setFeedback({ tone: "error", message: "定时任务需要 5 段 cron，例如 0 8 * * *。" });
      return;
    }
    if (form.scheduleEnabled && !resolvedScheduleMessage) {
      setFeedback({ tone: "error", message: "请填写定时任务要执行的内容。" });
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
      scheduleTimezone: form.scheduleEnabled ? form.scheduleTimezone : null
    };

    try {
      const result = modal?.mode === "edit" && modal.issue
        ? await taskBoardApi.updateIssue(modal.issue.id, payload)
        : await taskBoardApi.createIssue(payload as TaskBoardIssueInput);
      let savedIssue = result.issue;
      let nextIssues = result.issues;
      let nextMessage = result.message;
      let nextTone: Feedback["tone"] = result.ok ? "success" : "error";
      if (result.ok && savedIssue && (form.scheduleEnabled || savedIssue.scheduleId)) {
        const scheduleResult = await taskBoardApi.syncIssueSchedule(savedIssue.id);
        savedIssue = scheduleResult.issue ?? savedIssue;
        nextIssues = scheduleResult.issues;
        nextTone = scheduleResult.ok ? "success" : "error";
        nextMessage = scheduleResult.ok ? "任务和定时任务已保存。" : scheduleResult.message;
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
        message: error instanceof Error ? error.message : "任务保存失败。"
      });
    }
  }

  async function deleteIssue(issue: TaskBoardIssue) {
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    if (!window.confirm(`删除任务「${issue.title}」？`)) {
      return;
    }
    const result = await taskBoardApi.deleteIssue(issue.id);
    setIssues(sortIssues(result.issues));
    setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    if (result.ok) {
      setModal(null);
    }
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
      setFeedback({ tone: "error", message: "请先在智能体列表中配置可用智能体。" });
      return;
    }

    setBusyIssueId(issue.id);
    try {
      const runResult = await window.electronAPI.assistant.startRun({
        agentKey,
        message: buildAssistantPrompt(issue),
        source: "copilot"
      });
      if (!runResult.ok) {
        setFeedback({ tone: "error", message: runResult.message || "智能体启动失败。" });
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
      setFeedback({ tone: "success", message: "已交给智能体处理。" });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "智能体启动失败。"
      });
    } finally {
      setBusyIssueId(null);
    }
  }

  async function openAssistantIssueChat(issue: TaskBoardIssue) {
    const chatId = issue.chatId?.trim() ?? "";
    if (!chatId) {
      setFeedback({ tone: "error", message: "当前任务还没有关联聊天记录。" });
      return;
    }
    const agentKey = resolveIssueAgentKey(issue, agents);
    if (!agentKey) {
      setFeedback({ tone: "error", message: "当前任务没有绑定智能体，无法打开对应聊天。" });
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
      setFeedback({ tone: "error", message: "智能体正在回答，完成后才能切换状态。" });
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
      setFeedback({ tone: "error", message: "智能体正在回答，完成后才能切换状态。" });
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

  return (
    <section className="task-board-page" aria-label="任务看板">
      <div className="task-board-toolbar">
        <div className="task-board-toolbar-left">
          <button type="button" className="task-board-tool is-active">
            <span className="task-board-tool-icon" aria-hidden="true">▦</span>
            Board
          </button>
          <button
            type="button"
            className={`task-board-tool ${menu === "filter" ? "is-active" : ""}`}
            onClick={() => setMenu(menu === "filter" ? null : "filter")}
          >
            <span className="task-board-tool-icon" aria-hidden="true">⌕</span>
            Filter
          </button>
          <button
            type="button"
            className={`task-board-tool ${menu === "display" ? "is-active" : ""}`}
            onClick={() => setMenu(menu === "display" ? null : "display")}
          >
            <span className="task-board-tool-icon" aria-hidden="true">☷</span>
            Display
          </button>
          <input
            className="task-board-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
            aria-label="搜索任务"
          />
        </div>
        <div className="task-board-toolbar-right">
          <span className="task-board-count">{filteredCount}/{totalCount} Issues</span>
        </div>
      </div>

      {menu ? (
        <div className="task-board-menu-panel">
          {menu === "filter" ? (
            <>
              <strong>优先级</strong>
              <div className="task-board-menu-grid">
                {TASK_BOARD_PRIORITIES.map((priority) => (
                  <label key={priority} className="task-board-check-row">
                    <input
                      type="checkbox"
                      checked={priorityFilters.includes(priority)}
                      onChange={() => togglePriority(priority)}
                    />
                    <PriorityBadge priority={priority} />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <strong>卡片字段</strong>
              {Object.entries({
                description: "描述",
                assignee: "负责人",
                priority: "优先级"
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
          <button type="button" onClick={() => setFeedback(null)} aria-label="关闭提示">×</button>
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
                canAdd={taskBoardReady}
                onAdd={() => openCreateModal(status)}
                onEdit={openEditModal}
                onOpenChat={openAssistantIssueChat}
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

      {modal ? (
        <div className="task-board-modal-layer" role="presentation" onMouseDown={() => setModal(null)}>
          <form
            className={`task-board-modal ${formCompact ? "is-compact" : "is-advanced"}`}
            onSubmit={submitForm}
            onMouseDown={(event) => event.stopPropagation()}
            noValidate
          >
            <div className="task-board-modal-head">
              <strong>{modal.mode === "edit" ? "编辑任务" : "新建任务"}</strong>
              <div className="task-board-modal-head-actions">
                <button
                  type="button"
                  className="task-board-modal-mode-button"
                  onClick={toggleFormCompactMode}
                >
                  {formCompact ? "高级模式" : "精简模式"}
                </button>
                <button type="button" className="task-board-modal-close-button" onClick={() => setModal(null)} aria-label="关闭">×</button>
              </div>
            </div>
            {!formCompact ? (
              <label className="task-board-field">
                <span>标题</span>
                <input
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  autoFocus={!formCompact}
                  required
                />
              </label>
            ) : null}
            <label className="task-board-field">
              <span>描述</span>
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
            </label>
            {!formCompact ? (
              <div className="task-board-field-grid">
                <label className="task-board-field">
                  <span>状态</span>
                  <select
                    value={form.status}
                    disabled={modalStatusLocked}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      status: event.target.value as TaskBoardStatus
                    }))}
                  >
                    {TASK_BOARD_STATUSES.map((status) => (
                      <option key={status} value={status}>{STATUS_META[status].label}</option>
                    ))}
                  </select>
                </label>
                <label className="task-board-field">
                  <span>优先级</span>
                  <select
                    value={form.priority}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      priority: event.target.value as TaskBoardPriority
                    }))}
                  >
                    {TASK_BOARD_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>{PRIORITY_META[priority].label}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            <label className="task-board-field">
              <span>负责人</span>
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
                <option value="">未分配</option>
                {agents.map((agent) => (
                  <option key={agent.agentKey} value={agent.agentKey}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
            {!formCompact ? (
              <section className="task-board-schedule-panel" aria-label="定时任务">
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
                  <span>定时执行</span>
                </label>
                {form.scheduleEnabled ? (
                  <div className="task-board-schedule-popover">
                    <span className="task-board-schedule-panel-title">计划</span>
                    <div className="task-board-field task-board-schedule-select-field">
                      <span>频率</span>
                      <div className={`task-board-schedule-menu ${scheduleMenuOpen === "plan" ? "is-open" : ""}`}>
                        <button
                          type="button"
                          className="task-board-schedule-menu-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={scheduleMenuOpen === "plan"}
                          onClick={() => toggleScheduleMenu("plan")}
                        >
                          <span>{getSchedulePlanLabel(form.schedulePreset)}</span>
                          <span className="task-board-schedule-menu-arrow" aria-hidden="true">⌄</span>
                        </button>
                        {scheduleMenuOpen === "plan" ? (
                          <div className="task-board-schedule-menu-list" role="listbox" aria-label="计划频率">
                            {TASK_BOARD_SCHEDULE_PLANS.map((plan) => (
                              <button
                                key={plan.value}
                                type="button"
                                className={plan.value === form.schedulePreset ? "is-selected" : ""}
                                role="option"
                                aria-selected={plan.value === form.schedulePreset}
                                onClick={() => updateSchedulePlan(plan.value)}
                              >
                                {plan.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {form.schedulePreset === "custom" ? (
                      <label className="task-board-field">
                        <span>Cron</span>
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
                          <span>时间</span>
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
                              <div className="task-board-schedule-menu-list is-time-list" role="listbox" aria-label="计划时间">
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
                  删除
                </button>
              ) : null}
              <button type="button" className="task-board-secondary-button" onClick={() => setModal(null)}>
                取消
              </button>
              <button type="submit" className="task-board-primary-button" disabled={!taskBoardReady}>
                保存
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
            aria-label={chatModalRequest.displayName ? `${chatModalRequest.displayName} 聊天` : "任务聊天"}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <PluginPage
              key={`task-board-chat:${chatModalRequest.agentKey}:${chatModalRequest.chatId}`}
              active
              hostTheme={hostTheme}
              pluginId="agent-webclient"
              surfaceLabel="任务聊天"
              embedPath={buildTaskBoardChatEmbedPath(chatModalRequest)}
              skipContextRegistration
              loadInitialEmbeddedUrlDirectly
              suppressInitialLoadingCopy
            />
            <button
              type="button"
              className="task-board-chat-modal-close"
              aria-label="关闭聊天"
              title="关闭"
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
  canAdd,
  onAdd,
  onEdit,
  onOpenChat
}: {
  status: TaskBoardStatus;
  issues: TaskBoardIssue[];
  agents: AssistantNavAgentItem[];
  display: DisplayState;
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (issue: TaskBoardIssue) => void;
  onOpenChat: (issue: TaskBoardIssue) => void | Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getColumnId(status) });
  const meta = STATUS_META[status];
  return (
    <section ref={setNodeRef} className={`task-board-column is-${meta.tone} ${isOver ? "is-over" : ""}`}>
      <header className="task-board-column-head">
        <div className="task-board-column-title">
          <span className={`task-board-status-dot is-${meta.tone}`} aria-hidden="true" />
          <strong>{meta.label}</strong>
          <span>{issues.length}</span>
        </div>
        <div className="task-board-column-actions">
          <button type="button" aria-label={`添加到 ${meta.label}`} disabled={!canAdd} onClick={onAdd}>+</button>
        </div>
      </header>
      <div className="task-board-column-body">
        <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue) => (
            <TaskBoardCard
              key={issue.id}
              issue={issue}
              awaitingConfirmation={issueHasPendingAwaiting(issue, agents)}
              display={display}
              onEdit={() => onEdit(issue)}
              onOpenChat={() => void onOpenChat(issue)}
            />
          ))}
        </SortableContext>
        {issues.length === 0 ? (
          <p className="task-board-empty-column">拖到这里</p>
        ) : null}
      </div>
    </section>
  );
}

function TaskBoardCard({
  issue,
  awaitingConfirmation,
  display,
  onEdit,
  onOpenChat
}: {
  issue: TaskBoardIssue;
  awaitingConfirmation: boolean;
  display: DisplayState;
  onEdit: () => void;
  onOpenChat: () => void;
}) {
  const dragLocked = isIssueDragLocked(issue);
  const sortable = useSortable({ id: issue.id, disabled: dragLocked });
  const style = {
    transform: sortable.isDragging ? undefined : CSS.Transform.toString(sortable.transform),
    transition: sortable.isDragging ? undefined : sortable.transition
  };

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
      {...(dragLocked ? {} : sortable.listeners)}
    >
      <TaskBoardCardContent
        issue={issue}
        awaitingConfirmation={awaitingConfirmation}
        display={display}
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
  interactive,
  onEdit,
  onOpenChat
}: {
  issue: TaskBoardIssue;
  awaitingConfirmation: boolean;
  display: DisplayState;
  interactive: boolean;
  onEdit: () => void;
  onOpenChat: () => void;
}) {
  const preview = descriptionPreview(issue.description);
  const chatActionLabel = getIssueChatActionLabel(issue);
  const visibleChatActionLabel = awaitingConfirmation ? "等待你确认" : chatActionLabel;
  const visibleAssigneeName = getVisibleAssigneeName(issue.assigneeName);
  const scheduleLabel = getScheduleDisplayLabel(issue);
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
        <span className="task-board-run-dot" aria-label="运行中" title="运行中" />
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
          {display.priority ? <PriorityBadge priority={issue.priority} /> : null}
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
                  ? `打开 ${issue.identifier} 的聊天记录并处理确认`
                  : `打开 ${issue.identifier} 的聊天记录`
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

function PriorityBadge({ priority }: { priority: TaskBoardPriority }) {
  const meta = PRIORITY_META[priority];
  return (
    <span className={`task-board-priority is-${meta.tone}`}>
      <span className="task-board-priority-bars" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <span key={index} className={index < meta.bars ? "is-on" : ""} />
        ))}
      </span>
      {meta.label}
    </span>
  );
}
