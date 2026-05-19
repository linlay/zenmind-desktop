import fs from "node:fs";
import path from "node:path";
import type { App, Rectangle } from "electron";
import type {
  DesktopPetAgentOption,
  DesktopPetAgentPresence,
  DesktopPetPreviewPanel,
  DesktopPetSettings,
  DesktopPetState,
  DesktopPetStatus
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey
} from "../../../shared/desktop-pet";
import { getDesktopPetSettingsPath as resolveDesktopPetSettingsPath } from "../../user-paths";
export {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS
} from "../../../shared/desktop-pet";

export const DESKTOP_PET_WINDOW_SIZE = {
  width: 176,
  height: 198
} as const;

export type DesktopPetWindowMode = "base" | "bubble" | "preview-collapsed" | "preview-expanded";

export const DESKTOP_PET_WINDOW_SIZES: Record<DesktopPetWindowMode, { width: number; height: number }> = {
  base: DESKTOP_PET_WINDOW_SIZE,
  bubble: {
    width: 224,
    height: 228
  },
  "preview-collapsed": {
    width: 380,
    height: 276
  },
  "preview-expanded": {
    width: 420,
    height: 412
  }
} as const;

type Platform = NodeJS.Platform | string;

type DesktopPetStoredState = {
  enabled: boolean;
  lastVisible: boolean;
  unreadCount: number;
  boundAgentKey: string;
  appearanceId: string;
  position?: {
    x: number;
    y: number;
  };
};

export type DesktopPetLocalStatus = {
  status: DesktopPetStatus;
  hint: string;
  unreadCount: number;
  chatId: string | null;
};

export type DesktopPetBoundAgentStatus = {
  agentKey: string;
  displayName: string;
  role: string;
  presence: DesktopPetAgentPresence;
  unreadCount: number;
  latestPreview: string;
  chatId: string | null;
  hasPendingAwaiting: boolean;
  stale: boolean;
  updatedAt: string;
};

type DisplayArea = Pick<Rectangle, "x" | "y" | "width" | "height">;
export type DesktopPetContextMenuAction = "dance" | "hide";

export type DesktopPetContextMenuItem = {
  action: DesktopPetContextMenuAction;
  label: string;
};

const DEFAULT_OFFSET = {
  x: 20,
  y: 78
} as const;
const DESKTOP_PET_MESSAGE_PREVIEW_MAX_LENGTH = 30;
const DESKTOP_PET_DONE_FALLBACK_HINT = "暂无回复预览";
const DESKTOP_PET_STATUS_HINTS = new Set(["思考中", "已完成", "回复已生成", "出错了", "目标智能体未在线", "打开对话查看完整回复", DESKTOP_PET_DONE_FALLBACK_HINT]);

function getDesktopPetRoot(app: App) {
  return path.dirname(getDesktopPetSettingsPath(app));
}

function getDesktopPetSettingsPath(app: App) {
  return resolveDesktopPetSettingsPath(app);
}

function ensureDesktopPetRoot(app: App) {
  fs.mkdirSync(getDesktopPetRoot(app), { recursive: true });
}

export function sanitizeDesktopPetBoundAgentKey(value: unknown) {
  return normalizeDesktopPetBoundAgentKey(value);
}

export function sanitizeDesktopPetAppearanceId(value: unknown) {
  return normalizeDesktopPetAppearanceId(value);
}

export function getDesktopPetContextMenuItems(appearanceId: unknown): DesktopPetContextMenuItem[] {
  const normalizedAppearanceId = sanitizeDesktopPetAppearanceId(appearanceId);
  return [
    ...(normalizedAppearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
      ? [{
          action: "dance" as const,
          label: "跳舞"
        }]
      : []),
    {
      action: "hide",
      label: "关闭宠物"
    }
  ];
}

function sanitizeDesktopPetUnreadCount(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function sanitizeDesktopPetMessagePreview(value: unknown) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return "";
  }
  if (DESKTOP_PET_STATUS_HINTS.has(normalized)) {
    return "";
  }
  if (normalized.length > DESKTOP_PET_MESSAGE_PREVIEW_MAX_LENGTH) {
    return `${normalized.slice(0, Math.max(0, DESKTOP_PET_MESSAGE_PREVIEW_MAX_LENGTH - 3)).trimEnd()}...`;
  }
  return normalized;
}

function isGenericDesktopPetDoneHint(value: unknown) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return !normalized || DESKTOP_PET_STATUS_HINTS.has(normalized);
}

function sanitizeDesktopPetStoredState(value: unknown, supported: boolean): DesktopPetStoredState {
  const candidate = typeof value === "object" && value !== null
    ? value as Partial<DesktopPetStoredState>
    : {};
  const position = candidate.position && Number.isFinite(candidate.position.x) && Number.isFinite(candidate.position.y)
    ? {
        x: Math.round(candidate.position.x),
        y: Math.round(candidate.position.y)
      }
    : undefined;
  return {
    enabled: supported ? candidate.enabled !== false : false,
    lastVisible: supported ? candidate.lastVisible !== false : false,
    unreadCount: sanitizeDesktopPetUnreadCount(candidate.unreadCount),
    boundAgentKey: sanitizeDesktopPetBoundAgentKey(candidate.boundAgentKey),
    appearanceId: sanitizeDesktopPetAppearanceId(candidate.appearanceId),
    ...(position ? { position } : {})
  };
}

export function isDesktopPetSupportedPlatform(platform: Platform) {
  return platform === "darwin" || platform === "win32";
}

export function readDesktopPetStoredState(app: App, platform: Platform = process.platform) {
  const supported = isDesktopPetSupportedPlatform(platform);
  if (!supported) {
    return sanitizeDesktopPetStoredState(null, supported);
  }

  ensureDesktopPetRoot(app);
  try {
    const raw = fs.readFileSync(getDesktopPetSettingsPath(app), "utf8");
    return sanitizeDesktopPetStoredState(JSON.parse(raw), supported);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).name === "SyntaxError") {
      return sanitizeDesktopPetStoredState(null, supported);
    }
    throw error;
  }
}

export function writeDesktopPetStoredState(
  app: App,
  nextState: DesktopPetStoredState,
  platform: Platform = process.platform
) {
  const supported = isDesktopPetSupportedPlatform(platform);
  const sanitized = sanitizeDesktopPetStoredState(nextState, supported);
  if (!supported) {
    return sanitized;
  }

  ensureDesktopPetRoot(app);
  fs.writeFileSync(getDesktopPetSettingsPath(app), `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return sanitized;
}

export function saveDesktopPetSettings(
  app: App,
  input: Partial<DesktopPetStoredState>,
  platform: Platform = process.platform
) {
  const current = readDesktopPetStoredState(app, platform);
  return writeDesktopPetStoredState(app, {
    ...current,
    ...input,
    ...(input.position ? { position: input.position } : {})
  }, platform);
}

export function toDesktopPetSettings(stored: DesktopPetStoredState): DesktopPetSettings {
  return {
    enabled: stored.enabled,
    boundAgentKey: stored.boundAgentKey,
    appearanceId: stored.appearanceId
  };
}

export function createDefaultDesktopPetLocalStatus(settings?: { unreadCount?: unknown }): DesktopPetLocalStatus {
  return {
    status: "idle",
    hint: "",
    unreadCount: sanitizeDesktopPetUnreadCount(settings?.unreadCount),
    chatId: null
  };
}

export function createDefaultDesktopPetAgentStatus(boundAgentKey: string): Pick<
  DesktopPetBoundAgentStatus,
  "agentKey" | "displayName" | "role" | "presence" | "stale"
> {
  return {
    agentKey: sanitizeDesktopPetBoundAgentKey(boundAgentKey),
    displayName: "",
    role: "",
    presence: "offline",
    stale: true
  };
}

function getAgentStatusHint(agentStatus: DesktopPetBoundAgentStatus | null) {
  if (!agentStatus || agentStatus.stale) {
    return "";
  }
  if (agentStatus.hasPendingAwaiting || agentStatus.presence === "busy") {
    return "思考中";
  }
  if (agentStatus.presence === "away") {
    return sanitizeDesktopPetMessagePreview(agentStatus.latestPreview) || DESKTOP_PET_DONE_FALLBACK_HINT;
  }
  return "";
}

function normalizeLocalDesktopPetStatus(
  localStatus: DesktopPetLocalStatus
): Pick<DesktopPetState, "status" | "hint" | "messagePreview" | "unreadCount" | "chatId"> {
  if (localStatus.status === "done") {
    return {
      status: "done",
      hint: localStatus.hint.trim() || DESKTOP_PET_DONE_FALLBACK_HINT,
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "error") {
    return {
      status: "error",
      hint: localStatus.hint.trim() || "出错了",
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "running" || localStatus.status === "awaiting") {
    return {
      status: "running",
      hint: "思考中",
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  return {
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
    chatId: localStatus.chatId
  };
}

function resolveMergedDesktopPetStatus(
  localStatus: DesktopPetLocalStatus,
  agentStatus: DesktopPetBoundAgentStatus | null
): Pick<DesktopPetState, "status" | "hint" | "messagePreview" | "unreadCount" | "chatId"> {
  if (
    localStatus.status === "done" &&
    agentStatus &&
    !agentStatus.stale &&
    agentStatus.presence === "away" &&
    (!localStatus.chatId || !agentStatus.chatId || localStatus.chatId === agentStatus.chatId)
  ) {
    const agentReplyPreview = sanitizeDesktopPetMessagePreview(agentStatus.latestPreview);
    if (agentReplyPreview && isGenericDesktopPetDoneHint(localStatus.hint)) {
      return {
        status: "done",
        hint: agentReplyPreview,
        messagePreview: "",
        unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
        chatId: agentStatus.chatId || localStatus.chatId
      };
    }
  }

  if (localStatus.status !== "idle") {
    return normalizeLocalDesktopPetStatus(localStatus);
  }

  if (agentStatus && !agentStatus.stale) {
    const hint = getAgentStatusHint(agentStatus);
    const unreadCount = sanitizeDesktopPetUnreadCount(agentStatus.unreadCount);
    const status = agentStatus.presence === "away"
      ? "done"
      : agentStatus.hasPendingAwaiting || agentStatus.presence === "busy"
        ? "running"
        : "idle";
    return {
      status,
      hint,
      messagePreview: status === "idle" && unreadCount > 0
        ? sanitizeDesktopPetMessagePreview(agentStatus.latestPreview)
        : "",
      unreadCount,
      chatId: agentStatus.chatId
    };
  }

  return {
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: 0,
    chatId: null
  };
}

export function createDesktopPetState(
  settings: DesktopPetStoredState,
  options: {
    supported?: boolean;
    visible?: boolean;
    localStatus?: DesktopPetLocalStatus;
    agentStatus?: DesktopPetBoundAgentStatus | null;
    agentOptions?: DesktopPetAgentOption[];
    previewPanel?: DesktopPetPreviewPanel | null;
  } = {}
): DesktopPetState {
  const localStatus = options.localStatus ?? createDefaultDesktopPetLocalStatus(settings);
  const agentStatus = options.agentStatus ?? null;
  const mergedStatus = resolveMergedDesktopPetStatus(localStatus, agentStatus);
  const appearanceId = sanitizeDesktopPetAppearanceId(settings.appearanceId);
  const agentUnreadCount = agentStatus && !agentStatus.stale
    ? sanitizeDesktopPetUnreadCount(agentStatus.unreadCount)
    : 0;
  const agentDefaults = createDefaultDesktopPetAgentStatus(settings.boundAgentKey);
  return {
    supported: options.supported ?? isDesktopPetSupportedPlatform(process.platform),
    enabled: settings.enabled,
    visible: Boolean(options.visible),
    ...mergedStatus,
    unreadCount: Math.max(mergedStatus.unreadCount, agentUnreadCount),
    appearanceId,
    appearanceOptions: [...DESKTOP_PET_APPEARANCE_OPTIONS],
    boundAgentKey: settings.boundAgentKey,
    agentDisplayName: agentStatus?.displayName ?? agentDefaults.displayName,
    agentRole: agentStatus?.role ?? agentDefaults.role,
    agentPresence: agentStatus?.presence ?? agentDefaults.presence,
    agentStatusStale: agentStatus?.stale ?? agentDefaults.stale,
    agentOptions: options.agentOptions ?? [],
    previewPanel: options.previewPanel ?? null,
    updatedAt: new Date().toISOString()
  };
}

export function getDesktopPetWindowSize(mode: DesktopPetWindowMode = "base") {
  return DESKTOP_PET_WINDOW_SIZES[mode] ?? DESKTOP_PET_WINDOW_SIZES.base;
}

export function clampDesktopPetPosition(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  size: { width: number; height: number } = DESKTOP_PET_WINDOW_SIZE
) {
  const width = size.width;
  const height = size.height;
  const minX = displayArea.x;
  const minY = displayArea.y;
  const maxX = displayArea.x + Math.max(0, displayArea.width - width);
  const maxY = displayArea.y + Math.max(0, displayArea.height - height);
  const fallbackX = Math.min(maxX, displayArea.x + DEFAULT_OFFSET.x);
  const fallbackY = Math.min(maxY, displayArea.y + DEFAULT_OFFSET.y);
  const resolved = position ?? { x: fallbackX, y: fallbackY };
  return {
    x: Math.max(minX, Math.min(maxX, Math.round(resolved.x))),
    y: Math.max(minY, Math.min(maxY, Math.round(resolved.y))),
    width,
    height
  };
}

export function getAnchoredDesktopPetBounds(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  mode: DesktopPetWindowMode = "base"
) {
  const size = getDesktopPetWindowSize(mode);
  const baseBounds = clampDesktopPetPosition(position, displayArea, DESKTOP_PET_WINDOW_SIZE);
  if (mode === "base") {
    return baseBounds;
  }
  return clampDesktopPetPosition({
    x: baseBounds.x + DESKTOP_PET_WINDOW_SIZE.width - size.width,
    y: baseBounds.y + DESKTOP_PET_WINDOW_SIZE.height - size.height
  }, displayArea, size);
}

export function getDesktopPetLogicalPositionFromBounds(
  bounds: { x: number; y: number },
  mode: DesktopPetWindowMode = "base"
) {
  const size = getDesktopPetWindowSize(mode);
  return {
    x: Math.round(bounds.x + size.width - DESKTOP_PET_WINDOW_SIZE.width),
    y: Math.round(bounds.y + size.height - DESKTOP_PET_WINDOW_SIZE.height)
  };
}

export const __testInternals = {
  DEFAULT_OFFSET,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_WINDOW_SIZES,
  sanitizeDesktopPetStoredState,
  sanitizeDesktopPetAppearanceId,
  sanitizeDesktopPetMessagePreview,
  sanitizeDesktopPetUnreadCount,
  resolveMergedDesktopPetStatus,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetRoot
};
