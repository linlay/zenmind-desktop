const MIN_EPOCH_MILLISECONDS = 1_000_000_000_000;
const MAX_SHARE_BYTES = 2 << 20;
const MAX_SHARE_ENTRIES = 2000;
const MAX_SHARE_ENTRY_BYTES = 200_000;
const MAX_SHARE_TITLE_BYTES = 300;
const MAX_SHARE_LABEL_BYTES = 300;

export type ChatTranscriptUserMessage = {
  kind: "user-message";
  content: string;
  createdAt: number;
};

export type ChatTranscriptAssistantReasoning = {
  kind: "assistant-reasoning";
  content: string;
  label?: string;
  createdAt: number;
};

export type ChatTranscriptAssistantMessage = {
  kind: "assistant-message";
  content: string;
  createdAt: number;
};

export type ChatTranscriptItem =
  | ChatTranscriptUserMessage
  | ChatTranscriptAssistantReasoning
  | ChatTranscriptAssistantMessage;

export type ChatTranscriptTurn = {
  startedAt: number;
  completedAt?: number;
  items: ChatTranscriptItem[];
};

export type ChatTranscriptExportV1 = {
  exportVersion: 1;
  kind: "chat-transcript";
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTranscriptTurn[];
};

export type SharedConversationMessageEntry = {
  type: "message";
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
};

export type SharedConversationReasoningEntry = {
  type: "reasoning";
  content: string;
  label?: string;
  durationMs?: number;
  createdAt?: number;
};

export type SharedConversationEntry =
  | SharedConversationMessageEntry
  | SharedConversationReasoningEntry;

export type SharedConversationSnapshot = {
  schemaVersion: 1;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: SharedConversationEntry[];
};

export type ConversationShareSnapshotValidationError =
  | "empty"
  | "entry-limit"
  | "title-size"
  | "entry-size"
  | "label-size"
  | "payload-size"
  | "invalid-time";

export function parseChatTranscriptExport(value: unknown): ChatTranscriptExportV1 | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.exportVersion !== 1 ||
    value.kind !== "chat-transcript" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !isEpochMilliseconds(value.createdAt) ||
    !isEpochMilliseconds(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !Array.isArray(value.turns) ||
    value.turns.length === 0
  ) {
    return null;
  }
  const turns: ChatTranscriptTurn[] = [];
  for (const candidate of value.turns) {
    if (!isRecord(candidate) || !isEpochMilliseconds(candidate.startedAt) || !Array.isArray(candidate.items)) {
      return null;
    }
    if (
      candidate.completedAt !== undefined &&
      (!isEpochMilliseconds(candidate.completedAt) || candidate.completedAt < candidate.startedAt)
    ) {
      return null;
    }
    const items: ChatTranscriptItem[] = [];
    for (const item of candidate.items) {
      if (!isRecord(item) || typeof item.kind !== "string") {
        return null;
      }
      if (!isKnownTranscriptItemKind(item.kind)) {
        continue;
      }
      if (
        typeof item.content !== "string" ||
        !item.content.trim() ||
        !isEpochMilliseconds(item.createdAt) ||
        (item.kind === "assistant-reasoning" && item.label !== undefined && typeof item.label !== "string")
      ) {
        return null;
      }
      if (item.kind === "assistant-reasoning") {
        items.push({
          kind: item.kind,
          content: item.content,
          ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
          createdAt: item.createdAt
        });
      } else {
        items.push({
          kind: item.kind,
          content: item.content,
          createdAt: item.createdAt
        });
      }
    }
    turns.push({
      startedAt: candidate.startedAt,
      ...(typeof candidate.completedAt === "number" ? { completedAt: candidate.completedAt } : {}),
      items
    });
  }
  return {
    exportVersion: 1,
    kind: "chat-transcript",
    title: value.title.trim(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    turns
  };
}

export function parseChatTranscriptJSONL(value: string): ChatTranscriptExportV1 | null {
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length < 2 || lines.some((line) => !line.trim())) {
    return null;
  }
  try {
    const records = lines.map((line) => JSON.parse(line) as unknown);
    const metadata = records[0];
    if (!isRecord(metadata) || metadata.type !== "metadata") {
      return null;
    }
    const turns: unknown[] = [];
    for (const record of records.slice(1)) {
      if (!isRecord(record) || record.type !== "turn") {
        return null;
      }
      turns.push(record);
    }
    return parseChatTranscriptExport({
      exportVersion: metadata.exportVersion,
      kind: metadata.kind,
      title: metadata.title,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      turns
    });
  } catch {
    return null;
  }
}

export function buildConversationShareSnapshot(transcript: ChatTranscriptExportV1): SharedConversationSnapshot {
  const entries: SharedConversationEntry[] = [];
  for (const turn of transcript.turns) {
    const durationMs = turn.completedAt === undefined
      ? undefined
      : turn.completedAt - turn.startedAt;
    for (const item of turn.items) {
      switch (item.kind) {
        case "user-message":
          entries.push({ type: "message", role: "user", content: item.content, createdAt: item.createdAt });
          break;
        case "assistant-message":
          entries.push({ type: "message", role: "assistant", content: item.content, createdAt: item.createdAt });
          break;
        case "assistant-reasoning":
          entries.push({
            type: "reasoning",
            content: item.content,
            ...(item.label ? { label: item.label } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
            createdAt: item.createdAt
          });
          break;
      }
    }
  }
  return {
    schemaVersion: 1,
    title: transcript.title,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
    entries
  };
}

export function validateConversationShareSnapshot(
  snapshot: SharedConversationSnapshot
): ConversationShareSnapshotValidationError | null {
  if (!isEpochMilliseconds(snapshot.createdAt) || !isEpochMilliseconds(snapshot.updatedAt) || snapshot.updatedAt < snapshot.createdAt) {
    return "invalid-time";
  }
  if (snapshot.entries.length === 0) {
    return "empty";
  }
  if (snapshot.entries.length > MAX_SHARE_ENTRIES) {
    return "entry-limit";
  }
  if (utf8Bytes(snapshot.title.trim()) === 0 || utf8Bytes(snapshot.title.trim()) > MAX_SHARE_TITLE_BYTES) {
    return "title-size";
  }
  for (const entry of snapshot.entries) {
    if (utf8Bytes(entry.content.trim()) === 0 || utf8Bytes(entry.content) > MAX_SHARE_ENTRY_BYTES) {
      return "entry-size";
    }
    if (entry.type === "reasoning" && entry.label && utf8Bytes(entry.label) > MAX_SHARE_LABEL_BYTES) {
      return "label-size";
    }
    if (entry.createdAt !== undefined && !isEpochMilliseconds(entry.createdAt)) {
      return "invalid-time";
    }
  }
  return utf8Bytes(JSON.stringify(snapshot)) > MAX_SHARE_BYTES ? "payload-size" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnownTranscriptItemKind(value: string): value is ChatTranscriptItem["kind"] {
  return value === "user-message" || value === "assistant-reasoning" || value === "assistant-message";
}

function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_EPOCH_MILLISECONDS;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type AgentPlatformChatTranscriptExportResult =
  | { ok: true; transcript: ChatTranscriptExportV1 }
  | { ok: false; message: string };
