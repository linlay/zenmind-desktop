import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type WheelEvent } from "react";
import type {
  AssistantAttachment,
  AssistantAttachmentPickResult,
  AssistantChatMessage,
  AssistantSettingsPublic
} from "../../shared/contracts";
import { AssistantMarkdownContent } from "./AssistantMarkdownContent";
import {
  getArtifactAttachmentsFromEvent,
  getArtifactAttachmentsFromMessages,
  mergeAssistantAttachments
} from "../services/assistantArtifacts";
import {
  ensureAssistantMessageForRun as ensureRemoteAssistantMessageForRun,
  isStructuredAssistantEvent,
  isTerminalAssistantEvent,
  shouldEnsureAssistantMessageForEvent
} from "../services/assistantEventState";

type VoiceState = "idle" | "recording" | "transcribing";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  [index: number]: { transcript: string };
};

type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
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

const VOICE_TRANSCRIPTION_TIMEOUT_MS = 45000;
const VOICE_CORRECTION_TIMEOUT_MS = 20000;

const VOICE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus"
];

function createLocalMessage(
  role: AssistantChatMessage["role"],
  content: string,
  runId?: string,
  attachments?: AssistantAttachment[]
) {
  return {
    id: `quick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(runId ? { runId } : {}),
    ...(attachments?.length ? { attachments } : {})
  } satisfies AssistantChatMessage;
}

function getPreferredVoiceMimeType() {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
    return "";
  }
  return VOICE_MIME_TYPES.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function canUseVoiceRecorder() {
  return Boolean(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") {
    return null;
  }
  const browserWindow = window as SpeechRecognitionWindow;
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

function canUseVoiceInput() {
  return canUseVoiceRecorder() || Boolean(getSpeechRecognitionConstructor());
}

function getVoiceRecognitionErrorMessage(error: string) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未开启。";
    case "no-speech":
      return "没有识别到语音，请再试一次。";
    case "audio-capture":
      return "无法访问麦克风。";
    case "network":
      return "语音识别网络异常，请稍后重试。";
    default:
      return "语音识别失败，请重新尝试。";
  }
}

function withVoiceTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        globalThis.clearTimeout(timer);
        reject(reason);
      }
    );
  });
}

function appendVoiceText(current: string, next: string) {
  const currentText = current.trimEnd();
  const nextText = next.trim();
  if (!nextText) {
    return current;
  }
  return `${currentText}${currentText ? " " : ""}${nextText}`.trimStart();
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
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

function MicIcon() {
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
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
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

function NewChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
      <path d="M15 4h5v5" />
      <path d="m11 13 8.5-8.5" />
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

function ZenMindMarkIcon() {
  return (
    <img
      src="./brand-icon.png"
      alt=""
      className="quick-brand-icon"
      draggable={false}
    />
  );
}

export function QuickAssistant() {
  const [settings, setSettings] = useState<AssistantSettingsPublic | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [activeAttachmentTaskId, setActiveAttachmentTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceExpandedComposer, setVoiceExpandedComposer] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(() => canUseVoiceInput());
  const [isExpanded, setIsExpanded] = useState(false);
  const [artifactDockVisible, setArtifactDockVisible] = useState(true);
  const [hiddenArtifactIds, setHiddenArtifactIds] = useState<Set<string>>(() => new Set());
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentMenuPinned, setAttachmentMenuPinned] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const attachmentMenuCloseTimerRef = useRef<number | null>(null);
  const attachmentMenuOpenTimerRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const runningRunIdRef = useRef<string | null>(runningRunId);
  const runMessageIdsRef = useRef(new Map<string, string>());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCancelRef = useRef(false);
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceRecognitionActiveRef = useRef(false);
  const voiceRecognitionTranscriptRef = useRef("");
  const voiceRecognitionStopRequestedRef = useRef(false);
  const voiceRecognitionFallbackToRecorderRef = useRef(false);
  const voiceBaseDraftRef = useRef("");
  const voiceOperationIdRef = useRef(0);
  const visibleAttachments = attachments.filter((attachment) => !attachment.hidden);
  const isSmallTrayMode = !isExpanded && visibleAttachments.length === 0 && !voiceExpandedComposer;
  const quickAssistantDisplayMode = isExpanded
    ? "expanded"
    : attachmentMenuOpen
      ? isSmallTrayMode
        ? "compactMenu"
        : "menu"
    : visibleAttachments.length > 0 || voiceExpandedComposer
      ? "attachment"
      : "compact";
  const showScreenshotMenuItem = !isSmallTrayMode;
  const hasDraft = draft.trim().length > 0;
  const showSendAction = hasDraft || attachments.some((attachment) => !attachment.hidden);
  const canSubmit = showSendAction && !runningRunId && voiceState === "idle";
  const voiceStatus = voiceState === "recording"
    ? "正在监听，点击麦克风结束。"
    : voiceState === "transcribing"
      ? "正在识别语音..."
      : "";
  const composerStatus = isExpanded ? voiceStatus || feedback : "";
  const composerHasStatus = Boolean(composerStatus);
  const composerSingleLine = !voiceExpandedComposer && !composerHasStatus;
  const attachmentMenuDisabled = Boolean(runningRunId) || Boolean(activeAttachmentTaskId) || voiceState !== "idle";

  async function refreshAssistantSettings() {
    const nextSettings = await window.electronAPI.assistant.getSettings();
    setSettings(nextSettings);
    return nextSettings;
  }

  function applyVoiceTextToDraft(text: string) {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return;
    }
    setVoiceExpandedComposer(normalizedText.length > 42 || normalizedText.includes("\n"));
    setDraft((current) => {
      const nextDraft = appendVoiceText(current, normalizedText);
      draftRef.current = nextDraft;
      return nextDraft;
    });
    textareaRef.current?.focus();
  }

  function ensureAssistantMessageForRun(runId: string) {
    return ensureRemoteAssistantMessageForRun(runId, runMessageIdsRef.current, setMessages, "quick_remote_");
  }

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    runningRunIdRef.current = runningRunId;
    void window.electronAPI.quickAssistant.setInteractionState({
      busy: Boolean(runningRunId) || voiceState !== "idle"
    });
  }, [runningRunId, voiceState]);

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
    if (attachmentMenuDisabled) {
      closeAttachmentMenu();
    }
  }, [attachmentMenuDisabled]);

  useEffect(() => () => clearAttachmentMenuCloseTimer(), []);

  useEffect(() => {
    document.body.classList.add("quick-assistant-body");
    void refreshAssistantSettings().catch((reason) => {
      setIsExpanded(true);
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    });
    setVoiceSupported(canUseVoiceInput());
    textareaRef.current?.focus();
    return () => {
      document.body.classList.remove("quick-assistant-body");
      stopVoiceInput(true);
      void window.electronAPI.quickAssistant.setInteractionState({ busy: false, mouseInside: false });
    };
  }, []);

  useEffect(() => {
    return window.electronAPI.quickAssistant.onCompactModeRequested(() => {
      stopVoiceInput(true);
      setIsExpanded(false);
      setFeedback("");
      setVoiceState("idle");
      setVoiceExpandedComposer(false);
      textareaRef.current?.focus();
    });
  }, []);

  useLayoutEffect(() => {
    void window.electronAPI.quickAssistant.setDisplayMode(quickAssistantDisplayMode);
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [quickAssistantDisplayMode, messages]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const hasDraft = draft.trim().length > 0;
    const currentVoiceStatus = voiceState === "recording"
      ? "正在监听，点击麦克风结束。"
      : voiceState === "transcribing"
        ? "正在识别语音..."
        : "";
    const currentComposerHasStatus = isExpanded && Boolean(currentVoiceStatus || feedback);
    const singleLineComposer = !voiceExpandedComposer && !currentComposerHasStatus;
    const minHeight = singleLineComposer ? 42 : hasDraft && voiceExpandedComposer ? 72 : 30;
    const maxHeight = hasDraft && (isExpanded || voiceExpandedComposer) ? 160 : singleLineComposer ? 42 : 46;
    textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
  }, [draft, feedback, isExpanded, quickAssistantDisplayMode, voiceExpandedComposer, voiceState]);

  useEffect(() => {
    return window.electronAPI.assistant.onAssistantEvent((event) => {
      const isActiveChatEvent = event.chatId === activeChatIdRef.current;
      if (!isStructuredAssistantEvent(event)) {
        if (isTerminalAssistantEvent(event) && event.runId && runningRunIdRef.current === event.runId) {
          setRunningRunId(null);
        }
        return;
      }

      if (isActiveChatEvent && event.type === "run.start") {
        setRunningRunId(event.runId);
        ensureAssistantMessageForRun(event.runId);
      }
      if (isActiveChatEvent && event.type === "awaiting.ask") {
        setIsExpanded(true);
        setFeedback("需要确认，已打开主窗口继续处理。");
        void window.electronAPI.quickAssistant.openMainAssistant(event.chatId);
      }

      const messageId = runMessageIdsRef.current.get(event.runId) ??
        (isActiveChatEvent && shouldEnsureAssistantMessageForEvent(event) ? ensureAssistantMessageForRun(event.runId) : undefined);
      if (event.type === "content.delta" && messageId && event.delta) {
        setMessages((current) => current.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${event.delta}` }
            : message
        ));
      }

      if (event.type === "artifact.publish" && messageId) {
        const artifactAttachments = getArtifactAttachmentsFromEvent(event);
        if (artifactAttachments.length > 0) {
          setArtifactDockVisible(true);
          setMessages((current) => current.map((message) =>
            message.id === messageId
              ? { ...message, attachments: mergeAssistantAttachments(message.attachments, artifactAttachments) }
              : message
          ));
        }
      }

      if (!isTerminalAssistantEvent(event)) {
        return;
      }

      if (messageId && event.type === "run.error") {
        const errorContent = event.message || (event.error ? `生成失败：${event.error}` : "生成失败。");
        setMessages((current) => current.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content ? `${message.content}\n\n${errorContent}` : errorContent }
            : message
        ));
      }
      if (messageId && event.type === "run.stopped") {
        setMessages((current) => current.map((message) =>
          message.id === messageId && !message.content
            ? { ...message, content: "已停止生成。" }
            : message
        ));
      }
      runMessageIdsRef.current.delete(event.runId);
      if (runningRunIdRef.current === event.runId) {
        setRunningRunId(null);
      }
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.assistant.onAttachmentProgress((progress) => {
      setActiveAttachmentTaskId(progress.done ? null : progress.taskId);
      if (!progress.cancelled) {
        showFeedback(progress.message);
      }
    });
  }, []);

  function showFeedback(message: string) {
    setIsExpanded(true);
    setFeedback(message);
  }

  function stopVoiceRecording(cancel: boolean) {
    if (cancel) {
      voiceOperationIdRef.current += 1;
      setVoiceState("idle");
    }
    if (cancel) {
      voiceChunksRef.current = [];
    }
    voiceCancelRef.current = cancel;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (reason) {
        setFeedback(reason instanceof Error ? reason.message : "语音录制停止失败。");
        setVoiceState("idle");
      }
    } else if (!cancel) {
      setVoiceState("idle");
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
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
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      voiceRecognitionActiveRef.current = true;
      voiceRecognitionTranscriptRef.current = "";
      setVoiceState("recording");
      setFeedback("正在监听，点击麦克风结束。");
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript = `${transcript}${result[0]?.transcript ?? ""}`;
      }
      if (transcript.trim()) {
        voiceRecognitionTranscriptRef.current = transcript;
      }
    };
    recognition.onerror = (event) => {
      voiceRecognitionActiveRef.current = false;
      const hasTranscript = Boolean(voiceRecognitionTranscriptRef.current.trim());
      const shouldFallbackToRecorder =
        !voiceRecognitionStopRequestedRef.current &&
        event.error === "network" &&
        !hasTranscript &&
        canUseVoiceRecorder();
      if (
        !voiceRecognitionStopRequestedRef.current &&
        event.error !== "aborted" &&
        !hasTranscript
      ) {
        if (shouldFallbackToRecorder) {
          showFeedback("内部语音识别网络异常，正在切换录音转写...");
        } else {
          showFeedback(event.message || getVoiceRecognitionErrorMessage(event.error));
        }
      }
      voiceRecognitionFallbackToRecorderRef.current = shouldFallbackToRecorder;
      setVoiceState("idle");
    };
    recognition.onend = () => {
      voiceRecognitionActiveRef.current = false;
      const transcript = voiceRecognitionTranscriptRef.current;
      const shouldFallbackToRecorder = voiceRecognitionFallbackToRecorderRef.current;
      const shouldApplyTranscript = !voiceRecognitionStopRequestedRef.current && transcript.trim();
      voiceRecognitionStopRequestedRef.current = false;
      voiceRecognitionFallbackToRecorderRef.current = false;
      if (shouldFallbackToRecorder) {
        void startVoiceRecorderInput({
          feedback: "内部语音识别网络异常，已切换录音转写，点击麦克风结束。"
        });
        return;
      }
      if (shouldApplyTranscript) {
        const operationId = voiceOperationIdRef.current;
        void applyTranscribedVoiceText(transcript, operationId);
        return;
      }
      setVoiceState("idle");
    };

    voiceRecognitionRef.current = recognition;
    return recognition;
  }

  function stopVoiceRecognition(cancel: boolean) {
    if (cancel) {
      voiceOperationIdRef.current += 1;
      voiceRecognitionTranscriptRef.current = "";
      voiceRecognitionStopRequestedRef.current = true;
      voiceRecognitionFallbackToRecorderRef.current = false;
    }
    const recognition = voiceRecognitionRef.current;
    if (!recognition) {
      return;
    }
    if (voiceRecognitionActiveRef.current) {
      try {
        recognition.stop();
      } catch (reason) {
        showFeedback(reason instanceof Error ? reason.message : "语音输入停止失败。");
        setVoiceState("idle");
      }
    } else if (cancel) {
      try {
        recognition.abort();
      } catch {
        // Ignore abort errors during cleanup.
      }
      setVoiceState("idle");
    }
  }

  function stopVoiceInput(cancel: boolean) {
    if (voiceRecognitionActiveRef.current) {
      stopVoiceRecognition(cancel);
      return;
    }
    if (mediaRecorderRef.current) {
      stopVoiceRecording(cancel);
      return;
    }
    if (cancel) {
      stopVoiceRecognition(true);
    }
  }

  async function applyTranscribedVoiceText(transcriptText: string, operationId: number) {
    if (operationId !== voiceOperationIdRef.current) {
      return;
    }
    const text = transcriptText.trim();
    if (!text) {
      setFeedback("");
      setVoiceState("idle");
      return;
    }
    const baseDraft = voiceBaseDraftRef.current;
    if (draftRef.current !== baseDraft) {
      showFeedback("检测到手动编辑，已保留当前输入。");
      setVoiceState("idle");
      return;
    }
    const recognizedDraft = appendVoiceText(baseDraft, text);
    setVoiceExpandedComposer(text.length > 42 || text.includes("\n"));
    draftRef.current = recognizedDraft;
    setDraft(recognizedDraft);
    textareaRef.current?.focus();

    setVoiceState("transcribing");
    setFeedback("正在整理语音文本...");
    const corrected = await withVoiceTimeout(
      window.electronAPI.assistant.correctVoiceText({
        text,
        locale: "zh-CN-mixed-en"
      }),
      VOICE_CORRECTION_TIMEOUT_MS,
      "语音文本整理超时，已保留原始识别结果。"
    ).catch((reason) => {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
      return null;
    });
    if (operationId !== voiceOperationIdRef.current) {
      return;
    }
    const correctedText = corrected ? (corrected.correctedText || corrected.text).trim() : "";
    if (draftRef.current !== recognizedDraft) {
      showFeedback("检测到手动编辑，已保留当前输入。");
      setVoiceState("idle");
      return;
    }
    const finalText = corrected?.ok && correctedText ? correctedText : text;
    const finalDraft = appendVoiceText(baseDraft, finalText);
    setVoiceExpandedComposer(finalText.length > 42 || finalText.includes("\n"));
    draftRef.current = finalDraft;
    setDraft(finalDraft);
    textareaRef.current?.focus();
    setFeedback("");
    setVoiceState("idle");
  }

  async function finishVoiceRecording(mimeType: string, operationId: number) {
    if (operationId !== voiceOperationIdRef.current) {
      return;
    }
    const cancelled = voiceCancelRef.current;
    voiceCancelRef.current = false;
    const chunks = voiceChunksRef.current;
    voiceChunksRef.current = [];
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;

    if (cancelled) {
      setVoiceState("idle");
      return;
    }

    if (chunks.length === 0) {
      showFeedback("没有录到可识别的语音。");
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");
    setFeedback("正在识别语音...");
    try {
      const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" });
      const transcript = await withVoiceTimeout(
        window.electronAPI.assistant.transcribeVoiceAudio({
          mimeType: blob.type || "audio/webm",
          data: await blob.arrayBuffer(),
          locale: "zh-CN-mixed-en"
        }),
        VOICE_TRANSCRIPTION_TIMEOUT_MS,
        "语音识别超时，请重新尝试。"
      );
      if (operationId !== voiceOperationIdRef.current) {
        return;
      }
      if (!transcript.ok) {
        showFeedback(transcript.message || "语音识别失败。");
        return;
      }
      if (!transcript.text.trim()) {
        setFeedback("");
        return;
      }
      await applyTranscribedVoiceText(transcript.text, operationId);
    } catch (reason) {
      showFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (operationId === voiceOperationIdRef.current) {
        setVoiceState("idle");
      }
    }
  }

  async function startVoiceRecorderInput(options: { feedback?: string } = {}) {
    const mimeType = getPreferredVoiceMimeType();
    const operationId = voiceOperationIdRef.current + 1;
    voiceOperationIdRef.current = operationId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (operationId !== voiceOperationIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceChunksRef.current = [];
      voiceCancelRef.current = false;
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void finishVoiceRecording(recorder.mimeType || mimeType, operationId);
      };
      recorder.onerror = (event) => {
        voiceOperationIdRef.current += 1;
        voiceCancelRef.current = true;
        setVoiceState("idle");
        showFeedback(event.error?.message || "录音失败，请重新尝试。");
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
      };
      recorder.start();
      setVoiceState("recording");
      setFeedback(options.feedback || "正在监听，点击麦克风结束。");
    } catch (reason) {
      showFeedback(reason instanceof Error ? reason.message : "麦克风权限未开启。");
      setVoiceState("idle");
    }
  }

  async function toggleVoice() {
    if (voiceState === "recording") {
      stopVoiceInput(false);
      return;
    }
    if (voiceState === "transcribing") {
      setFeedback("语音正在识别，请稍候。");
      return;
    }
    if (!voiceSupported || runningRunId) {
      showFeedback("当前环境无法访问麦克风语音输入。");
      return;
    }
    setFeedback("");
    voiceBaseDraftRef.current = draftRef.current;
    if (canUseVoiceRecorder()) {
      await startVoiceRecorderInput();
      return;
    }
    const recognition = ensureVoiceRecognition();
    if (recognition) {
      const operationId = voiceOperationIdRef.current + 1;
      voiceOperationIdRef.current = operationId;
      voiceRecognitionTranscriptRef.current = "";
      voiceRecognitionStopRequestedRef.current = false;
      voiceRecognitionFallbackToRecorderRef.current = false;
      try {
        recognition.start();
        return;
      } catch (reason) {
        showFeedback(reason instanceof Error ? reason.message : "语音输入启动失败。");
        setVoiceState("idle");
        return;
      }
    }

    showFeedback("当前环境无法访问前端语音识别。");
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

  async function openMessageAttachment(attachment: AssistantAttachment) {
    if (!activeChatId) {
      showFeedback("请先打开对应对话后再打开附件。");
      return;
    }
    const result = await window.electronAPI.assistant.openAttachment(activeChatId, attachment.id);
    showFeedback(result.ok ? "已打开产物。" : result.message || "打开产物失败。");
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

  function renderArtifactDock() {
    const artifactAttachments = getArtifactAttachmentsFromMessages(messages)
      .filter((attachment) => !hiddenArtifactIds.has(attachment.artifactId || attachment.id));
    if (artifactAttachments.length === 0 || !isExpanded || !artifactDockVisible) {
      return null;
    }
    return (
      <div className="quick-artifact-dock" aria-label="生成的产物">
        <ul className="quick-artifact-list" onWheel={handleArtifactListWheel}>
          {artifactAttachments.map((attachment) => {
            const size = formatAttachmentSize(attachment.sizeBytes) || attachment.mimeType;
            const artifactKey = attachment.artifactId || attachment.id;
            return (
              <li className="quick-artifact-item" key={artifactKey}>
                <button
                  type="button"
                  className="quick-artifact-card"
                  onClick={() => void openMessageAttachment(attachment)}
                  title={attachment.name}
                >
                  <span className="quick-artifact-card-file-shell">
                    <span className="quick-artifact-card-file-icon" aria-hidden="true">
                      <FileArtifactIcon />
                    </span>
                    <span className="quick-artifact-card-file-copy">
                      <span className="quick-artifact-card-title">{attachment.name}</span>
                      {size ? <span className="quick-artifact-card-subtitle">{size}</span> : null}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="quick-artifact-remove"
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
        <div className="quick-artifact-actions">
          <button
            type="button"
            className="quick-artifact-collapse"
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
      <div className="quick-message-attachments" aria-label="消息附件">
        {regularAttachments.map((attachment) => (
          <span
            className={
              isAttachmentReadable(attachment)
                ? "quick-message-attachment-card"
                : "quick-message-attachment-card has-warning"
            }
            title={attachmentStatusTitle(attachment)}
            key={attachment.id}
          >
            <strong>{attachment.name}</strong>
            <small>{formatAttachmentSize(attachment.sizeBytes) || attachment.mimeType || "附件"}</small>
          </span>
        ))}
      </div>
    );
  }

  async function startRun() {
    const content = draft.trim() || (attachments.length > 0 ? "请结合附件内容进行总结。" : "");
    if ((!content && attachments.length === 0) || runningRunId) {
      return;
    }
    if (!settings?.configured) {
      showFeedback("请先配置 agent-platform 的 minimax provider。");
      return;
    }
    if (voiceState === "recording") {
      stopVoiceInput(false);
      setFeedback("语音已停止，正在整理文本。");
      return;
    }
    if (voiceState === "transcribing") {
      showFeedback("语音正在识别，请稍后发送。");
      return;
    }

    setFeedback("");
    let result;
    try {
      result = await window.electronAPI.assistant.startRun({
        chatId: activeChatId,
        message: content,
        action: "chat",
        source: "quick-assistant",
        pageContext: null,
        attachments
      });
    } catch (reason) {
      showFeedback(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (!result.ok) {
      showFeedback(result.message);
      return;
    }

	    setIsExpanded(true);
	    activeChatIdRef.current = result.chatId;
	    setActiveChatId(result.chatId);
    const userMessage = createLocalMessage("user", content, result.runId, attachments);
    const assistantMessage = createLocalMessage("assistant", "", result.runId);
    runMessageIdsRef.current.set(result.runId, assistantMessage.id);
    setRunningRunId(result.runId);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setAttachments([]);
    setDraft("");
    setVoiceExpandedComposer(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void startRun();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void startRun();
  }

	  function startNewChat() {
	    if (runningRunId) {
	      return;
	    }
	    stopVoiceInput(true);
	    activeChatIdRef.current = null;
	    setActiveChatId(null);
    setMessages([]);
    setAttachments([]);
    setHiddenArtifactIds(new Set());
    setDraft("");
    setFeedback("");
    setIsExpanded(false);
    setVoiceExpandedComposer(false);
    textareaRef.current?.focus();
  }

  async function handleStopRun() {
    if (!runningRunId) {
      return;
    }
    const result = await window.electronAPI.assistant.stopRun(runningRunId);
    if (!result.ok) {
      showFeedback(result.message);
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    setVoiceExpandedComposer(value.trim().length > 0 && (value.length > 42 || value.includes("\n")));
  }

  async function appendAttachmentResult(result: AssistantAttachmentPickResult) {
    if (!result.ok) {
      if (!result.message.includes("取消")) {
        showFeedback(result.message);
      }
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
    setFeedback("");
  }

  async function chooseAttachmentFiles() {
    if (runningRunId || activeAttachmentTaskId || voiceState !== "idle") {
      return;
    }
    try {
      const result = await window.electronAPI.quickAssistant.pickAttachments(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      showFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function captureScreenshotQuestion() {
    if (runningRunId || activeAttachmentTaskId || voiceState !== "idle") {
      return;
    }
    try {
      const result = await window.electronAPI.quickAssistant.captureScreenshot(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      showFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function cancelAttachmentTask() {
    if (!activeAttachmentTaskId) {
      return;
    }
    const result = await window.electronAPI.quickAssistant.cancelAttachmentTask(activeAttachmentTaskId);
    showFeedback(result.message);
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

  function clearAttachmentMenuOpenTimer() {
    if (attachmentMenuOpenTimerRef.current !== null) {
      window.clearTimeout(attachmentMenuOpenTimerRef.current);
      attachmentMenuOpenTimerRef.current = null;
    }
  }

  function closeAttachmentMenu() {
    clearAttachmentMenuOpenTimer();
    clearAttachmentMenuCloseTimer();
    setAttachmentMenuOpen(false);
    setAttachmentMenuPinned(false);
  }

  function showAttachmentMenu() {
    if (attachmentMenuDisabled) {
      return;
    }
    clearAttachmentMenuCloseTimer();
    if (attachmentMenuOpen || attachmentMenuOpenTimerRef.current !== null) {
      return;
    }
    attachmentMenuOpenTimerRef.current = window.setTimeout(() => {
      attachmentMenuOpenTimerRef.current = null;
      setAttachmentMenuOpen(true);
    }, 420);
  }

  function hideAttachmentMenuOnLeave() {
    clearAttachmentMenuOpenTimer();
    if (!attachmentMenuPinned) {
      clearAttachmentMenuCloseTimer();
      attachmentMenuCloseTimerRef.current = window.setTimeout(() => {
        attachmentMenuCloseTimerRef.current = null;
        setAttachmentMenuOpen(false);
      }, 180);
    }
  }

  function toggleAttachmentMenu() {
    if (attachmentMenuDisabled) {
      return;
    }
    clearAttachmentMenuOpenTimer();
    if (attachmentMenuOpen && attachmentMenuPinned) {
      closeAttachmentMenu();
      return;
    }
    setAttachmentMenuOpen(true);
    setAttachmentMenuPinned(true);
  }

  async function handleChooseAttachmentFromMenu() {
    closeAttachmentMenu();
    await chooseAttachmentFiles();
  }

  async function handleCaptureScreenshotFromMenu() {
    closeAttachmentMenu();
    await captureScreenshotQuestion();
  }

  return (
    <div
      className={[
        "quick-assistant",
        isExpanded ? "is-expanded" : "is-compact",
        attachmentMenuOpen ? "is-menu-open" : "",
        !isExpanded && visibleAttachments.length > 0 ? "has-attachments" : ""
      ].filter(Boolean).join(" ")}
      onPointerEnter={() => void window.electronAPI.quickAssistant.setInteractionState({ mouseInside: true })}
      onPointerLeave={() => void window.electronAPI.quickAssistant.setInteractionState({ mouseInside: false })}
    >
      {isExpanded ? (
        <header className="quick-assistant-header">
          <button type="button" className="quick-icon-button" onClick={() => void window.electronAPI.quickAssistant.hide()} aria-label="关闭">
            <CloseIcon />
          </button>
          <div className="quick-header-actions">
            <button type="button" className="quick-icon-button" onClick={startNewChat} disabled={Boolean(runningRunId)} aria-label="新对话">
              <NewChatIcon />
            </button>
            <button type="button" className="quick-icon-button" onClick={() => void window.electronAPI.quickAssistant.openMainAssistant(activeChatId)} aria-label="展开到主窗口">
              <ExpandIcon />
            </button>
          </div>
        </header>
      ) : null}
      {isExpanded ? (
        <main className="quick-assistant-content">
          {messages.length === 0 ? (
            <div className="quick-empty">
              <ZenMindMarkIcon />
              <span>你可以直接问 ZenMind。</span>
            </div>
          ) : (
            <div className="quick-message-list">
              {messages.map((message) => (
                <article key={message.id} className={`quick-message is-${message.role}`}>
                  {message.role === "assistant" ? <ZenMindMarkIcon /> : null}
                  {message.role === "assistant" ? (
                    <AssistantMarkdownContent
                      className="quick-message-markdown"
                      content={message.content || "正在思考..."}
                    />
                  ) : (
                    <div className="quick-message-text">{message.content}</div>
                  )}
                  {renderMessageAttachments(message)}
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
          {feedback ? (
            <div className="quick-feedback">
              <span>{feedback}</span>
              {!settings?.configured ? (
                <button type="button" onClick={() => void window.electronAPI.quickAssistant.openSettings()}>
                  去设置
                </button>
              ) : null}
              {activeAttachmentTaskId ? (
                <button type="button" onClick={() => void cancelAttachmentTask()}>
                  取消
                </button>
              ) : null}
            </div>
          ) : null}
        </main>
      ) : null}
      {renderArtifactDock()}
      {visibleAttachments.length > 0 ? (
        <div className="quick-attachment-strip">
          {visibleAttachments.map((attachment) => {
            const canPreviewImage = canPreviewImageAttachment(attachment);
            return (
              <span
                key={attachment.id}
                className={[
                  isAttachmentReadable(attachment)
                    ? "quick-attachment-preview-card"
                    : "quick-attachment-preview-card has-warning",
                  canPreviewImage ? "is-image-previewable" : ""
                ].filter(Boolean).join(" ")}
                title={canPreviewImage ? `在主窗口预览：${attachment.name}` : attachmentStatusTitle(attachment)}
              >
                {canPreviewImage ? (
                  <button
                    type="button"
                    className="quick-attachment-preview-image-button"
                    onClick={() => void window.electronAPI.quickAssistant.openMainAssistant(activeChatId)}
                    aria-label={`在主窗口预览图片 ${attachment.name}`}
                  >
                    <img src={attachment.dataUrl} alt="" draggable={false} />
                  </button>
                ) : (
                  <span className="quick-attachment-preview-file">
                    {attachment.document?.format?.toUpperCase() || attachment.mimeType.split("/").pop()?.toUpperCase() || "FILE"}
                  </span>
                )}
                <strong>{attachment.name}</strong>
                <small>{formatAttachmentSize(attachment.sizeBytes) || attachment.mimeType || "附件"}</small>
                <button
                  type="button"
                  className="quick-attachment-remove"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`移除附件 ${attachment.name}`}
                  disabled={Boolean(runningRunId)}
                >
                  <CloseIcon />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <form
        className={[
          "quick-composer",
          composerSingleLine ? "is-single-line" : "",
          quickAssistantDisplayMode === "compact" ? "is-tray" : "",
          voiceExpandedComposer ? "is-voice-expanded" : "",
          composerHasStatus ? "has-status" : ""
        ].filter(Boolean).join(" ")}
        onSubmit={handleSubmit}
      >
        <div
          className="quick-attachment-entry attachment-action-menu-root"
          ref={attachmentMenuRef}
          onPointerEnter={showAttachmentMenu}
          onPointerLeave={hideAttachmentMenuOnLeave}
        >
          <button
            type="button"
            className="quick-tool-button quick-attach-button"
            onClick={toggleAttachmentMenu}
            disabled={attachmentMenuDisabled}
            aria-label="附件操作"
            title="附件操作"
            aria-haspopup="menu"
            aria-expanded={attachmentMenuOpen}
          >
            <PlusIcon />
          </button>
          <div
            className={[
              "attachment-action-menu",
              "quick-attachment-action-menu",
              attachmentMenuOpen ? "is-open" : ""
            ].filter(Boolean).join(" ")}
            role="menu"
            aria-label="附件操作"
          >
            <button type="button" className="attachment-action-menu-item" onClick={() => void handleChooseAttachmentFromMenu()} role="menuitem">
              <PlusIcon />
              <span>上传文件</span>
            </button>
            {showScreenshotMenuItem ? (
              <button type="button" className="attachment-action-menu-item" onClick={() => void handleCaptureScreenshotFromMenu()} role="menuitem">
                <ScreenshotIcon />
                <span>截屏提问</span>
              </button>
            ) : null}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="问问 ZenMind"
          rows={1}
          disabled={Boolean(runningRunId)}
        />
        {runningRunId ? (
          <button
            type="button"
            className="quick-send-button quick-primary-action"
            onClick={() => void handleStopRun()}
            aria-label="停止生成"
            title="停止生成"
          >
            <StopIcon />
          </button>
        ) : showSendAction ? (
          <button
            type="submit"
            className="quick-send-button quick-primary-action"
            disabled={!canSubmit}
            aria-label="发送"
            title="发送"
          >
            <SendIcon />
          </button>
        ) : (
          <button
            type="button"
            className={[
              "quick-tool-button",
              "quick-primary-action",
              "quick-voice-button",
              voiceState === "recording" ? "is-recording" : "",
              voiceState === "transcribing" ? "is-transcribing" : ""
            ].filter(Boolean).join(" ")}
            onClick={() => void toggleVoice()}
            disabled={!voiceSupported || Boolean(runningRunId) || voiceState === "transcribing"}
            aria-label={voiceState === "recording" ? "停止语音输入" : "语音输入"}
            title={voiceState === "recording" ? "停止语音输入" : voiceState === "transcribing" ? "正在识别语音" : "语音输入"}
          >
            <MicIcon />
          </button>
        )}
        <button
          type="button"
          className="quick-tool-button quick-expand-button"
          onClick={() => void window.electronAPI.quickAssistant.openMainAssistant(activeChatId)}
          aria-label="展开到主窗口"
          title="展开到主窗口"
        >
          <ExpandIcon />
        </button>
        {composerStatus ? (
          <div className="quick-composer-status" aria-live="polite">
            <span>{composerStatus}</span>
            {activeAttachmentTaskId ? (
              <button type="button" onClick={() => void cancelAttachmentTask()}>
                取消
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
