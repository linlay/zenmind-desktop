import { STORAGE_NAMESPACE } from "../../../shared/brand";

const COPILOT_DOCK_SESSION_VERSION = 3;
const COPILOT_DOCK_SESSION_KEY = `${STORAGE_NAMESPACE}.copilot-dock-session`;
const COPILOT_PATH = "/copilot";

export type CopilotDockSurfaceSession = {
  embedPath: string;
  agentKey: string;
  chatId?: string;
};

export type CopilotDockSessionSnapshot = {
  version: 3;
  surfaces: Record<string, CopilotDockSurfaceSession>;
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
    if (
      value.version !== COPILOT_DOCK_SESSION_VERSION ||
      !value.surfaces ||
      typeof value.surfaces !== "object" ||
      Array.isArray(value.surfaces)
    ) {
      clearCopilotDockSessionSnapshot();
      return null;
    }
    const surfaces: Record<string, CopilotDockSurfaceSession> = {};
    for (const [rawSurfaceId, rawSession] of Object.entries(value.surfaces)) {
      const surfaceId = normalizeCopilotSurfaceId(rawSurfaceId);
      if (!surfaceId || !rawSession || typeof rawSession !== "object" || Array.isArray(rawSession)) {
        continue;
      }
      const candidate = rawSession as Partial<CopilotDockSurfaceSession>;
      const embedPath = normalizeCopilotEmbedPath(typeof candidate.embedPath === "string" ? candidate.embedPath : "");
      const agentKey = typeof candidate.agentKey === "string" ? candidate.agentKey.trim() : "";
      const chatId = typeof candidate.chatId === "string"
        ? candidate.chatId.trim()
        : readCopilotChatId(embedPath);
      if (!embedPath || !agentKey) {
        continue;
      }
      surfaces[surfaceId] = {
        embedPath,
        agentKey,
        ...(chatId ? { chatId } : {})
      };
    }
    if (Object.keys(surfaces).length === 0) {
      clearCopilotDockSessionSnapshot();
      return null;
    }
    return {
      version: COPILOT_DOCK_SESSION_VERSION,
      surfaces
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
  const surfaces: Record<string, CopilotDockSurfaceSession> = {};
  for (const [rawSurfaceId, rawSession] of Object.entries(input.surfaces)) {
    const surfaceId = normalizeCopilotSurfaceId(rawSurfaceId);
    const embedPath = normalizeCopilotEmbedPath(rawSession.embedPath);
    const agentKey = rawSession.agentKey.trim();
    const chatId = rawSession.chatId?.trim() || readCopilotChatId(embedPath);
    if (!surfaceId || !embedPath || !agentKey) {
      continue;
    }
    surfaces[surfaceId] = {
      embedPath,
      agentKey,
      ...(chatId ? { chatId } : {})
    };
  }
  if (Object.keys(surfaces).length === 0) {
    clearCopilotDockSessionSnapshot();
    return;
  }
  try {
    window.sessionStorage.setItem(COPILOT_DOCK_SESSION_KEY, JSON.stringify({
      version: COPILOT_DOCK_SESSION_VERSION,
      surfaces
    } satisfies CopilotDockSessionSnapshot));
  } catch {
    // Session restoration is best-effort and must never block the Dock.
  }
}

function normalizeCopilotSurfaceId(value: string) {
  const surfaceId = value.trim();
  if (
    !surfaceId ||
    surfaceId.length > 512 ||
    surfaceId === "__proto__" ||
    surfaceId === "prototype" ||
    surfaceId === "constructor"
  ) {
    return "";
  }
  return surfaceId;
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
