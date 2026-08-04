import { STORAGE_NAMESPACE } from "../../../shared/brand";

const COPILOT_DOCK_SESSION_VERSION = 1;
const COPILOT_DOCK_SESSION_KEY = `${STORAGE_NAMESPACE}.copilot-dock-session`;
const COPILOT_PATH = "/copilot";

export type CopilotDockSessionSnapshot = {
  version: 1;
  openPath: string;
  surfaceId: string;
  embedPath: string;
  agentKey: string;
  chatId?: string;
};

export function normalizeCopilotEmbedPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed, "http://agent-webclient.local");
    if (url.pathname !== COPILOT_PATH && !url.pathname.startsWith(`${COPILOT_PATH}/`)) {
      return "";
    }
    const safeParams = new URLSearchParams();
    const chatId = url.searchParams.get("chatId")?.trim() ?? "";
    if (chatId) {
      safeParams.set("chatId", chatId);
    }
    const query = safeParams.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}

export function readCopilotChatId(value: string) {
  try {
    return new URL(value, "http://agent-webclient.local").searchParams.get("chatId")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function readCopilotDockSessionSnapshot(): CopilotDockSessionSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(COPILOT_DOCK_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<CopilotDockSessionSnapshot>;
    const openPath = typeof value.openPath === "string" ? value.openPath.trim() : "";
    const surfaceId = typeof value.surfaceId === "string" ? value.surfaceId.trim() : "";
    const embedPath = normalizeCopilotEmbedPath(typeof value.embedPath === "string" ? value.embedPath : "");
    const agentKey = typeof value.agentKey === "string" ? value.agentKey.trim() : "";
    const chatId = typeof value.chatId === "string" ? value.chatId.trim() : readCopilotChatId(embedPath);
    if (
      value.version !== COPILOT_DOCK_SESSION_VERSION ||
      !openPath.startsWith("/") ||
      !surfaceId ||
      !embedPath ||
      !agentKey
    ) {
      clearCopilotDockSessionSnapshot();
      return null;
    }
    return {
      version: COPILOT_DOCK_SESSION_VERSION,
      openPath,
      surfaceId,
      embedPath,
      agentKey,
      ...(chatId ? { chatId } : {})
    };
  } catch {
    clearCopilotDockSessionSnapshot();
    return null;
  }
}

export function writeCopilotDockSessionSnapshot(
  input: Omit<CopilotDockSessionSnapshot, "version">
) {
  if (typeof window === "undefined") {
    return;
  }
  const openPath = input.openPath.trim();
  const surfaceId = input.surfaceId.trim();
  const embedPath = normalizeCopilotEmbedPath(input.embedPath);
  const agentKey = input.agentKey.trim();
  const chatId = input.chatId?.trim() || readCopilotChatId(embedPath);
  if (!openPath.startsWith("/") || !surfaceId || !embedPath || !agentKey) {
    return;
  }
  try {
    window.sessionStorage.setItem(COPILOT_DOCK_SESSION_KEY, JSON.stringify({
      version: COPILOT_DOCK_SESSION_VERSION,
      openPath,
      surfaceId,
      embedPath,
      agentKey,
      ...(chatId ? { chatId } : {})
    } satisfies CopilotDockSessionSnapshot));
  } catch {
    // Session restoration is best-effort and must never block the Dock.
  }
}

export function clearCopilotDockSessionSnapshot() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(COPILOT_DOCK_SESSION_KEY);
  } catch {
    // Ignore unavailable session storage.
  }
}

export const __testInternals = {
  COPILOT_DOCK_SESSION_KEY,
  COPILOT_DOCK_SESSION_VERSION
};
