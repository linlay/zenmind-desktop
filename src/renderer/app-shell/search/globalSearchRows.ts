import type {
  AssistantChatSearchResult,
  AssistantNavAgentItem,
  AssistantNavChatItem
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

export type DesktopGlobalSearchActionId = "newChat" | "agents" | "controlCenter" | "settings";
export type DesktopGlobalSearchSectionId = "actions" | "agents" | "chats";

export type DesktopGlobalSearchRow =
  | {
      kind: "action";
      key: string;
      actionId: DesktopGlobalSearchActionId;
      label: string;
      description: string;
    }
  | {
      kind: "agent";
      key: string;
      agentKey: string;
      label: string;
      description: string;
      updatedAtMs: number;
    }
  | {
      kind: "chat";
      key: string;
      chatId: string;
      agentKey: string;
      label: string;
      agentLabel: string;
      snippet: string;
      updatedAtMs: number;
      source: "local" | "remote";
      score: number;
      hasActiveRun: boolean;
      hasPendingAwaiting: boolean;
    };

export type DesktopGlobalSearchSection = {
  id: DesktopGlobalSearchSectionId;
  title: string;
  rows: DesktopGlobalSearchRow[];
};

export type BuildDesktopGlobalSearchRowsInput = {
  agents: AssistantNavAgentItem[];
  query: string;
  currentAgentKey?: string;
  remoteResults?: AssistantChatSearchResult[];
  t: TranslateFunction;
};

const EMPTY_AGENT_LIMIT = 8;
const EMPTY_CHAT_LIMIT = 12;
const QUERY_AGENT_LIMIT = 10;
const QUERY_CHAT_LIMIT = 30;

export function resolveDesktopGlobalSearchAgentKey(currentRoute: string) {
  const [pathname, search = ""] = currentRoute.split("?", 2);
  const pathMatch = /^\/(?:agent|agents|copilot)\/([^/?#]+)/u.exec(pathname);
  if (pathMatch?.[1]) {
    return decodeURIComponentSafe(pathMatch[1]);
  }
  try {
    return new URLSearchParams(search).get("agentKey")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function buildDesktopGlobalSearchSections(input: BuildDesktopGlobalSearchRowsInput): DesktopGlobalSearchSection[] {
  const query = input.query.trim();
  const normalizedQuery = normalizeSearchText(query);
  const agentByKey = new Map(
    input.agents
      .filter((agent) => agent.agentKey.trim())
      .map((agent) => [agent.agentKey.trim(), agent])
  );
  const actions = createActionRows(input.currentAgentKey?.trim() ?? "", input.t)
    .filter((row) => !normalizedQuery || rowMatches(row, normalizedQuery));
  const agentRows = input.agents
    .map((agent) => createAgentRow(agent))
    .filter((row): row is Extract<DesktopGlobalSearchRow, { kind: "agent" }> => Boolean(row))
    .filter((row) => !normalizedQuery || rowMatches(row, normalizedQuery))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, normalizedQuery ? QUERY_AGENT_LIMIT : EMPTY_AGENT_LIMIT);
  const localChatRows = createLocalChatRows(input.agents, input.t)
    .filter((row) => !normalizedQuery || rowMatches(row, normalizedQuery));
  const chatRows = normalizedQuery
    ? mergeQueryChatRows(localChatRows, input.remoteResults ?? [], agentByKey, input.t)
      .sort(compareQueryChatRows)
      .slice(0, QUERY_CHAT_LIMIT)
    : localChatRows
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .slice(0, EMPTY_CHAT_LIMIT);

  return [
    createSection("actions", input.t("desktop.globalSearch.group.actions"), actions),
    createSection("agents", input.t("desktop.globalSearch.group.agents"), agentRows),
    createSection("chats", input.t("desktop.globalSearch.group.chats"), chatRows)
  ].filter((section): section is DesktopGlobalSearchSection => Boolean(section));
}

function createSection(
  id: DesktopGlobalSearchSectionId,
  title: string,
  rows: DesktopGlobalSearchRow[]
): DesktopGlobalSearchSection | null {
  return rows.length > 0 ? { id, title, rows } : null;
}

function createActionRows(currentAgentKey: string, t: TranslateFunction): DesktopGlobalSearchRow[] {
  const rows: Array<DesktopGlobalSearchRow | null> = [
    currentAgentKey
      ? {
          kind: "action",
          key: "action:newChat",
          actionId: "newChat",
          label: t("desktop.globalSearch.action.newChat"),
          description: t("desktop.globalSearch.action.newChat.description")
        }
      : null,
    {
      kind: "action",
      key: "action:agents",
      actionId: "agents",
      label: t("desktop.globalSearch.action.agents"),
      description: t("desktop.globalSearch.action.agents.description")
    },
    {
      kind: "action",
      key: "action:controlCenter",
      actionId: "controlCenter",
      label: t("desktop.globalSearch.action.controlCenter"),
      description: t("desktop.globalSearch.action.controlCenter.description")
    },
    {
      kind: "action",
      key: "action:settings",
      actionId: "settings",
      label: t("desktop.globalSearch.action.settings"),
      description: t("desktop.globalSearch.action.settings.description")
    }
  ];
  return rows.filter((row): row is DesktopGlobalSearchRow => Boolean(row));
}

function createAgentRow(agent: AssistantNavAgentItem): Extract<DesktopGlobalSearchRow, { kind: "agent" }> | null {
  const agentKey = agent.agentKey.trim();
  if (!agentKey) {
    return null;
  }
  return {
    kind: "agent",
    key: `agent:${agentKey}`,
    agentKey,
    label: agent.displayName || agentKey,
    description: agent.role || agent.latestPreview || agentKey,
    updatedAtMs: readTimestampMs(agent.updatedAt)
  };
}

function createLocalChatRows(
  agents: AssistantNavAgentItem[],
  t: TranslateFunction
): Array<Extract<DesktopGlobalSearchRow, { kind: "chat" }>> {
  const chatById = new Map<string, Extract<DesktopGlobalSearchRow, { kind: "chat" }>>();
  for (const agent of agents) {
    const agentKey = agent.agentKey.trim();
    if (!agentKey) {
      continue;
    }
    for (const chat of agent.recentChats ?? []) {
      const row = createLocalChatRow(chat, {
        agentKey,
        agentLabel: agent.displayName || agentKey,
        t
      });
      if (!row) {
        continue;
      }
      const previous = chatById.get(row.chatId);
      if (!previous || row.updatedAtMs > previous.updatedAtMs) {
        chatById.set(row.chatId, row);
      }
    }
  }
  return [...chatById.values()];
}

function createLocalChatRow(
  chat: AssistantNavChatItem,
  options: { agentKey: string; agentLabel: string; t: TranslateFunction }
): Extract<DesktopGlobalSearchRow, { kind: "chat" }> | null {
  const chatId = chat.chatId.trim();
  if (!chatId || !options.agentKey) {
    return null;
  }
  const label = chat.chatName || options.t("assistant.newChat");
  return {
    kind: "chat",
    key: `chat:${chatId}`,
    chatId,
    agentKey: options.agentKey,
    label,
    agentLabel: options.agentLabel,
    snippet: chat.lastRunContent || label,
    updatedAtMs: readTimestampMs(chat.updatedAt),
    source: "local",
    score: 0,
    hasActiveRun: chat.hasActiveRun,
    hasPendingAwaiting: chat.hasPendingAwaiting
  };
}

function mergeQueryChatRows(
  localRows: Array<Extract<DesktopGlobalSearchRow, { kind: "chat" }>>,
  remoteResults: AssistantChatSearchResult[],
  agentByKey: Map<string, AssistantNavAgentItem>,
  t: TranslateFunction
) {
  const chatById = new Map(localRows.map((row) => [row.chatId, row]));
  for (const result of remoteResults) {
    const chatId = result.chatId?.trim() ?? "";
    const agentKey = result.agentKey?.trim() ?? "";
    if (!chatId || !agentKey) {
      continue;
    }
    const localRow = chatById.get(chatId);
    const agent = agentByKey.get(agentKey);
    const fallbackLabel = localRow?.label || result.chatName || t("assistant.newChat");
    chatById.set(chatId, {
      kind: "chat",
      key: `chat:${chatId}`,
      chatId,
      agentKey,
      label: result.chatName || fallbackLabel,
      agentLabel: agent?.displayName || localRow?.agentLabel || agentKey,
      snippet: result.snippet || localRow?.snippet || fallbackLabel,
      updatedAtMs: readTimestampMs(result.timestamp) || localRow?.updatedAtMs || 0,
      source: "remote",
      score: result.score,
      hasActiveRun: localRow?.hasActiveRun ?? false,
      hasPendingAwaiting: localRow?.hasPendingAwaiting ?? false
    });
  }
  return [...chatById.values()];
}

function compareQueryChatRows(
  left: Extract<DesktopGlobalSearchRow, { kind: "chat" }>,
  right: Extract<DesktopGlobalSearchRow, { kind: "chat" }>
) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.source !== left.source) {
    return right.source === "remote" ? 1 : -1;
  }
  return right.updatedAtMs - left.updatedAtMs;
}

function rowMatches(row: DesktopGlobalSearchRow, normalizedQuery: string) {
  const values = row.kind === "action"
    ? [row.label, row.description]
    : row.kind === "agent"
      ? [row.label, row.description, row.agentKey]
      : [row.label, row.snippet, row.agentLabel, row.agentKey, row.chatId];
  return values.some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function readTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}
