import type {
  AssistantAwaitingPayload,
  AssistantChatMessage,
  AssistantEvent,
  AssistantRunEvent
} from "../../shared/contracts";
import {
  ASSISTANT_RUN_EVENT_TYPES,
  ASSISTANT_TERMINAL_EVENT_TYPES
} from "../../shared/contracts";

export const STRUCTURED_ASSISTANT_EVENT_TYPES = new Set<string>(ASSISTANT_RUN_EVENT_TYPES);
export const TERMINAL_ASSISTANT_EVENT_TYPES = new Set<string>(ASSISTANT_TERMINAL_EVENT_TYPES);

export function isStructuredAssistantEvent(event: AssistantEvent): event is AssistantRunEvent {
  return (
    STRUCTURED_ASSISTANT_EVENT_TYPES.has(event.type) &&
    typeof event.id === "string" &&
    typeof event.seq === "number" &&
    typeof event.createdAt === "string"
  );
}

export function isTerminalAssistantEvent(event: AssistantEvent) {
  return TERMINAL_ASSISTANT_EVENT_TYPES.has(event.type);
}

export function shouldEnsureAssistantMessageForEvent(event: AssistantEvent) {
  return (
    event.type === "delta" ||
    event.type === "content.delta" ||
    event.type === "artifact.publish" ||
    event.type === "error" ||
    event.type === "run.error" ||
    event.type === "stopped" ||
    event.type === "run.stopped"
  );
}

export function getLatestRunningRunId(events: AssistantRunEvent[]) {
  const closedRunIds = new Set<string>();
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (isTerminalAssistantEvent(event)) {
      closedRunIds.add(event.runId);
      continue;
    }
    if (event.type === "run.start" && !closedRunIds.has(event.runId)) {
      return event.runId;
    }
  }
  return null;
}

export function getAssistantEventAwaitingPayload(event: AssistantRunEvent): AssistantAwaitingPayload | null {
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

export function getLatestPendingAwaitingPayload(events: AssistantRunEvent[]) {
  const resolvedAwaitingIds = new Set<string>();
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    const awaitingId = event.awaiting?.awaitingId ?? event.awaitingId;
    if (!awaitingId) {
      continue;
    }
    if (event.type === "awaiting.answer") {
      resolvedAwaitingIds.add(awaitingId);
      continue;
    }
    if (event.type === "awaiting.ask" && !resolvedAwaitingIds.has(awaitingId)) {
      return getAssistantEventAwaitingPayload(event);
    }
  }
  return null;
}

export function getAssistantErrorContent(event: AssistantEvent) {
  return event.message || (event.error ? `生成失败：${event.error}` : "生成失败。");
}

export type AssistantTimelineReducerState = {
  runningRunId: string | null;
  terminalRunIds: Set<string>;
  pendingAwaiting: AssistantAwaitingPayload | null;
};

export function createAssistantTimelineReducerState(): AssistantTimelineReducerState {
  return {
    runningRunId: null,
    terminalRunIds: new Set(),
    pendingAwaiting: null
  };
}

export function reduceAssistantTimelineEvent(
  state: AssistantTimelineReducerState,
  event: AssistantRunEvent
): AssistantTimelineReducerState {
  const next: AssistantTimelineReducerState = {
    runningRunId: state.runningRunId,
    terminalRunIds: new Set(state.terminalRunIds),
    pendingAwaiting: state.pendingAwaiting
  };
  if (event.type === "run.start") {
    next.runningRunId = event.runId;
    next.terminalRunIds.delete(event.runId);
  }
  if (isTerminalAssistantEvent(event)) {
    next.terminalRunIds.add(event.runId);
    if (next.runningRunId === event.runId) {
      next.runningRunId = null;
    }
  }
  if (event.type === "awaiting.ask") {
    next.pendingAwaiting = getAssistantEventAwaitingPayload(event);
  }
  if (
    event.type === "awaiting.answer" &&
    next.pendingAwaiting &&
    (event.awaitingId === next.pendingAwaiting.awaitingId || event.awaiting?.awaitingId === next.pendingAwaiting.awaitingId)
  ) {
    next.pendingAwaiting = null;
  }
  return next;
}

export function reduceAssistantTimeline(events: AssistantRunEvent[]) {
  return events
    .slice()
    .sort((left, right) => left.seq - right.seq)
    .reduce(reduceAssistantTimelineEvent, createAssistantTimelineReducerState());
}

export function createRemoteAssistantMessage(runId: string, idPrefix: string) {
  return {
    id: `${idPrefix}${runId}`,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    runId
  } satisfies AssistantChatMessage;
}

export function ensureAssistantMessageForRun(
  runId: string,
  runMessageIds: Map<string, string>,
  setMessages: (updater: (current: AssistantChatMessage[]) => AssistantChatMessage[]) => void,
  idPrefix: string
) {
  const existingMappedId = runMessageIds.get(runId);
  if (existingMappedId) {
    return existingMappedId;
  }

  const remoteMessageId = `${idPrefix}${runId}`;
  runMessageIds.set(runId, remoteMessageId);
  setMessages((current) => {
    const existingMessage = current.find((message) => message.role === "assistant" && message.runId === runId);
    if (existingMessage) {
      runMessageIds.set(runId, existingMessage.id);
      return current;
    }
    return [...current, createRemoteAssistantMessage(runId, idPrefix)];
  });
  return remoteMessageId;
}

export function attachRunningAssistantPlaceholder(
  messagesForChat: AssistantChatMessage[],
  runId: string | null,
  runMessageIds: Map<string, string>,
  idPrefix: string
) {
  if (!runId) {
    return messagesForChat;
  }
  const existingMessage = messagesForChat.find((message) => message.role === "assistant" && message.runId === runId);
  if (existingMessage) {
    runMessageIds.set(runId, existingMessage.id);
    return messagesForChat;
  }
  const placeholder = createRemoteAssistantMessage(runId, idPrefix);
  runMessageIds.set(runId, placeholder.id);
  return [...messagesForChat, placeholder];
}
