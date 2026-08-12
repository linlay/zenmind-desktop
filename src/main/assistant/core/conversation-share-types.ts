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

export function parseSharedConversationSnapshot(value: unknown): SharedConversationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["schemaVersion", "title", "createdAt", "updatedAt", "entries"]) ||
    record.schemaVersion !== 1 ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    typeof record.updatedAt !== "number" ||
    !Number.isSafeInteger(record.updatedAt) ||
    !Array.isArray(record.entries)
  ) {
    return null;
  }
  const entries: SharedConversationEntry[] = [];
  for (const item of record.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      return null;
    }
    if (
      entry.createdAt !== undefined &&
      (typeof entry.createdAt !== "number" || !Number.isSafeInteger(entry.createdAt))
    ) {
      return null;
    }
    if (entry.type === "message") {
      if (
        (entry.role !== "user" && entry.role !== "assistant") ||
        entry.label !== undefined ||
        !hasOnlyKeys(entry, ["type", "role", "content", "createdAt"])
      ) {
        return null;
      }
      entries.push({
        type: "message",
        role: entry.role,
        content: entry.content,
        ...(typeof entry.createdAt === "number" ? { createdAt: entry.createdAt } : {})
      });
      continue;
    }
    if (
      entry.type !== "reasoning" ||
      entry.role !== undefined ||
      (entry.label !== undefined && typeof entry.label !== "string") ||
      (entry.durationMs !== undefined && !isDurationMilliseconds(entry.durationMs)) ||
      !hasOnlyKeys(entry, ["type", "content", "label", "durationMs", "createdAt"])
    ) {
      return null;
    }
    entries.push({
      type: "reasoning",
      content: entry.content,
      ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
      ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
      ...(typeof entry.createdAt === "number" ? { createdAt: entry.createdAt } : {})
    });
  }
  if (entries.length === 0) {
    return null;
  }
  return {
    schemaVersion: 1,
    title: record.title.trim(),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    entries
  };
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isDurationMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type AgentPlatformChatShareSnapshotResult =
  | { ok: true; snapshot: SharedConversationSnapshot }
  | { ok: false; message: string };
