import type {
  AssistantAwaitingMode,
  DesktopPetPreviewAwaiting,
  DesktopPetPreviewItem,
  DesktopPetPreviewItemKind,
  DesktopPetPreviewItemStatus,
  DesktopPetPreviewPanel
} from "../../../shared/contracts";

type PreviewStatus = DesktopPetPreviewPanel["status"];

export type DesktopPetPreviewMeta = {
  source?: string;
  transportMode?: string;
};

export type DesktopPetPreviewEvent = {
  id?: string;
  seq?: number;
  runId: string;
  chatId: string | null;
  type: string;
  createdAt: string;
  status?: string;
  message?: string;
  delta?: string;
  text?: string;
  content?: string;
  toolCallId?: string;
  actionId?: string;
  toolName?: string;
  action?: string;
  target?: string;
  error?: string;
  awaiting?: Record<string, unknown>;
  awaitingId?: string;
  mode?: string;
  timeout?: number | null;
  timeoutMs?: number | null;
  questions?: unknown[];
  approvals?: unknown[];
  forms?: unknown[];
  artifactCount?: number;
  artifacts?: unknown[];
  taskId?: string;
  taskName?: string;
  subAgentKey?: string;
  groupId?: string;
  data?: unknown;
  raw: Record<string, unknown>;
};

export type DesktopPetPreviewIngestResult = {
  changed: boolean;
  panel: DesktopPetPreviewPanel | null;
  refresh: "none" | "throttled" | "immediate";
  holdMs?: number;
};

export type DesktopPetSseParseResult = {
  events: DesktopPetPreviewEvent[];
  done: boolean;
  errors: string[];
};

const MAX_ITEMS = 8;
const SUMMARY_MAX_LENGTH = 42;
const REPLY_PREVIEW_MAX_LENGTH = 30;
const ITEM_TEXT_MAX_LENGTH = 96;
const DETAIL_TEXT_MAX_LENGTH = 220;
const DONE_HOLD_MS = 12_000;
const ERROR_HOLD_MS = 5_200;
const STOPPED_HOLD_MS = 2_500;
const DONE_SENTINEL = "[DONE]";
const DONE_FALLBACK_SUMMARY = "暂无回复预览";
const GENERIC_DONE_SUMMARIES = new Set([
  "已完成",
  "完成",
  "任务已完成",
  "生成完成",
  "生成完成。",
  "处理完成",
  "处理完成。",
  "运行完成",
  "运行完成。",
  "回复已生成",
  "正在生成回复",
  "回复生成中",
  "正在整理思路",
  "思考中",
  "思考中...",
  "开始处理请求",
  "打开对话查看完整回复",
  DONE_FALLBACK_SUMMARY
]);
const SENSITIVE_KEY_PATTERN = /\b(password|passwd|token|secret|api[_-]?key|authorization|cookie)\b/iu;
const PREVIEW_TEXT_FIELD_KEYS = [
  "message",
  "text",
  "content",
  "title",
  "summary",
  "description",
  "detail",
  "details",
  "name",
  "error",
  "command",
  "target",
  "action",
  "input",
  "output",
  "stdout",
  "stderr",
  "result"
] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function truncateReplyPreview(value: string) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= REPLY_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, REPLY_PREVIEW_MAX_LENGTH - 3)).trimEnd()}...`;
}

function readRecordPreviewText(value: Record<string, unknown>, maxLength: number) {
  for (const key of PREVIEW_TEXT_FIELD_KEYS) {
    const candidate = toText(value[key]);
    if (candidate) {
      return sanitizeDesktopPetPreviewText(candidate, maxLength);
    }
  }
  for (const key of ["args", "params", "data"]) {
    const nested = value[key];
    if (!isObjectRecord(nested)) {
      continue;
    }
    for (const nestedKey of PREVIEW_TEXT_FIELD_KEYS) {
      const candidate = toText(nested[nestedKey]);
      if (candidate) {
        return sanitizeDesktopPetPreviewText(candidate, maxLength);
      }
    }
  }
  return "";
}

export function sanitizeDesktopPetPreviewText(value: unknown, maxLength = ITEM_TEXT_MAX_LENGTH): string {
  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      return "";
    }
    if (normalized.startsWith("data:")) {
      return "[已隐藏数据]";
    }
    if (SENSITIVE_KEY_PATTERN.test(normalized)) {
      return truncateText(
        normalized.replace(/([A-Za-z0-9_.-]*(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*)(\s*[:=]\s*)\S+/giu, "$1$2[已隐藏]"),
        maxLength
      );
    }
    return truncateText(normalized, maxLength);
  }

  if (!isObjectRecord(value)) {
    return "";
  }

  return readRecordPreviewText(value, maxLength);
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return isObjectRecord(value) && isObjectRecord(value[key]) ? value[key] as Record<string, unknown> : null;
}

function readStringField(event: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = toText(event[key]);
    if (value) {
      return value;
    }
  }
  const data = readNestedRecord(event, "data");
  if (data) {
    for (const key of keys) {
      const value = toText(data[key]);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function readArrayField(event: Record<string, unknown>, key: string) {
  const direct = toArray(event[key]);
  if (direct.length > 0) {
    return direct;
  }
  const awaiting = readNestedRecord(event, "awaiting");
  if (awaiting) {
    const nested = toArray(awaiting[key]);
    if (nested.length > 0) {
      return nested;
    }
  }
  const data = readNestedRecord(event, "data");
  return data ? toArray(data[key]) : [];
}

function readNumericField(event: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (event[key] !== undefined) {
      return toNumber(event[key]);
    }
  }
  const data = readNestedRecord(event, "data");
  if (data) {
    for (const key of keys) {
      if (data[key] !== undefined) {
        return toNumber(data[key]);
      }
    }
  }
  return 0;
}

export function normalizeDesktopPetAgentEvent(rawEvent: unknown): DesktopPetPreviewEvent | null {
  if (!isObjectRecord(rawEvent)) {
    return null;
  }

  const rawType = readStringField(rawEvent, "type");
  const type = rawType === "delta"
    ? "content.delta"
    : rawType === "error"
      ? "run.error"
      : rawType === "stopped"
        ? "run.stopped"
        : rawType;
  if (!type || type.startsWith("debug.")) {
    return null;
  }

  const runId = readStringField(rawEvent, "runId", "runID");
  const data = readNestedRecord(rawEvent, "data");
  const fallbackRunId = data ? readStringField(data, "runId", "runID") : "";
  const resolvedRunId = runId || fallbackRunId;
  if (!resolvedRunId) {
    return null;
  }

  const chatId = readStringField(rawEvent, "chatId", "chatID") || (data ? readStringField(data, "chatId", "chatID") : "");
  const createdAt = readStringField(rawEvent, "createdAt") || new Date().toISOString();
  const seq = rawEvent.seq !== undefined ? toNumber(rawEvent.seq) : data?.seq !== undefined ? toNumber(data.seq) : undefined;
  const artifactCount = readNumericField(rawEvent, "artifactCount");

  return {
    id: readStringField(rawEvent, "id") || undefined,
    seq: seq && Number.isFinite(seq) ? seq : undefined,
    runId: resolvedRunId,
    chatId: chatId || null,
    type,
    createdAt,
    status: readStringField(rawEvent, "status") || undefined,
    message: readStringField(rawEvent, "message") || undefined,
    delta: readStringField(rawEvent, "delta") || undefined,
    text: readStringField(rawEvent, "text") || undefined,
    content: readStringField(rawEvent, "content") || undefined,
    toolCallId: readStringField(rawEvent, "toolCallId", "tool_call_id", "toolId") || undefined,
    actionId: readStringField(rawEvent, "actionId") || undefined,
    toolName: readStringField(rawEvent, "toolName", "name") || undefined,
    action: readStringField(rawEvent, "action") || undefined,
    target: readStringField(rawEvent, "target") || undefined,
    error: readStringField(rawEvent, "error") || undefined,
    awaiting: readNestedRecord(rawEvent, "awaiting") ?? undefined,
    awaitingId: readStringField(rawEvent, "awaitingId") || undefined,
    mode: readStringField(rawEvent, "mode") || undefined,
    timeout: rawEvent.timeout === null ? null : rawEvent.timeout !== undefined ? toNumber(rawEvent.timeout) : undefined,
    timeoutMs: rawEvent.timeoutMs === null ? null : rawEvent.timeoutMs !== undefined ? toNumber(rawEvent.timeoutMs) : undefined,
    questions: readArrayField(rawEvent, "questions"),
    approvals: readArrayField(rawEvent, "approvals"),
    forms: readArrayField(rawEvent, "forms"),
    artifactCount: artifactCount > 0 ? artifactCount : undefined,
    artifacts: readArrayField(rawEvent, "artifacts"),
    taskId: readStringField(rawEvent, "taskId") || undefined,
    taskName: readStringField(rawEvent, "taskName", "title", "name") || undefined,
    subAgentKey: readStringField(rawEvent, "subAgentKey") || undefined,
    groupId: readStringField(rawEvent, "groupId") || undefined,
    data: rawEvent.data,
    raw: rawEvent
  };
}

function getEventDedupeKey(event: DesktopPetPreviewEvent) {
  if (event.id) {
    return `id:${event.id}`;
  }
  if (event.seq !== undefined && event.seq > 0) {
    return `seq:${event.runId}:${event.seq}:${event.type}`;
  }
  return "";
}

function isStartEvent(type: string) {
  return type === "request.query" || type === "run.start";
}

function isTerminalEvent(type: string) {
  return type === "run.complete" ||
    type === "run.error" ||
    type === "run.cancel" ||
    type === "run.stopped" ||
    type === "run.interrupt" ||
    type === "run.expired" ||
    type === "done";
}

function isDeltaEvent(type: string) {
  return type === "content.delta" || type === "reasoning.delta" || type === "tool.args" || type === "action.args";
}

function createDefaultPanel(event: DesktopPetPreviewEvent, expanded: boolean): DesktopPetPreviewPanel {
  return {
    runId: event.runId,
    chatId: event.chatId,
    visible: true,
    expanded,
    title: "思考中...",
    summary: "开始处理请求",
    status: "running",
    items: [],
    artifactCount: 0,
    updatedAt: event.createdAt
  };
}

function clampItems(items: DesktopPetPreviewItem[]) {
  if (items.length <= MAX_ITEMS) {
    return items;
  }
  return items.slice(items.length - MAX_ITEMS);
}

function statusForTool(event: DesktopPetPreviewEvent): DesktopPetPreviewItemStatus {
  if (event.status === "error" || event.status === "failed") {
    return "error";
  }
  if (event.status === "cancelled" || event.status === "canceled") {
    return "cancelled";
  }
  if (event.status === "ok" || event.status === "success" || event.status === "completed") {
    return "success";
  }
  if (event.type.endsWith(".result")) {
    return event.status === "error" ? "error" : "success";
  }
  if (event.type.endsWith(".end")) {
    return event.status === "error" ? "error" : "done";
  }
  return "running";
}

function terminalStatus(event: DesktopPetPreviewEvent): {
  title: string;
  status: PreviewStatus;
  itemStatus: DesktopPetPreviewItemStatus;
  holdMs: number;
} {
  if (event.type === "run.error" || event.status === "error") {
    return { title: "出错了", status: "error", itemStatus: "error", holdMs: ERROR_HOLD_MS };
  }
  if (event.type === "run.expired") {
    return { title: "已过期", status: "stopped", itemStatus: "cancelled", holdMs: STOPPED_HOLD_MS };
  }
  if (event.type === "run.cancel" || event.type === "run.stopped" || event.type === "run.interrupt" || event.status === "stopped") {
    return { title: "已停止", status: "stopped", itemStatus: "cancelled", holdMs: STOPPED_HOLD_MS };
  }
  return { title: DONE_FALLBACK_SUMMARY, status: "done", itemStatus: "success", holdMs: DONE_HOLD_MS };
}

function isGenericDoneSummary(value: string) {
  return GENERIC_DONE_SUMMARIES.has(normalizeWhitespace(value));
}

function terminalTitleForPanel(terminal: ReturnType<typeof terminalStatus>, summary: string) {
  return terminal.status === "done" ? summary : terminal.title;
}

function resolveTerminalSummary(
  event: DesktopPetPreviewEvent,
  terminal: ReturnType<typeof terminalStatus>,
  currentSummary: string,
  responsePreview: string,
  canUseCurrentSummary: boolean
) {
  const candidate = sanitizeDesktopPetPreviewText(event.error || event.message || event.data, DETAIL_TEXT_MAX_LENGTH);
  if (terminal.status !== "done") {
    return sanitizeDesktopPetPreviewText(candidate || terminal.title, SUMMARY_MAX_LENGTH);
  }
  if (candidate && !isGenericDoneSummary(candidate)) {
    return truncateReplyPreview(candidate);
  }
  const latestResponsePreview = sanitizeDesktopPetPreviewText(responsePreview, DETAIL_TEXT_MAX_LENGTH);
  if (latestResponsePreview && !isGenericDoneSummary(latestResponsePreview)) {
    return truncateReplyPreview(latestResponsePreview);
  }
  const previousSummary = canUseCurrentSummary
    ? sanitizeDesktopPetPreviewText(currentSummary, DETAIL_TEXT_MAX_LENGTH)
    : "";
  if (previousSummary && !isGenericDoneSummary(previousSummary)) {
    return truncateReplyPreview(previousSummary);
  }
  return DONE_FALLBACK_SUMMARY;
}

function readContentText(event: DesktopPetPreviewEvent, maxLength = ITEM_TEXT_MAX_LENGTH) {
  return sanitizeDesktopPetPreviewText(event.delta || event.text || event.content || event.message, maxLength);
}

function readDetailText(...values: unknown[]) {
  for (const value of values) {
    const detailText = sanitizeDesktopPetPreviewText(value, DETAIL_TEXT_MAX_LENGTH);
    if (detailText) {
      return detailText;
    }
  }
  return "";
}

function readEventDetailField(event: DesktopPetPreviewEvent, ...keys: string[]) {
  const direct = readStringField(event.raw, ...keys);
  if (direct) {
    return sanitizeDesktopPetPreviewText(direct, DETAIL_TEXT_MAX_LENGTH);
  }
  for (const record of [event.data, event.awaiting]) {
    if (!isObjectRecord(record)) {
      continue;
    }
    for (const key of keys) {
      const detailText = sanitizeDesktopPetPreviewText(record[key], DETAIL_TEXT_MAX_LENGTH);
      if (detailText) {
        return detailText;
      }
    }
  }
  return "";
}

function readContentDetail(event: DesktopPetPreviewEvent) {
  return readDetailText(
    event.delta,
    event.text,
    event.content,
    event.message,
    readEventDetailField(event, "delta", "text", "content", "message", "summary", "description")
  );
}

function readToolDetail(event: DesktopPetPreviewEvent, fallback: string) {
  if (event.type === "tool.args") {
    return readEventDetailField(event, "command", "target", "args", "message") || fallback;
  }
  return readEventDetailField(event, "error", "message", "target", "command", "output", "stdout", "stderr", "result") ||
    fallback;
}

function readActionDetail(event: DesktopPetPreviewEvent, fallback: string) {
  if (event.type === "action.args") {
    return readEventDetailField(event, "action", "target", "args", "message") || fallback;
  }
  return readEventDetailField(event, "error", "message", "action", "target", "output", "stdout", "stderr", "result") ||
    fallback;
}

function readToolLabel(event: DesktopPetPreviewEvent) {
  return sanitizeDesktopPetPreviewText(event.toolName || event.action || event.target || event.message, 32) || "工具";
}

function readActionLabel(event: DesktopPetPreviewEvent) {
  return sanitizeDesktopPetPreviewText(event.action || event.toolName || event.target || event.message, 32) || "操作";
}

function readAwaitingMode(event: DesktopPetPreviewEvent): AssistantAwaitingMode | "" {
  const mode = toText(event.mode || event.awaiting?.mode);
  return mode === "question" || mode === "approval" || mode === "form" ? mode : "";
}

function firstRecordText(items: unknown[], keys: string[], maxLength = ITEM_TEXT_MAX_LENGTH) {
  const first = items.find(isObjectRecord) as Record<string, unknown> | undefined;
  if (!first) {
    return "";
  }
  for (const key of keys) {
    const text = sanitizeDesktopPetPreviewText(first[key], maxLength);
    if (text) {
      return text;
    }
  }
  return "";
}

function buildAwaitingPreview(event: DesktopPetPreviewEvent): {
  awaiting: DesktopPetPreviewAwaiting;
  title: string;
  text: string;
  detailText: string;
} {
  const mode = readAwaitingMode(event);
  const questions = event.questions ?? [];
  const approvals = event.approvals ?? [];
  const forms = event.forms ?? [];
  const awaitingId = event.awaitingId || toText(event.awaiting?.awaitingId) || "awaiting";
  const timeoutMs = event.timeoutMs ?? event.timeout ?? null;

  if (mode === "question") {
    const count = Math.max(questions.length, 1);
    const text = firstRecordText(questions, ["title", "label", "question", "prompt", "description"]) ||
      sanitizeDesktopPetPreviewText(event.message, ITEM_TEXT_MAX_LENGTH) ||
      "等待你回答问题";
    const detailText = firstRecordText(questions, ["question", "prompt", "description", "title", "label"], DETAIL_TEXT_MAX_LENGTH) ||
      sanitizeDesktopPetPreviewText(event.message, DETAIL_TEXT_MAX_LENGTH) ||
      text;
    return {
      awaiting: { awaitingId, mode, count, title: `等待回答 ${count} 个问题`, timeoutMs },
      title: `等待回答 ${count} 个问题`,
      text,
      detailText
    };
  }
  if (mode === "form") {
    const count = Math.max(forms.length, 1);
    const text = firstRecordText(forms, ["title", "action", "description", "id"]) ||
      sanitizeDesktopPetPreviewText(event.message, ITEM_TEXT_MAX_LENGTH) ||
      "等待你填写表单";
    const detailText = firstRecordText(forms, ["description", "title", "action", "id"], DETAIL_TEXT_MAX_LENGTH) ||
      sanitizeDesktopPetPreviewText(event.message, DETAIL_TEXT_MAX_LENGTH) ||
      text;
    return {
      awaiting: { awaitingId, mode, count, title: `等待填写 ${count} 个表单`, timeoutMs },
      title: `等待填写 ${count} 个表单`,
      text,
      detailText
    };
  }

  const count = Math.max(approvals.length, 1);
  const text = firstRecordText(approvals, ["summary", "description", "risk", "command"]) ||
    sanitizeDesktopPetPreviewText(event.message, ITEM_TEXT_MAX_LENGTH) ||
    "等待你审批操作";
  const detailText = firstRecordText(approvals, ["command", "summary", "description", "risk"], DETAIL_TEXT_MAX_LENGTH) ||
    sanitizeDesktopPetPreviewText(event.message, DETAIL_TEXT_MAX_LENGTH) ||
    text;
  return {
    awaiting: { awaitingId, mode: mode || "approval", count, title: `等待审批 ${count} 项操作`, timeoutMs },
    title: `等待审批 ${count} 项操作`,
    text,
    detailText
  };
}

function buildAwaitingAnswerTitle(event: DesktopPetPreviewEvent) {
  const data = isObjectRecord(event.data) ? event.data : {};
  const dataStatus = toText(data.status);
  const error = isObjectRecord(data.error) ? data.error : null;
  const errorCode = toText(error?.code);
  const status = event.status || dataStatus || errorCode;
  if (status === "timeout" || errorCode === "timeout") {
    return "确认超时";
  }
  if (status === "rejected") {
    return "已拒绝确认";
  }
  if (status === "cancelled" || status === "canceled" || errorCode === "user_dismissed") {
    return "已取消确认";
  }
  if (status === "error" || errorCode === "invalid_submit") {
    return "确认提交失败";
  }
  return "已收到确认";
}

function artifactNames(event: DesktopPetPreviewEvent) {
  return (event.artifacts ?? [])
    .map((artifact) => sanitizeDesktopPetPreviewText(artifact, 28))
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeItemStatus(status: DesktopPetPreviewItemStatus): DesktopPetPreviewItemStatus {
  return status === "done" ? "success" : status;
}

export class DesktopPetPreviewProjector {
  private panel: DesktopPetPreviewPanel | null = null;
  private expanded = false;
  private seenKeys = new Set<string>();
  private responsePreview = "";

  getPanel() {
    return this.panel;
  }

  clear() {
    this.panel = null;
    this.responsePreview = "";
    this.seenKeys.clear();
    return this.panel;
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    if (this.panel) {
      this.panel = {
        ...this.panel,
        expanded,
        updatedAt: new Date().toISOString()
      };
    }
    return this.panel;
  }

  ingest(rawEvent: unknown, _meta: DesktopPetPreviewMeta = {}): DesktopPetPreviewIngestResult {
    const event = normalizeDesktopPetAgentEvent(rawEvent);
    if (!event) {
      return { changed: false, panel: this.panel, refresh: "none" };
    }

    const dedupeKey = getEventDedupeKey(event);
    if (dedupeKey && this.seenKeys.has(dedupeKey)) {
      return { changed: false, panel: this.panel, refresh: "none" };
    }

    if (!this.panel || isStartEvent(event.type)) {
      this.panel = createDefaultPanel(event, this.expanded);
      this.responsePreview = "";
      this.seenKeys.clear();
    } else if (event.runId !== this.panel.runId) {
      if (this.panel.status === "waiting" && !isStartEvent(event.type)) {
        return { changed: false, panel: this.panel, refresh: "none" };
      }
      return { changed: false, panel: this.panel, refresh: "none" };
    }

    if (dedupeKey) {
      this.seenKeys.add(dedupeKey);
    }

    const holdMs = this.applyEvent(event);
    return {
      changed: true,
      panel: this.panel,
      refresh: isDeltaEvent(event.type) ? "throttled" : "immediate",
      ...(holdMs ? { holdMs } : {})
    };
  }

  private applyEvent(event: DesktopPetPreviewEvent) {
    if (!this.panel) {
      return undefined;
    }
    this.panel = {
      ...this.panel,
      chatId: event.chatId ?? this.panel.chatId,
      visible: true,
      updatedAt: event.createdAt
    };

    if (event.type === "request.query" || event.type === "run.start") {
      this.panel.title = "思考中...";
      this.panel.status = "running";
      this.panel.summary = sanitizeDesktopPetPreviewText(event.message, SUMMARY_MAX_LENGTH) || "开始处理请求";
      const detailText = readEventDetailField(event, "message", "query", "prompt", "input", "content", "text") ||
        this.panel.summary;
      this.upsertItem("run:start", "status", "开始处理请求", this.panel.summary, "running", event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("reasoning.")) {
      const text = readContentText(event) || "正在整理思路";
      const done = event.type === "reasoning.end" || event.type === "reasoning.snapshot";
      const detailText = readContentDetail(event) || text;
      this.panel.summary = text;
      this.upsertItem("reasoning", "thinking", done ? "思考过程" : "思考中", text, done ? "success" : "running", event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("content.")) {
      const responsePreview = this.rememberResponsePreview(event);
      const text = responsePreview ? truncateReplyPreview(responsePreview) : "正在生成回复";
      const done = event.type === "content.end" || event.type === "content.snapshot";
      const detailText = sanitizeDesktopPetPreviewText(responsePreview, DETAIL_TEXT_MAX_LENGTH) || readContentDetail(event) || text;
      this.panel.summary = text;
      this.upsertItem("content", "content", done ? "回复已生成" : "回复生成中", text, done ? "success" : "running", event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("tool.")) {
      const label = readToolLabel(event);
      const id = `tool:${event.toolCallId || label}`;
      const status = statusForTool(event);
      const text = event.type === "tool.args"
        ? "参数已准备"
        : sanitizeDesktopPetPreviewText(event.error || event.message || event.target, ITEM_TEXT_MAX_LENGTH) || (status === "running" ? "正在执行" : "工具返回结果");
      const detailText = readToolDetail(event, text);
      this.panel.summary = status === "error" ? `${label} 失败` : status === "running" ? `正在使用 ${label}` : `${label} 完成`;
      this.upsertItem(id, "tool", status === "running" ? `正在使用 ${label}` : `工具 ${label}`, text, status, event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("action.")) {
      const label = readActionLabel(event);
      const id = `action:${event.actionId || event.toolCallId || label}`;
      const status = statusForTool(event);
      const text = event.type === "action.args"
        ? "参数已准备"
        : sanitizeDesktopPetPreviewText(event.error || event.message || event.target, ITEM_TEXT_MAX_LENGTH) || (status === "running" ? "正在执行" : "操作返回结果");
      const detailText = readActionDetail(event, text);
      this.panel.summary = status === "error" ? `${label} 失败` : status === "running" ? `正在执行 ${label}` : `${label} 完成`;
      this.upsertItem(id, "action", status === "running" ? `正在执行 ${label}` : `操作 ${label}`, text, status, event.createdAt, detailText);
      return undefined;
    }

    if (
      event.type === "awaiting.ask" ||
      event.type === "awaiting.asking" ||
      event.type === "awaiting.confirm"
    ) {
      const preview = buildAwaitingPreview(event);
      this.panel.status = "waiting";
      this.panel.title = "等待你确认";
      this.panel.summary = preview.title;
      this.panel.awaiting = preview.awaiting;
      this.upsertItem(`awaiting:${preview.awaiting.awaitingId}`, "awaiting", preview.title, preview.text, "waiting", event.createdAt, preview.detailText);
      return undefined;
    }

    if (event.type === "request.submit") {
      this.panel.summary = "已提交确认";
      this.upsertItem(`submit:${event.awaitingId || event.seq || event.createdAt}`, "awaiting-answer", "已提交确认", "等待运行继续", "success", event.createdAt, "已提交确认，等待运行继续");
      return undefined;
    }

    if (event.type === "awaiting.answer" || event.type === "awaiting.answered") {
      const title = buildAwaitingAnswerTitle(event);
      const status: DesktopPetPreviewItemStatus = title.includes("失败") || title.includes("超时") ? "error" : title.includes("取消") || title.includes("拒绝") ? "cancelled" : "success";
      this.panel.status = "running";
      this.panel.title = "思考中...";
      this.panel.summary = title;
      this.panel.awaiting = undefined;
      this.upsertItem(`answer:${event.awaitingId || event.seq || event.createdAt}`, "awaiting-answer", title, "确认流程已返回", status, event.createdAt, "确认流程已返回，继续处理请求");
      return undefined;
    }

    if (event.type === "artifact.publish") {
      const count = event.artifactCount || (event.artifacts ?? []).length || 1;
      const names = artifactNames(event);
      const text = names.length > 0 ? names.join(" · ") : sanitizeDesktopPetPreviewText(event.message, ITEM_TEXT_MAX_LENGTH) || "产物已生成";
      const detailText = names.length > 0
        ? names.join(" · ")
        : sanitizeDesktopPetPreviewText(event.message || event.data, DETAIL_TEXT_MAX_LENGTH) || `生成 ${count} 个文件`;
      this.panel.artifactCount += count;
      this.panel.summary = names[0] || `生成 ${count} 个文件`;
      this.upsertItem(`artifact:${event.seq || event.createdAt}`, "artifact", "生成产物", text || `生成 ${count} 个文件`, event.status === "error" ? "error" : "success", event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("plan.")) {
      const text = sanitizeDesktopPetPreviewText(event.message || event.data, ITEM_TEXT_MAX_LENGTH) || "计划已更新";
      const detailText = readEventDetailField(event, "message", "summary", "description", "content", "text") || text;
      this.panel.summary = text;
      this.upsertItem("plan", "plan", "更新计划", text, "success", event.createdAt, detailText);
      return undefined;
    }

    if (event.type.startsWith("task.")) {
      const taskId = event.taskId || event.groupId || event.taskName || String(event.seq || event.createdAt);
      const text = sanitizeDesktopPetPreviewText(event.taskName || event.message || event.subAgentKey || event.data, ITEM_TEXT_MAX_LENGTH) || "子任务";
      const status: DesktopPetPreviewItemStatus = event.type === "task.fail" ? "error" : event.type === "task.cancel" ? "cancelled" : event.type === "task.complete" ? "success" : "running";
      const detailText = readEventDetailField(event, "taskName", "message", "summary", "description", "subAgentKey") || text;
      this.panel.summary = status === "running" ? `子任务开始：${text}` : `子任务${status === "success" ? "完成" : status === "error" ? "失败" : "取消"}`;
      this.upsertItem(`task:${taskId}`, "task", status === "running" ? "子任务开始" : "子任务更新", text, status, event.createdAt, detailText);
      return undefined;
    }

    if (isTerminalEvent(event.type)) {
      const terminal = terminalStatus(event);
      const canUseCurrentSummary = this.panel.items.some((item) => item.id !== "run:start");
      const summary = resolveTerminalSummary(event, terminal, this.panel.summary, this.responsePreview, canUseCurrentSummary);
      const title = terminalTitleForPanel(terminal, summary);
      const detailText = readEventDetailField(event, "error", "message", "summary", "description", "output", "stderr", "result") ||
        summary;
      this.panel.title = title;
      this.panel.status = terminal.status;
      this.panel.summary = summary;
      this.panel.awaiting = undefined;
      this.upsertItem("run:terminal", "status", title, summary, terminal.itemStatus, event.createdAt, detailText);
      return terminal.holdMs;
    }

    return undefined;
  }

  private rememberResponsePreview(event: DesktopPetPreviewEvent) {
    const incoming = readContentText(event, DETAIL_TEXT_MAX_LENGTH);
    if (!incoming || isGenericDoneSummary(incoming)) {
      return this.responsePreview;
    }
    this.responsePreview = event.type === "content.delta"
      ? sanitizeDesktopPetPreviewText(`${this.responsePreview}${incoming}`, DETAIL_TEXT_MAX_LENGTH)
      : incoming;
    return this.responsePreview;
  }

  private upsertItem(
    id: string,
    kind: DesktopPetPreviewItemKind,
    title: string,
    text: string,
    status: DesktopPetPreviewItemStatus,
    createdAt: string,
    detailText?: string
  ) {
    if (!this.panel) {
      return;
    }
    const nextItem: DesktopPetPreviewItem = {
      id,
      kind,
      title: truncateText(title, 36),
      text: sanitizeDesktopPetPreviewText(text, ITEM_TEXT_MAX_LENGTH),
      detailText: sanitizeDesktopPetPreviewText(detailText, DETAIL_TEXT_MAX_LENGTH) || undefined,
      status: normalizeItemStatus(status),
      createdAt
    };
    const index = this.panel.items.findIndex((item) => item.id === id);
    const items = index >= 0
      ? this.panel.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...nextItem } : item)
      : [...this.panel.items, nextItem];
    this.panel.items = clampItems(items);
  }
}

function parseSseFrame(block: string): { event?: string; data: string } | null {
  const lines = block.split(/\r?\n/u);
  let eventName = "";
  const dataLines: string[] = [];
  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }
    if (rawLine.startsWith("event:")) {
      eventName = rawLine.slice(6).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return {
    event: eventName || undefined,
    data: dataLines.join("\n")
  };
}

export class DesktopPetSseParser {
  private buffer = "";

  push(chunk: string): DesktopPetSseParseResult {
    this.buffer += chunk;
    const blocks = this.buffer.split(/\r?\n\r?\n/u);
    this.buffer = blocks.pop() || "";
    return this.parseBlocks(blocks);
  }

  finish(): DesktopPetSseParseResult {
    const tail = this.buffer.trim() ? [this.buffer] : [];
    this.buffer = "";
    return this.parseBlocks(tail);
  }

  private parseBlocks(blocks: string[]): DesktopPetSseParseResult {
    const events: DesktopPetPreviewEvent[] = [];
    const errors: string[] = [];
    let done = false;
    for (const block of blocks) {
      const frame = parseSseFrame(block);
      if (!frame) {
        continue;
      }
      if (frame.data === DONE_SENTINEL) {
        done = true;
        continue;
      }
      try {
        const parsed = JSON.parse(frame.data) as Record<string, unknown>;
        if (frame.event && !toText(parsed.type) && frame.event !== "message") {
          parsed.type = frame.event;
        }
        const event = normalizeDesktopPetAgentEvent(parsed);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { events, done, errors };
  }
}

export const __testInternals = {
  DONE_HOLD_MS,
  ERROR_HOLD_MS,
  STOPPED_HOLD_MS,
  normalizeDesktopPetAgentEvent,
  sanitizeDesktopPetPreviewText
};
