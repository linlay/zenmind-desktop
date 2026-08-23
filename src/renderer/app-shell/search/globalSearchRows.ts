import type {
  AssistantChatSearchResult,
  AssistantNavAgentItem,
  AssistantNavChatItem,
  DesktopGlobalSearchActionShortcutId
} from "../../../shared/contracts";
import type { EpochMilliseconds } from "../../../shared/time-contract";
import type { TranslateFunction } from "../../../shared/i18n";
import { decodeRoutePathSegment } from "../../../shared/route-path";

export type DesktopGlobalSearchActionId = DesktopGlobalSearchActionShortcutId | "settings";
export type DesktopGlobalSearchSectionId = "awaiting" | "unread" | "actions" | "agents" | "chats";
export type DesktopGlobalSearchProjectAgentKind = "coder" | "kbase";

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
      description?: string;
      projectKind?: DesktopGlobalSearchProjectAgentKind;
      updatedAtMs?: EpochMilliseconds;
    }
  | {
      kind: "chat";
      key: string;
      chatId: string;
      agentKey: string;
      label: string;
      agentLabel: string;
      snippet: string;
      updatedAtMs: EpochMilliseconds;
      source: "local" | "remote";
      score: number;
      hasActiveRun: boolean;
      hasPendingAwaiting: boolean;
      awaitingMode?: AssistantNavChatItem["awaitingMode"];
      isUnread: boolean;
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

export type DesktopGlobalSearchShortcutTargets = {
  attention: Array<Extract<DesktopGlobalSearchRow, { kind: "chat" }>>;
  agents: Array<Extract<DesktopGlobalSearchRow, { kind: "agent" }>>;
};

const EMPTY_AGENT_LIMIT = 10;
const EMPTY_CHAT_LIMIT = 12;
const EMPTY_ATTENTION_LIMIT = 10;
const QUERY_AGENT_LIMIT = 10;
const QUERY_CHAT_LIMIT = 30;

export function resolveDesktopGlobalSearchAgentKey(currentRoute: string) {
  const [pathname, search = ""] = currentRoute.split("?", 2);
  const pathMatch = /^\/(?:agent|agents|copilot)\/([^/?#]+)/u.exec(pathname);
  if (pathMatch?.[1]) {
    return decodeRoutePathSegment(pathMatch[1]) ?? "";
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
    .sort(compareAgentRows)
    .slice(0, normalizedQuery ? QUERY_AGENT_LIMIT : EMPTY_AGENT_LIMIT);
  const allLocalChatRows = createLocalChatRows(input.agents, input.t);
  const localChatRows = allLocalChatRows
    .filter((row) => !normalizedQuery || rowMatches(row, normalizedQuery));
  const chatRows = normalizedQuery
    ? mergeQueryChatRows(localChatRows, input.remoteResults ?? [], agentByKey, allLocalChatRows, input.t)
      .sort(compareQueryChatRows)
      .slice(0, QUERY_CHAT_LIMIT)
    : [];

  if (normalizedQuery) {
    return [
      createSection("actions", input.t("desktop.globalSearch.group.actions"), actions),
      createSection("agents", input.t("desktop.globalSearch.group.agents"), agentRows),
      createSection("chats", input.t("desktop.globalSearch.group.chats"), chatRows)
    ].filter((section): section is DesktopGlobalSearchSection => Boolean(section));
  }

  const attentionChatIds = new Set<string>();
  const awaitingRows = allLocalChatRows
    .filter((row) => row.hasPendingAwaiting)
    .sort(compareAttentionChatRows)
    .slice(0, EMPTY_ATTENTION_LIMIT);
  for (const row of awaitingRows) {
    attentionChatIds.add(row.chatId);
  }
  const unreadRows = allLocalChatRows
    .filter((row) => row.isUnread && !attentionChatIds.has(row.chatId))
    .sort(compareAttentionChatRows)
    .slice(0, EMPTY_ATTENTION_LIMIT);
  for (const row of unreadRows) {
    attentionChatIds.add(row.chatId);
  }
  const recentChatRows = allLocalChatRows
    .filter((row) => !attentionChatIds.has(row.chatId))
    .sort(compareAttentionChatRows)
    .slice(0, EMPTY_CHAT_LIMIT);

  return [
    createSection("awaiting", input.t("desktop.globalSearch.group.awaiting"), awaitingRows),
    createSection("unread", input.t("desktop.globalSearch.group.unread"), unreadRows),
    createSection("actions", input.t("desktop.globalSearch.group.actions"), actions),
    createSection("agents", input.t("desktop.globalSearch.group.agents"), agentRows),
    createSection("chats", input.t("desktop.globalSearch.group.chats"), recentChatRows)
  ].filter((section): section is DesktopGlobalSearchSection => Boolean(section));
}

export function buildDesktopGlobalSearchShortcutTargets(
  agents: AssistantNavAgentItem[],
  t: TranslateFunction
): DesktopGlobalSearchShortcutTargets {
  const sections = buildDesktopGlobalSearchSections({
    agents,
    query: "",
    t
  });
  const rowsForSection = (sectionId: DesktopGlobalSearchSectionId) =>
    sections.find((section) => section.id === sectionId)?.rows ?? [];
  return {
    attention: [...rowsForSection("awaiting"), ...rowsForSection("unread")]
      .filter((row): row is Extract<DesktopGlobalSearchRow, { kind: "chat" }> => row.kind === "chat")
      .slice(0, 10),
    agents: rowsForSection("agents")
      .filter((row): row is Extract<DesktopGlobalSearchRow, { kind: "agent" }> => row.kind === "agent")
      .slice(0, 10)
  };
}

function createSection(
  id: DesktopGlobalSearchSectionId,
  title: string,
  rows: DesktopGlobalSearchRow[]
): DesktopGlobalSearchSection | null {
  return rows.length > 0 ? { id, title, rows } : null;
}

function createActionRows(_currentAgentKey: string, t: TranslateFunction): DesktopGlobalSearchRow[] {
  const rows: DesktopGlobalSearchRow[] = [
    {
      kind: "action",
      key: "action:newChat",
      actionId: "newChat",
      label: t("desktop.globalSearch.action.newChat"),
      description: t("desktop.globalSearch.action.newChat.description")
    },
    {
      kind: "action",
      key: "action:history",
      actionId: "history",
      label: t("desktop.globalSearch.action.history"),
      description: t("desktop.globalSearch.action.history.description")
    },
    {
      kind: "action",
      key: "action:agents",
      actionId: "agents",
      label: t("desktop.globalSearch.action.agents"),
      description: t("desktop.globalSearch.action.agents.description")
    },
    {
      kind: "action",
      key: "action:skills",
      actionId: "skills",
      label: t("desktop.globalSearch.action.skills"),
      description: t("desktop.globalSearch.action.skills.description")
    },
    {
      kind: "action",
      key: "action:mcpConnectors",
      actionId: "mcpConnectors",
      label: t("desktop.globalSearch.action.mcpConnectors"),
      description: t("desktop.globalSearch.action.mcpConnectors.description")
    },
    {
      kind: "action",
      key: "action:settings",
      actionId: "settings",
      label: t("desktop.globalSearch.action.settings"),
      description: t("desktop.globalSearch.action.settings.description")
    }
  ];
  return rows;
}

function createAgentRow(agent: AssistantNavAgentItem): Extract<DesktopGlobalSearchRow, { kind: "agent" }> | null {
  const agentKey = agent.agentKey.trim();
  if (!agentKey) {
    return null;
  }
  const projectKind = getProjectAgentKind(agent.mode);
  return {
    kind: "agent",
    key: `agent:${agentKey}`,
    agentKey,
    label: agent.displayName || agentKey,
    ...(projectKind
      ? { projectKind }
      : { description: agent.role || agent.latestPreview || agentKey }),
    ...(agent.updatedAt !== undefined && agent.updatedAt !== null
      ? { updatedAtMs: agent.updatedAt }
      : {})
  };
}

function getProjectAgentKind(mode?: string): DesktopGlobalSearchProjectAgentKind | undefined {
  switch (mode?.trim().toUpperCase()) {
    case "CODER":
      return "coder";
    case "KBASE":
      return "kbase";
    default:
      return undefined;
  }
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
  const updatedAtMs = chat.updatedAt;
  return {
    kind: "chat",
    key: `chat:${chatId}`,
    chatId,
    agentKey: options.agentKey,
    label,
    agentLabel: options.agentLabel,
    snippet: chat.lastRunContent || label,
    updatedAtMs,
    source: "local",
    score: 0,
    hasActiveRun: chat.hasActiveRun,
    hasPendingAwaiting: chat.hasPendingAwaiting,
    awaitingMode: chat.awaitingMode,
    isUnread: chat.isRead === false
  };
}

function mergeQueryChatRows(
  localRows: Array<Extract<DesktopGlobalSearchRow, { kind: "chat" }>>,
  remoteResults: AssistantChatSearchResult[],
  agentByKey: Map<string, AssistantNavAgentItem>,
  allLocalRows: Array<Extract<DesktopGlobalSearchRow, { kind: "chat" }>>,
  t: TranslateFunction
) {
  const chatById = new Map(localRows.map((row) => [row.chatId, row]));
  const localById = new Map(allLocalRows.map((row) => [row.chatId, row]));
  for (const result of remoteResults) {
    const chatId = result.chatId?.trim() ?? "";
    const agentKey = result.agentKey?.trim() ?? "";
    if (!chatId || !agentKey) {
      continue;
    }
    const localRow = localById.get(chatId) ?? chatById.get(chatId);
    const agent = agentByKey.get(agentKey);
    const updatedAtMs = result.timestamp;
    const fallbackLabel = localRow?.label || result.chatName || t("assistant.newChat");
    chatById.set(chatId, {
      kind: "chat",
      key: `chat:${chatId}`,
      chatId,
      agentKey,
      label: result.chatName || fallbackLabel,
      agentLabel: agent?.displayName || localRow?.agentLabel || agentKey,
      snippet: result.snippet || localRow?.snippet || fallbackLabel,
      updatedAtMs,
      source: "remote",
      score: result.score,
      hasActiveRun: localRow?.hasActiveRun ?? false,
      hasPendingAwaiting: localRow?.hasPendingAwaiting ?? false,
      awaitingMode: localRow?.awaitingMode,
      isUnread: localRow?.isUnread ?? false
    });
  }
  return [...chatById.values()];
}

function compareAttentionChatRows(
  left: Extract<DesktopGlobalSearchRow, { kind: "chat" }>,
  right: Extract<DesktopGlobalSearchRow, { kind: "chat" }>
) {
  if (right.updatedAtMs !== left.updatedAtMs) {
    return right.updatedAtMs - left.updatedAtMs;
  }
  return left.chatId.localeCompare(right.chatId);
}

function compareAgentRows(
  left: Extract<DesktopGlobalSearchRow, { kind: "agent" }>,
  right: Extract<DesktopGlobalSearchRow, { kind: "agent" }>,
) {
  if (right.updatedAtMs !== undefined && left.updatedAtMs !== undefined && right.updatedAtMs !== left.updatedAtMs) {
    return right.updatedAtMs - left.updatedAtMs;
  }
  if (left.updatedAtMs === undefined && right.updatedAtMs !== undefined) {
    return 1;
  }
  if (left.updatedAtMs !== undefined && right.updatedAtMs === undefined) {
    return -1;
  }
  return left.agentKey.localeCompare(right.agentKey);
}

function compareQueryChatRows(
  left: Extract<DesktopGlobalSearchRow, { kind: "chat" }>,
  right: Extract<DesktopGlobalSearchRow, { kind: "chat" }>
) {
  const leftPriority = getQueryChatPriority(left);
  const rightPriority = getQueryChatPriority(right);
  if (rightPriority !== leftPriority) {
    return rightPriority - leftPriority;
  }
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.source !== left.source) {
    return right.source === "remote" ? 1 : -1;
  }
  return right.updatedAtMs - left.updatedAtMs;
}

function getQueryChatPriority(row: Extract<DesktopGlobalSearchRow, { kind: "chat" }>) {
  if (row.hasPendingAwaiting) {
    return 3;
  }
  if (row.isUnread) {
    return 2;
  }
  if (row.hasActiveRun) {
    return 1;
  }
  return 0;
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
