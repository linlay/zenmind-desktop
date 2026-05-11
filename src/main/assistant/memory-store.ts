import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  AssistantMemoryItem,
  AssistantMemoryKind,
  AssistantMemorySettings,
  AssistantMemorySettingsInput,
  AssistantMemorySummary,
  AssistantMemoryStorage,
  AssistantMemoryStats,
  AssistantMemoryStatus
} from "../../shared/contracts";

export const ASSISTANT_MEMORY_RELATIVE_PATH = path.join("assistant", "memory", "zenmind-memory.md");
export const ASSISTANT_MEMORY_RECORDS_RELATIVE_PATH = path.join("assistant", "memory", "records.json");
export const ASSISTANT_MEMORY_SETTINGS_RELATIVE_PATH = path.join("assistant", "memory", "settings.json");
export const ASSISTANT_MEMORY_AUDIT_RELATIVE_PATH = path.join("assistant", "memory", "audit.jsonl");

const MAX_MEMORY_REFERENCE_EXCERPT_LENGTH = 260;
const GENERIC_QUERY_TOKENS = new Set([
  "内容",
  "告诉",
  "告诉我",
  "什么",
  "喜欢",
  "搜索",
  "总结",
  "工作流",
  "输入",
  "运行",
  "浏览器",
  "打开",
  "直接",
  "桌面",
  "文件",
  "html",
  "英文",
  "然后",
  "前条",
  "前三",
  "三条",
  "结果",
  "今天",
  "今日",
  "热点",
  "页面",
  "这个",
  "那个",
  "一下",
  "帮我",
  "我想"
]);
const DEFAULT_MEMORY_SETTINGS: AssistantMemorySettings = {
  enabled: true,
  autoLearn: true,
  maxItems: 5,
  maxChars: 4000
};

type AssistantMemoryScopeType = "user" | "chat";
type AssistantMemoryFacet =
  | "food_preference"
  | "response_style"
  | "constraint"
  | "workflow"
  | "decision"
  | "general";

type MemoryQueryIntent =
  | "food_preference"
  | "response_style"
  | "constraint"
  | "workflow_or_bugfix"
  | "history_or_previous_process"
  | "general";

export type AssistantMemoryReference = {
  id: string;
  title: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  reason?: string;
};

export type AssistantMemorySnapshotOptions = {
  query?: string;
  chatId?: string;
  maxItems?: number;
  maxChars?: number;
};

export type AssistantMemorySnapshot = {
  content: string;
  references: AssistantMemoryReference[];
};

export type AssistantMemoryUpsertInput = {
  kind?: string;
  title?: string;
  summary?: string;
  category?: string;
  scopeType?: string;
  facet?: string;
  subjectKey?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  status?: string;
  reason?: string;
};

export type AssistantMemoryUpsertContext = {
  chatId?: string;
  runId?: string;
};

export type AssistantMemoryUpsertResult = {
  stored: AssistantMemoryItem[];
  skipped: Array<{ reason: string; title?: string; summary?: string }>;
};

type RuntimeMemorySelection = {
  item: AssistantMemoryItem;
  reason: string;
  score: number;
  layer: "stable" | "session" | "observation";
};

type LayeredRuntimeMemorySelection = {
  queryIntent: MemoryQueryIntent;
  stableFacts: RuntimeMemorySelection[];
  currentSession: RuntimeMemorySelection[];
  relevantObservations: RuntimeMemorySelection[];
  candidateCountsByLayer: {
    stable: number;
    session: number;
    observation: number;
  };
  selectedCountsByLayer: {
    stable: number;
    session: number;
    observation: number;
  };
};

type StoredMemoryRecords = {
  items: AssistantMemoryItem[];
};

type StaticMemoryChunk = {
  title: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  score: number;
};

function getPathFromRoot(rootDir: string, relativePath: string) {
  return path.join(rootDir, relativePath);
}

export function getAssistantMemoryPathFromRoot(rootDir: string) {
  return getPathFromRoot(rootDir, ASSISTANT_MEMORY_RELATIVE_PATH);
}

export function getAssistantMemoryRecordsPathFromRoot(rootDir: string) {
  return getPathFromRoot(rootDir, ASSISTANT_MEMORY_RECORDS_RELATIVE_PATH);
}

export function getAssistantMemoryDirectoryFromRoot(rootDir: string) {
  return path.dirname(getAssistantMemoryRecordsPathFromRoot(rootDir));
}

function getAssistantMemorySettingsPathFromRoot(rootDir: string) {
  return getPathFromRoot(rootDir, ASSISTANT_MEMORY_SETTINGS_RELATIVE_PATH);
}

export function getAssistantMemoryAuditPathFromRoot(rootDir: string) {
  return getPathFromRoot(rootDir, ASSISTANT_MEMORY_AUDIT_RELATIVE_PATH);
}

export function getAssistantMemoryStorageFromRoot(rootDir: string): AssistantMemoryStorage {
  const directoryPath = getAssistantMemoryDirectoryFromRoot(rootDir);
  return {
    recordsPath: getAssistantMemoryRecordsPathFromRoot(rootDir),
    staticPath: getAssistantMemoryPathFromRoot(rootDir),
    auditPath: getAssistantMemoryAuditPathFromRoot(rootDir),
    directoryPath
  };
}

function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function normalizeMemoryKind(kind: unknown): AssistantMemoryKind {
  return asString(kind).toLowerCase() === "observation" ? "observation" : "fact";
}

function normalizeMemoryStatus(status: unknown, kind: AssistantMemoryKind): AssistantMemoryStatus {
  const normalized = asString(status).toLowerCase();
  if (normalized === "archived") {
    return "archived";
  }
  if (normalized === "open" && kind === "observation") {
    return "open";
  }
  return kind === "observation" ? "open" : "active";
}

function normalizeMemoryScopeType(scopeType: unknown, kind: AssistantMemoryKind): AssistantMemoryScopeType {
  const normalized = asString(scopeType).toLowerCase();
  if (normalized === "chat") {
    return "chat";
  }
  if (normalized === "user") {
    return "user";
  }
  return kind === "observation" ? "chat" : "user";
}

function normalizeMemoryFacet(facet: unknown): AssistantMemoryFacet | "" {
  const normalized = asString(facet).toLowerCase();
  switch (normalized) {
    case "food_preference":
    case "response_style":
    case "constraint":
    case "workflow":
    case "decision":
    case "general":
      return normalized;
    default:
      return "";
  }
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  return Array.from(new Set(
    tags
      .map((tag) => asString(tag).toLowerCase())
      .filter(Boolean)
      .slice(0, 10)
  ));
}

function normalizeCategory(category: unknown) {
  const normalized = asString(category).toLowerCase();
  return normalized || "general";
}

function normalizeMemoryItem(value: unknown): AssistantMemoryItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  const summary = asString(value.summary);
  if (!id || !summary) {
    return null;
  }
  const kind = normalizeMemoryKind(value.kind);
  const status = normalizeMemoryStatus(value.status, kind);
  const now = new Date().toISOString();
  const title = asString(value.title, summary).slice(0, 120) || "本地记忆";
  const scopeType = normalizeMemoryScopeType(value.scopeType, kind);
  const category = normalizeCategory(value.category);
  const tags = Array.isArray(value.tags) ? value.tags.map((tag) => asString(tag)).filter(Boolean) : [];
  const facet = normalizeMemoryFacet(value.facet) || inferMemoryFacet({
    category,
    title,
    summary,
    tags
  });
  const subjectKey = asString(value.subjectKey) || inferMemorySubjectKey({
    category,
    title,
    summary,
    tags,
    facet
  });
  return {
    id,
    kind,
    title,
    summary,
    category,
    scopeType,
    ...(facet ? { facet } : {}),
    ...(subjectKey ? { subjectKey } : {}),
    tags: normalizeTags(tags),
    importance: clampNumber(value.importance, kind === "fact" ? 8 : 6, 1, 10),
    confidence: clampNumber(value.confidence, 0.75, 0, 1),
    status,
    ...(asString(value.sourceChatId) ? { sourceChatId: asString(value.sourceChatId) } : {}),
    ...(asString(value.sourceRunId) ? { sourceRunId: asString(value.sourceRunId) } : {}),
    referenceCount: clampNumber(value.referenceCount, 0, 0, Number.MAX_SAFE_INTEGER),
    ...(asString(value.reason) ? { reason: asString(value.reason).slice(0, 500) } : {}),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now),
    ...(asString(value.lastReferencedAt) ? { lastReferencedAt: asString(value.lastReferencedAt) } : {})
  };
}

function normalizeSettings(value: unknown): AssistantMemorySettings {
  const candidate = isRecord(value) ? value : {};
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_MEMORY_SETTINGS.enabled,
    autoLearn: typeof candidate.autoLearn === "boolean" ? candidate.autoLearn : DEFAULT_MEMORY_SETTINGS.autoLearn,
    maxItems: Math.round(clampNumber(candidate.maxItems, DEFAULT_MEMORY_SETTINGS.maxItems, 1, 20)),
    maxChars: Math.round(clampNumber(candidate.maxChars, DEFAULT_MEMORY_SETTINGS.maxChars, 500, 20000))
  };
}

function normalizeRecords(value: unknown): StoredMemoryRecords {
  const candidate = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return {
    items: candidate
      .map(normalizeMemoryItem)
      .filter((item): item is AssistantMemoryItem => Boolean(item))
  };
}

function writeMemoryItemsToRoot(rootDir: string, items: AssistantMemoryItem[]) {
  writeJsonFile(getAssistantMemoryRecordsPathFromRoot(rootDir), { items });
}

function createMemoryId() {
  return `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function normalizeForHash(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function normalizeTopicSubject(value: string) {
  return normalizeForHash(value)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 48);
}

function buildGenericSubjectKey(prefix: string, value: string) {
  const subject = normalizeTopicSubject(value);
  return subject ? `${prefix}:${subject}` : "";
}

function inferMemoryFacet(input: { category?: string; title?: string; summary: string; tags?: string[] }): AssistantMemoryFacet {
  const category = normalizeCategory(input.category);
  const haystack = normalizeForHash([
    input.title ?? "",
    input.summary,
    category,
    ...(input.tags ?? [])
  ].join(" "));
  if (isLikedFoodPreferenceMemory({
    category,
    title: input.title,
    summary: input.summary,
    tags: input.tags
  })) {
    return "food_preference";
  }
  if (isResponseStyleMemoryText(category, input.tags ?? [], haystack)) {
    return "response_style";
  }
  if (category === "constraint" || /约束|规则|必须|不要|不能|禁止|constraint|rule/iu.test(haystack)) {
    return "constraint";
  }
  if (category === "decision" || /决定|采用|选用|决策|decision|chosen|decided/iu.test(haystack)) {
    return "decision";
  }
  if (["workflow", "bugfix"].includes(category) || /流程|步骤|排查|修复|发布|部署|调试|workflow|debug|deploy|bugfix|runbook/iu.test(haystack)) {
    return "workflow";
  }
  return "general";
}

function inferMemorySubjectKey(input: {
  category?: string;
  title?: string;
  summary: string;
  tags?: string[];
  facet?: AssistantMemoryFacet | "";
}) {
  const facet = input.facet || inferMemoryFacet(input);
  const title = input.title ?? "";
  const summary = input.summary;
  const tags = input.tags ?? [];
  const category = normalizeCategory(input.category);
  const subject = extractDietPreferenceSubject({ title, summary, tags });
  if (facet === "food_preference" && subject) {
    return `food:${subject}`;
  }
  const topic = canonicalMemoryTopic({
    title,
    summary,
    tags
  });
  if (topic.startsWith("response:")) {
    return topic;
  }
  if (facet === "response_style") {
    return buildGenericSubjectKey("response", title || summary);
  }
  if (facet === "constraint") {
    return buildGenericSubjectKey("constraint", title || summary);
  }
  if (facet === "workflow") {
    return buildGenericSubjectKey(category === "bugfix" ? "bugfix" : "workflow", title || summary);
  }
  if (facet === "decision") {
    return buildGenericSubjectKey("decision", title || summary);
  }
  return "";
}

function memoryFingerprint(input: { kind: string; category: string; summary: string }) {
  return createHash("sha256")
    .update(`${input.kind}\0${input.category}\0${normalizeForHash(input.summary)}`)
    .digest("hex");
}

function extractDietPreferenceSubject(input: { title?: string; summary: string; tags?: string[] }) {
  const title = input.title ?? "";
  const titleMatch = title.match(/饮食偏好\s*[-:：]\s*([^，。；;,.!?！？\s]{1,40})/u);
  if (titleMatch) {
    return normalizeTopicSubject(titleMatch[1]);
  }
  const text = [title, input.summary, ...(input.tags ?? [])].join(" ");
  const likeMatch = text.match(/(?:喜欢吃|爱吃)\s*([^，。；;,.!?！？\s]{1,40})/u);
  if (likeMatch) {
    return normalizeTopicSubject(likeMatch[1]);
  }
  const englishMatch = text.match(/(?:likes?|prefers?)\s+(?:to\s+eat\s+)?([a-z0-9][a-z0-9 _-]{0,40})/iu);
  return englishMatch ? normalizeTopicSubject(englishMatch[1]) : "";
}

function canonicalMemoryTopic(input: { title?: string; summary: string; tags?: string[] }) {
  const haystack = normalizeForHash([
    input.title ?? "",
    input.summary,
    ...(input.tags ?? [])
  ].join(" "));
  const dietSubject = extractDietPreferenceSubject(input);
  if (dietSubject && /(饮食|食物|吃饭|喜欢吃|爱吃|饭|菜谱|food|meal|diet|recipe|dinner|lunch|breakfast|口味|主食)/iu.test(haystack)) {
    return `diet:item:${dietSubject}`;
  }
  if (/(米饭|rice)/iu.test(haystack) && /(饮食|食物|吃饭|饭|菜谱|food|meal|diet|recipe|dinner|lunch|breakfast|口味|主食|rice)/iu.test(haystack)) {
    return "diet:rice";
  }
  if (/(先给结论|结论优先|先说结论|先讲结论|conclusion)/iu.test(haystack) && /(回答|回复|风格|偏好|answer|response|style)/iu.test(haystack)) {
    return "response:conclusion-first";
  }
  if (/(简洁|简短|brief|concise)/iu.test(haystack) && /(回答|回复|风格|偏好|answer|response|style)/iu.test(haystack)) {
    return "response:concise";
  }
  return "";
}

function memoryDedupeKey(input: {
  kind: string;
  category: string;
  title?: string;
  summary: string;
  tags?: string[];
  facet?: string;
  subjectKey?: string;
}) {
  const facet = normalizeMemoryFacet(input.facet) || inferMemoryFacet(input);
  const subjectKey = asString(input.subjectKey) || inferMemorySubjectKey({
    ...input,
    facet
  });
  if (subjectKey) {
    return `${normalizeMemoryKind(input.kind)}\0${normalizeCategory(input.category)}\0${facet || "general"}\0${subjectKey}`;
  }
  const topic = canonicalMemoryTopic(input);
  if (!topic) {
    return "";
  }
  return `${normalizeMemoryKind(input.kind)}\0${normalizeCategory(input.category)}\0${topic}`;
}

function isLikedFoodPreferenceMemory(input: { category: string; title?: string; summary: string; tags?: string[] }) {
  const haystack = normalizeForHash([
    input.title ?? "",
    input.summary,
    input.category,
    ...(input.tags ?? [])
  ].join(" "));
  if (input.category !== "preference") {
    return false;
  }
  if (!/(喜欢吃|爱吃|likes?\s+(?:to\s+eat\s+)?|prefers?\s+(?:to\s+eat\s+)?)/iu.test(haystack)) {
    return false;
  }
  return /(饮食|食物|吃饭|饭|菜谱|food|meal|diet|recipe|dinner|lunch|breakfast|口味|主食|米饭|地沟油|rice)/iu.test(haystack);
}

function memorySlotKey(input: {
  kind: string;
  category: string;
  title?: string;
  summary: string;
  tags?: string[];
  facet?: string;
}) {
  const facet = normalizeMemoryFacet(input.facet) || inferMemoryFacet(input);
  if (facet === "food_preference") {
    return `${normalizeMemoryKind(input.kind)}\0preference\0food_preference`;
  }
  return "";
}

function isAdditivePreferenceText(text: string) {
  return /(^|[，。；;,.!！?\s])(也|还|另外|同时|除此之外|also|too|as well|another)(?=$|[，。；;,.!！?\s])/iu.test(text);
}

function shouldReplaceSlotMemory(input: AssistantMemoryUpsertInput, slotKey: string) {
  if (!slotKey.endsWith("\0food_preference")) {
    return false;
  }
  const incomingText = [
    input.title ?? "",
    input.summary ?? "",
    ...(input.tags ?? [])
  ].join(" ");
  return !isAdditivePreferenceText(incomingText);
}

function hasConclusionFirstPreference(text: string) {
  return /(先给结论|结论优先|先说结论|先讲结论|conclusion)/iu.test(text);
}

function rejectsConclusionFirstPreference(text: string) {
  return /(不需要|不用|不要|无需|别).{0,8}(先给结论|结论优先|先说结论|先讲结论)|(?:先给结论|结论优先|先说结论|先讲结论).{0,8}(不需要|不用|不要|无需|别)/iu.test(text);
}

function hasDetailedAnswerPreference(text: string) {
  return /(详细|展开|多讲|说全|完整|长一点|detail|detailed)/iu.test(text);
}

function hasConciseAnswerPreference(text: string) {
  return /(简洁|简短|短一点|少说|brief|concise)/iu.test(text);
}

function isConflictingMemory(existing: AssistantMemoryItem, input: AssistantMemoryUpsertInput) {
  const existingText = normalizeForHash([existing.title, existing.summary, ...existing.tags].join(" "));
  const incomingText = normalizeForHash([
    input.title ?? "",
    input.summary ?? "",
    ...(input.tags ?? [])
  ].join(" "));
  if (!incomingText || normalizeForHash(existing.summary) === normalizeForHash(input.summary ?? "")) {
    return false;
  }
  if (
    (hasConclusionFirstPreference(existingText) && rejectsConclusionFirstPreference(incomingText)) ||
    (rejectsConclusionFirstPreference(existingText) && hasConclusionFirstPreference(incomingText))
  ) {
    return true;
  }
  if (
    (hasConciseAnswerPreference(existingText) && hasDetailedAnswerPreference(incomingText)) ||
    (hasDetailedAnswerPreference(existingText) && hasConciseAnswerPreference(incomingText))
  ) {
    return true;
  }
  return false;
}

function containsSensitiveMemoryText(text: string) {
  return /(api[_-]?key|secret|token|password|passwd|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|akia[0-9a-z]{16})/iu.test(text);
}

function isExplicitDoNotRemember(text: string) {
  return /(不要记住|别记住|不要记录|别记录|不用记住|do\s+not\s+remember|don't\s+remember|dont\s+remember)/iu.test(text);
}

function isLowSignalMemory(text: string) {
  const normalized = normalizeForHash(text);
  if (normalized.length < 8) {
    return true;
  }
  return /^(好的|收到|明白|已完成|完成了|生成完成|ok|done)[。.!！\s]*$/iu.test(normalized);
}

function normalizeUpsertInput(
  input: AssistantMemoryUpsertInput,
  context: AssistantMemoryUpsertContext,
  existing?: AssistantMemoryItem
): { item?: AssistantMemoryItem; skip?: { reason: string; title?: string; summary?: string } } {
  const kind = normalizeMemoryKind(input.kind);
  const summary = asString(input.summary);
  const title = asString(input.title, summary).slice(0, 120) || "本地记忆";
  const combinedText = `${title}\n${summary}`;
  const inputConfidence = typeof input.confidence === "number" ? input.confidence : Number(input.confidence);
  if (!summary) {
    return { skip: { reason: "empty", title, summary } };
  }
  if (isLowSignalMemory(summary)) {
    return { skip: { reason: "low_signal", title, summary } };
  }
  if (containsSensitiveMemoryText(combinedText)) {
    return { skip: { reason: "sensitive", title, summary } };
  }
  if (isExplicitDoNotRemember(combinedText)) {
    return { skip: { reason: "do_not_remember", title, summary } };
  }
  if (Number.isFinite(inputConfidence) && inputConfidence < 0.55) {
    return { skip: { reason: "low_confidence", title, summary } };
  }

  const now = new Date().toISOString();
  const category = normalizeCategory(input.category);
  const scopeType = normalizeMemoryScopeType(input.scopeType, kind);
  const nextTags = normalizeTags(input.tags);
  const facet = normalizeMemoryFacet(input.facet) || inferMemoryFacet({
    category,
    title,
    summary,
    tags: nextTags
  });
  const subjectKey = asString(input.subjectKey) || inferMemorySubjectKey({
    category,
    title,
    summary,
    tags: nextTags,
    facet
  });
  const reason = asString(input.reason).slice(0, 500);
  if (existing) {
    return {
      item: {
        ...existing,
        title,
        summary,
        category,
        scopeType,
        ...(facet ? { facet } : {}),
        ...(subjectKey ? { subjectKey } : {}),
        tags: Array.from(new Set([...existing.tags, ...nextTags])),
        importance: Math.max(existing.importance, clampNumber(input.importance, existing.importance, 1, 10)),
        confidence: Math.max(existing.confidence, clampNumber(input.confidence, existing.confidence, 0, 1)),
        status: normalizeMemoryStatus(input.status ?? existing.status, kind),
        ...(context.chatId ? { sourceChatId: context.chatId } : {}),
        ...(context.runId ? { sourceRunId: context.runId } : {}),
        ...(reason ? { reason } : existing.reason ? { reason: existing.reason } : {}),
        updatedAt: now
      }
    };
  }

  return {
    item: {
      id: createMemoryId(),
      kind,
      title,
      summary,
      category,
      scopeType,
      ...(facet ? { facet } : {}),
      ...(subjectKey ? { subjectKey } : {}),
      tags: nextTags,
      importance: clampNumber(input.importance, kind === "fact" ? 8 : 6, 1, 10),
      confidence: clampNumber(input.confidence, 0.75, 0, 1),
      status: normalizeMemoryStatus(input.status, kind),
      ...(context.chatId ? { sourceChatId: context.chatId } : {}),
      ...(context.runId ? { sourceRunId: context.runId } : {}),
      ...(reason ? { reason } : {}),
      referenceCount: 0,
      createdAt: now,
      updatedAt: now
    }
  };
}

function inferStaticMemoryCategory(text: string) {
  if (/偏好|喜欢|习惯|风格|口味|饮食|吃|饭|菜谱|food|meal|recipe/iu.test(text)) {
    return "preference";
  }
  if (/约束|规则|必须|不要|不能|禁止|constraint|rule/iu.test(text)) {
    return "constraint";
  }
  if (/部署|发布|排查|流程|怎么做|上次|workflow|deploy|debug/iu.test(text)) {
    return "workflow";
  }
  return "general";
}

function scoreStaticMemoryText(title: string, text: string, query: string) {
  const pseudoItem: AssistantMemoryItem = {
    id: "local-zenmind-memory",
    kind: "fact",
    title,
    summary: text,
    category: inferStaticMemoryCategory(`${title}\n${text}`),
    scopeType: "user",
    tags: [],
    importance: 7,
    confidence: 1,
    status: "active",
    referenceCount: 0,
    createdAt: "",
    updatedAt: ""
  };
  const intent = detectMemoryQueryIntent(query);
  const gated = gateRuntimeMemoryCandidate(pseudoItem, {
    query,
    chatId: "",
    intent,
    layer: "stable"
  });
  return gated.eligible ? scoreEligibleMemoryForQuery(pseudoItem, {
    query,
    chatId: "",
    intent,
    layer: "stable"
  }) : 0;
}

function parseStaticMemoryChunks(content: string, query: string): StaticMemoryChunk[] {
  const lines = content.trim().split(/\r?\n/u);
  const chunks: Array<Omit<StaticMemoryChunk, "score">> = [];
  let currentTitle = "本地长期记忆";
  let currentLines: string[] = [];
  let currentStart = 1;

  const pushCurrent = (lineEnd: number) => {
    const text = currentLines.join("\n").trim();
    if (!text) {
      return;
    }
    chunks.push({
      title: currentTitle,
      text,
      lineStart: currentStart,
      lineEnd
    });
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = line.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      pushCurrent(lineNumber - 1);
      currentTitle = heading[1].trim() || "本地长期记忆";
      currentLines = [line];
      currentStart = lineNumber;
      return;
    }
    if (!line.trim() && currentLines.some((item) => item.trim())) {
      pushCurrent(lineNumber - 1);
      currentLines = [];
      currentStart = lineNumber + 1;
      return;
    }
    if (currentLines.length === 0) {
      currentStart = lineNumber;
    }
    currentLines.push(line);
  });
  pushCurrent(lines.length);

  return chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreStaticMemoryText(chunk.title, chunk.text, query)
    }))
    .filter((chunk) => chunk.score > 0);
}

function renderStaticMemory(chunks: StaticMemoryChunk[], maxChars: number) {
  if (chunks.length === 0) {
    return "";
  }
  const rendered = [
    "<静态长期记忆>",
    ...chunks.map((chunk) => chunk.text),
    "</静态长期记忆>"
  ].join("\n\n");
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(0, maxChars - 24))}\n...[记忆已截断]`;
}

function buildAssistantMemoryReferences(chunks: StaticMemoryChunk[]): AssistantMemoryReference[] {
  return chunks.map((chunk, index) => ({
    id: index === 0 ? "local-zenmind-memory" : `local-zenmind-memory-${index + 1}`,
    title: chunk.title.slice(0, 80) || "本地长期记忆",
    path: ASSISTANT_MEMORY_RELATIVE_PATH,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    excerpt: chunk.text.length > MAX_MEMORY_REFERENCE_EXCERPT_LENGTH
      ? `${chunk.text.slice(0, MAX_MEMORY_REFERENCE_EXCERPT_LENGTH)}...`
      : chunk.text,
    reason: "匹配静态长期记忆"
  }));
}

function extractQueryTokens(query: string) {
  const normalized = query.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]*|[\p{Script=Han}]{2,}/giu)) {
    const token = match[0].trim();
    if (!token) {
      continue;
    }
    tokens.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) {
        tokens.add(token.slice(index, index + 2));
      }
    }
  }
  return [...tokens].filter((token) => token.length >= 2 && !GENERIC_QUERY_TOKENS.has(token));
}

function hasFoodQueryIntent(query: string) {
  return /喜欢吃|爱吃|吃什么|吃啥|吃点什么|吃哪|饭|餐|菜谱|菜品|食物|饮食|口味|主食|早餐|午餐|晚餐|晚饭|夜宵|宵夜|点外卖|做什么菜|food|meal|dinner|lunch|breakfast|recipe/iu.test(query);
}

function hasResponsePreferenceQueryIntent(query: string) {
  return /(?:按我(?:的)?(?:偏好|习惯|风格)|回复风格|回答风格|输出风格|怎么回复|如何回复|如何回答|怎么回答|回答偏好|回复偏好)|(?:(?:偏好|习惯|风格).*(?:回复|回答|输出)|(?:回复|回答|输出).*(?:偏好|习惯|风格))/iu.test(query);
}

function isFoodRelatedMemory(item: AssistantMemoryItem, haystack: string) {
  if (item.category === "diet" || item.category === "food") {
    return true;
  }
  if (item.tags.some((tag) => /food|rice|meal|diet|recipe|breakfast|lunch|dinner|饮食|米饭|吃饭|菜谱|食物|口味/iu.test(tag))) {
    return true;
  }
  return /饮食|米饭|吃饭|菜谱|食物|口味|晚饭|午饭|早餐|food|rice|meal|diet|recipe|dinner|lunch|breakfast/iu.test(haystack);
}

function isResponseStyleMemory(item: AssistantMemoryItem, haystack: string) {
  return isResponseStyleMemoryText(item.category, item.tags, haystack);
}

function isResponseStyleMemoryText(category: string, tags: string[], haystack: string) {
  if (tags.some((tag) => /reply|response|answer|style|conclusion|concise|回答|回复|输出|风格|结论/iu.test(tag))) {
    return true;
  }
  return category === "preference" && /回答|回复|输出|风格|结论|简洁|详细|answer|response|reply|style|conclusion|concise|detailed/iu.test(haystack);
}

function detectMemoryQueryIntent(query: string): MemoryQueryIntent {
  const normalized = normalizeForHash(query);
  if (hasResponsePreferenceQueryIntent(normalized)) {
    return "response_style";
  }
  if (hasFoodQueryIntent(normalized)) {
    return "food_preference";
  }
  if (/约束|规则|要求|必须|不要|不能|禁止|限制|constraint|rule|requirement/iu.test(normalized)) {
    return "constraint";
  }
  if (/部署|发布|排查|流程|工作流|怎么做|如何做|失败|报错|修复|调试|端口|服务|bug|bugfix|workflow|deploy|debug|runbook|incident/iu.test(normalized)) {
    return "workflow_or_bugfix";
  }
  if (/刚才|刚刚|上次|之前|前面|上一轮|这次|本次|过程|步骤|怎么处理|怎么解决|历史|previous|before|last time|earlier/iu.test(normalized)) {
    return "history_or_previous_process";
  }
  return "general";
}

function getMemoryFacet(item: AssistantMemoryItem): AssistantMemoryFacet {
  return normalizeMemoryFacet(item.facet) || inferMemoryFacet(item);
}

function getMemorySubjectKey(item: AssistantMemoryItem) {
  return asString(item.subjectKey) || inferMemorySubjectKey({
    category: item.category,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    facet: getMemoryFacet(item)
  });
}

function buildMemoryHaystack(item: AssistantMemoryItem) {
  return normalizeForHash([
    item.title,
    item.summary,
    item.category,
    item.kind,
    item.facet ?? "",
    item.subjectKey ?? "",
    ...item.tags
  ].join(" "));
}

function getRuntimeMemoryLayer(item: AssistantMemoryItem, chatId: string): RuntimeMemorySelection["layer"] | "" {
  const scopeType = normalizeMemoryScopeType(item.scopeType, item.kind);
  if (item.kind === "fact" && scopeType === "user") {
    return "stable";
  }
  if (item.kind === "observation" && chatId && item.sourceChatId === chatId) {
    return "session";
  }
  if (item.kind === "observation") {
    return "observation";
  }
  return "";
}

function queryMatchesSubjectKey(query: string, subjectKey: string) {
  if (!subjectKey) {
    return false;
  }
  const [, subject = subjectKey] = subjectKey.split(":");
  return Boolean(subject && normalizeTopicSubject(query).includes(subject));
}

function hasNonGenericQueryTokenMatch(item: AssistantMemoryItem, query: string) {
  const haystack = buildMemoryHaystack(item);
  return extractQueryTokens(query).some((token) => haystack.includes(token));
}

function gateRuntimeMemoryCandidate(
  item: AssistantMemoryItem,
  options: {
    query: string;
    chatId: string;
    intent: MemoryQueryIntent;
    layer: RuntimeMemorySelection["layer"];
  }
): { eligible: boolean; reason: string } {
  if (item.status === "archived") {
    return { eligible: false, reason: "archived" };
  }
  const facet = getMemoryFacet(item);
  const subjectKey = getMemorySubjectKey(item);
  const tokenMatched = hasNonGenericQueryTokenMatch(item, options.query);
  const subjectMatched = queryMatchesSubjectKey(options.query, subjectKey);
  switch (options.intent) {
    case "food_preference":
      return facet === "food_preference"
        ? { eligible: true, reason: "facet:food_preference" }
        : { eligible: false, reason: `facet:${facet}:not_food_preference` };
    case "response_style":
      return facet === "response_style"
        ? { eligible: true, reason: "facet:response_style" }
        : { eligible: false, reason: `facet:${facet}:not_response_style` };
    case "constraint":
      if (facet === "constraint" || item.category === "constraint") {
        return { eligible: true, reason: "facet:constraint" };
      }
      if (item.kind === "fact" && item.confidence >= 0.8 && (tokenMatched || subjectMatched)) {
        return { eligible: true, reason: "high_confidence_fact_match" };
      }
      return { eligible: false, reason: "not_constraint" };
    case "workflow_or_bugfix":
      if (facet === "workflow" || facet === "decision" || ["workflow", "bugfix", "decision"].includes(item.category)) {
        return tokenMatched || subjectMatched || options.layer === "session"
          ? { eligible: true, reason: "workflow_or_decision_match" }
          : { eligible: false, reason: "workflow_without_specific_match" };
      }
      if (options.layer === "session" && item.kind === "observation" && (tokenMatched || subjectMatched)) {
        return { eligible: true, reason: "current_session_observation_match" };
      }
      return { eligible: false, reason: "not_workflow_or_bugfix" };
    case "history_or_previous_process":
      if (options.layer === "session" && item.kind === "observation") {
        return { eligible: true, reason: "current_session_process" };
      }
      if (facet === "workflow" || facet === "decision" || ["workflow", "bugfix", "decision"].includes(item.category)) {
        return tokenMatched || subjectMatched
          ? { eligible: true, reason: "historical_process_match" }
          : { eligible: false, reason: "historical_process_without_specific_match" };
      }
      return { eligible: false, reason: "not_history_or_process" };
    case "general":
    default:
      if (item.kind !== "fact" || normalizeMemoryScopeType(item.scopeType, item.kind) !== "user") {
        return { eligible: false, reason: "general_requires_stable_fact" };
      }
      if (facet !== "general" && facet !== "decision" && facet !== "constraint") {
        return { eligible: false, reason: `general_excludes_${facet}` };
      }
      if (item.confidence < 0.75) {
        return { eligible: false, reason: "low_confidence_general_fact" };
      }
      return tokenMatched || subjectMatched
        ? { eligible: true, reason: subjectMatched ? "subject_match" : "keyword_match" }
        : { eligible: false, reason: "no_specific_match" };
  }
}

function scoreEligibleMemoryForQuery(
  item: AssistantMemoryItem,
  options: {
    query: string;
    chatId: string;
    intent: MemoryQueryIntent;
    layer: RuntimeMemorySelection["layer"];
  }
) {
  const facet = getMemoryFacet(item);
  const subjectKey = getMemorySubjectKey(item);
  const haystack = buildMemoryHaystack(item);
  const tokens = extractQueryTokens(options.query);
  let score = 0;

  if (queryMatchesSubjectKey(options.query, subjectKey)) {
    score += 80;
  }
  if (
    (options.intent === "food_preference" && facet === "food_preference") ||
    (options.intent === "response_style" && facet === "response_style") ||
    (options.intent === "constraint" && facet === "constraint") ||
    (options.intent === "workflow_or_bugfix" && ["workflow", "decision"].includes(facet)) ||
    (options.intent === "history_or_previous_process" && ["workflow", "decision"].includes(facet))
  ) {
    score += 48;
  }
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 12 : 6;
    }
  }
  score += item.importance * 2;
  score += Math.min(10, item.referenceCount * 0.5);
  if (options.chatId && item.sourceChatId === options.chatId) {
    score += 8;
  }
  if (options.layer === "stable") {
    score += 10;
  } else if (options.layer === "session") {
    score += 6;
  }
  if (item.updatedAt) {
    const ageMs = Date.now() - Date.parse(item.updatedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      score += Math.max(0, 6 - ageMs / (1000 * 60 * 60 * 24 * 30));
    }
  }
  return score;
}

function describeMemoryRecallReason(
  item: AssistantMemoryItem,
  options: {
    query: string;
    chatId: string;
    intent: MemoryQueryIntent;
    layer: RuntimeMemorySelection["layer"];
    gateReason: string;
  }
) {
  const reasons: string[] = [];
  const haystack = buildMemoryHaystack(item);
  const tokens = extractQueryTokens(options.query);
  const facet = getMemoryFacet(item);
  if (options.chatId && item.sourceChatId === options.chatId) {
    reasons.push("当前会话相关");
  }
  if (options.intent === "food_preference" && facet === "food_preference") {
    reasons.push("匹配饮食偏好");
  }
  if (options.intent === "response_style" && facet === "response_style") {
    reasons.push("匹配回复风格");
  }
  if (options.intent === "constraint" && (facet === "constraint" || item.category === "constraint")) {
    reasons.push("匹配明确约束");
  }
  if (["workflow_or_bugfix", "history_or_previous_process"].includes(options.intent) && ["workflow", "decision"].includes(facet)) {
    reasons.push(options.layer === "session" ? "匹配当前会话过程" : "匹配历史任务过程");
  }
  if (queryMatchesSubjectKey(options.query, getMemorySubjectKey(item))) {
    reasons.push("匹配记忆主题");
  }
  const matchedTokens = tokens.filter((token) => haystack.includes(token)).slice(0, 3);
  if (matchedTokens.length > 0) {
    reasons.push(`匹配关键词：${matchedTokens.join("、")}`);
  }
  return reasons.length > 0 ? reasons.join("；") : options.gateReason || "与当前问题相关";
}

function compareRuntimeMemorySelection(left: RuntimeMemorySelection, right: RuntimeMemorySelection) {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return right.item.updatedAt.localeCompare(left.item.updatedAt);
}

function layerBudget(maxItems: number, layer: RuntimeMemorySelection["layer"]) {
  if (layer === "stable") {
    return Math.max(1, Math.min(maxItems, Math.ceil(maxItems * 0.65)));
  }
  if (layer === "session") {
    return Math.max(1, Math.min(2, maxItems));
  }
  return Math.max(0, maxItems);
}

function selectLayerItems(
  items: AssistantMemoryItem[],
  options: {
    query: string;
    chatId: string;
    intent: MemoryQueryIntent;
    layer: RuntimeMemorySelection["layer"];
    maxItems: number;
  },
  selectedDedupeKeys: Set<string>
) {
  if (options.maxItems <= 0) {
    return [];
  }
  const selections = items
    .map((item) => {
      const gate = gateRuntimeMemoryCandidate(item, options);
      if (!gate.eligible) {
        return null;
      }
      const score = scoreEligibleMemoryForQuery(item, options);
      if (score <= 0) {
        return null;
      }
      return {
        item,
        score,
        layer: options.layer,
        reason: describeMemoryRecallReason(item, {
          query: options.query,
          chatId: options.chatId,
          intent: options.intent,
          layer: options.layer,
          gateReason: gate.reason
        })
      };
    })
    .filter((entry): entry is RuntimeMemorySelection => Boolean(entry))
    .sort(compareRuntimeMemorySelection);

  const selected: RuntimeMemorySelection[] = [];
  for (const selection of selections) {
    const dedupeKey = memoryDedupeKey(selection.item);
    if (dedupeKey && selectedDedupeKeys.has(dedupeKey)) {
      continue;
    }
    selected.push(selection);
    if (dedupeKey) {
      selectedDedupeKeys.add(dedupeKey);
    }
    if (selected.length >= options.maxItems) {
      break;
    }
  }
  return selected;
}

function selectRuntimeMemoryItems(
  rootDir: string,
  options: Required<Pick<AssistantMemorySnapshotOptions, "query" | "chatId" | "maxItems" | "maxChars">>
) : LayeredRuntimeMemorySelection {
  const queryIntent = detectMemoryQueryIntent(options.query);
  const selectedDedupeKeys = new Set<string>();
  const allItems = listAssistantMemoryItemsFromRoot(rootDir);
  const layered = allItems.reduce<{
    stable: AssistantMemoryItem[];
    session: AssistantMemoryItem[];
    observation: AssistantMemoryItem[];
  }>((accumulator, item) => {
    const layer = getRuntimeMemoryLayer(item, options.chatId);
    if (layer) {
      accumulator[layer].push(item);
    }
    return accumulator;
  }, {
    stable: [],
    session: [],
    observation: []
  });
  const stableFacts = selectLayerItems(layered.stable, {
    query: options.query,
    chatId: options.chatId,
    intent: queryIntent,
    layer: "stable",
    maxItems: layerBudget(options.maxItems, "stable")
  }, selectedDedupeKeys);
  const remainingAfterStable = Math.max(0, options.maxItems - stableFacts.length);
  const currentSession = selectLayerItems(layered.session, {
    query: options.query,
    chatId: options.chatId,
    intent: queryIntent,
    layer: "session",
    maxItems: Math.min(layerBudget(options.maxItems, "session"), remainingAfterStable)
  }, selectedDedupeKeys);
  const remainingAfterSession = Math.max(0, options.maxItems - stableFacts.length - currentSession.length);
  const relevantObservations = selectLayerItems(layered.observation, {
    query: options.query,
    chatId: options.chatId,
    intent: queryIntent,
    layer: "observation",
    maxItems: remainingAfterSession
  }, selectedDedupeKeys);
  return {
    queryIntent,
    stableFacts,
    currentSession,
    relevantObservations,
    candidateCountsByLayer: {
      stable: layered.stable.length,
      session: layered.session.length,
      observation: layered.observation.length
    },
    selectedCountsByLayer: {
      stable: stableFacts.length,
      session: currentSession.length,
      observation: relevantObservations.length
    }
  };
}

function flattenRuntimeMemorySelection(selection: LayeredRuntimeMemorySelection) {
  return [
    ...selection.stableFacts,
    ...selection.currentSession,
    ...selection.relevantObservations
  ];
}

function renderMemoryLayerSection(title: string, selections: RuntimeMemorySelection[]) {
  if (selections.length === 0) {
    return "";
  }
  return [
    `<${title}>`,
    ...selections.map((selection, index) => {
      const item = selection.item;
      const label = item.kind === "fact" ? "稳定记忆" : "历史观察";
      const source = item.sourceChatId ? ` 来源：${item.sourceChatId}` : "";
      const recallReason = selection.reason ? ` 召回原因：${selection.reason}` : "";
      return `${index + 1}. [${label}/${item.category}] ${item.title}：${item.summary}${source}${recallReason}`;
    }),
    `</${title}>`
  ].join("\n");
}

function renderRuntimeMemory(selection: LayeredRuntimeMemorySelection, maxChars: number) {
  const sections = [
    renderMemoryLayerSection("Stable Memory", selection.stableFacts),
    renderMemoryLayerSection("Current Session", selection.currentSession),
    renderMemoryLayerSection("Relevant Observations", selection.relevantObservations)
  ].filter(Boolean);
  if (sections.length === 0) {
    return "";
  }
  const rendered = [
    "<运行时记忆>",
    `Query Intent: ${selection.queryIntent}`,
    ...sections,
    "</运行时记忆>"
  ].join("\n");
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(0, maxChars - 24))}\n...[记忆已截断]`;
}

function buildRuntimeMemoryReferences(selection: LayeredRuntimeMemorySelection): AssistantMemoryReference[] {
  return flattenRuntimeMemorySelection(selection).map((selection, index) => {
    const item = selection.item;
    return {
      id: item.id,
      title: item.title || "本地运行时记忆",
      path: ASSISTANT_MEMORY_RECORDS_RELATIVE_PATH,
      lineStart: index + 1,
      lineEnd: index + 1,
      excerpt: item.summary.length > MAX_MEMORY_REFERENCE_EXCERPT_LENGTH
        ? `${item.summary.slice(0, MAX_MEMORY_REFERENCE_EXCERPT_LENGTH)}...`
        : item.summary,
      reason: selection.reason
    };
  });
}

function markReferencedMemoryItems(rootDir: string, items: AssistantMemoryItem[]) {
  if (items.length === 0) {
    return;
  }
  const ids = new Set(items.map((item) => item.id));
  const now = new Date().toISOString();
  const allItems = listAssistantMemoryItemsFromRoot(rootDir);
  const nextItems = allItems.map((item) => ids.has(item.id)
    ? {
        ...item,
        referenceCount: item.referenceCount + 1,
        lastReferencedAt: now,
        updatedAt: now
      }
    : item);
  writeMemoryItemsToRoot(rootDir, nextItems);
}

export function readAssistantMemoryFromRoot(rootDir: string) {
  try {
    return fs.readFileSync(getAssistantMemoryPathFromRoot(rootDir), "utf8").trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    return "";
  }
}

export function saveAssistantMemoryToRoot(rootDir: string, content: string) {
  const memoryPath = getAssistantMemoryPathFromRoot(rootDir);
  ensureParent(memoryPath);
  fs.writeFileSync(memoryPath, content.trim(), "utf8");
}

export function listAssistantMemoryItemsFromRoot(rootDir: string): AssistantMemoryItem[] {
  return normalizeRecords(safeReadJson(getAssistantMemoryRecordsPathFromRoot(rootDir))).items
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function upsertAssistantMemoryItemsFromRoot(
  rootDir: string,
  inputs: AssistantMemoryUpsertInput[],
  context: AssistantMemoryUpsertContext = {}
): AssistantMemoryUpsertResult {
  const current = listAssistantMemoryItemsFromRoot(rootDir);
  const activeCurrent = current.filter((item) => item.status !== "archived");
  const byFingerprint = new Map(activeCurrent.map((item) => [
    memoryFingerprint(item),
    item
  ]));
  const byDedupeKey = new Map(activeCurrent.flatMap((item) => {
    const key = memoryDedupeKey(item);
    return key ? [[key, item] as const] : [];
  }));
  const bySlotKey = new Map<string, AssistantMemoryItem[]>();
  for (const item of activeCurrent) {
    const key = memorySlotKey(item);
    if (!key) {
      continue;
    }
    bySlotKey.set(key, [...(bySlotKey.get(key) ?? []), item]);
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  const stored: AssistantMemoryItem[] = [];
  const skipped: AssistantMemoryUpsertResult["skipped"] = [];
  let updated = 0;
  let archived = 0;

  for (const input of inputs) {
    const kind = normalizeMemoryKind(input.kind);
    const category = normalizeCategory(input.category);
    const summary = asString(input.summary);
    const fingerprint = memoryFingerprint({ kind, category, summary });
    const dedupeKey = memoryDedupeKey({
      kind,
      category,
      title: input.title,
      summary,
      tags: input.tags,
      facet: input.facet,
      subjectKey: input.subjectKey
    });
    const slotKey = memorySlotKey({
      kind,
      category,
      title: input.title,
      summary,
      tags: input.tags,
      facet: input.facet
    });
    let existing = byFingerprint.get(fingerprint) ?? (dedupeKey ? byDedupeKey.get(dedupeKey) : undefined);
    if (existing && dedupeKey && isConflictingMemory(existing, input)) {
      const archivedItem: AssistantMemoryItem = {
        ...existing,
        status: "archived",
        updatedAt: new Date().toISOString()
      };
      byId.set(archivedItem.id, archivedItem);
      byFingerprint.set(memoryFingerprint(archivedItem), archivedItem);
      byDedupeKey.delete(dedupeKey);
      existing = undefined;
      archived += 1;
    }
    if (!existing && slotKey && shouldReplaceSlotMemory(input, slotKey)) {
      const slotMatches = (bySlotKey.get(slotKey) ?? [])
        .filter((item) => {
          const itemDedupeKey = memoryDedupeKey(item);
          return !dedupeKey || itemDedupeKey !== dedupeKey;
        });
      for (const item of slotMatches) {
        const archivedItem: AssistantMemoryItem = {
          ...item,
          status: "archived",
          updatedAt: new Date().toISOString()
        };
        byId.set(archivedItem.id, archivedItem);
        byFingerprint.set(memoryFingerprint(archivedItem), archivedItem);
        const archivedDedupeKey = memoryDedupeKey(archivedItem);
        if (archivedDedupeKey && byDedupeKey.get(archivedDedupeKey)?.id === archivedItem.id) {
          byDedupeKey.delete(archivedDedupeKey);
        }
        archived += 1;
      }
      if (slotMatches.length > 0) {
        bySlotKey.set(slotKey, (bySlotKey.get(slotKey) ?? []).filter((item) => !slotMatches.some((match) => match.id === item.id)));
      }
    }
    const normalized = normalizeUpsertInput(input, context, existing);
    if (normalized.skip) {
      skipped.push(normalized.skip);
      continue;
    }
    if (!normalized.item) {
      continue;
    }
    if (existing) {
      updated += 1;
    }
    byId.set(normalized.item.id, normalized.item);
    byFingerprint.set(fingerprint, normalized.item);
    if (dedupeKey) {
      byDedupeKey.set(dedupeKey, normalized.item);
    }
    if (slotKey) {
      bySlotKey.set(slotKey, [
        normalized.item,
        ...(bySlotKey.get(slotKey) ?? []).filter((item) => item.id !== normalized.item?.id)
      ]);
    }
    stored.push(normalized.item);
  }

  const nextItems = [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  writeMemoryItemsToRoot(rootDir, nextItems);
  if (stored.length > 0 || skipped.length > 0) {
    appendAssistantMemoryAuditFromRoot(rootDir, {
      operation: "upsert",
      status: "ok",
      stored: stored.length,
      skipped: skipped.length,
      updated,
      archived,
      chatId: context.chatId ?? "",
      runId: context.runId ?? ""
    });
  }
  return { stored, skipped };
}

function cleanExplicitFoodPreferenceValue(value: string) {
  return value
    .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/gu, "")
    .replace(/^(吃|的是|就是|为)\s*/u, "")
    .replace(/[啊呀呢吧哦哈啦～~]+$/u, "")
    .trim()
    .slice(0, 40);
}

function extractExplicitLikedFood(userText: string) {
  if (!userText.trim() || isExplicitDoNotRemember(userText)) {
    return "";
  }
  if (/[?？]/u.test(userText) || /(?:什么|哪些|哪种|吗|么|是否|是不是|请问我喜欢吃)/u.test(userText)) {
    return "";
  }
  const match = userText.match(/(?:^|[，。；;,.!！\s])(?:我|俺|本人|i)\s*(?:现在|刚刚|一直|一直都|很|非常|特别|最)?\s*(?:喜欢吃|爱吃|like\s+(?:to\s+eat\s+)?|love\s+(?:to\s+eat\s+)?)\s*([^，。；;,.!?！？\n]{1,40})/iu);
  if (!match) {
    return "";
  }
  const food = cleanExplicitFoodPreferenceValue(match[1]);
  if (!food || /(?:什么|哪些|哪种|吗|么|是否|是不是)/u.test(food)) {
    return "";
  }
  return food;
}

function isUnsafeFoodPreference(food: string) {
  return /(地沟油|gutter\s*oil|变质|发霉|腐烂|有毒|poison|spoiled|rotten)/iu.test(food);
}

export function upsertExplicitUserMemoryFromRoot(
  rootDir: string,
  userText: string,
  context: AssistantMemoryUpsertContext = {}
): AssistantMemoryUpsertResult {
  const likedFood = extractExplicitLikedFood(userText);
  if (!likedFood) {
    return { stored: [], skipped: [] };
  }
  const unsafe = isUnsafeFoodPreference(likedFood);
  return upsertAssistantMemoryItemsFromRoot(rootDir, [{
    kind: "fact",
    title: `饮食偏好-${likedFood}`,
    summary: unsafe
      ? `用户刚表达喜欢吃${likedFood}；这是不安全且不应食用的内容。后续回答用户偏好时可以如实提及并提醒风险，但饮食建议中不要推荐食用。`
      : `用户喜欢吃${likedFood}。这是用户当前明确表达的饮食偏好；后续饮食相关回答优先按这条最新偏好理解。`,
    category: "preference",
    tags: ["food", "diet-preference", likedFood, unsafe ? "unsafe-food" : "liked-food"],
    importance: 9,
    confidence: 0.96,
    reason: unsafe ? "用户当前表达了饮食偏好，但内容存在食品安全风险。" : "用户当前明确表达饮食偏好。"
  }], context);
}

export function deleteAssistantMemoryItemFromRoot(rootDir: string, memoryId: string) {
  const current = listAssistantMemoryItemsFromRoot(rootDir);
  const nextItems = current.filter((item) => item.id !== memoryId);
  writeMemoryItemsToRoot(rootDir, nextItems);
  return {
    ok: nextItems.length !== current.length,
    message: nextItems.length !== current.length ? "已删除记忆。" : "该记忆不存在。"
  };
}

export function clearAssistantMemoryItemsFromRoot(rootDir: string) {
  const current = listAssistantMemoryItemsFromRoot(rootDir);
  writeMemoryItemsToRoot(rootDir, []);
  appendAssistantMemoryAuditFromRoot(rootDir, {
    operation: "clear",
    status: "ok",
    deletedCount: current.length
  });
  return {
    ok: true,
    message: current.length > 0 ? `已清空 ${current.length} 条记忆。` : "没有可清空的记忆。",
    deletedCount: current.length
  };
}

export function getAssistantMemorySettingsFromRoot(rootDir: string): AssistantMemorySettings {
  return normalizeSettings(safeReadJson(getAssistantMemorySettingsPathFromRoot(rootDir)));
}

export function saveAssistantMemorySettingsToRoot(
  rootDir: string,
  input: AssistantMemorySettingsInput
): AssistantMemorySettings {
  const current = getAssistantMemorySettingsFromRoot(rootDir);
  const next = normalizeSettings({
    ...current,
    ...input
  });
  writeJsonFile(getAssistantMemorySettingsPathFromRoot(rootDir), next);
  appendAssistantMemoryAuditFromRoot(rootDir, {
    operation: "settings",
    status: "ok",
    enabled: next.enabled,
    autoLearn: next.autoLearn,
    maxItems: next.maxItems,
    maxChars: next.maxChars
  });
  return next;
}

export function getAssistantMemoryStatsFromRoot(rootDir: string): AssistantMemoryStats {
  const items = listAssistantMemoryItemsFromRoot(rootDir);
  const learnedTimes = items.map((item) => item.createdAt).filter(Boolean).sort();
  const referencedTimes = items.map((item) => item.lastReferencedAt ?? "").filter(Boolean).sort();
  return {
    total: items.length,
    factCount: items.filter((item) => item.kind === "fact").length,
    observationCount: items.filter((item) => item.kind === "observation").length,
    lastLearnedAt: learnedTimes.at(-1) ?? null,
    lastReferencedAt: referencedTimes.at(-1) ?? null
  };
}

export function appendAssistantMemoryAuditFromRoot(rootDir: string, payload: Record<string, unknown>) {
  const auditPath = getAssistantMemoryAuditPathFromRoot(rootDir);
  ensureParent(auditPath);
  fs.appendFileSync(auditPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    category: "assistant.memory",
    ...payload
  })}\n`, "utf8");
}

function readLatestAssistantMemoryAuditFromRoot(rootDir: string): AssistantMemorySummary["recentAudit"] {
  const auditPath = getAssistantMemoryAuditPathFromRoot(rootDir);
  try {
    const lines = fs.readFileSync(auditPath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
        return {
          operation: asString(parsed.operation),
          status: asString(parsed.status),
          reason: asString(parsed.reason),
          stored: Number.isFinite(Number(parsed.stored)) ? Number(parsed.stored) : undefined,
          skipped: Number.isFinite(Number(parsed.skipped)) ? Number(parsed.skipped) : undefined,
          updated: Number.isFinite(Number(parsed.updated)) ? Number(parsed.updated) : undefined,
          archived: Number.isFinite(Number(parsed.archived)) ? Number(parsed.archived) : undefined,
          timestamp: asString(parsed.ts)
        };
      } catch {
        // Try an older audit line if the latest line is incomplete.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return null;
}

export function getAssistantMemorySummaryFromRoot(rootDir: string): AssistantMemorySummary {
  const directoryPath = getAssistantMemoryDirectoryFromRoot(rootDir);
  return {
    settings: getAssistantMemorySettingsFromRoot(rootDir),
    stats: getAssistantMemoryStatsFromRoot(rootDir),
    storage: getAssistantMemoryStorageFromRoot(rootDir),
    directoryPath,
    recentAudit: readLatestAssistantMemoryAuditFromRoot(rootDir)
  };
}

export function readAssistantMemorySnapshotFromRoot(
  rootDir: string,
  options: AssistantMemorySnapshotOptions = {}
): AssistantMemorySnapshot {
  const settings = getAssistantMemorySettingsFromRoot(rootDir);
  const maxItems = options.maxItems ?? settings.maxItems;
  const maxChars = options.maxChars ?? settings.maxChars;
  const staticContent = readAssistantMemoryFromRoot(rootDir);
  const staticChunks = settings.enabled && staticContent
    ? parseStaticMemoryChunks(staticContent, options.query ?? "")
        .sort((left, right) => {
          if (left.score !== right.score) {
            return right.score - left.score;
          }
          return left.lineStart - right.lineStart;
        })
        .slice(0, maxItems)
    : [];
  const runtimeItems = settings.enabled
    ? selectRuntimeMemoryItems(rootDir, {
        query: options.query ?? "",
        chatId: options.chatId ?? "",
        maxItems,
        maxChars
      })
    : {
        queryIntent: detectMemoryQueryIntent(options.query ?? ""),
        stableFacts: [],
        currentSession: [],
        relevantObservations: [],
        candidateCountsByLayer: {
          stable: 0,
          session: 0,
          observation: 0
        },
        selectedCountsByLayer: {
          stable: 0,
          session: 0,
          observation: 0
        }
      };
  const runtimeBlock = renderRuntimeMemory(runtimeItems, maxChars);
  const runtimeReferences = buildRuntimeMemoryReferences(runtimeItems);
  let staticBlock = renderStaticMemory(staticChunks, maxChars);
  if (!staticBlock && staticContent && runtimeBlock) {
    staticBlock = "<静态长期记忆>\n</静态长期记忆>";
  }
  const staticReferences = buildAssistantMemoryReferences(staticChunks);
  markReferencedMemoryItems(rootDir, flattenRuntimeMemorySelection(runtimeItems).map((selection) => selection.item));

  const content = [
    staticBlock,
    runtimeBlock
  ].filter(Boolean).join("\n\n");

  if (staticReferences.length > 0 || runtimeReferences.length > 0) {
    appendAssistantMemoryAuditFromRoot(rootDir, {
      operation: "recall",
      status: "ok",
      query: options.query ?? "",
      chatId: options.chatId ?? "",
      referenced: staticReferences.length + runtimeReferences.length,
      queryIntent: runtimeItems.queryIntent,
      candidateCountsByLayer: runtimeItems.candidateCountsByLayer,
      selectedCountsByLayer: runtimeItems.selectedCountsByLayer,
      selectedIds: runtimeReferences.map((reference) => reference.id),
      selectedReasons: runtimeReferences.map((reference) => reference.reason ?? ""),
      maxItems,
      maxChars
    });
  }

  return {
    content,
    references: [...staticReferences, ...runtimeReferences]
  };
}

export function readAssistantMemory(app: App) {
  return readAssistantMemoryFromRoot(app.getPath("userData"));
}

export function readAssistantMemorySnapshot(app: App, options: AssistantMemorySnapshotOptions = {}) {
  return readAssistantMemorySnapshotFromRoot(app.getPath("userData"), options);
}

export function getAssistantMemorySettings(app: App) {
  return getAssistantMemorySettingsFromRoot(app.getPath("userData"));
}

export function saveAssistantMemorySettings(app: App, input: AssistantMemorySettingsInput) {
  return saveAssistantMemorySettingsToRoot(app.getPath("userData"), input);
}

export function listAssistantMemoryItems(app: App) {
  return listAssistantMemoryItemsFromRoot(app.getPath("userData"));
}

export function deleteAssistantMemoryItem(app: App, memoryId: string) {
  return deleteAssistantMemoryItemFromRoot(app.getPath("userData"), memoryId);
}

export function clearAssistantMemoryItems(app: App) {
  return clearAssistantMemoryItemsFromRoot(app.getPath("userData"));
}

export function getAssistantMemoryStats(app: App) {
  return getAssistantMemoryStatsFromRoot(app.getPath("userData"));
}

export function getAssistantMemorySummary(app: App) {
  return getAssistantMemorySummaryFromRoot(app.getPath("userData"));
}

export function getAssistantMemoryDirectory(app: App) {
  return getAssistantMemoryDirectoryFromRoot(app.getPath("userData"));
}
