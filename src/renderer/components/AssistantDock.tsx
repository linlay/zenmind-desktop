import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import type {
  AssistantAttachment,
  AssistantAttachmentPickResult,
  AssistantAwaitingPayload,
  AssistantEvent,
  AssistantChatMessage,
  AssistantChatSummary,
  AssistantPageContext,
  AssistantRunEvent,
  AssistantRunAction,
  AssistantSettingsPublic,
  AssistantVoiceCorrectionLocale
} from "../../shared/contracts";
import { AssistantAwaitingDialog } from "./AssistantAwaitingDialog";
import { getAssistantPageContext } from "../services/assistantPageContext";

export type AssistantDockMode = "full" | "compact";

type AssistantDockProps = {
  open: boolean;
  mode: AssistantDockMode;
  isMac: boolean;
  isWindows: boolean;
  onOpen: () => void;
  onClose: () => void;
  onModeChange: (mode: AssistantDockMode) => void;
  onOpenSettings: () => void;
};

type VoiceState = "idle" | "recording" | "correcting";

const VOICE_CORRECTION_LOCALE: AssistantVoiceCorrectionLocale = "zh-CN-mixed-en";
const VOICE_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus"
];

const STRUCTURED_ASSISTANT_EVENT_TYPES = new Set([
  "request.query",
  "chat.start",
  "run.start",
  "content.delta",
  "tool.start",
  "tool.args",
  "tool.result",
  "tool.end",
  "awaiting.confirm",
  "awaiting.ask",
  "awaiting.answer",
  "artifact.publish",
  "run.complete",
  "run.error",
  "run.interrupt",
  "done",
  "run.stopped"
]);

function isStructuredAssistantEvent(event: AssistantEvent): event is AssistantRunEvent {
  return (
    STRUCTURED_ASSISTANT_EVENT_TYPES.has(event.type) &&
    typeof event.id === "string" &&
    typeof event.seq === "number" &&
    typeof event.createdAt === "string"
  );
}

function isTerminalAssistantEvent(event: AssistantEvent) {
  return (
    event.type === "done" ||
    event.type === "stopped" ||
    event.type === "error" ||
    event.type === "run.complete" ||
    event.type === "run.stopped" ||
    event.type === "run.error" ||
    event.type === "done"
  );
}

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

function getAssistantErrorContent(event: AssistantEvent) {
  return event.message || (event.error ? `生成失败：${event.error}` : "生成失败。");
}

function getRunEventTone(event: AssistantRunEvent) {
  if (event.type === "awaiting.confirm" || event.type === "awaiting.ask" || event.status === "blocked" || event.status === "waiting") {
    return "is-blocked";
  }
  if (event.type === "run.error" || event.status === "error") {
    return "is-error";
  }
  if (event.status === "timeout" || event.status === "rejected" || event.status === "cancelled") {
    return "is-blocked";
  }
  if (event.type === "run.stopped" || event.status === "stopped") {
    return "is-stopped";
  }
  if (event.type === "tool.start" || event.type === "run.start" || event.status === "running") {
    return "is-running";
  }
  return "is-ok";
}

function getRunTimelineStatusText(runId: string, runningRunId: string | null, events: AssistantRunEvent[]) {
  const lastEvent = events[events.length - 1];
  if (!lastEvent) {
    return "";
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

function getAssistantEventAwaitingPayload(event: AssistantRunEvent): AssistantAwaitingPayload | null {
  if (event.awaiting) {
    return event.awaiting;
  }
  if (event.type !== "awaiting.ask" || !event.awaitingId) {
    return null;
  }
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Partial<AssistantAwaitingPayload>
    : {};
  const mode = event.mode === "approval" || event.mode === "form" || event.mode === "question"
    ? event.mode
    : event.questions?.length
      ? "question"
      : event.approvals?.length
        ? "approval"
        : event.forms?.length
          ? "form"
          : "question";
  return {
    awaitingId: event.awaitingId,
    mode,
    title: data.title || event.message || (mode === "question" ? "需要你补充信息" : "需要你确认"),
    description: data.description,
    toolName: event.toolName,
    runId: event.runId,
    chatId: event.chatId,
    createdAt: event.timestamp ?? event.createdAt,
    timeout: event.timeout ?? data.timeout ?? null,
    timeoutMs: event.timeoutMs ?? data.timeoutMs,
    questions: event.questions ?? data.questions,
    approvals: event.approvals ?? data.approvals,
    forms: event.forms ?? data.forms,
    viewportKey: event.viewportKey ?? data.viewportKey,
    viewportHtml: data.viewportHtml,
    loading: data.loading,
    loadError: data.loadError,
    resolvedByOther: data.resolvedByOther
  };
}

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

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

export function AssistantDock({
  open,
  mode,
  isMac,
  isWindows,
  onOpen,
  onClose,
  onModeChange,
  onOpenSettings
}: AssistantDockProps) {
  const [settings, setSettings] = useState<AssistantSettingsPublic | null>(null);
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [runEvents, setRunEvents] = useState<AssistantRunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [loadingChatId, setLoadingChatId] = useState("");
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [activeAwaiting, setActiveAwaiting] = useState<AssistantAwaitingPayload | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceSupported, setVoiceSupported] = useState(() => canUseVoiceInput());
  const [voiceFeedback, setVoiceFeedback] = useState("");
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const runningRunIdRef = useRef<string | null>(runningRunId);
  const runMessageIdsRef = useRef(new Map<string, string>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  function updateDraft(nextDraft: string) {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
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
    if (!open) {
      return;
    }
    void refreshSettingsAndChats().catch((reason) => {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    });
  }, [open]);

  useEffect(() => {
    return window.electronAPI.assistant.onAssistantEvent((event) => {
      if (isStructuredAssistantEvent(event)) {
        setRunEvents((current) => {
          if (current.some((item) => item.id === event.id)) {
            return current;
          }
          return [...current, event];
        });
        if (event.type === "awaiting.ask") {
          const awaiting = getAssistantEventAwaitingPayload(event);
          if (awaiting) {
            setActiveAwaiting(awaiting);
          }
        }
        if (event.type === "awaiting.answer") {
          const awaitingId = event.awaiting?.awaitingId;
          setActiveAwaiting((current) => {
            if (!current || (awaitingId && current.awaitingId !== awaitingId)) {
              return current;
            }
            return null;
          });
        }
      }

      const messageId = runMessageIdsRef.current.get(event.runId);
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

  async function loadChat(chatId: string) {
    setLoadingChatId(chatId);
    setFeedback("");
    try {
      const chat = await window.electronAPI.assistant.getChat(chatId);
      if (!chat) {
        setFeedback("该对话不存在或已被删除。");
        return;
      }
      setActiveChatId(chat.summary.id);
      setMessages(chat.messages);
      setRunEvents(chat.events ?? []);
      setAttachments([]);
      setActiveAwaiting(null);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingChatId("");
    }
  }

  function startNewChat() {
    setActiveChatId(null);
    setMessages([]);
    setRunEvents([]);
    setAttachments([]);
    setActiveAwaiting(null);
    setFeedback("");
    setVoiceFeedback("");
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

  async function correctVoiceTranscript(transcript: string) {
    const voiceText = transcript.trim();
    if (!voiceText) {
      setVoiceState("idle");
      return;
    }

    const requestId = voiceCorrectionRequestIdRef.current + 1;
    voiceCorrectionRequestIdRef.current = requestId;
    const baseDraft = voiceBaseDraftRef.current;
    const expectedDraft = mergeVoiceText(baseDraft, voiceText);
    updateDraft(expectedDraft);
    setVoiceState("correcting");
    setVoiceFeedback("正在纠正语音文本...");

    try {
      const result = await window.electronAPI.assistant.correctVoiceText({
        text: voiceText,
        locale: VOICE_CORRECTION_LOCALE
      });
      if (voiceCorrectionRequestIdRef.current !== requestId) {
        return;
      }
      if (draftRef.current !== expectedDraft) {
        setVoiceFeedback("检测到手动编辑，已保留当前输入。");
        return;
      }
      if (result.ok && result.text.trim()) {
        updateDraft(mergeVoiceText(baseDraft, result.text));
      }
      setVoiceFeedback(result.message);
    } catch (reason) {
      if (voiceCorrectionRequestIdRef.current === requestId) {
        setVoiceFeedback(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (voiceCorrectionRequestIdRef.current === requestId) {
        setVoiceState("idle");
      }
    }
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
      if (!voiceStopRequestedRef.current && event.error !== "aborted") {
        setVoiceFeedback(event.message || getVoiceErrorMessage(event.error));
      }
      voiceCancelCorrectionRef.current = true;
      setVoiceState("idle");
    };
    recognition.onend = () => {
      voiceRecognitionStartingRef.current = false;
      voiceRecognitionActiveRef.current = false;
      const shouldSkipCorrection = voiceCancelCorrectionRef.current;
      const transcript = voiceCurrentTranscriptRef.current;
      voiceStopRequestedRef.current = false;
      voiceCancelCorrectionRef.current = false;
      if (!shouldSkipCorrection && transcript.trim()) {
        void correctVoiceTranscript(transcript);
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
        locale: VOICE_CORRECTION_LOCALE
      });
      if (!result.ok) {
        setVoiceFeedback(normalizeVoiceFeedbackMessage(result.message));
        setVoiceState("idle");
        return;
      }
      await correctVoiceTranscript(result.text);
    } catch (reason) {
      setVoiceFeedback(normalizeVoiceFeedbackMessage(reason instanceof Error ? reason.message : "语音识别失败。"));
      setVoiceState("idle");
    }
  }

  async function startRecordedVoiceInput() {
    if (runningRunId || voiceState !== "idle" || voiceRecorderActiveRef.current) {
      return;
    }

    voiceBaseDraftRef.current = draftRef.current;
    voiceCurrentTranscriptRef.current = "";
    voiceFinalTranscriptRef.current = "";
    voiceStopRequestedRef.current = false;
    voiceCancelCorrectionRef.current = false;
    voiceAudioChunksRef.current = [];
    setVoiceFeedback("正在监听，点击麦克风结束。");
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
    startSpeechRecognitionInput();
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
    const content = message.trim() || (attachmentsForRun.length > 0 ? "请结合附件和当前页面内容进行总结。" : "");
    if ((!content && attachmentsForRun.length === 0) || runningRunId) {
      return;
    }
    if (!settings?.configured) {
      setFeedback("请先在设置中配置助手模型。");
      return;
    }

    if (voiceState === "recording") {
      stopVoiceInput();
      setVoiceFeedback("录音已停止，正在准备纠正语音文本...");
      return;
    }
    if (voiceState === "correcting") {
      setVoiceFeedback("语音文本正在纠正，请稍后发送。");
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

    const result = await window.electronAPI.assistant.startRun({
      chatId: activeChatId,
      message: content,
      action,
      pageContext,
      attachments: attachmentsForRun,
      historyBeforeMessageId: options.historyBeforeMessageId
    });
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }

    setActiveChatId(result.chatId);
    const userMessage = createOptimisticMessage("user", content, result.runId, attachmentsForRun);
    const assistantMessage = createOptimisticMessage("assistant", "", result.runId);
    runMessageIdsRef.current.set(result.runId, assistantMessage.id);
    setRunningRunId(result.runId);
    setMessages((current) => {
      const shouldReset = activeChatIdRef.current !== result.chatId && current.length === 0;
      return [...(shouldReset ? [] : current), userMessage, assistantMessage];
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

  async function handleStopRun() {
    if (!runningRunId) {
      return;
    }
    const result = await window.electronAPI.assistant.stopRun(runningRunId);
    if (!result.ok) {
      setFeedback(result.message);
    }
  }

  async function handleDeleteActiveChat() {
    if (!activeChatId || runningRunId) {
      return;
    }
    const result = await window.electronAPI.assistant.deleteChat(activeChatId);
    setFeedback(result.message);
    setActiveChatId(null);
    setMessages([]);
    setRunEvents([]);
    setAttachments([]);
    setActiveAwaiting(null);
    await refreshSettingsAndChats();
  }

  async function appendAttachmentResult(result: AssistantAttachmentPickResult) {
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }
    setActiveChatId(result.chatId);
    setAttachments((current) => {
      const existingIds = new Set(current.map((attachment) => attachment.id));
      return [
        ...current,
        ...result.attachments.filter((attachment) => !existingIds.has(attachment.id))
      ];
    });
    const unreadableCount = result.attachments.filter(
      (attachment) => attachment.error && !attachment.text.trim() && !attachment.dataUrl
    ).length;
    if (unreadableCount > 0) {
      setFeedback(`${unreadableCount} 个附件已保存，但暂时不能直接发送给模型识别。`);
    } else {
      setFeedback(result.message);
    }
    await refreshSettingsAndChats();
  }

  async function handlePickAttachments() {
    if (runningRunId) {
      return;
    }
    setFeedback("");
    try {
      const result = await window.electronAPI.assistant.pickAttachments(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
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
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
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

  function formatMessageForClipboard(message: AssistantChatMessage) {
    const parts = [message.content.trim()].filter(Boolean);
    const messageAttachments = message.attachments ?? [];
    if (messageAttachments.length > 0) {
      parts.push([
        "附件：",
        ...messageAttachments.map((attachment) => {
          const size = formatAttachmentSize(attachment.sizeBytes);
          const suffix = [size, attachment.error].filter(Boolean).join("，");
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
      feedback,
      voiceFeedback,
      loadingChatId ? "正在读取对话..." : ""
    ].filter(Boolean);
    if (notices.length === 0) {
      return null;
    }
    return (
      <div className="assistant-dock-feedback-stack">
        {notices.map((notice) => (
          <div className="assistant-dock-feedback" key={notice}>{notice}</div>
        ))}
      </div>
    );
  }

  function renderChatbar() {
    if (chats.length === 0 && !activeChatId) {
      return null;
    }
    const recentChats = chats.slice(0, 4);

    return (
      <div className="assistant-dock-chatbar">
        <button
          type="button"
          className={!activeChatId ? "assistant-dock-chat-pill is-active" : "assistant-dock-chat-pill"}
          onClick={startNewChat}
          disabled={Boolean(runningRunId)}
        >
          新对话
        </button>
        <div className="assistant-dock-chat-list" aria-label="最近会话">
          {recentChats.map((chat) => (
            <button
              type="button"
              className={chat.id === activeChatId ? "assistant-dock-chat-pill is-active" : "assistant-dock-chat-pill"}
              onClick={() => void loadChat(chat.id)}
              disabled={Boolean(runningRunId)}
              title={chat.title}
              key={chat.id}
            >
              {chat.title}
            </button>
          ))}
        </div>
        {activeChatId ? (
          <button
            type="button"
            className="assistant-dock-chat-delete"
            onClick={() => void handleDeleteActiveChat()}
            disabled={Boolean(runningRunId)}
          >
            删除
          </button>
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

  function renderRunTimeline(runId?: string) {
    if (!runId) {
      return null;
    }
    const timelineEvents = runEvents
      .filter((event) =>
        event.runId === runId &&
        (
          event.type === "tool.start" ||
          event.type === "tool.result" ||
          event.type === "tool.end" ||
          event.type === "awaiting.confirm" ||
          event.type === "awaiting.ask" ||
          event.type === "awaiting.answer" ||
          event.type === "artifact.publish"
        )
      )
      .sort((left, right) => left.seq - right.seq);
    if (timelineEvents.length === 0) {
      return null;
    }

    return (
      <details className="assistant-run-timeline">
        <summary className="assistant-run-summary" aria-label="展开或收起助手思考过程">
          <span className="assistant-run-summary-caret" aria-hidden="true" />
          <span className="assistant-run-summary-label">思考过程</span>
          <span className="assistant-run-summary-count">{timelineEvents.length} 步</span>
          <span className="assistant-run-summary-status">{getRunTimelineStatusText(runId, runningRunId, timelineEvents)}</span>
        </summary>
        <div className="assistant-run-events" aria-label="助手运行状态">
          {timelineEvents.map((event) => {
            const text = getRunEventText(event);
            if (!text) {
              return null;
            }
            return (
              <div className={`assistant-run-event ${getRunEventTone(event)}`} key={event.id}>
                <span className="assistant-run-event-dot" aria-hidden="true" />
                <span className="assistant-run-event-text">{text}</span>
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  function renderMessageAttachments(message: AssistantChatMessage) {
    const messageAttachments = message.attachments ?? [];
    if (messageAttachments.length === 0) {
      return null;
    }
    return (
      <div className="assistant-message-attachments" aria-label="消息附件">
        {messageAttachments.map((attachment) => (
          <span
            className={
              attachment.text.trim() || !attachment.error
                ? "assistant-message-attachment-chip"
                : "assistant-message-attachment-chip has-warning"
            }
            title={attachment.error || attachment.name}
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
    if (messages.length === 0) {
      return null;
    }

    return (
      <div className="assistant-dock-messages">
        {messages.map((message, index) => (
          <div className={`assistant-message is-${message.role}`} key={message.id}>
            <span>{message.role === "user" ? "你" : "ZenMind"}</span>
            {message.role === "assistant" ? renderRunTimeline(message.runId) : null}
            <div className="assistant-message-body">
              <p>{message.content || (message.role === "assistant" ? "正在思考..." : "")}</p>
              {renderMessageAttachments(message)}
              {renderMessageActions(message, index)}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
    );
  }

  function renderComposer(variant: AssistantDockMode) {
    const configured = settings?.configured ?? false;
    const voiceBusy = voiceState === "recording" || voiceState === "correcting";
    const canSubmit = configured && !voiceBusy && (draft.trim().length > 0 || attachments.length > 0);
    const voiceButtonDisabled = !configured || !voiceSupported || Boolean(runningRunId) || voiceState === "correcting";
    const voiceButtonTitle = !configured
      ? "请先配置助手模型"
      : !voiceSupported
        ? getVoiceUnsupportedMessage(isMac, isWindows)
        : voiceState === "recording"
          ? "停止语音输入"
          : voiceState === "correcting"
            ? "正在纠正语音文本"
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
          {attachments.length > 0 ? (
            <div className="assistant-dock-attachments" aria-label="已选择附件">
              {attachments.map((attachment) => (
                <span
                  className={
                    attachment.text.trim() || attachment.dataUrl
                      ? "assistant-dock-attachment-chip"
                      : "assistant-dock-attachment-chip has-warning"
                  }
                  key={attachment.id}
                  title={attachment.error || attachment.name}
                >
                  {attachment.name}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={`移除附件 ${attachment.name}`}
                    disabled={Boolean(runningRunId)}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
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
              <button
                type="button"
                className="assistant-dock-tool-button"
                onClick={() => void handlePickAttachments()}
                disabled={Boolean(runningRunId)}
                aria-label="添加附件"
                title="添加附件"
              >
                <PaperclipIcon />
              </button>
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
        <div className="assistant-dock-full-body">
          {messages.length === 0 ? (
            <div className="assistant-dock-empty">
              <span className="assistant-dock-empty-mark" aria-hidden="true">
                <ZenMindLogoIcon />
              </span>
              <strong>你有什么想法？</strong>
            </div>
          ) : renderMessages()}
        </div>
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
        <div className="assistant-dock-compact-body">
          {messages.length === 0 ? (
            <div className="assistant-dock-empty">
              <span className="assistant-dock-empty-mark" aria-hidden="true">
                <ZenMindLogoIcon />
              </span>
              <strong>你有什么想法？</strong>
            </div>
          ) : renderMessages()}
        </div>
        {renderComposer("compact")}
      </>
    );
  }

  const rootClassName = [
    "assistant-dock-root",
    open ? "is-open" : "",
    `is-${mode}`,
    isMac ? "is-mac" : "",
    isWindows ? "is-windows" : ""
  ].filter(Boolean).join(" ");

  return (
    <>
      {!open ? (
        <button type="button" className="assistant-dock-fab" onClick={onOpen} aria-label="打开 ZenMind助手">
          <ZenMindLogoIcon />
          <span>助手</span>
        </button>
      ) : null}
      <aside className={rootClassName} aria-hidden={!open} aria-label="ZenMind 助手">
        {mode === "full" ? renderFullMode() : renderCompactMode()}
        {activeAwaiting ? <AssistantAwaitingDialog awaiting={activeAwaiting} onSubmit={submitAwaiting} /> : null}
      </aside>
    </>
  );
}
