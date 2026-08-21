import type { AssistantChatInfo } from "./contracts/copilot";
import type { TranslateFunction } from "./i18n/types";

export type ChatInfoSummary = {
  chatId: string;
  chatName: string;
  agentKey: string;
};

export type ChatInfoRow = {
  key: string;
  label: string;
  displayValue: string;
  copyValue: string;
};

function createChatInfoRow(
  key: string,
  label: string,
  value: unknown,
  options: { displayValue?: string; copyValue?: string } = {},
): ChatInfoRow | null {
  const copyValue = options.copyValue ?? String(value ?? "");
  if (!copyValue.trim()) return null;
  return {
    key,
    label,
    displayValue: options.displayValue ?? copyValue,
    copyValue,
  };
}

function formatTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildChatInfoRows(input: {
  summary: ChatInfoSummary;
  detail: AssistantChatInfo | null;
  t: TranslateFunction;
}): ChatInfoRow[] {
  const { summary, detail, t } = input;
  const createdAt = detail?.createdAt;
  const updatedAt = detail?.updatedAt;
  return [
    createChatInfoRow("chatId", t("sidebar.chat.infoField.chatId"), detail?.chatId || summary.chatId),
    createChatInfoRow("chatName", t("sidebar.chat.infoField.chatName"), detail?.chatName || summary.chatName),
    createChatInfoRow("agentKey", t("sidebar.chat.infoField.agentKey"), detail?.agentKey || summary.agentKey),
    createChatInfoRow("firstAgentKey", t("sidebar.chat.infoField.firstAgentKey"), detail?.firstAgentKey),
    createChatInfoRow("firstAgentName", t("sidebar.chat.infoField.firstAgentName"), detail?.firstAgentName),
    createChatInfoRow("teamId", t("sidebar.chat.infoField.teamId"), detail?.teamId),
    createChatInfoRow("source", t("sidebar.chat.infoField.source"), detail?.source),
    createChatInfoRow("createdAt", t("sidebar.chat.infoField.createdAt"), createdAt, {
      displayValue: formatTimestamp(createdAt),
      copyValue: createdAt === undefined ? undefined : String(createdAt),
    }),
    createChatInfoRow("updatedAt", t("sidebar.chat.infoField.updatedAt"), updatedAt, {
      displayValue: formatTimestamp(updatedAt),
      copyValue: updatedAt === undefined ? undefined : String(updatedAt),
    }),
    createChatInfoRow("lastRunId", t("sidebar.chat.infoField.lastRunId"), detail?.lastRunId),
    createChatInfoRow("lastRunContent", t("sidebar.chat.infoField.lastRunContent"), detail?.lastRunContent),
  ].filter((row): row is ChatInfoRow => Boolean(row));
}

export function buildChatInfoCopyAllText(rows: ChatInfoRow[]) {
  return rows.map((row) => `${row.label}: ${row.copyValue}`).join("\n");
}
