import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
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
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueUpdateInput,
  TaskBoardPriority,
  TaskBoardStatus
} from "../../../shared/contracts";
import { TASK_BOARD_PRIORITIES, TASK_BOARD_STATUSES } from "../../../shared/contracts";

type MenuKind = "filter" | "display" | null;
type ModalMode = "create" | "edit";

type IssueFormState = {
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  assigneeAgentKey: string;
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

const emptyForm: IssueFormState = {
  title: "",
  description: "",
  status: "backlog",
  priority: "medium",
  assigneeAgentKey: ""
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

function buildAssistantPrompt(issue: TaskBoardIssue) {
  const parts = [
    "请你处理下面这个 ZenMind 任务看板任务，并在完成后总结结果。",
    "不要直接修改任务看板文件或任务状态；Desktop 会在你完成后自动把任务更新到 Done。",
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
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentKey: issue.assigneeAgentKey ?? ""
  };
}

function getAssigneeName(agentKey: string, agents: AssistantNavAgentItem[]) {
  if (!agentKey) return null;
  return agents.find((agent) => agent.agentKey === agentKey)?.displayName ?? agentKey;
}

function resolveAssistantTaskStatus(event: AssistantEvent): {
  status: TaskBoardStatus;
  tone: Feedback["tone"];
  message: string;
} | null {
  if (event.type === "done" || event.type === "run.complete") {
    return {
      status: "done",
      tone: "success",
      message: "智能体已处理完成，任务已更新为 Done。"
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

export function TaskBoardPage() {
  const [issues, setIssues] = useState<TaskBoardIssue[]>([]);
  const [agents, setAgents] = useState<AssistantNavAgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [query, setQuery] = useState("");
  const [priorityFilters, setPriorityFilters] = useState<TaskBoardPriority[]>([]);
  const [display, setDisplay] = useState<DisplayState>(defaultDisplayState);
  const [modal, setModal] = useState<{ mode: ModalMode; issue?: TaskBoardIssue } | null>(null);
  const [form, setForm] = useState<IssueFormState>(emptyForm);
  const [activeDragIssueId, setActiveDragIssueId] = useState<string | null>(null);
  const [agentPickerIssue, setAgentPickerIssue] = useState<TaskBoardIssue | null>(null);
  const issuesRef = useRef<TaskBoardIssue[]>([]);
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
          window.electronAPI.assistant.listNavigationAgents()
        ]);
        if (cancelled) return;
        setIssues(sortIssues(issueResult.issues));
        setAgents(agentResult.items ?? []);
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
    issuesRef.current = issues;
  }, [issues]);

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
    setModal({ mode: "create" });
  }

  function openEditModal(issue: TaskBoardIssue) {
    setForm(createFormFromIssue(issue));
    setModal({ mode: "edit", issue });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    const title = form.title.trim();
    if (!title) {
      setFeedback({ tone: "error", message: "请输入任务标题。" });
      return;
    }
    const assigneeName = getAssigneeName(form.assigneeAgentKey, agents);
    const payload: TaskBoardIssueInput | TaskBoardIssueUpdateInput = {
      title,
      description: form.description,
      status: form.status,
      priority: form.priority,
      assigneeAgentKey: form.assigneeAgentKey || null,
      assigneeName
    };

    try {
      const result = modal?.mode === "edit" && modal.issue
        ? await taskBoardApi.updateIssue(modal.issue.id, payload)
        : await taskBoardApi.createIssue(payload as TaskBoardIssueInput);
      setIssues(sortIssues(result.issues));
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
      if (result.ok) {
        setModal(null);
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

  function requestAssignIssueToAssistant(issue: TaskBoardIssue) {
    if (agents.length > 1) {
      setAgentPickerIssue(issue);
      return;
    }
    void assignIssueToAssistant(issue);
  }

  async function assignIssueToAssistant(issue: TaskBoardIssue, selectedAgentKey?: string) {
    const taskBoardApi = readTaskBoardApi();
    if (!taskBoardApi) {
      setFeedback({ tone: "error", message: missingTaskBoardApiMessage });
      return;
    }
    const agentKey = selectedAgentKey ?? issue.assigneeAgentKey ?? agents[0]?.agentKey ?? "";
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
        assigneeName: getAssigneeName(agentKey, agents),
        chatId: runResult.chatId,
        runId: runResult.runId
      });
      setIssues(sortIssues(updateResult.issues));
      setAgentPickerIssue(null);
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
      <header className="task-board-breadcrumb">
        <strong>Issues</strong>
      </header>

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
          <button
            type="button"
            className="task-board-primary-button"
            disabled={!taskBoardReady}
            onClick={() => openCreateModal()}
          >
            + New Issue
          </button>
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
        collisionDetection={closestCenter}
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
                display={display}
                busyIssueId={busyIssueId}
                canAdd={taskBoardReady}
                onAdd={() => openCreateModal(status)}
                onEdit={openEditModal}
                onAssign={requestAssignIssueToAssistant}
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
                  display={display}
                  busy={false}
                  interactive={false}
                  onEdit={() => undefined}
                  onAssign={() => undefined}
                />
              </article>
            ) : null}
          </DragOverlay>,
          document.body
        ) : null}
      </DndContext>

      {agentPickerIssue ? (
        <div className="task-board-modal-layer" role="presentation" onMouseDown={() => setAgentPickerIssue(null)}>
          <div
            className="task-board-modal task-board-agent-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-board-agent-picker-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="task-board-modal-head">
              <strong id="task-board-agent-picker-title">选择智能体</strong>
              <button type="button" onClick={() => setAgentPickerIssue(null)} aria-label="关闭">×</button>
            </div>
            <div className="task-board-agent-list">
              {agents.map((agent) => (
                <button
                  key={agent.agentKey}
                  type="button"
                  className="task-board-agent-option"
                  disabled={busyIssueId === agentPickerIssue.id}
                  onClick={() => void assignIssueToAssistant(agentPickerIssue, agent.agentKey)}
                >
                  <span className="task-board-agent-avatar" aria-hidden="true">
                    {agent.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{agent.displayName}</strong>
                    <small>{agent.role || agent.agentKey}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="task-board-modal-actions">
              <span />
              <button
                type="button"
                className="task-board-secondary-button"
                onClick={() => setAgentPickerIssue(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal ? (
        <div className="task-board-modal-layer" role="presentation" onMouseDown={() => setModal(null)}>
          <form
            className="task-board-modal"
            onSubmit={submitForm}
            onMouseDown={(event) => event.stopPropagation()}
            noValidate
          >
            <div className="task-board-modal-head">
              <strong>{modal.mode === "edit" ? "编辑任务" : "新建任务"}</strong>
              <button type="button" onClick={() => setModal(null)} aria-label="关闭">×</button>
            </div>
            <label className="task-board-field">
              <span>标题</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                autoFocus
                required
              />
            </label>
            <label className="task-board-field">
              <span>描述</span>
              <textarea
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                rows={4}
              />
            </label>
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
            <label className="task-board-field">
              <span>负责人</span>
              <select
                value={form.assigneeAgentKey}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  assigneeAgentKey: event.target.value
                }))}
              >
                <option value="">未分配</option>
                {agents.map((agent) => (
                  <option key={agent.agentKey} value={agent.agentKey}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
            </label>
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
              <span />
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
    </section>
  );
}

function TaskBoardColumn({
  status,
  issues,
  display,
  busyIssueId,
  canAdd,
  onAdd,
  onEdit,
  onAssign
}: {
  status: TaskBoardStatus;
  issues: TaskBoardIssue[];
  display: DisplayState;
  busyIssueId: string | null;
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (issue: TaskBoardIssue) => void;
  onAssign: (issue: TaskBoardIssue) => void | Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getColumnId(status) });
  const meta = STATUS_META[status];
  return (
    <section className={`task-board-column is-${meta.tone} ${isOver ? "is-over" : ""}`}>
      <header className="task-board-column-head">
        <div className="task-board-column-title">
          <span className={`task-board-status-dot is-${meta.tone}`} aria-hidden="true" />
          <strong>{meta.label}</strong>
          <span>{issues.length}</span>
        </div>
        <div className="task-board-column-actions">
          <button type="button" aria-label={`${meta.label} 更多`}>…</button>
          <button type="button" aria-label={`添加到 ${meta.label}`} disabled={!canAdd} onClick={onAdd}>+</button>
        </div>
      </header>
      <div ref={setNodeRef} className="task-board-column-body">
        <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue) => (
            <TaskBoardCard
              key={issue.id}
              issue={issue}
              display={display}
              busy={busyIssueId === issue.id}
              onEdit={() => onEdit(issue)}
              onAssign={() => void onAssign(issue)}
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
  display,
  busy,
  onEdit,
  onAssign
}: {
  issue: TaskBoardIssue;
  display: DisplayState;
  busy: boolean;
  onEdit: () => void;
  onAssign: () => void;
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
      className={`task-board-card ${sortable.isDragging ? "is-dragging-source" : ""} ${dragLocked ? "is-drag-locked" : ""}`}
      aria-disabled={dragLocked}
      {...sortable.attributes}
      {...(dragLocked ? {} : sortable.listeners)}
    >
      <TaskBoardCardContent
        issue={issue}
        display={display}
        busy={busy}
        interactive
        onEdit={onEdit}
        onAssign={onAssign}
      />
    </article>
  );
}

function TaskBoardCardContent({
  issue,
  display,
  busy,
  interactive,
  onEdit,
  onAssign
}: {
  issue: TaskBoardIssue;
  display: DisplayState;
  busy: boolean;
  interactive: boolean;
  onEdit: () => void;
  onAssign: () => void;
}) {
  const preview = descriptionPreview(issue.description);
  const mainContent = (
    <>
      <span className="task-board-card-id">{issue.identifier}</span>
      <strong>{issue.title}</strong>
      {display.description && preview ? <span className="task-board-card-description">{preview}</span> : null}
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
        {display.assignee ? (
          <span className="task-board-avatar" title={issue.assigneeName ?? "未分配"}>
            {issue.assigneeName ? issue.assigneeName.slice(0, 1).toUpperCase() : "?"}
          </span>
        ) : null}
        {display.priority ? <PriorityBadge priority={issue.priority} /> : null}
        {issue.runId ? <span className="task-board-run-badge">运行中</span> : null}
        <button
          type="button"
          className="task-board-card-action"
          disabled={busy || !interactive}
          tabIndex={interactive ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (interactive) {
              onAssign();
            }
          }}
        >
          {busy ? "提交中" : "交给智能体"}
        </button>
      </footer>
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
