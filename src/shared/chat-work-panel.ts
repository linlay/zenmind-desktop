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
