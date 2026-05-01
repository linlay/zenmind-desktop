import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  AssistantAttachment,
  AssistantAttachmentPickResult,
  AssistantChatMessage,
  AssistantEvent,
  AssistantRunEvent,
  AssistantSettingsPublic
} from "../../shared/contracts";
import { AssistantMarkdownContent } from "./AssistantMarkdownContent";

type VoiceState = "idle" | "recording" | "transcribing";

const VOICE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus"
];

const STRUCTURED_EVENT_TYPES = new Set([
  "request.query",
  "chat.start",
  "run.start",
  "content.delta",
  "run.complete",
  "run.error",
  "run.stopped",
  "done"
]);

function isStructuredEvent(event: AssistantEvent): event is AssistantRunEvent {
  return STRUCTURED_EVENT_TYPES.has(event.type) &&
    typeof event.id === "string" &&
    typeof event.seq === "number" &&
    typeof event.createdAt === "string";
}

function isTerminalEvent(event: AssistantEvent) {
  return event.type === "done" ||
    event.type === "run.complete" ||
    event.type === "run.error" ||
    event.type === "run.stopped" ||
    event.type === "error" ||
    event.type === "stopped";
}

function createLocalMessage(role: AssistantChatMessage["role"], content: string, runId?: string) {
  return {
    id: `quick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(runId ? { runId } : {})
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

function ZmanMarkIcon() {
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
  const [draft, setDraft] = useState("");
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceExpandedComposer, setVoiceExpandedComposer] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(() => canUseVoiceRecorder());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const runningRunIdRef = useRef<string | null>(runningRunId);
  const runMessageIdsRef = useRef(new Map<string, string>());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCancelRef = useRef(false);
  const isExpanded = messages.length > 0 || Boolean(runningRunId) || Boolean(feedback) || voiceExpandedComposer;

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
    document.body.classList.add("quick-assistant-body");
    void window.electronAPI.assistant.getSettings().then(setSettings).catch((reason) => {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    });
    setVoiceSupported(canUseVoiceRecorder());
    textareaRef.current?.focus();
    return () => {
      document.body.classList.remove("quick-assistant-body");
      stopVoiceRecording(true);
      void window.electronAPI.quickAssistant.setInteractionState({ busy: false, mouseInside: false });
    };
  }, []);

  useLayoutEffect(() => {
    void window.electronAPI.quickAssistant.setExpanded(isExpanded);
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [isExpanded, messages]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const minHeight = voiceExpandedComposer ? 82 : 34;
    const maxHeight = isExpanded || voiceExpandedComposer ? 160 : 46;
    textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
  }, [draft, isExpanded, voiceExpandedComposer]);

  useEffect(() => {
    return window.electronAPI.assistant.onAssistantEvent((event) => {
      if (!isStructuredEvent(event)) {
        if (isTerminalEvent(event) && event.runId && runningRunIdRef.current === event.runId) {
          setRunningRunId(null);
        }
        return;
      }

      const messageId = runMessageIdsRef.current.get(event.runId);
      if (event.type === "content.delta" && messageId && event.delta) {
        setMessages((current) => current.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${event.delta}` }
            : message
        ));
      }

      if (!isTerminalEvent(event)) {
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

  function stopVoiceRecording(cancel: boolean) {
    if (cancel) {
      voiceChunksRef.current = [];
    }
    voiceCancelRef.current = cancel;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }

  async function finishVoiceRecording(mimeType: string) {
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
      setFeedback("没有录到可识别的语音。");
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");
    try {
      const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" });
      const transcript = await window.electronAPI.assistant.transcribeVoiceAudio({
        mimeType: blob.type || "audio/webm",
        data: await blob.arrayBuffer(),
        locale: "zh-CN-mixed-en"
      });
      if (!transcript.ok || !transcript.text.trim()) {
        setFeedback(transcript.message || "语音识别失败。");
        return;
      }
      const corrected = await window.electronAPI.assistant.correctVoiceText({
        text: transcript.text,
        locale: "zh-CN-mixed-en"
      });
      const text = corrected.ok && corrected.text.trim() ? corrected.text : transcript.text;
      setVoiceExpandedComposer(true);
      setDraft((current) => `${current}${current.trim() ? " " : ""}${text}`.trimStart());
      setFeedback(corrected.message || transcript.message);
      textareaRef.current?.focus();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVoiceState("idle");
    }
  }

  async function toggleVoice() {
    if (voiceState === "recording") {
      stopVoiceRecording(false);
      return;
    }
    if (!voiceSupported || runningRunId) {
      setFeedback("当前环境无法访问麦克风语音输入。");
      return;
    }
    setFeedback("");
    const mimeType = getPreferredVoiceMimeType();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        void finishVoiceRecording(mimeType);
      };
      recorder.start();
      setVoiceState("recording");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "麦克风权限未开启。");
      setVoiceState("idle");
    }
  }

  async function startRun() {
    const content = draft.trim() || (attachments.length > 0 ? "请结合附件内容进行总结。" : "");
    if ((!content && attachments.length === 0) || runningRunId) {
      return;
    }
    if (!settings?.configured) {
      setFeedback("请先在设置中配置助手模型。");
      return;
    }
    if (voiceState === "recording") {
      stopVoiceRecording(false);
      setFeedback("录音已停止，正在识别语音。");
      return;
    }
    if (voiceState === "transcribing") {
      setFeedback("语音正在识别，请稍后发送。");
      return;
    }

    setFeedback("");
    let result;
    try {
      result = await window.electronAPI.assistant.startRun({
        chatId: activeChatId,
        message: content,
        action: "chat",
        pageContext: null,
        attachments
      });
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }

    setActiveChatId(result.chatId);
    const userMessage = createLocalMessage("user", content, result.runId);
    const assistantMessage = createLocalMessage("assistant", "", result.runId);
    runMessageIdsRef.current.set(result.runId, assistantMessage.id);
    setRunningRunId(result.runId);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setAttachments([]);
    setDraft("");
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
    setActiveChatId(null);
    setMessages([]);
    setAttachments([]);
    setDraft("");
    setFeedback("");
    setVoiceExpandedComposer(false);
    textareaRef.current?.focus();
  }

  const canSubmit = (Boolean(draft.trim()) || attachments.length > 0) && !runningRunId && voiceState !== "transcribing";

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
    setFeedback(result.message);
  }

  async function pickAttachments() {
    if (runningRunId) {
      return;
    }
    try {
      const result = await window.electronAPI.assistant.pickAttachments(activeChatId);
      await appendAttachmentResult(result);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div
      className={["quick-assistant", isExpanded ? "is-expanded" : "is-compact"].join(" ")}
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
              <ZmanMarkIcon />
              <span>你可以直接问 Zman。</span>
            </div>
          ) : (
            <div className="quick-message-list">
              {messages.map((message) => (
                <article key={message.id} className={`quick-message is-${message.role}`}>
                  {message.role === "assistant" ? <ZmanMarkIcon /> : null}
                  {message.role === "assistant" ? (
                    <AssistantMarkdownContent
                      className="quick-message-markdown"
                      content={message.content || "正在思考..."}
                    />
                  ) : (
                    <div>{message.content}</div>
                  )}
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
            </div>
          ) : null}
        </main>
      ) : null}
      {attachments.length > 0 ? (
        <div className="quick-attachment-strip">
          {attachments.map((attachment) => (
            <span key={attachment.id} className={attachment.error ? "has-warning" : ""}>
              {attachment.name}
            </span>
          ))}
        </div>
      ) : null}
      <form
        className={["quick-composer", voiceExpandedComposer ? "is-voice-expanded" : ""].join(" ")}
        onSubmit={handleSubmit}
      >
        <button type="button" className="quick-tool-button" onClick={() => void pickAttachments()} aria-label="添加附件">
          <PlusIcon />
        </button>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="问问 Zman"
          rows={1}
          disabled={Boolean(runningRunId)}
        />
        <button
          type="button"
          className={["quick-tool-button", voiceState !== "idle" ? "is-active" : ""].join(" ")}
          onClick={() => void toggleVoice()}
          disabled={!voiceSupported || Boolean(runningRunId)}
          aria-label="语音输入"
        >
          <MicIcon />
        </button>
        {draft.trim() || attachments.length > 0 ? (
          <button type="submit" className="quick-send-button" disabled={!canSubmit} aria-label="发送">
            <SendIcon />
          </button>
        ) : null}
      </form>
    </div>
  );
}
