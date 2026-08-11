export const CHAT_WORK_PANEL_BLANK_URL = "about:blank";

export type ChatWorkPanelWorkspace = {
  chatId: string;
  surfaceId: string;
  generation: string;
  partition: string;
  initialUrl: string;
  initialTitle?: string;
};

export type ChatWorkPanelClearSessionRequest = {
  partition: string;
};

function stableHash(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

export function createChatWorkPanelSurfaceId(chatId: string) {
  return `chat-work-panel:${stableHash(chatId.trim())}`;
}

export function normalizeChatWorkPanelUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === CHAT_WORK_PANEL_BLANK_URL) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}
