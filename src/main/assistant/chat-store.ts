import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AssistantAttachment,
  AssistantChatDetail,
  AssistantChatMessage,
  AssistantChatSummary,
  AssistantRunEvent
} from "../../shared/contracts";

const INDEX_FILE = "index.json";
const CHAT_TITLE_LIMIT = 30;

type StoredIndex = {
  chats: AssistantChatSummary[];
};

type StoredChat = {
  summary: AssistantChatSummary;
  messages: AssistantChatMessage[];
};

function getAssistantRoot(app: App) {
  return path.join(app.getPath("userData"), "assistant");
}

function getChatsRoot(rootDir: string) {
  return path.join(rootDir, "chats");
}

function getIndexPath(rootDir: string) {
  return path.join(getChatsRoot(rootDir), INDEX_FILE);
}

function getChatDir(rootDir: string, chatId: string) {
  return path.join(getChatsRoot(rootDir), chatId);
}

function getChatPath(rootDir: string, chatId: string) {
  return path.join(getChatDir(rootDir, chatId), "chat.json");
}

function getEventsPath(rootDir: string, chatId: string) {
  return path.join(getChatDir(rootDir, chatId), "events.jsonl");
}

function getAttachmentsDir(rootDir: string, chatId: string) {
  return path.join(getChatDir(rootDir, chatId), "attachments");
}

function getLegacyChatPath(rootDir: string, chatId: string) {
  return path.join(getChatsRoot(rootDir), `${chatId}.json`);
}

function ensureChatsRoot(rootDir: string) {
  fs.mkdirSync(getChatsRoot(rootDir), { recursive: true });
}

function createChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isAttachment(value: unknown): value is AssistantAttachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AssistantAttachment>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.text === "string"
  );
}

function sanitizeAttachmentDocument(document: AssistantAttachment["document"]) {
  if (!document || typeof document !== "object") {
    return undefined;
  }
  const format = document.format;
  const readStatus = document.readStatus;
  if (
    !["text", "pdf", "docx", "xlsx", "pptx", "zip", "image", "binary"].includes(format) ||
    !["readable", "truncated", "unreadable"].includes(readStatus) ||
    !Number.isFinite(document.extractedChars)
  ) {
    return undefined;
  }
  return {
    format,
    readStatus,
    extractedChars: document.extractedChars,
    truncated: Boolean(document.truncated),
    ...(Number.isFinite(document.pageCount) ? { pageCount: document.pageCount } : {}),
    ...(Array.isArray(document.sheetNames)
      ? { sheetNames: document.sheetNames.filter((sheetName) => typeof sheetName === "string").slice(0, 100) }
      : {}),
	    ...(Number.isFinite(document.slideCount) ? { slideCount: document.slideCount } : {}),
	    ...(document.imageMode === "vision" ? { imageMode: "vision" as const } : {}),
	    ...(typeof document.errorCode === "string" ? { errorCode: document.errorCode } : {}),
	    ...(typeof document.visionSummary === "string" ? { visionSummary: document.visionSummary.slice(0, 20000) } : {}),
	    ...(document.visionStatus === "pending" ||
	      document.visionStatus === "readable" ||
	      document.visionStatus === "failed" ||
	      document.visionStatus === "unavailable"
	      ? { visionStatus: document.visionStatus }
	      : {})
	  };
	}

export function sanitizeAssistantAttachmentForHistory(attachment: AssistantAttachment): AssistantAttachment {
  const document = sanitizeAttachmentDocument(attachment.document);
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : 0,
    text: attachment.text ?? "",
    ...(attachment.kind === "artifact" ? { kind: "artifact" as const } : attachment.kind === "input" ? { kind: "input" as const } : {}),
    ...(attachment.artifactId ? { artifactId: attachment.artifactId } : {}),
    ...(attachment.description ? { description: attachment.description } : {}),
    ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
	    ...(attachment.url ? { url: attachment.url } : {}),
	    ...(attachment.hidden ? { hidden: true } : {}),
	    ...(attachment.sourceAttachmentId ? { sourceAttachmentId: attachment.sourceAttachmentId } : {}),
	    ...(Number.isFinite(attachment.pageNumber) ? { pageNumber: attachment.pageNumber } : {}),
	    ...(attachment.truncated ? { truncated: true } : {}),
    ...(attachment.error ? { error: attachment.error } : {}),
    ...(document ? { document } : {})
  };
}

function normalizeMessage(value: unknown): AssistantChatMessage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<AssistantChatMessage>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.role !== "user" && candidate.role !== "assistant") ||
    typeof candidate.content !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.filter(isAttachment).map(sanitizeAssistantAttachmentForHistory)
    : [];
  return {
    id: candidate.id,
    role: candidate.role,
    content: candidate.content,
    createdAt: candidate.createdAt,
    ...(typeof candidate.runId === "string" ? { runId: candidate.runId } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  };
}

function readStoredAttachmentMetadata(rootDir: string, chatId: string) {
  const attachmentsDir = getAttachmentsDir(rootDir, chatId);
  try {
    return fs.readdirSync(attachmentsDir)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(attachmentsDir, fileName), "utf8")) as unknown;
          return isAttachment(parsed) ? sanitizeAssistantAttachmentForHistory(parsed) : null;
        } catch {
          return null;
        }
      })
      .filter((attachment): attachment is AssistantAttachment => Boolean(attachment));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function timestampFromId(id: string) {
  const match = /^(?:msg|att)_([0-9a-z]+)_/iu.exec(id);
  if (!match) {
    return null;
  }
  const timestamp = Number.parseInt(match[1], 36);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function chooseLegacyAttachmentMessageIndex(messages: AssistantChatMessage[], attachment: AssistantAttachment) {
  const userIndexes = messages
    .map((message, index) => message.role === "user" ? index : -1)
    .filter((index) => index >= 0);
  if (userIndexes.length <= 1) {
    return userIndexes[0] ?? -1;
  }

  const attachmentTimestamp = timestampFromId(attachment.id);
  if (!attachmentTimestamp) {
    return userIndexes[userIndexes.length - 1];
  }

  let bestIndex = userIndexes[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const index of userIndexes) {
    const message = messages[index];
    const messageTimestamp = Date.parse(message.createdAt) || timestampFromId(message.id) || 0;
    const delta = messageTimestamp - attachmentTimestamp;
    const score = Math.abs(delta) + (delta < 0 ? 60_000 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function mergeLegacyStoredAttachments(
  rootDir: string,
  chatId: string,
  messages: AssistantChatMessage[]
) {
  const storedAttachments = readStoredAttachmentMetadata(rootDir, chatId);
  if (storedAttachments.length === 0 || messages.every((message) => message.role !== "user")) {
    return messages;
  }

  const referencedIds = new Set(
    messages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? [])
  );
  const unreferencedAttachments = storedAttachments.filter((attachment) => !referencedIds.has(attachment.id));
  if (unreferencedAttachments.length === 0) {
    return messages;
  }

  const nextMessages = messages.map((message) => ({
    ...message,
    ...(message.attachments ? { attachments: [...message.attachments] } : {})
  }));
  for (const attachment of unreferencedAttachments) {
    const messageIndex = chooseLegacyAttachmentMessageIndex(nextMessages, attachment);
    if (messageIndex < 0) {
      continue;
    }
    const existingAttachments = nextMessages[messageIndex].attachments ?? [];
    if (existingAttachments.some((item) => item.id === attachment.id)) {
      continue;
    }
    nextMessages[messageIndex] = {
      ...nextMessages[messageIndex],
      attachments: [...existingAttachments, attachment]
    };
  }
  return nextMessages;
}

export function createAssistantMessage(
  role: AssistantChatMessage["role"],
  content: string,
  runId?: string,
  attachments?: AssistantAttachment[]
) {
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.filter(isAttachment).map(sanitizeAssistantAttachmentForHistory)
    : [];
  return {
    id: `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(runId ? { runId } : {}),
    ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {})
  } satisfies AssistantChatMessage;
}

function readIndex(rootDir: string): StoredIndex {
  ensureChatsRoot(rootDir);
  try {
    const raw = fs.readFileSync(getIndexPath(rootDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredIndex>;
    return {
      chats: Array.isArray(parsed.chats) ? parsed.chats.filter(isChatSummary) : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { chats: [] };
    }
    throw error;
  }
}

function writeIndex(rootDir: string, index: StoredIndex) {
  ensureChatsRoot(rootDir);
  const sorted = [...index.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  fs.writeFileSync(getIndexPath(rootDir), `${JSON.stringify({ chats: sorted }, null, 2)}\n`, "utf8");
}

function isChatSummary(value: unknown): value is AssistantChatSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AssistantChatSummary>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.lastMessage === "string" &&
    typeof candidate.messageCount === "number"
  );
}

function isRunEvent(value: unknown): value is AssistantRunEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AssistantRunEvent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.seq === "number" &&
    typeof candidate.runId === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.createdAt === "string"
  );
}

export function createChatTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "新的对话";
  }
  return normalized.length > CHAT_TITLE_LIMIT
    ? `${normalized.slice(0, CHAT_TITLE_LIMIT)}...`
    : normalized;
}

function writeChat(rootDir: string, chat: StoredChat) {
  ensureChatsRoot(rootDir);
  fs.mkdirSync(getChatDir(rootDir, chat.summary.id), { recursive: true });
  fs.writeFileSync(getChatPath(rootDir, chat.summary.id), `${JSON.stringify(chat, null, 2)}\n`, "utf8");
}

function readChat(rootDir: string, chatId: string): AssistantChatDetail | null {
  ensureChatsRoot(rootDir);
  try {
    const chatPath = fs.existsSync(getChatPath(rootDir, chatId))
      ? getChatPath(rootDir, chatId)
      : getLegacyChatPath(rootDir, chatId);
    const raw = fs.readFileSync(chatPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredChat>;
    if (!isChatSummary(parsed.summary)) {
      return null;
    }
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.map(normalizeMessage).filter((message): message is AssistantChatMessage => Boolean(message))
      : [];
    return {
      summary: parsed.summary,
      messages: mergeLegacyStoredAttachments(rootDir, chatId, messages),
      events: readAssistantEventsFromRoot(rootDir, chatId)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function readAssistantEventsFromRoot(rootDir: string, chatId: string) {
  ensureChatsRoot(rootDir);
  try {
    const raw = fs.readFileSync(getEventsPath(rootDir, chatId), "utf8");
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter(isRunEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function appendAssistantEventToRoot(rootDir: string, event: AssistantRunEvent) {
  ensureChatsRoot(rootDir);
  fs.mkdirSync(getChatDir(rootDir, event.chatId), { recursive: true });
  fs.appendFileSync(getEventsPath(rootDir, event.chatId), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

function upsertIndexSummary(rootDir: string, summary: AssistantChatSummary) {
  const index = readIndex(rootDir);
  const nextChats = [summary, ...index.chats.filter((chat) => chat.id !== summary.id)];
  writeIndex(rootDir, { chats: nextChats });
}

export function listAssistantChatsFromRoot(rootDir: string) {
  return readIndex(rootDir).chats;
}

export function getAssistantChatFromRoot(rootDir: string, chatId: string) {
  return readChat(rootDir, chatId);
}

export function appendAssistantMessageToRoot(
  rootDir: string,
  chatId: string | null | undefined,
  message: AssistantChatMessage
) {
  const storedMessage = normalizeMessage(message);
  if (!storedMessage) {
    throw new Error("Invalid assistant chat message.");
  }
  const now = storedMessage.createdAt;
  const resolvedChatId = chatId || createChatId();
  const existing = readChat(rootDir, resolvedChatId);
  const summary: AssistantChatSummary = existing?.summary ?? {
    id: resolvedChatId,
    title: storedMessage.role === "user" ? createChatTitle(storedMessage.content) : "新的对话",
    createdAt: now,
    updatedAt: now,
    lastMessage: "",
    messageCount: 0
  };
  const messages = [...(existing?.messages ?? []), storedMessage];
  const nextSummary: AssistantChatSummary = {
    ...summary,
    title: summary.title === "新的对话" && storedMessage.role === "user" ? createChatTitle(storedMessage.content) : summary.title,
    updatedAt: now,
    lastMessage: storedMessage.content.slice(0, 120),
    messageCount: messages.length
  };

  const chat: StoredChat = {
    summary: nextSummary,
    messages
  };
  writeChat(rootDir, chat);
  upsertIndexSummary(rootDir, nextSummary);
  return {
    ...chat,
    events: readAssistantEventsFromRoot(rootDir, resolvedChatId)
  };
}

export function updateAssistantMessageAttachmentsToRoot(
  rootDir: string,
  chatId: string,
  messageId: string,
  attachments: AssistantAttachment[]
) {
  const existing = readChat(rootDir, chatId);
  if (!existing) {
    return null;
  }
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.filter(isAttachment).map(sanitizeAssistantAttachmentForHistory)
    : [];
  const messages = existing.messages.map((message) => message.id === messageId
    ? {
        ...message,
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {})
      }
    : message);
  const chat: StoredChat = {
    summary: existing.summary,
    messages
  };
  writeChat(rootDir, chat);
  upsertIndexSummary(rootDir, chat.summary);
  return {
    ...chat,
    events: readAssistantEventsFromRoot(rootDir, chatId)
  };
}

export function ensureAssistantChatFromRoot(rootDir: string, chatId: string | null | undefined, title = "新的对话") {
  const now = new Date().toISOString();
  const resolvedChatId = chatId || createChatId();
  const existing = readChat(rootDir, resolvedChatId);
  if (existing) {
    return existing;
  }

  const chat: StoredChat = {
    summary: {
      id: resolvedChatId,
      title,
      createdAt: now,
      updatedAt: now,
      lastMessage: "",
      messageCount: 0
    },
    messages: []
  };
  writeChat(rootDir, chat);
  upsertIndexSummary(rootDir, chat.summary);
  return {
    ...chat,
    events: []
  };
}

export function deleteAssistantChatFromRoot(rootDir: string, chatId: string) {
  ensureChatsRoot(rootDir);
  const index = readIndex(rootDir);
  writeIndex(rootDir, { chats: index.chats.filter((chat) => chat.id !== chatId) });
  try {
    fs.rmSync(getChatDir(rootDir, chatId), { recursive: true, force: true });
    fs.rmSync(getLegacyChatPath(rootDir, chatId), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function listAssistantChats(app: App) {
  return listAssistantChatsFromRoot(getAssistantRoot(app));
}

export function getAssistantChat(app: App, chatId: string) {
  return getAssistantChatFromRoot(getAssistantRoot(app), chatId);
}

export function appendAssistantEvent(app: App, event: AssistantRunEvent) {
  return appendAssistantEventToRoot(getAssistantRoot(app), event);
}

export function getAssistantChatDir(app: App, chatId: string) {
  return getChatDir(getAssistantRoot(app), chatId);
}

export function appendAssistantMessage(app: App, chatId: string | null | undefined, message: AssistantChatMessage) {
  return appendAssistantMessageToRoot(getAssistantRoot(app), chatId, message);
}

export function updateAssistantMessageAttachments(
  app: App,
  chatId: string,
  messageId: string,
  attachments: AssistantAttachment[]
) {
  return updateAssistantMessageAttachmentsToRoot(getAssistantRoot(app), chatId, messageId, attachments);
}

export function ensureAssistantChat(app: App, chatId: string | null | undefined, title?: string) {
  return ensureAssistantChatFromRoot(getAssistantRoot(app), chatId, title);
}

export function deleteAssistantChat(app: App, chatId: string) {
  return deleteAssistantChatFromRoot(getAssistantRoot(app), chatId);
}

export const __testInternals = {
  CHAT_TITLE_LIMIT,
  createChatId,
  getChatDir,
  getEventsPath,
  getAssistantRoot,
  getChatsRoot,
  readIndex,
  readAssistantEventsFromRoot,
  appendAssistantEventToRoot
};
