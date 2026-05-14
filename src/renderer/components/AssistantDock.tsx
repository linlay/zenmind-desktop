import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type WheelEvent } from "react";
import type {
  AssistantAttachment,
  AssistantAttachmentPickResult,
  AssistantAwaitingPayload,
  AssistantChatMessage,
  AssistantChatSummary,
  AssistantPageContext,
  AssistantPermissionMode,
  AssistantRunEvent,
  AssistantRunEventStatus,
  AssistantRunAction,
  AssistantSettingsPublic,
  AssistantVoiceCorrectionLocale,
  DesktopPetAgentOption
} from "../../shared/contracts";
import { ZENMIND_ASSISTANT_WONDERS } from "../../shared/assistant-capabilities";
import { DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY } from "../../shared/desktop-pet";
import { AssistantAwaitingDialog } from "./AssistantAwaitingDialog";
import { AssistantMarkdownContent } from "./AssistantMarkdownContent";
import { AttachmentImagePreview } from "./AttachmentImagePreview";
import {
  getArtifactAttachmentsFromEvent,
  getArtifactAttachmentsFromMessages,
  mergeAssistantAttachments
} from "../services/assistantArtifacts";
import {
  attachRunningAssistantPlaceholder,
  ensureAssistantMessageForRun as ensureRemoteAssistantMessageForRun,
  getAssistantErrorContent,
  getAssistantEventAwaitingPayload,
  getLatestPendingAwaitingPayload,
  getLatestRunningRunId,
  getVisibleAssistantMessages,
  isStructuredAssistantEvent,
  isTerminalAssistantEvent,
  mergeOptimisticRunMessages,
  shouldEnsureAssistantMessageForEvent
} from "../services/assistantEventState";
import { getAssistantPageContext } from "../services/assistantPageContext";

export type AssistantDockMode = "full" | "compact";

type AssistantDockProps = {
  open: boolean;
  mode: AssistantDockMode;
  isMac: boolean;
  isWindows: boolean;
  nativeDialogVisible?: boolean;
  showLauncher?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onModeChange: (mode: AssistantDockMode) => void;
  requestedChatId?: string | null;
  onOpenSettings: () => void;
};

type VoiceState = "idle" | "recording" | "correcting";

const VOICE_TRANSCRIPTION_LOCALE: AssistantVoiceCorrectionLocale = "zh-CN-mixed-en";
const FULL_ACCESS_DURATION_MS = 10 * 60 * 1000;
const VOICE_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus"
];

function getRunEventText(event: AssistantRunEvent) {
  if (event.message) {
    return event.message;
  }
  switch (event.type) {
    case "request.query":
      return "已收到请求。";
    case "chat.start":
      return "已进入桌面单智能体会话。";
    case "run.start":
      return "已开始生成。";
    case "memory.recalled":
    case "memory.reference":
      return "已引用本地记忆。";
    case "memory.stored":
      return "已保存本地记忆。";
    case "memory.skipped":
      return "已跳过低价值记忆。";
    case "tool.start":
      return event.toolName ? `正在执行 ${event.toolName}。` : "正在执行工具。";
    case "tool.args":
      return event.toolName ? `${event.toolName} 参数已准备。` : "工具参数已准备。";
    case "tool.result":
      return event.status === "ok" ? "工具执行完成。" : "工具执行未完成。";
    case "tool.end":
      return event.status === "ok" ? "工具已结束。" : "工具已停止。";
    case "awaiting.confirm":
    case "awaiting.ask":
      return "等待用户确认。";
    case "awaiting.answer":
      return event.status === "ok" || event.status === "answered"
        ? "用户已确认。"
        : event.status === "timeout"
          ? "确认已超时。"
          : "用户未确认。";
    case "artifact.publish":
      return event.message || "已生成产物。";
    case "run.complete":
      return "生成完成。";
    case "run.error":
      return event.error ? `生成失败：${event.error}` : "生成失败。";
    case "run.stopped":
      return "已停止生成。";
    case "done":
      return "";
    case "content.delta":
    default:
      return "";
  }
}

function getRunTimelineStatusText(runId: string, runningRunId: string | null, events: AssistantRunEvent[]) {
  const lastEvent = events[events.length - 1];
  if (!lastEvent) {
    return runningRunId === runId ? "运行中" : "";
  }
  if (lastEvent.type === "awaiting.confirm" || lastEvent.type === "awaiting.ask" || lastEvent.status === "blocked" || lastEvent.status === "waiting") {
    return "待确认";
  }
  if (lastEvent.type === "run.error" || lastEvent.status === "error") {
    return "失败";
  }
  if (lastEvent.type === "run.stopped" || lastEvent.status === "stopped") {
    return "已停止";
  }
  if (runningRunId === runId || lastEvent.status === "running") {
    return "运行中";
  }
  return "已完成";
}

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

type AssistantMemoryReference = {
  id?: string;
  title?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt?: string;
  reason?: string;
};

type OperatorModeInfo = {
  expiresAt: number;
  remainingMs: number;
};

type AssistantTimelineRecordStatus = AssistantRunEventStatus | "pending";

type AssistantTimelineToolRecord = {
  id: string;
  title: string;
  status: AssistantTimelineRecordStatus;
  statusLabel: string;
  verificationLabel?: string;
  argsData?: unknown;
  resultData?: unknown;
  resultText: string;
  errorText: string;
};

type AssistantTimelineToolItem = {
  kind: "tool";
  id: string;
  title: string;
  status: AssistantTimelineRecordStatus;
  statusLabel: string;
  records: AssistantTimelineToolRecord[];
};

type AssistantTimelineTextItem = {
  kind: "thinking" | "awaiting" | "artifact";
  id: string;
  title: string;
  text: string;
  status: AssistantTimelineRecordStatus;
};

type AssistantTimelineItem = AssistantTimelineToolItem | AssistantTimelineTextItem;

const TOOL_LABELS: Record<string, string> = {
  browser_observe: "观察网页",
  browser_snapshot: "页面快照",
  browser_wait: "等待网页",
  browser_extract: "提取结果",
  browser_open_url: "打开网页",
  browser_navigate: "网页导航",
  browser_click: "点击页面",
  browser_fill: "填写输入",
  browser_autofill: "自动填表",
  browser_select: "选择选项",
  browser_check: "切换选项",
  browser_submit: "提交页面",
  browser_read: "读取网页",
  browser_cdp_command: "CDP 命令",
  service_list: "服务列表",
  service_control: "服务控制",
  service_verify: "服务复查",
  desktop_file_read: "读取文件",
  desktop_file_write: "写入文件",
  desktop_file_list: "查看目录",
  desktop_create_docx: "生成 Word",
  desktop_create_pdf: "生成 PDF",
  desktop_create_xlsx: "生成 Excel",
  desktop_create_pptx: "生成 PPT",
  host_app_launch: "启动应用",
  bash_sandbox: "执行命令",
  operator_mode_request: "权限模式",
  operator_mode_revoke: "权限模式",
  artifact_publish: "生成产物",
  _ask_user_question_: "询问用户"
};

const MAX_TIMELINE_DETAIL_LENGTH = 1800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getAssistantMemoryReferences(event: AssistantRunEvent): AssistantMemoryReference[] {
  if (event.type !== "memory.reference" || !isRecord(event.data) || !Array.isArray(event.data.references)) {
    return [];
  }
  return event.data.references
    .filter(isRecord)
    .map((reference) => ({
      id: typeof reference.id === "string" ? reference.id : undefined,
      title: typeof reference.title === "string" ? reference.title : undefined,
      path: typeof reference.path === "string" ? reference.path : undefined,
      lineStart: typeof reference.lineStart === "number" ? reference.lineStart : undefined,
      lineEnd: typeof reference.lineEnd === "number" ? reference.lineEnd : undefined,
      excerpt: typeof reference.excerpt === "string" ? reference.excerpt : undefined,
      reason: typeof reference.reason === "string" ? reference.reason : undefined
    }))
    .filter((reference) => reference.title || reference.excerpt || reference.path);
}

function getNestedRecord(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }
  const child = value[key];
  return isRecord(child) ? child : null;
}

function getOperatorModeInfo(events: AssistantRunEvent[], nowMs: number): OperatorModeInfo | null {
  const operatorEvents = events
    .filter((event) => event.toolName === "operator_mode_request" || event.toolName === "operator_mode_revoke")
    .sort((left, right) => right.seq - left.seq);
  const latest = operatorEvents[0];
  if (!latest || latest.toolName === "operator_mode_revoke" || latest.status !== "ok") {
    return null;
  }
  const resultData = getNestedRecord(latest.data, "data");
  const grant = getNestedRecord(resultData, "grant");
  const expiresAt = typeof grant?.expiresAt === "number" ? grant.expiresAt : 0;
  if (!expiresAt || expiresAt <= nowMs) {
    return null;
  }
  return {
    expiresAt,
    remainingMs: expiresAt - nowMs
  };
}

function formatOperatorModeRemaining(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function truncateTimelineText(value: string, maxLength = MAX_TIMELINE_DETAIL_LENGTH) {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n...`;
}

function formatTimelineValue(value: unknown, maxLength = MAX_TIMELINE_DETAIL_LENGTH): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncateTimelineText(value, maxLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncateTimelineText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return truncateTimelineText(String(value), maxLength);
  }
}

function formatTimelineInlineValue(value: unknown) {
  return formatTimelineValue(value, 260).replace(/\s+/g, " ").trim();
}

function getTimelineStatusLabel(status?: AssistantTimelineRecordStatus) {
  switch (status) {
    case "running":
    case "waiting":
      return "运行中";
    case "ok":
    case "answered":
      return "完成";
    case "rejected":
      return "已拒绝";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "已超时";
    case "error":
    case "blocked":
      return "异常";
    case "stopped":
      return "已停止";
    case "pending":
    default:
      return "等待中";
  }
}

function getTimelineVerificationLabel(data: unknown) {
  const root = isRecord(data) ? data : null;
  const nestedData = root ? getNestedRecord(root, "data") : null;
  const verification = root
    ? getNestedRecord(root, "verification") ?? getNestedRecord(nestedData, "verification")
    : null;
  const error = typeof root?.error === "string"
    ? root.error
    : typeof nestedData?.error === "string"
      ? nestedData.error
      : "";
  if (verification) {
    if (typeof verification.verified === "boolean") {
      return verification.verified ? "已验证" : "验证失败";
    }
    if (typeof verification.enoughItems === "boolean") {
      return verification.enoughItems ? "已验证" : "结果不足";
    }
  }
  if (error === "insufficient_items") {
    return "结果不足";
  }
  if (error === "stale_ref") {
    return "ref 已失效";
  }
  return "";
}

function getToolDisplayName(event: AssistantRunEvent) {
  const key = event.toolName || event.action || "";
  if (key && TOOL_LABELS[key]) {
    return TOOL_LABELS[key];
  }
  if (event.message && event.type === "tool.start") {
    return event.message.replace(/[。.]$/u, "");
  }
  if (event.toolName) {
    return event.toolName.replace(/^_+|_+$/g, "").replace(/[_-]+/g, " ");
  }
  return "执行工具";
}

function getToolGroupKey(event: AssistantRunEvent) {
  return [
    event.toolName || "tool",
    event.action || "",
    event.toolCallId ? "" : event.target || ""
  ].join(":");
}

function getToolRecordKey(event: AssistantRunEvent, groupKey: string) {
  return event.toolCallId || groupKey;
}

function createToolRecord(event: AssistantRunEvent, index: number): AssistantTimelineToolRecord {
  const status = event.status || "pending";
  return {
    id: getToolRecordKey(event, `${event.toolName || "tool"}:${index}`),
    title: `第 ${index + 1} 次`,
    status,
    statusLabel: getTimelineStatusLabel(status),
    resultText: event.message || "",
    errorText: event.error || ""
  };
}

function updateToolRecordStatus(record: AssistantTimelineToolRecord, status?: AssistantRunEventStatus) {
  if (!status) {
    return;
  }
  record.status = status;
  record.statusLabel = getTimelineStatusLabel(status);
}

function buildRunTimelineItems(
  events: AssistantRunEvent[],
  runId: string,
  runningRunId: string | null
): AssistantTimelineItem[] {
  const sortedEvents = events
    .filter((event) => event.runId === runId)
    .sort((left, right) => left.seq - right.seq);
  const items: AssistantTimelineItem[] = [];
  const toolItemsByKey = new Map<string, AssistantTimelineToolItem>();
  const toolRecordsByKey = new Map<string, AssistantTimelineToolRecord>();

  const ensureToolItem = (event: AssistantRunEvent) => {
    const groupKey = getToolGroupKey(event);
    let item = toolItemsByKey.get(groupKey);
    if (!item) {
      const status = event.status || "pending";
      item = {
        kind: "tool",
        id: `tool-${groupKey}-${event.seq}`,
        title: getToolDisplayName(event),
        status,
        statusLabel: getTimelineStatusLabel(status),
        records: []
      };
      toolItemsByKey.set(groupKey, item);
      items.push(item);
    }
    return { item, groupKey };
  };

  const ensureToolRecord = (event: AssistantRunEvent, item: AssistantTimelineToolItem, groupKey: string) => {
    const recordKey = getToolRecordKey(event, groupKey);
    let record = toolRecordsByKey.get(recordKey);
    if (!record || event.type === "tool.start") {
      record = createToolRecord(event, item.records.length);
      item.records.push(record);
      toolRecordsByKey.set(recordKey, record);
    }
    return record;
  };

  for (const event of sortedEvents) {
    if (event.type === "tool.start" || event.type === "tool.args" || event.type === "tool.result" || event.type === "tool.end") {
      const { item, groupKey } = ensureToolItem(event);
      const record = ensureToolRecord(event, item, groupKey);
      updateToolRecordStatus(record, event.status);
      if (event.type === "tool.args") {
        record.argsData = event.data;
      }
      if (event.type === "tool.result") {
        record.resultData = event.data;
        record.resultText = event.message || formatTimelineValue(event.data) || record.resultText;
        record.errorText = event.error || record.errorText;
        record.verificationLabel = getTimelineVerificationLabel(event.data) || record.verificationLabel;
      }
      if (event.type === "tool.end" && event.message && !record.resultText) {
        record.resultText = event.message;
      }
      item.status = record.status;
      item.statusLabel = record.statusLabel;
      continue;
    }

    if (event.type === "awaiting.confirm" || event.type === "awaiting.ask" || event.type === "awaiting.answer") {
      const status = event.status || (event.type === "awaiting.answer" ? "answered" : "waiting");
      items.push({
        kind: "awaiting",
        id: event.id,
        title: event.type === "awaiting.answer" ? "用户确认" : "等待确认",
        text: getRunEventText(event),
        status
      });
      continue;
    }

    if (event.type === "artifact.publish") {
      const status = event.status || "ok";
      items.push({
        kind: "artifact",
        id: event.id,
        title: "生成产物",
        text: getRunEventText(event),
        status
      });
    }
  }

  const isRunning = runningRunId === runId;
  if (items.length > 0 || isRunning) {
    items.unshift({
      kind: "thinking",
      id: `thinking-${runId}`,
      title: isRunning ? "思考中..." : "思考过程",
      text: isRunning
        ? items.length > 0
          ? "正在根据上下文推进下一步。"
          : "正在理解请求并整理下一步。"
        : "本轮运行过程已整理完成。",
      status: isRunning ? "running" : "ok"
    });
  }

  return items;
}

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0?: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = {
  error: string;
  message?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructorLike;
  webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
};

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") {
    return null;
  }
  const browserWindow = window as SpeechRecognitionWindow;
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

function getPreferredVoiceAudioMimeType() {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
    return "";
  }
  return VOICE_AUDIO_MIME_TYPES.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function canUseRecordedVoiceInput() {
  return Boolean(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

function canUseVoiceInput() {
  return canUseRecordedVoiceInput() || Boolean(getSpeechRecognitionConstructor());
}

function normalizeVoiceFeedbackMessage(message: string) {
  const compact = message.replace(/\s+/gu, " ").trim();
  if (!compact) {
    return "语音识别失败。";
  }
  const maxLength = 180;
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function waitForAssistantDockPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function createOptimisticMessage(
  role: AssistantChatMessage["role"],
  content: string,
  runId?: string,
  attachments?: AssistantAttachment[]
) {
  const messageAttachments = attachments?.length ? attachments : undefined;
  return {
    id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(runId ? { runId } : {}),
    ...(messageAttachments ? { attachments: messageAttachments } : {})
  } satisfies AssistantChatMessage;
}

function hasUsefulPageText(pageContext: AssistantPageContext | null) {
  if (!pageContext) {
    return false;
  }
  return Boolean(
    pageContext.bodyText.trim() ||
    pageContext.selectedText.trim() ||
    pageContext.metaDescription.trim() ||
    pageContext.headings.length > 0
  );
}

function mergeVoiceText(baseDraft: string, transcript: string) {
  const voiceText = transcript.trimStart();
  if (!voiceText) {
    return baseDraft;
  }
  if (!baseDraft.trim()) {
    return voiceText;
  }
  const spacer = /\s$/u.test(baseDraft) ? "" : " ";
  return `${baseDraft}${spacer}${voiceText}`;
}

function getVoiceErrorMessage(error: string) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未开启。";
    case "no-speech":
      return "没有识别到语音。";
    case "audio-capture":
      return "未检测到可用麦克风。";
    case "network":
      return "语音识别网络不可用。";
    default:
      return "语音输入启动失败。";
  }
}

function getVoiceUnsupportedMessage(isMac: boolean, isWindows: boolean) {
  if (isMac) {
    return "当前 macOS Electron 环境无法访问麦克风语音输入。";
  }
  if (isWindows) {
    return "当前 Windows Electron 环境无法访问麦克风语音输入。";
  }
  return "当前 Electron 环境无法访问麦克风语音输入。";
}

function getVoiceCaptureErrorMessage(reason: unknown, isMac: boolean, isWindows: boolean) {
  const error = reason instanceof DOMException || reason instanceof Error ? reason : null;
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    if (isMac) {
      return "麦克风权限未开启，请在系统设置中允许 ZenMind 访问麦克风。";
    }
    if (isWindows) {
      return "麦克风权限未开启，请在 Windows 隐私设置中允许 ZenMind 访问麦克风。";
    }
    return "麦克风权限未开启。";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "未检测到可用麦克风。";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "麦克风正被其他应用占用。";
  }
  return error?.message || "语音输入启动失败。";
}

function normalizeChatText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function getChatDisplayTitle(chat: AssistantChatSummary | null | undefined, fallback = "当前对话") {
  return normalizeChatText(chat?.title ?? "") || fallback;
}

function getChatPreview(chat: AssistantChatSummary) {
  return normalizeChatText(chat.lastMessage) || `${chat.messageCount} 条消息`;
}

function getChatAvatarLabel(title: string) {
  return title.trim().charAt(0).toLocaleUpperCase() || "Z";
}

function formatChatUpdatedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) {
    return "刚刚";
  }
  if (diffMs < hour) {
    return `${Math.floor(diffMs / minute)} 分钟前`;
  }
  if (diffMs < day) {
    return `${Math.floor(diffMs / hour)} 小时前`;
  }
  if (diffMs < 7 * day) {
    return `${Math.floor(diffMs / day)} 天前`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric"
  }).format(new Date(timestamp));
}

function ZenMindLogoIcon() {
  return (
    <img
      src="./brand-icon.png"
      alt=""
      className="assistant-dock-logo-icon"
      draggable={false}
    />
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="m8.8 12.2 5.1-5.1a3.3 3.3 0 0 1 4.6 4.6l-6.3 6.3a5 5 0 0 1-7.1-7.1l6.7-6.7" />
      <path d="m10 13.4 5.6-5.6a1.8 1.8 0 0 1 2.5 2.5l-5.8 5.8a2.5 2.5 0 0 1-3.5-3.5" />
    </svg>
  );
}

function ScreenshotIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      <path d="M9 9h6v6H9z" />
    </svg>
  );
}

function FileArtifactIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  );
}

function MicrophoneIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="m4 12 15-7-4.5 14-3-5.5L4 12Z" />
      <path d="m11.5 13.5 7.5-8.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8 8h8v8H8z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M21 12a9 9 0 0 1-15.3 6.4" />
      <path d="M3 12A9 9 0 0 1 18.3 5.6" />
      <path d="M18 2v4h4" />
      <path d="M6 22v-4H2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
      <path d="M15 4h5v5" />
      <path d="m11 13 8.5-8.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function CompactIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M5 5h14v14H5z" />
      <path d="M14 5v14" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8 3H3v5" />
      <path d="M16 3h5v5" />
      <path d="M21 16v5h-5" />
      <path d="M3 16v5h5" />
    </svg>
  );
}

function ThinkingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 3a7 7 0 0 0-4 12.74V18h8v-2.26A7 7 0 0 0 12 3Z" />
      <path d="M9 21h6" />
      <path d="M10 9h.01" />
      <path d="M14 9h.01" />
      <path d="M10.5 12.5a2.6 2.6 0 0 0 3 0" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="m14.7 6.3 3-3a4 4 0 0 1-5 5l-7.4 7.4a2 2 0 0 0 3 3l7.4-7.4a4 4 0 0 1-1-5Z" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function AwaitingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 6v6l4 2" />
      <path d="M21 12a9 9 0 1 1-4.3-7.7" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 3 19 6v5c0 4.6-2.7 8-7 10-4.3-2-7-5.4-7-10V6l7-3Z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M14 11V6a1.5 1.5 0 0 1 3 0v7" />
      <path d="M8 12 6.8 10.8a1.6 1.6 0 0 0-2.3 2.2l4.2 5A6 6 0 0 0 19 14v-3a1.5 1.5 0 0 0-3 0" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function AssistantDock({
  open,
  mode,
  isMac,
  isWindows,
  nativeDialogVisible = false,
  showLauncher = true,
  onOpen,
  onClose,
  onModeChange,
  requestedChatId,
  onOpenSettings
}: AssistantDockProps) {
  const [settings, setSettings] = useState<AssistantSettingsPublic | null>(null);
  const [agentOptions, setAgentOptions] = useState<DesktopPetAgentOption[]>([]);
  const [selectedAgentKey, setSelectedAgentKey] = useState("");
  const [agentOptionsLoading, setAgentOptionsLoading] = useState(false);
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [runEvents, setRunEvents] = useState<AssistantRunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [loadingChatId, setLoadingChatId] = useState("");
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [activeAttachmentTaskId, setActiveAttachmentTaskId] = useState<string | null>(null);
  const [activeAwaiting, setActiveAwaiting] = useState<AssistantAwaitingPayload | null>(null);
  const [artifactDockVisible, setArtifactDockVisible] = useState(true);
  const [hiddenArtifactIds, setHiddenArtifactIds] = useState<Set<string>>(() => new Set());
  const [attachmentPickerVisible, setAttachmentPickerVisible] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceSupported, setVoiceSupported] = useState(() => canUseVoiceInput());
  const [voiceFeedback, setVoiceFeedback] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [permissionMode, setPermissionMode] = useState<AssistantPermissionMode>("default");
  const [fullAccessExpiresAt, setFullAccessExpiresAt] = useState<number | null>(null);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryQuery, setChatHistoryQuery] = useState("");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentMenuPinned, setAttachmentMenuPinned] = useState(false);
  const [previewImageAttachment, setPreviewImageAttachment] = useState<AssistantAttachment | null>(null);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const runningRunIdRef = useRef<string | null>(runningRunId);
  const runMessageIdsRef = useRef(new Map<string, string>());
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const attachmentMenuCloseTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatHistoryRef = useRef<HTMLDivElement | null>(null);
  const chatHistorySearchRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef(draft);
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceMediaStreamRef = useRef<MediaStream | null>(null);
  const voiceAudioChunksRef = useRef<Blob[]>([]);
  const voiceBaseDraftRef = useRef("");
  const voiceCurrentTranscriptRef = useRef("");
  const voiceFinalTranscriptRef = useRef("");
  const voiceStopRequestedRef = useRef(false);
  const voiceCancelCorrectionRef = useRef(false);
  const voiceRecognitionFallbackToRecorderRef = useRef(false);
  const voiceCorrectionRequestIdRef = useRef(0);
  const voiceRecognitionStartingRef = useRef(false);
  const voiceRecognitionActiveRef = useRef(false);
  const voiceRecorderActiveRef = useRef(false);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    runningRunIdRef.current = runningRunId;
  }, [runningRunId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!open) {
      setChatHistoryOpen(false);
      setChatHistoryQuery("");
      closeAttachmentMenu();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let canceled = false;
    setAgentOptionsLoading(true);
    window.electronAPI.assistant.listAgents()
      .then((agents) => {
        if (canceled) {
          return;
        }
        const nextAgents = Array.isArray(agents) ? agents : [];
        setAgentOptions(nextAgents);
        setSelectedAgentKey((current) => {
          if (current && nextAgents.some((agent) => agent.agentKey === current)) {
            return current;
          }
          return nextAgents.find((agent) => agent.agentKey === DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY)?.agentKey ||
            nextAgents[0]?.agentKey ||
            "";
        });
      })
      .catch((reason) => {
        if (canceled) {
          return;
        }
        console.warn("[assistant-dock] failed to load agent options", reason);
        setAgentOptions([]);
        setSelectedAgentKey("");
      })
      .finally(() => {
        if (!canceled) {
          setAgentOptionsLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!attachmentMenuOpen) {
      return undefined;
    }
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && attachmentMenuRef.current?.contains(target)) {
        return;
      }
      closeAttachmentMenu();
    };
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAttachmentMenu();
      }
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [attachmentMenuOpen]);

  useEffect(() => {
    if (runningRunId) {
      closeAttachmentMenu();
    }
  }, [runningRunId]);

  useEffect(() => () => clearAttachmentMenuCloseTimer(), []);

  useEffect(() => {
    if (!chatHistoryOpen) {
      return undefined;
    }

    const focusTimer = window.setTimeout(() => {
      chatHistorySearchRef.current?.focus();
    }, 0);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && chatHistoryRef.current?.contains(target)) {
        return;
      }
      setChatHistoryOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatHistoryOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [chatHistoryOpen]);

  function updateDraft(nextDraft: string) {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function ensureAssistantMessageForRun(runId: string) {
    return ensureRemoteAssistantMessageForRun(runId, runMessageIdsRef.current, setMessages, "remote_");
  }

  function attachRunningPlaceholder(messagesForChat: AssistantChatMessage[], runId: string | null) {
    return attachRunningAssistantPlaceholder(messagesForChat, runId, runMessageIdsRef.current, "remote_");
  }

  function getEffectivePermissionMode(now = Date.now()): AssistantPermissionMode {
    return permissionMode === "full_access" && Boolean(fullAccessExpiresAt && fullAccessExpiresAt > now)
      ? "full_access"
      : "default";
  }

  function formatFullAccessRemaining(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function handlePermissionModeChange(nextMode: AssistantPermissionMode) {
    if (nextMode === "full_access") {
      setPermissionMode("full_access");
      setFullAccessExpiresAt(Date.now() + FULL_ACCESS_DURATION_MS);
      return;
    }
    setPermissionMode("default");
    setFullAccessExpiresAt(null);
  }

  function resizeComposerTextarea() {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight);
    const cappedHeight = Number.isFinite(maxHeight)
      ? Math.min(textarea.scrollHeight, maxHeight)
      : textarea.scrollHeight;
    textarea.style.height = `${cappedHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > cappedHeight + 1 ? "auto" : "hidden";
  }

  useLayoutEffect(() => {
    resizeComposerTextarea();
  }, [draft, mode, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleWindowResize = () => resizeComposerTextarea();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [open]);

  async function refreshSettingsAndChats() {
    const [nextSettings, nextChats] = await Promise.all([
      window.electronAPI.assistant.getSettings(),
      window.electronAPI.assistant.listChats()
    ]);
    setSettings(nextSettings);
    setChats(nextChats);
  }

  useEffect(() => {
    void refreshSettingsAndChats().catch((reason) => {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.assistant.onAttachmentProgress((progress) => {
      setActiveAttachmentTaskId(progress.done ? null : progress.taskId);
      setFeedback(progress.message);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refreshSettingsAndChats().catch((reason) => {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    });
  }, [open]);

  useEffect(() => {
    if (!open || !requestedChatId) {
      return;
    }
    void loadChat(requestedChatId);
  }, [open, requestedChatId]);

  useEffect(() => {
    return window.electronAPI.assistant.onAssistantEvent((event) => {
      const isActiveChatEvent = event.chatId === activeChatIdRef.current;
      if (isStructuredAssistantEvent(event)) {
        setRunEvents((current) => {
          if (current.some((item) => item.id === event.id)) {
            return current;
          }
          return [...current, event];
        });
        if (isActiveChatEvent && event.type === "run.start") {
          setRunningRunId(event.runId);
          ensureAssistantMessageForRun(event.runId);
        }
        if (isActiveChatEvent && event.type === "awaiting.ask") {
          const awaiting = getAssistantEventAwaitingPayload(event);
          if (awaiting) {
            setActiveAwaiting(awaiting);
          }
        }
        if (isActiveChatEvent && event.type === "awaiting.answer") {
          const awaitingId = event.awaiting?.awaitingId ?? event.awaitingId;
          setActiveAwaiting((current) => {
            if (!current || (awaitingId && current.awaitingId !== awaitingId)) {
              return current;
            }
            return null;
          });
        }
      }

      const messageId = runMessageIdsRef.current.get(event.runId) ??
        (isActiveChatEvent && shouldEnsureAssistantMessageForEvent(event) ? ensureAssistantMessageForRun(event.runId) : undefined);
      if ((event.type === "delta" || event.type === "content.delta") && messageId && event.delta) {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? { ...message, content: `${message.content}${event.delta}` }
              : message
          )
        );
        return;
      }

      if (event.type === "artifact.publish" && messageId) {
        const artifactAttachments = getArtifactAttachmentsFromEvent(event);
        if (artifactAttachments.length > 0) {
          setArtifactDockVisible(true);
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? { ...message, attachments: mergeAssistantAttachments(message.attachments, artifactAttachments) }
                : message
            )
          );
        }
      }

      if (isTerminalAssistantEvent(event)) {
        if (messageId && (event.type === "error" || event.type === "run.error")) {
          const errorContent = getAssistantErrorContent(event);
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    content: message.content
                      ? `${message.content}\n\n${errorContent}`
                      : errorContent
                  }
                : message
            )
          );
        } else if (event.type === "error" || event.type === "run.error") {
          setFeedback(event.error || event.message || "生成失败。");
        }
        if (messageId && (event.type === "stopped" || event.type === "run.stopped")) {
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? { ...message, content: message.content || "已停止生成。" }
                : message
            )
          );
        }
        runMessageIdsRef.current.delete(event.runId);
        if (runningRunIdRef.current === event.runId) {
          setRunningRunId(null);
        }
        void refreshSettingsAndChats().catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => {
    if (!runningRunId || !activeChatId) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const reconcileRunningChat = async () => {
      const chatId = activeChatIdRef.current;
      const runId = runningRunIdRef.current;
      if (!chatId || !runId) {
        return;
      }

      try {
        const chat = await window.electronAPI.assistant.getChat(chatId);
        if (cancelled || !chat) {
          return;
        }
        const events = chat.events ?? [];
        setRunEvents(events);
        const terminalEvent = events.find(
          (event) => event.runId === runId && isTerminalAssistantEvent(event)
        );
        if (terminalEvent) {
          activeChatIdRef.current = chat.summary.id;
          setActiveChatId(chat.summary.id);
          setMessages(chat.messages);
          runMessageIdsRef.current.delete(runId);
          setRunningRunId(null);
          void refreshSettingsAndChats().catch(() => undefined);
          return;
        }
      } catch {
        // The live IPC event stream remains the primary path; polling is only a recovery net.
      }

      if (!cancelled) {
        timer = window.setTimeout(reconcileRunningChat, 1500);
      }
    };

    timer = window.setTimeout(reconcileRunningChat, 1500);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [activeChatId, runningRunId]);

  useEffect(() => {
    setVoiceSupported(canUseVoiceInput());
    return () => {
      voiceStopRequestedRef.current = true;
      voiceCancelCorrectionRef.current = true;
      voiceRecognitionFallbackToRecorderRef.current = false;
      voiceCorrectionRequestIdRef.current += 1;
      stopRecordedVoiceInput(true);
      voiceRecognitionRef.current?.abort();
      voiceRecognitionRef.current = null;
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open || voiceState === "idle") {
      return;
    }

    voiceStopRequestedRef.current = true;
    voiceCancelCorrectionRef.current = true;
    voiceRecognitionFallbackToRecorderRef.current = false;
    voiceCorrectionRequestIdRef.current += 1;
    if (voiceState === "recording") {
      stopRecordedVoiceInput(true);
      voiceRecognitionRef.current?.abort();
    }
    setVoiceState("idle");
  }, [open, voiceState]);

  useEffect(() => {
    if (!open) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, runEvents, open, mode]);

  useEffect(() => {
    if (!getOperatorModeInfo(runEvents, Date.now()) && !(fullAccessExpiresAt && fullAccessExpiresAt > Date.now())) {
      return undefined;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runEvents, fullAccessExpiresAt]);

  useEffect(() => {
    if (permissionMode !== "full_access" || !fullAccessExpiresAt || fullAccessExpiresAt > nowMs) {
      return;
    }
    setPermissionMode("default");
    setFullAccessExpiresAt(null);
  }, [fullAccessExpiresAt, nowMs, permissionMode]);

  async function loadChat(chatId: string) {
    setLoadingChatId(chatId);
    setFeedback("");
    try {
      const chat = await window.electronAPI.assistant.getChat(chatId);
      if (!chat) {
        setFeedback("该对话不存在或已被删除。");
        return;
      }
      const events = chat.events ?? [];
      const runningChatRunId = getLatestRunningRunId(events);
      activeChatIdRef.current = chat.summary.id;
      setActiveChatId(chat.summary.id);
      setMessages(attachRunningPlaceholder(chat.messages, runningChatRunId));
      setRunEvents(events);
      setRunningRunId(runningChatRunId);
      setAttachments([]);
      setActiveAwaiting(getLatestPendingAwaitingPayload(events));
      setArtifactDockVisible(true);
      setChatHistoryOpen(false);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingChatId("");
    }
  }

  function startNewChat() {
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
    setRunEvents([]);
    setAttachments([]);
    setActiveAwaiting(null);
    setArtifactDockVisible(true);
    setHiddenArtifactIds(new Set());
    setFeedback("");
    setVoiceFeedback("");
    setChatHistoryOpen(false);
    setChatHistoryQuery("");
  }

  async function collectPageContext(action: AssistantRunAction | "chat") {
    const pageContext = await getAssistantPageContext();
    if (action === "explain_selection" && !pageContext.selectedText.trim()) {
      throw new Error("请先在当前页面中选中文本。");
    }
    if ((action === "summarize_page" || action === "extract_todos") && !hasUsefulPageText(pageContext)) {
      throw new Error("当前页面没有可读取的文本内容。");
    }
    return pageContext;
  }

  async function finalizeVoiceTranscript(transcript: string) {
    const voiceText = transcript.trim();
    if (!voiceText) {
      setVoiceState("idle");
      return;
    }

    applyVoiceTranscript(voiceText);
  }

  function applyVoiceTranscript(transcript: string) {
    const voiceText = transcript.trim();
    if (!voiceText) {
      setVoiceState("idle");
      return;
    }

    const baseDraft = voiceBaseDraftRef.current;
    const expectedDraft = mergeVoiceText(baseDraft, voiceText);
    updateDraft(expectedDraft);
    // Voice correction is temporarily paused; keep the ASR text without calling the correction IPC.
    setVoiceFeedback("");
    setVoiceState("idle");
  }

  function ensureVoiceRecognition() {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setVoiceSupported(false);
      return null;
    }

    setVoiceSupported(true);
    if (voiceRecognitionRef.current) {
      return voiceRecognitionRef.current;
    }

    const recognition = new Recognition();
    // Web Speech only accepts one primary language; zh-CN keeps Chinese-first recognition while still allowing English fragments.
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = true;
      voiceCurrentTranscriptRef.current = "";
      voiceFinalTranscriptRef.current = "";
      voiceCancelCorrectionRef.current = false;
      setVoiceFeedback("");
      setVoiceState("recording");
    };
    recognition.onresult = (event) => {
      let interimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          voiceFinalTranscriptRef.current = `${voiceFinalTranscriptRef.current}${transcript}`;
        } else {
          interimTranscript = `${interimTranscript}${transcript}`;
        }
      }

      const nextTranscript = `${voiceFinalTranscriptRef.current}${interimTranscript}`;
      voiceCurrentTranscriptRef.current = nextTranscript;
      updateDraft(mergeVoiceText(voiceBaseDraftRef.current, nextTranscript));
    };
    recognition.onerror = (event) => {
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = false;
      const hasTranscript = Boolean(voiceCurrentTranscriptRef.current.trim());
      const shouldFallbackToRecorder =
        !voiceStopRequestedRef.current &&
        event.error === "network" &&
        !hasTranscript &&
        canUseRecordedVoiceInput();
      if (
        !voiceStopRequestedRef.current &&
        event.error !== "aborted" &&
        !hasTranscript
      ) {
        if (shouldFallbackToRecorder) {
          setVoiceFeedback("内部语音识别网络不可用，正在切换录音转写...");
        } else {
          setVoiceFeedback(event.message || getVoiceErrorMessage(event.error));
        }
      }
      voiceRecognitionFallbackToRecorderRef.current = shouldFallbackToRecorder;
      voiceCancelCorrectionRef.current = !hasTranscript && !shouldFallbackToRecorder;
      setVoiceState("idle");
    };
    recognition.onend = () => {
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = false;
      const shouldSkipCorrection = voiceCancelCorrectionRef.current;
      const shouldFallbackToRecorder = voiceRecognitionFallbackToRecorderRef.current;
      const transcript = voiceCurrentTranscriptRef.current;
      voiceStopRequestedRef.current = false;
      voiceCancelCorrectionRef.current = false;
      voiceRecognitionFallbackToRecorderRef.current = false;
      if (shouldFallbackToRecorder) {
        void startRecordedVoiceInput({
          force: true,
          preserveBaseDraft: true,
          feedback: "内部语音识别网络不可用，已切换录音转写，点击麦克风结束。"
        });
        return;
      }
      if (!shouldSkipCorrection && transcript.trim()) {
        void finalizeVoiceTranscript(transcript);
        return;
      }
      setVoiceState("idle");
    };

    voiceRecognitionRef.current = recognition;
    return recognition;
  }

  function stopRecordedVoiceInput(cancelCorrection: boolean) {
    if (cancelCorrection) {
      voiceCancelCorrectionRef.current = true;
    }
    const recorder = voiceMediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    voiceMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceMediaStreamRef.current = null;
    voiceMediaRecorderRef.current = null;
    voiceRecorderActiveRef.current = false;
  }

  async function finishRecordedVoiceInput(mimeType: string) {
    const shouldSkipCorrection = voiceCancelCorrectionRef.current;
    const chunks = voiceAudioChunksRef.current;
    voiceAudioChunksRef.current = [];
    voiceMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceMediaStreamRef.current = null;
    voiceMediaRecorderRef.current = null;
    voiceRecorderActiveRef.current = false;
    voiceStopRequestedRef.current = false;

    if (shouldSkipCorrection) {
      voiceCancelCorrectionRef.current = false;
      setVoiceState("idle");
      return;
    }
    if (chunks.length === 0) {
      setVoiceFeedback("没有录到可识别的语音。");
      setVoiceState("idle");
      return;
    }

    setVoiceState("correcting");
    setVoiceFeedback("正在识别语音...");
    try {
      const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" });
      const result = await window.electronAPI.assistant.transcribeVoiceAudio({
        mimeType: blob.type || "audio/webm",
        data: await blob.arrayBuffer(),
        locale: VOICE_TRANSCRIPTION_LOCALE
      });
      if (!result.ok) {
        setVoiceFeedback(normalizeVoiceFeedbackMessage(result.message));
        setVoiceState("idle");
        return;
      }
      await finalizeVoiceTranscript(result.text);
    } catch (reason) {
      setVoiceFeedback(normalizeVoiceFeedbackMessage(reason instanceof Error ? reason.message : "语音识别失败。"));
      setVoiceState("idle");
    }
  }

  async function startRecordedVoiceInput(
    options: { force?: boolean; preserveBaseDraft?: boolean; feedback?: string } = {}
  ) {
    if (runningRunId || voiceRecorderActiveRef.current || (!options.force && voiceState !== "idle")) {
      return;
    }

    if (!options.preserveBaseDraft) {
      voiceBaseDraftRef.current = draftRef.current;
    }
    voiceCurrentTranscriptRef.current = "";
    voiceFinalTranscriptRef.current = "";
    voiceStopRequestedRef.current = false;
    voiceCancelCorrectionRef.current = false;
    voiceAudioChunksRef.current = [];
    setVoiceFeedback(options.feedback || "正在监听，点击麦克风结束。");
    setVoiceState("recording");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const mimeType = getPreferredVoiceAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceMediaStreamRef.current = stream;
      voiceMediaRecorderRef.current = recorder;
      voiceRecorderActiveRef.current = true;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceAudioChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = (event) => {
        voiceCancelCorrectionRef.current = true;
        setVoiceFeedback(event.error?.message || "录音失败。");
        stopRecordedVoiceInput(true);
        setVoiceState("idle");
      };
      recorder.onstop = () => {
        void finishRecordedVoiceInput(recorder.mimeType || mimeType);
      };
      recorder.start();
    } catch (reason) {
      stopRecordedVoiceInput(true);
      setVoiceState("idle");
      setVoiceFeedback(getVoiceCaptureErrorMessage(reason, isMac, isWindows));
    }
  }

  function startSpeechRecognitionInput() {
    if (
      runningRunId ||
      voiceState !== "idle" ||
      voiceRecognitionStartingRef.current ||
      voiceRecognitionActiveRef.current
    ) {
      return;
    }

    const recognition = ensureVoiceRecognition();
    if (!recognition) {
      setVoiceFeedback(getVoiceUnsupportedMessage(isMac, isWindows));
      return;
    }

    voiceBaseDraftRef.current = draftRef.current;
    voiceCurrentTranscriptRef.current = "";
    voiceFinalTranscriptRef.current = "";
    voiceStopRequestedRef.current = false;
    voiceCancelCorrectionRef.current = false;
    voiceRecognitionFallbackToRecorderRef.current = false;
    voiceRecognitionStartingRef.current = true;
    setVoiceState("recording");
    try {
      recognition.start();
    } catch (reason) {
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = false;
      setVoiceState("idle");
      setVoiceFeedback(reason instanceof Error ? reason.message : "语音输入启动失败。");
    }
  }

  async function startVoiceInput() {
    if (runningRunId || voiceState !== "idle") {
      return;
    }
    if (canUseRecordedVoiceInput()) {
      await startRecordedVoiceInput();
      return;
    }
    if (getSpeechRecognitionConstructor()) {
      startSpeechRecognitionInput();
      return;
    }
    setVoiceFeedback(getVoiceUnsupportedMessage(isMac, isWindows));
  }

  function stopVoiceInput() {
    voiceStopRequestedRef.current = true;
    voiceCancelCorrectionRef.current = false;
    if (voiceRecorderActiveRef.current || voiceMediaRecorderRef.current) {
      setVoiceState("correcting");
      setVoiceFeedback("录音已停止，正在识别语音...");
      stopRecordedVoiceInput(false);
      return;
    }
    voiceRecognitionRef.current?.stop();
    setVoiceState("idle");
  }

  async function toggleVoiceInput() {
    if (voiceState === "recording") {
      stopVoiceInput();
      return;
    }

    await startVoiceInput();
  }

  async function startRun(
    message: string,
    action: AssistantRunAction = "chat",
    overrideAttachments?: AssistantAttachment[],
    options: { historyBeforeMessageId?: string } = {}
  ) {
    const attachmentsForRun = overrideAttachments ?? attachments;
    const shouldClearComposerAttachments = overrideAttachments === undefined;
    const content = message.trim() || (attachmentsForRun.length > 0 ? "请解析附件内容。" : "");
    if ((!content && attachmentsForRun.length === 0) || runningRunId) {
      return;
    }
    if (!settings?.configured) {
      setFeedback("请先配置 agent-platform 的 minimax provider。");
      return;
    }

    if (voiceState === "recording") {
      stopVoiceInput();
      setVoiceFeedback("录音已停止，正在处理语音输入...");
      return;
    }
    if (voiceState === "correcting") {
      setVoiceFeedback("语音输入正在处理中，请稍后发送。");
      return;
    }

    setFeedback("");
    setVoiceFeedback("");
    let pageContext: AssistantPageContext | null = null;
    try {
      pageContext = await collectPageContext(action);
    } catch (reason) {
      if (action !== "chat") {
        setFeedback(reason instanceof Error ? reason.message : String(reason));
        return;
      }
    }

    const permissionModeForRun = getEffectivePermissionMode();
    let result;
    try {
      result = await window.electronAPI.assistant.startRun({
        chatId: activeChatId,
        agentKey: selectedAgentKey,
        message: content,
        action,
        permissionMode: permissionModeForRun,
        source: "sidebar",
        pageContext,
        attachments: attachmentsForRun,
        historyBeforeMessageId: options.historyBeforeMessageId
      });
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }
    if (result.fullAccessExpiresAt) {
      const expiresAt = Date.parse(result.fullAccessExpiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        setPermissionMode("full_access");
        setFullAccessExpiresAt(expiresAt);
      }
    } else if (permissionModeForRun === "default") {
      setFullAccessExpiresAt(null);
    }

    const shouldResetMessages = activeChatIdRef.current !== result.chatId && messages.length === 0;
    activeChatIdRef.current = result.chatId;
    setActiveChatId(result.chatId);
    const userMessage = createOptimisticMessage("user", content, result.runId, attachmentsForRun);
    const assistantMessage = createOptimisticMessage("assistant", "", result.runId);
    setRunningRunId(result.runId);
    setMessages((current) => {
      const baseMessages = shouldResetMessages ? [] : current;
      return mergeOptimisticRunMessages(
        baseMessages,
        result.runId,
        userMessage,
        assistantMessage,
        runMessageIdsRef.current
      );
    });
    updateDraft("");
    if (shouldClearComposerAttachments) {
      setAttachments([]);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await startRun(draft, "chat");
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void startRun(draft, "chat");
  }

  function handleWonderClick(prompt: string) {
    updateDraft(prompt);
    window.requestAnimationFrame(() => {
      resizeComposerTextarea();
      composerTextareaRef.current?.focus();
    });
  }

  async function handleStopRun() {
    if (!runningRunId) {
      return;
    }
    const result = await window.electronAPI.assistant.stopRun(runningRunId);
    if (!result.ok) {
      setFeedback(result.message);
    }
  }

  async function handleDeleteChat(chatId: string) {
    if (!chatId || runningRunId) {
      return;
    }
    const isActiveChat = chatId === activeChatIdRef.current;
    const result = await window.electronAPI.assistant.deleteChat(chatId);
    setFeedback(result.message);
	    if (isActiveChat) {
	      activeChatIdRef.current = null;
	      setActiveChatId(null);
      setMessages([]);
      setRunEvents([]);
      setAttachments([]);
      setActiveAwaiting(null);
      setArtifactDockVisible(true);
      setHiddenArtifactIds(new Set());
    }
    await refreshSettingsAndChats();
  }

  async function appendAttachmentResult(result: AssistantAttachmentPickResult) {
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }
	    activeChatIdRef.current = result.chatId;
	    setActiveChatId(result.chatId);
    setAttachments((current) => {
      const existingIds = new Set(current.map((attachment) => attachment.id));
      return [
        ...current,
        ...result.attachments.filter((attachment) => !existingIds.has(attachment.id))
      ];
    });
    setFeedback(result.message);
    await refreshSettingsAndChats();
  }

  async function handlePickAttachments() {
    if (runningRunId || activeAttachmentTaskId) {
      return;
    }
    setFeedback("");
    setAttachmentPickerVisible(true);
    try {
      if (isMac) {
        await waitForAssistantDockPaint();
      }
      const result = await window.electronAPI.assistant.pickAttachments(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAttachmentPickerVisible(false);
    }
  }

  async function handleCaptureScreenshot() {
    if (runningRunId || activeAttachmentTaskId) {
      return;
    }
    setFeedback("");
    try {
      const result = await window.electronAPI.assistant.captureScreenshot(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function handleCancelAttachmentTask() {
    if (!activeAttachmentTaskId) {
      return;
    }
    const result = await window.electronAPI.assistant.cancelAttachmentTask(activeAttachmentTaskId);
    setFeedback(result.message);
    if (result.ok) {
      setActiveAttachmentTaskId(null);
    }
  }

  function clearAttachmentMenuCloseTimer() {
    if (attachmentMenuCloseTimerRef.current !== null) {
      window.clearTimeout(attachmentMenuCloseTimerRef.current);
      attachmentMenuCloseTimerRef.current = null;
    }
  }

  function closeAttachmentMenu() {
    clearAttachmentMenuCloseTimer();
    setAttachmentMenuOpen(false);
    setAttachmentMenuPinned(false);
  }

  function showAttachmentMenu() {
    if (runningRunId || activeAttachmentTaskId) {
      return;
    }
    clearAttachmentMenuCloseTimer();
    setAttachmentMenuOpen(true);
  }

  function hideAttachmentMenuOnLeave() {
    if (!attachmentMenuPinned) {
      clearAttachmentMenuCloseTimer();
      attachmentMenuCloseTimerRef.current = window.setTimeout(() => {
        attachmentMenuCloseTimerRef.current = null;
        setAttachmentMenuOpen(false);
      }, 180);
    }
  }

  function toggleAttachmentMenu() {
    if (runningRunId || activeAttachmentTaskId) {
      return;
    }
    if (attachmentMenuOpen && attachmentMenuPinned) {
      closeAttachmentMenu();
      return;
    }
    clearAttachmentMenuCloseTimer();
    setAttachmentMenuOpen(true);
    setAttachmentMenuPinned(true);
  }

  async function handlePickAttachmentsFromMenu() {
    closeAttachmentMenu();
    await handlePickAttachments();
  }

  async function handleCaptureScreenshotFromMenu() {
    closeAttachmentMenu();
    await handleCaptureScreenshot();
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (runningRunId) {
      return;
    }
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setFeedback("");
    try {
      let targetChatId = activeChatIdRef.current;
      for (const file of imageFiles) {
        const result = await window.electronAPI.assistant.addPastedImage(targetChatId, {
          name: file.name || `pasted-image-${Date.now()}.png`,
          mimeType: file.type || "image/png",
          data: await file.arrayBuffer()
        });
        await appendAttachmentResult(result);
        targetChatId = result.chatId || targetChatId;
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id && attachment.sourceAttachmentId !== id));
  }

  function hideArtifactAttachment(id: string) {
    setHiddenArtifactIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  async function submitAwaiting(input: { action: "submit" | "reject" | "dismiss"; params?: unknown[]; reason?: string }) {
    if (!activeAwaiting) {
      return {
        ok: false,
        message: "没有待处理的确认请求。"
      };
    }
    try {
      const result = await window.electronAPI.assistant.submitAwaiting({
        awaitingId: activeAwaiting.awaitingId,
        runId: activeAwaiting.runId,
        chatId: activeAwaiting.chatId,
        action: input.action,
        params: input.params ?? [],
        reason: input.reason ?? ""
      });
      if (!result.ok) {
        setFeedback(result.message);
      }
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setFeedback(message);
      return {
        ok: false,
        message
      };
    }
  }

  function formatAttachmentSize(sizeBytes: number) {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return "";
    }
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }
    return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatAttachmentDocumentStatus(attachment: AssistantAttachment) {
    const document = attachment.document;
    if (!document) {
      return "";
    }
    if (document.imageMode === "vision" && document.readStatus === "readable") {
      return "图片已进入视觉上下文";
    }
    if (document.readStatus === "truncated") {
      return "已解析，内容已截断";
    }
    if (document.readStatus === "readable") {
      return "已解析";
    }
    return document.errorCode ? `不可解析：${document.errorCode}` : "不可解析";
  }

  function isAttachmentReadable(attachment: AssistantAttachment) {
    return attachment.document?.readStatus
      ? attachment.document.readStatus !== "unreadable"
      : Boolean(attachment.text.trim() || attachment.dataUrl || !attachment.error);
  }

  function canPreviewImageAttachment(attachment: AssistantAttachment) {
    return Boolean(attachment.dataUrl && attachment.mimeType.toLowerCase().startsWith("image/"));
  }

  function attachmentStatusTitle(attachment: AssistantAttachment) {
    return [formatAttachmentDocumentStatus(attachment), attachment.error, attachment.name].filter(Boolean).join("，");
  }

  function formatMessageForClipboard(message: AssistantChatMessage) {
    const parts = [message.content.trim()].filter(Boolean);
    const messageAttachments = (message.attachments ?? []).filter((attachment) => !attachment.hidden);
    if (messageAttachments.length > 0) {
      parts.push([
        "附件：",
        ...messageAttachments.map((attachment) => {
          const size = formatAttachmentSize(attachment.sizeBytes);
          const suffix = [size, formatAttachmentDocumentStatus(attachment), attachment.error].filter(Boolean).join("，");
          return suffix ? `- ${attachment.name}（${suffix}）` : `- ${attachment.name}`;
        })
      ].join("\n"));
    }
    return parts.join("\n\n");
  }

  async function copyMessage(message: AssistantChatMessage) {
    const text = formatMessageForClipboard(message);
    if (!text) {
      return;
    }
    const result = await window.electronAPI.clipboard.writeText(text);
    setFeedback(result.ok ? "已复制到剪贴板。" : result.message || "复制失败。");
  }

  async function openMessageAttachment(attachment: AssistantAttachment) {
    if (!activeChatId) {
      setFeedback("请先打开对应对话后再打开附件。");
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(activeChatId, attachment.id);
    setFeedback(result.ok ? "已打开产物。" : result.message || "打开产物失败。");
  }

  function handleArtifactListWheel(event: WheelEvent<HTMLUListElement>) {
    const list = event.currentTarget;
    if (list.scrollWidth <= list.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const maxScrollLeft = list.scrollWidth - list.clientWidth;
    if ((delta < 0 && list.scrollLeft <= 0) || (delta > 0 && list.scrollLeft >= maxScrollLeft - 1)) {
      return;
    }
    list.scrollLeft = Math.max(0, Math.min(maxScrollLeft, list.scrollLeft + delta));
    event.preventDefault();
  }

  function findRegenerateSourceMessage(message: AssistantChatMessage, index: number) {
    if (message.role !== "assistant") {
      return null;
    }
    const previousMessages = messages.slice(0, index).reverse();
    return (
      previousMessages.find((item) => item.role === "user" && message.runId && item.runId === message.runId) ??
      previousMessages.find((item) => item.role === "user") ??
      null
    );
  }

  function canRegenerateMessage(message: AssistantChatMessage, index: number) {
    return message.role === "assistant" && !runningRunId && Boolean(findRegenerateSourceMessage(message, index));
  }

  async function regenerateMessage(message: AssistantChatMessage, index: number) {
    if (runningRunId) {
      return;
    }
    const source = findRegenerateSourceMessage(message, index);
    if (!source) {
      setFeedback("没有找到可重新生成的问题。");
      return;
    }
    await startRun(source.content, "chat", source.attachments ?? [], {
      historyBeforeMessageId: source.id
    });
  }

  function renderFeedback() {
    const notices = [
      feedback
        ? {
            id: "feedback",
            message: feedback,
            action: activeAttachmentTaskId
              ? {
                  label: "取消",
                  onClick: () => void handleCancelAttachmentTask()
                }
              : null,
            onDismiss: () => setFeedback("")
          }
        : null,
      voiceFeedback
        ? {
            id: "voice-feedback",
            message: voiceFeedback,
            onDismiss: () => setVoiceFeedback("")
          }
        : null,
      loadingChatId
        ? {
            id: "loading-chat",
            message: "正在读取对话..."
          }
        : null
    ].filter(Boolean);
    if (notices.length === 0) {
      return null;
    }
    return (
      <div className="assistant-dock-feedback-stack">
        {notices.map((notice) => (
          <div
            className={`assistant-dock-feedback${notice.onDismiss ? " is-dismissible" : ""}`}
            key={notice.id}
          >
            <span className="assistant-dock-feedback-text">{notice.message}</span>
            {notice.action ? (
              <button
                type="button"
                className="assistant-dock-feedback-action"
                onClick={notice.action.onClick}
              >
                {notice.action.label}
              </button>
            ) : null}
            {notice.onDismiss ? (
              <button
                type="button"
                className="assistant-dock-feedback-dismiss"
                onClick={notice.onDismiss}
                aria-label="关闭提示"
                title="关闭"
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  function renderChatbar() {
    const activeChat = activeChatId
      ? chats.find((chat) => chat.id === activeChatId) ?? null
      : null;
    const firstUserMessage = messages.find((message) => message.role === "user");
    const activeChatTitle = activeChat
      ? getChatDisplayTitle(activeChat)
      : normalizeChatText(firstUserMessage?.content ?? "") || "当前对话";
    const query = normalizeChatText(chatHistoryQuery).toLocaleLowerCase();
    const matchesQuery = (chat: AssistantChatSummary) => {
      if (!query) {
        return true;
      }
      return `${chat.title} ${chat.lastMessage}`.toLocaleLowerCase().includes(query);
    };
    const visibleChats = chats.filter(matchesQuery);
    const visibleCurrentChat = activeChat && matchesQuery(activeChat) ? activeChat : null;
    const visibleHistoryChats = visibleChats.filter((chat) => chat.id !== activeChatId);
    const hasVisibleChats = Boolean(visibleCurrentChat || visibleHistoryChats.length > 0);

    const renderHistoryRow = (chat: AssistantChatSummary, isActive: boolean) => {
      const title = getChatDisplayTitle(chat, "未命名对话");
      const meta = [getChatPreview(chat), formatChatUpdatedAt(chat.updatedAt)].filter(Boolean).join(" · ");
      return (
        <div className={isActive ? "assistant-history-row is-active" : "assistant-history-row"} key={chat.id}>
          <button
            type="button"
            className="assistant-history-row-main"
            onClick={() => void loadChat(chat.id)}
            disabled={Boolean(runningRunId)}
            aria-current={isActive ? "true" : undefined}
          >
            <span className="assistant-history-avatar" aria-hidden="true">
              {getChatAvatarLabel(title)}
            </span>
            <span className="assistant-history-copy">
              <span className="assistant-history-title">{title}</span>
              <span className="assistant-history-meta">{meta}</span>
            </span>
          </button>
          <button
            type="button"
            className="assistant-history-row-delete"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteChat(chat.id);
            }}
            disabled={Boolean(runningRunId)}
            aria-label={`删除历史记录：${title}`}
            title="删除"
          >
            <CloseIcon />
          </button>
        </div>
      );
    };

    return (
      <div className="assistant-dock-chatbar" ref={chatHistoryRef}>
        <label className="assistant-dock-agent-select-wrap">
          <span className="assistant-dock-agent-select-label">智能体</span>
          <select
            className="assistant-dock-agent-select"
            value={selectedAgentKey}
            onChange={(event) => setSelectedAgentKey(event.target.value)}
            disabled={Boolean(runningRunId || agentOptionsLoading || agentOptions.length === 0)}
            aria-label="选择智能体"
            title={
              selectedAgentKey
                ? agentOptions.find((agent) => agent.agentKey === selectedAgentKey)?.displayName || selectedAgentKey
                : "选择智能体"
            }
          >
            {agentOptions.length === 0 ? (
              <option value="">{agentOptionsLoading ? "加载中..." : "暂无智能体"}</option>
            ) : (
              agentOptions.map((agent) => (
                <option value={agent.agentKey} key={agent.agentKey}>
                  {agent.displayName}{agent.role ? ` · ${agent.role}` : ""}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          className={!activeChatId ? "assistant-dock-chat-pill is-active" : "assistant-dock-chat-pill"}
          onClick={startNewChat}
          disabled={Boolean(runningRunId)}
        >
          新对话
        </button>
        <button
          type="button"
          className={[
            "assistant-dock-chat-pill",
            "assistant-dock-history-toggle",
            activeChatId ? "assistant-dock-current-chat" : "",
            chatHistoryOpen ? "is-open" : ""
          ].filter(Boolean).join(" ")}
          onClick={() => setChatHistoryOpen((current) => !current)}
          disabled={Boolean(runningRunId || chats.length === 0)}
          aria-haspopup="dialog"
          aria-expanded={chatHistoryOpen}
        >
          {activeChatId ? (
            <>
              <span>{activeChatTitle}</span>
              <ChevronDownIcon />
            </>
          ) : (
            <>
              <HistoryIcon />
              <span>历史记录</span>
              <span className="assistant-dock-history-count">{chats.length}</span>
            </>
          )}
        </button>
        {chatHistoryOpen ? (
          <div className="assistant-history-popover" role="dialog" aria-label="历史记录">
            <label className="assistant-history-search">
              <SearchIcon />
              <input
                ref={chatHistorySearchRef}
                value={chatHistoryQuery}
                onChange={(event) => setChatHistoryQuery(event.target.value)}
                placeholder="搜索历史记录"
                aria-label="搜索历史记录"
              />
            </label>
            <div className="assistant-history-scroll">
              {visibleCurrentChat ? (
                <section className="assistant-history-section" aria-label="当前对话">
                  <div className="assistant-history-section-title">当前对话</div>
                  {renderHistoryRow(visibleCurrentChat, true)}
                </section>
              ) : null}
              {visibleHistoryChats.length > 0 ? (
                <section className="assistant-history-section" aria-label="最近记录">
                  <div className="assistant-history-section-title">最近记录</div>
                  {visibleHistoryChats.map((chat) => renderHistoryRow(chat, false))}
                </section>
              ) : null}
              {!hasVisibleChats ? (
                <div className="assistant-history-empty">没有匹配的历史记录</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderConfigEmpty() {
    if (settings?.configured ?? false) {
      return null;
    }

    return (
      <div className="assistant-dock-config-empty">
        <strong>先配置模型</strong>
        <button type="button" onClick={onOpenSettings}>去设置</button>
      </div>
    );
  }

  function renderOperatorModeBanner() {
    if (!operatorModeInfo) {
      return null;
    }
    return (
      <div className="assistant-operator-banner" role="status" aria-live="polite">
        <div>
          <strong>完全允许控制已开启</strong>
          <span>当前会话临时授权，剩余 {formatOperatorModeRemaining(operatorModeInfo.remainingMs)}</span>
        </div>
        {runningRunId ? (
          <button type="button" onClick={() => void handleStopRun()}>
            停止当前操作
          </button>
        ) : null}
      </div>
    );
  }

  function renderTimelineIcon(kind: AssistantTimelineItem["kind"]) {
    if (kind === "thinking") {
      return <ThinkingIcon />;
    }
    if (kind === "tool") {
      return <ToolIcon />;
    }
    if (kind === "awaiting") {
      return <AwaitingIcon />;
    }
    return <DocumentIcon />;
  }

  function renderTimelineDataBlock(label: string, data: unknown, fallback = "") {
    const entries = isRecord(data)
      ? Object.entries(data)
          .filter(([, value]) => value !== undefined && value !== null && formatTimelineInlineValue(value))
          .slice(0, 8)
      : [];
    const fallbackText = fallback.trim();
    if (entries.length === 0 && !fallbackText) {
      return null;
    }

    return (
      <div className="assistant-run-data-block">
        <span className="assistant-run-data-label">{label}</span>
        {entries.length > 0 ? (
          <dl className="assistant-run-data-table">
            {entries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{formatTimelineInlineValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {fallbackText ? (
          <pre className="assistant-run-data-pre">{fallbackText}</pre>
        ) : null}
      </div>
    );
  }

  function renderTimelineToolRecord(record: AssistantTimelineToolRecord) {
    const argsBlock = renderTimelineDataBlock("参数", record.argsData);
    const resultBlock = renderTimelineDataBlock("结果", record.resultData, record.resultText);
    const errorBlock = record.errorText
      ? renderTimelineDataBlock("异常", null, record.errorText)
      : null;

    return (
      <div className="assistant-run-tool-card" data-record-status={record.status} key={record.id}>
        <div className="assistant-run-tool-card-head">
          <span>{record.title}</span>
          <span>{record.verificationLabel || record.statusLabel}</span>
        </div>
        <div className="assistant-run-tool-card-body">
          {argsBlock}
          {resultBlock}
          {errorBlock}
          {!argsBlock && !resultBlock && !errorBlock ? (
            <p className="assistant-run-tool-empty">{record.statusLabel}</p>
          ) : null}
        </div>
      </div>
    );
  }

  function renderTimelineItem(item: AssistantTimelineItem) {
    if (item.kind === "tool") {
      return (
        <div className={`assistant-run-item is-${item.kind}`} data-item-status={item.status} key={item.id}>
          <span className={`assistant-run-item-icon is-${item.kind}`} aria-hidden="true">
            {renderTimelineIcon(item.kind)}
          </span>
          <details className="assistant-run-tool" defaultOpen>
            <summary className="assistant-run-tool-trigger">
              <span className="assistant-run-item-title">{item.title}</span>
              <span className="assistant-run-tool-dots" aria-label={item.statusLabel}>
                {item.records.map((record) => (
                  <span
                    className="assistant-run-tool-dot"
                    data-record-status={record.status}
                    key={record.id}
                  />
                ))}
              </span>
              <span className="assistant-run-tool-chevron" aria-hidden="true" />
            </summary>
            <div className="assistant-run-tool-records">
              {item.records.map(renderTimelineToolRecord)}
            </div>
          </details>
        </div>
      );
    }

    return (
      <div className={`assistant-run-item is-${item.kind}`} data-item-status={item.status} key={item.id}>
        <span className={`assistant-run-item-icon is-${item.kind}`} aria-hidden="true">
          {renderTimelineIcon(item.kind)}
        </span>
        <div className="assistant-run-item-content">
          <span className="assistant-run-item-title">{item.title}</span>
          {item.text ? <p className="assistant-run-item-text">{item.text}</p> : null}
        </div>
      </div>
    );
  }

  function renderRunTimeline(runId?: string) {
    if (!runId) {
      return null;
    }
    const runEventsForTimeline = runEvents
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.seq - right.seq);
    const timelineItems = buildRunTimelineItems(runEventsForTimeline, runId, runningRunId);
    if (timelineItems.length === 0) {
      return null;
    }
    const stepCount = Math.max(1, timelineItems.filter((item) => item.kind !== "thinking").length);

    return (
      <details className="assistant-run-timeline" defaultOpen>
        <summary className="assistant-run-summary" aria-label="展开或收起助手思考过程">
          <span className="assistant-run-summary-caret" aria-hidden="true" />
          <span className="assistant-run-summary-label">思考过程</span>
          <span className="assistant-run-summary-count">{stepCount} 步</span>
          <span className="assistant-run-summary-status">
            {getRunTimelineStatusText(runId, runningRunId, runEventsForTimeline)}
          </span>
        </summary>
        <div className="assistant-run-lane" aria-label="助手运行状态">
          {timelineItems.map(renderTimelineItem)}
        </div>
      </details>
    );
  }

  function renderMemoryReferences(runId?: string) {
    if (!runId) {
      return null;
    }
    const references = runEvents
      .filter((event) => event.runId === runId && event.type === "memory.reference")
      .sort((left, right) => left.seq - right.seq)
      .flatMap(getAssistantMemoryReferences);
    if (references.length === 0) {
      return null;
    }

    return (
      <details className="assistant-memory-references">
        <summary>
          <span className="assistant-memory-caret" aria-hidden="true" />
          <span>{references.length} 条记忆引用</span>
        </summary>
        <div className="assistant-memory-reference-list">
          {references.map((reference, index) => {
            const lineText = reference.lineStart && reference.lineEnd
              ? reference.lineStart === reference.lineEnd
                ? `${reference.lineStart} 行`
                : `${reference.lineStart}-${reference.lineEnd} 行`
              : "";
            const key = reference.id || `${reference.path || "memory"}-${index}`;
            return (
              <div className="assistant-memory-reference" key={key}>
                <div className="assistant-memory-reference-title">
                  <span>{reference.title || "本地长期记忆"}</span>
                  {lineText ? <em>{lineText}</em> : null}
                </div>
                {reference.excerpt ? (
                  <p>{reference.excerpt}</p>
                ) : reference.path ? (
                  <p>存储于 {reference.path}</p>
                ) : null}
                {reference.reason ? <p>召回原因：{reference.reason}</p> : null}
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  function renderArtifactDock(variant: AssistantDockMode) {
    const artifactAttachments = getArtifactAttachmentsFromMessages(messages)
      .filter((attachment) => !hiddenArtifactIds.has(attachment.artifactId || attachment.id));
    if (artifactAttachments.length === 0 || !artifactDockVisible) {
      return null;
    }
    return (
      <div className={`assistant-artifact-dock assistant-artifact-dock-${variant}`} aria-label="生成的产物">
        <ul className="assistant-artifact-list" onWheel={handleArtifactListWheel}>
          {artifactAttachments.map((attachment) => {
            const size = formatAttachmentSize(attachment.sizeBytes) || attachment.mimeType;
            const artifactKey = attachment.artifactId || attachment.id;
            return (
              <li className="assistant-artifact-item" key={artifactKey}>
                <button
                  type="button"
                  className="assistant-artifact-card"
                  onClick={() => void openMessageAttachment(attachment)}
                  title={attachment.name}
                >
                  <span className="assistant-artifact-card-file-shell">
                    <span className="assistant-artifact-card-file-icon" aria-hidden="true">
                      <FileArtifactIcon />
                    </span>
                    <span className="assistant-artifact-card-file-copy">
                      <span className="assistant-artifact-card-title">{attachment.name}</span>
                      {size ? <span className="assistant-artifact-card-subtitle">{size}</span> : null}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="assistant-artifact-remove"
                  onClick={() => hideArtifactAttachment(artifactKey)}
                  aria-label={`隐藏产物 ${attachment.name}`}
                  title="隐藏产物"
                >
                  <CloseIcon />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="assistant-artifact-actions">
          <button
            type="button"
            className="assistant-artifact-collapse"
            onClick={() => setArtifactDockVisible(false)}
            aria-label="隐藏产物列表"
            title="隐藏产物"
          >
            <ChevronDownIcon />
          </button>
        </div>
      </div>
    );
  }

  function renderMessageAttachments(message: AssistantChatMessage) {
    const messageAttachments = message.attachments ?? [];
    const regularAttachments = messageAttachments.filter((attachment) => attachment.kind !== "artifact" && !attachment.hidden);
    if (regularAttachments.length === 0) {
      return null;
    }
    return (
      <div className="assistant-message-attachments" aria-label="消息附件">
        {regularAttachments.map((attachment) => (
          <span
            className={
              isAttachmentReadable(attachment)
                ? "assistant-message-attachment-chip"
                : "assistant-message-attachment-chip has-warning"
            }
            title={attachmentStatusTitle(attachment)}
            key={attachment.id}
          >
            <PaperclipIcon />
            <span>{attachment.name}</span>
          </span>
        ))}
      </div>
    );
  }

  function renderMessageActions(message: AssistantChatMessage, index: number) {
    const canCopy = Boolean(formatMessageForClipboard(message));
    const canRegenerate = canRegenerateMessage(message, index);
    if (!canCopy && !canRegenerate) {
      return null;
    }
    return (
      <div className="assistant-message-actions" aria-label="消息操作">
        {canCopy ? (
          <button
            type="button"
            className="assistant-message-action-button"
            onClick={() => void copyMessage(message)}
            aria-label="复制这条消息"
            title="复制"
          >
            <CopyIcon />
          </button>
        ) : null}
        {canRegenerate ? (
          <button
            type="button"
            className="assistant-message-action-button"
            onClick={() => void regenerateMessage(message, index)}
            aria-label="重新生成回答"
            title="重新生成回答"
          >
            <RegenerateIcon />
          </button>
        ) : null}
      </div>
    );
  }

  function renderMessages() {
    if (visibleMessages.length === 0) {
      return null;
    }

    return (
      <div className="assistant-dock-messages">
        {visibleMessages.map((message, index) => {
          const sourceIndex = messages.findIndex((candidate) => candidate.id === message.id);
          return (
            <div className={`assistant-message is-${message.role}`} key={message.id}>
              <span>{message.role === "user" ? "你" : "ZenMind"}</span>
              {message.role === "assistant" ? renderRunTimeline(message.runId) : null}
              <div className="assistant-message-body">
                {message.role === "assistant" ? (
                  <AssistantMarkdownContent
                    className="assistant-message-markdown"
                    content={message.content || "正在思考..."}
                  />
                ) : (
                  <p className="assistant-message-text">{message.content}</p>
                )}
                {message.role === "assistant" ? renderMemoryReferences(message.runId) : null}
                {renderMessageAttachments(message)}
                {renderMessageActions(message, sourceIndex >= 0 ? sourceIndex : index)}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
    );
  }

  function renderEmptyState() {
    return (
      <div className="assistant-dock-empty">
        <span className="assistant-dock-empty-mark" aria-hidden="true">
          <ZenMindLogoIcon />
        </span>
        <strong>你有什么想法？</strong>
        <div className="assistant-dock-wonders" aria-label="推荐问题">
          {ZENMIND_ASSISTANT_WONDERS.map((prompt) => (
            <button
              type="button"
              className="assistant-dock-wonder-button"
              key={prompt}
              onClick={() => handleWonderClick(prompt)}
              disabled={Boolean(runningRunId)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderComposer(variant: AssistantDockMode) {
    const configured = settings?.configured ?? false;
    const voiceBusy = voiceState === "recording" || voiceState === "correcting";
    const canSubmit = configured && !voiceBusy && (draft.trim().length > 0 || attachments.length > 0);
    const effectivePermissionMode = getEffectivePermissionMode(nowMs);
    const fullAccessRemainingMs = effectivePermissionMode === "full_access" && fullAccessExpiresAt
      ? Math.max(0, fullAccessExpiresAt - nowMs)
      : 0;
    const permissionTitle = effectivePermissionMode === "full_access"
      ? `完全允许控制，${formatFullAccessRemaining(fullAccessRemainingMs)} 内不再二次确认`
      : "询问后操作，危险操作会先确认";
    const permissionModeLabel = effectivePermissionMode === "full_access" ? "完全允许控制" : "询问后操作";
    const voiceButtonDisabled = !configured || !voiceSupported || Boolean(runningRunId) || voiceState === "correcting";
    const voiceButtonTitle = !configured
      ? "请先配置 minimax provider"
      : !voiceSupported
        ? getVoiceUnsupportedMessage(isMac, isWindows)
        : voiceState === "recording"
          ? "停止语音输入"
          : voiceState === "correcting"
            ? "正在处理语音输入"
            : "语音输入";

    return (
      <form
        className={[
          "assistant-dock-composer",
          `assistant-dock-composer-${variant}`
        ].join(" ")}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="assistant-dock-composer-shell">
          {attachments.some((attachment) => !attachment.hidden) ? (
            <div className="assistant-dock-attachments" aria-label="已选择附件">
              {attachments.filter((attachment) => !attachment.hidden).map((attachment) => {
                const canPreviewImage = canPreviewImageAttachment(attachment);
                return (
                  <span
                    className={[
                      isAttachmentReadable(attachment)
                        ? "assistant-dock-attachment-chip"
                        : "assistant-dock-attachment-chip has-warning",
                      canPreviewImage ? "is-image-previewable" : ""
                    ].filter(Boolean).join(" ")}
                    key={attachment.id}
                    title={canPreviewImage ? `点击预览：${attachment.name}` : attachmentStatusTitle(attachment)}
                  >
                    {canPreviewImage ? (
                      <button
                        type="button"
                        className="assistant-dock-attachment-preview-button"
                        onClick={() => setPreviewImageAttachment(attachment)}
                        aria-label={`预览图片 ${attachment.name}`}
                      >
                        <img src={attachment.dataUrl} alt="" draggable={false} />
                        <span>{attachment.name}</span>
                      </button>
                    ) : (
                      <span className="assistant-dock-attachment-name">{attachment.name}</span>
                    )}
                  <button
                    type="button"
                    className="assistant-dock-attachment-remove"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={`移除附件 ${attachment.name}`}
                    disabled={Boolean(runningRunId) || Boolean(activeAttachmentTaskId)}
                  >
                    <CloseIcon />
                  </button>
                </span>
                );
              })}
            </div>
          ) : null}
          <textarea
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            onPaste={(event) => void handleComposerPaste(event)}
            placeholder="问问 ZenMind..."
            disabled={!configured || Boolean(runningRunId)}
            rows={2}
            wrap="soft"
          />
          <div className="assistant-dock-composer-toolbar">
            <div className="assistant-dock-composer-tools">
              <div
                className="assistant-dock-attachment-entry attachment-action-menu-root"
                ref={attachmentMenuRef}
                onPointerEnter={showAttachmentMenu}
                onPointerLeave={hideAttachmentMenuOnLeave}
              >
                <button
                  type="button"
                  className="assistant-dock-tool-button"
                  onClick={toggleAttachmentMenu}
                  disabled={Boolean(runningRunId) || Boolean(activeAttachmentTaskId)}
                  aria-label="添加附件"
                  title="添加附件"
                  aria-haspopup="menu"
                  aria-expanded={attachmentMenuOpen}
                >
                  <PaperclipIcon />
                </button>
                <div
                  className={[
                    "attachment-action-menu",
                    "assistant-dock-attachment-action-menu",
                    attachmentMenuOpen ? "is-open" : ""
                  ].filter(Boolean).join(" ")}
                  role="menu"
                  aria-label="附件操作"
                >
                  <button type="button" className="attachment-action-menu-item" onClick={() => void handlePickAttachmentsFromMenu()} role="menuitem">
                    <PaperclipIcon />
                    <span>添加附件</span>
                  </button>
                  <button type="button" className="attachment-action-menu-item" onClick={() => void handleCaptureScreenshotFromMenu()} role="menuitem">
                    <ScreenshotIcon />
                    <span>截屏提问</span>
                  </button>
                </div>
              </div>
              <label
                className={[
                  "assistant-dock-permission-control",
                  effectivePermissionMode === "full_access" ? "is-full-access" : ""
                ].filter(Boolean).join(" ")}
                title={permissionTitle}
              >
                <select
                  value={effectivePermissionMode}
                  onChange={(event) => handlePermissionModeChange(event.target.value as AssistantPermissionMode)}
                  disabled={Boolean(runningRunId)}
                  aria-label="助手权限模式"
                  title={permissionTitle}
                >
                  <option value="default">询问后操作</option>
                  <option value="full_access">完全允许控制</option>
                </select>
                <span className="assistant-dock-permission-icon" aria-hidden="true">
                  {effectivePermissionMode === "full_access" ? <ShieldIcon /> : <HandIcon />}
                </span>
                <span className="assistant-dock-permission-value" aria-hidden="true">
                  {permissionModeLabel}
                </span>
                <span className="assistant-dock-permission-chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
                {effectivePermissionMode === "full_access" ? (
                  <span className="assistant-dock-permission-countdown">
                    {formatFullAccessRemaining(fullAccessRemainingMs)}
                  </span>
                ) : null}
              </label>
            </div>
            <div className="assistant-dock-composer-actions">
              <button
                type="button"
                className={[
                  "assistant-dock-tool-button",
                  "assistant-dock-voice-button",
                  voiceState === "recording" ? "is-recording" : "",
                  voiceState === "correcting" ? "is-correcting" : ""
                ].filter(Boolean).join(" ")}
                onClick={() => void toggleVoiceInput()}
                disabled={voiceButtonDisabled}
                aria-label={voiceState === "recording" ? "停止语音输入" : "语音输入"}
                title={voiceButtonTitle}
              >
                <MicrophoneIcon />
              </button>
              {runningRunId ? (
                <button
                  type="button"
                  className="assistant-dock-send-button"
                  onClick={() => void handleStopRun()}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  className="assistant-dock-send-button"
                  disabled={!canSubmit}
                  aria-label="发送"
                  title="发送"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    );
  }

  function renderFullMode() {
    return (
      <>
        <div className="assistant-dock-full-topbar">
          <button
            type="button"
            className="assistant-dock-icon-button"
            onClick={onClose}
            aria-label="关闭助手"
            title="关闭助手"
          >
            <CloseIcon />
          </button>
          <div className="assistant-dock-top-actions">
            <button
              type="button"
              className="assistant-dock-icon-button"
              onClick={() => onModeChange("compact")}
              aria-label="恢复悬浮状态"
              title="恢复悬浮状态"
            >
              <CompactIcon />
            </button>
          </div>
        </div>
        {renderChatbar()}
        {renderConfigEmpty()}
        {renderFeedback()}
        {renderOperatorModeBanner()}
        <div className="assistant-dock-full-body">
          {visibleMessages.length === 0 ? renderEmptyState() : renderMessages()}
        </div>
        {renderArtifactDock("full")}
        {renderComposer("full")}
      </>
    );
  }

  function renderCompactMode() {
    return (
      <>
        <div className="assistant-dock-compact-topbar">
          <button
            type="button"
            className="assistant-dock-icon-button"
            onClick={onClose}
            aria-label="关闭助手"
            title="关闭助手"
          >
            <CloseIcon />
          </button>
          <div className="assistant-dock-top-actions">
            <button
              type="button"
              className="assistant-dock-icon-button"
              onClick={startNewChat}
              disabled={Boolean(runningRunId)}
              aria-label="新对话"
              title="新对话"
            >
              <NewChatIcon />
            </button>
            <button
              type="button"
              className="assistant-dock-icon-button"
              onClick={() => onModeChange("full")}
              aria-label="嵌入到右侧"
              title="嵌入到右侧"
            >
              <ExpandIcon />
            </button>
          </div>
        </div>
        {renderChatbar()}
        {renderConfigEmpty()}
        {renderFeedback()}
        {renderOperatorModeBanner()}
        <div className="assistant-dock-compact-body">
          {visibleMessages.length === 0 ? renderEmptyState() : renderMessages()}
        </div>
        {renderArtifactDock("compact")}
        {renderComposer("compact")}
      </>
    );
  }

  const operatorModeInfo = getOperatorModeInfo(runEvents, nowMs);
  const visibleMessages = getVisibleAssistantMessages(messages, runningRunId);
  const shouldHideForNativeDialog = isMac && nativeDialogVisible && !attachmentPickerVisible;
  const shouldSuspendCompactDismissLayer = shouldHideForNativeDialog || (isMac && attachmentPickerVisible);
  const shouldRenderCompactDismissLayer = open && mode === "compact" && !shouldSuspendCompactDismissLayer;
  const rootClassName = [
    "assistant-dock-root",
    open ? "is-open" : "",
    `is-${mode}`,
    shouldHideForNativeDialog ? "is-native-dialog-open" : "",
    isMac ? "is-mac" : "",
    isWindows ? "is-windows" : ""
  ].filter(Boolean).join(" ");

  return (
    <>
      {showLauncher && !open ? (
        <button type="button" className="assistant-dock-fab" onClick={onOpen} aria-label="打开 ZenMind">
          <ZenMindLogoIcon />
          <span>助手</span>
        </button>
      ) : null}
      {shouldRenderCompactDismissLayer ? (
        <div className="assistant-dock-outside-dismiss" role="presentation" onMouseDown={onClose} />
      ) : null}
      <aside className={rootClassName} aria-hidden={!open || shouldHideForNativeDialog} aria-label="ZenMind">
        {mode === "full" ? renderFullMode() : renderCompactMode()}
        {activeAwaiting ? <AssistantAwaitingDialog awaiting={activeAwaiting} onSubmit={submitAwaiting} /> : null}
      </aside>
      <AttachmentImagePreview
        attachment={previewImageAttachment}
        onClose={() => setPreviewImageAttachment(null)}
      />
    </>
  );
}
