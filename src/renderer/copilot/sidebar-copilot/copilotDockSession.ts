import { STORAGE_NAMESPACE } from "../../../shared/brand";

const COPILOT_DOCK_SESSION_VERSION = 5;
const COPILOT_DOCK_SESSION_KEY = `${STORAGE_NAMESPACE}.copilot-dock-session`;
const COPILOT_PATH = "/copilot";
const FORBIDDEN_KANBAN_CONTEXT = "desktop-route:/kanban";

export type CopilotDockContextSession = {
  embedPath: string;
  agentKey: string;
  chatId?: string;
};

export type CopilotDockSessionSnapshot = {
  version: 5;
  contexts: Record<string, CopilotDockContextSession>;
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
    const value = JSON.parse(raw) as {
      version?: unknown;
      contexts?: unknown;
      surfaces?: unknown;
    };
    const rawContexts = value.version === COPILOT_DOCK_SESSION_VERSION || value.version === 4
      ? value.contexts
      : value.version === 3
        ? value.surfaces
        : null;
    if (!rawContexts || typeof rawContexts !== "object" || Array.isArray(rawContexts)) {
      clearCopilotDockSessionSnapshot();
      return null;
    }
    const contexts: Record<string, CopilotDockContextSession> = {};
    for (const [rawContextKey, rawSession] of Object.entries(rawContexts)) {
      const contextKey = normalizeCopilotContextKey(rawContextKey);
      if (!contextKey || !rawSession || typeof rawSession !== "object" || Array.isArray(rawSession)) {
        continue;
      }
      const candidate = rawSession as Partial<CopilotDockContextSession>;
      const embedPath = normalizeCopilotEmbedPath(typeof candidate.embedPath === "string" ? candidate.embedPath : "");
      const agentKey = typeof candidate.agentKey === "string" ? candidate.agentKey.trim() : "";
      const chatId = typeof candidate.chatId === "string"
        ? candidate.chatId.trim()
        : readCopilotChatId(embedPath);
      if (!embedPath || !agentKey) {
        continue;
      }
      contexts[contextKey] = {
        embedPath,
        agentKey,
        ...(chatId ? { chatId } : {})
      };
    }
    if (Object.keys(contexts).length === 0) {
      clearCopilotDockSessionSnapshot();
      return null;
    }
    const snapshot: CopilotDockSessionSnapshot = {
      version: COPILOT_DOCK_SESSION_VERSION,
      contexts
    };
    if (value.version !== COPILOT_DOCK_SESSION_VERSION) {
      window.sessionStorage.setItem(COPILOT_DOCK_SESSION_KEY, JSON.stringify(snapshot));
    }
    return snapshot;
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
  const contexts: Record<string, CopilotDockContextSession> = {};
  for (const [rawContextKey, rawSession] of Object.entries(input.contexts)) {
    const contextKey = normalizeCopilotContextKey(rawContextKey);
    const embedPath = normalizeCopilotEmbedPath(rawSession.embedPath);
    const agentKey = rawSession.agentKey.trim();
    const chatId = rawSession.chatId?.trim() || readCopilotChatId(embedPath);
    if (!contextKey || !embedPath || !agentKey) {
      continue;
    }
    contexts[contextKey] = {
      embedPath,
      agentKey,
      ...(chatId ? { chatId } : {})
    };
  }
  if (Object.keys(contexts).length === 0) {
    clearCopilotDockSessionSnapshot();
    return;
  }
  try {
    window.sessionStorage.setItem(COPILOT_DOCK_SESSION_KEY, JSON.stringify({
      version: COPILOT_DOCK_SESSION_VERSION,
      contexts
    } satisfies CopilotDockSessionSnapshot));
  } catch {
    // Session restoration is best-effort and must never block the Dock.
  }
}

function normalizeCopilotContextKey(value: string) {
  const contextKey = value.trim();
  if (
    !contextKey ||
    contextKey.length > 512 ||
    contextKey === "__proto__" ||
    contextKey === "prototype" ||
    contextKey === "constructor" ||
    contextKey === FORBIDDEN_KANBAN_CONTEXT
  ) {
    return "";
  }
  return contextKey;
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
