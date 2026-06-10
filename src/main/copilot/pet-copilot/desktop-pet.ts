import fs from "node:fs";
import path from "node:path";
import type { App, Rectangle } from "electron";
import type {
  DesktopPetTaskItem,
  DesktopPetAgentOption,
  DesktopPetAgentPresence,
  DesktopPetEdgeDock,
  DesktopPetPreviewPanel,
  DesktopPetSettings,
  DesktopPetState,
  DesktopPetStatus
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_RUNNING_TASK_ANIMATION_MIN_MS,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  applyDesktopPetActiveRunEvent,
  getDesktopPetRunningTaskAnimationDurationMs,
  isDesktopPetDanceAppearance,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey,
  resolveDesktopPetRunningTaskCount,
  sanitizeDesktopPetRunningTaskCount,
  shouldUseDesktopPetTaskRunningAnimation
} from "../../../shared/desktop-pet";
import {
  getDesktopConfigRoot,
  getDesktopPetSettingsPath as resolveDesktopPetSettingsPath,
  getDesktopPetsDataRoot,
  getDesktopStateRoot
} from "../../user-paths";
export {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  applyDesktopPetActiveRunEvent,
  getDesktopPetRunningTaskAnimationDurationMs,
  resolveDesktopPetRunningTaskCount,
  shouldUseDesktopPetTaskRunningAnimation
} from "../../../shared/desktop-pet";

export const DESKTOP_PET_WINDOW_SIZE = {
  width: 176,
  height: 198
} as const;

export const DESKTOP_PET_VISIBLE_FOOTPRINT = {
  x: 40,
  y: 52,
  width: 96,
  height: 108
} as const;

export type DesktopPetWindowMode = "base" | "bubble" | "preview-collapsed" | "preview-expanded" | "task-list";

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
  },
  "task-list": {
    width: 392,
    height: 360
  }
} as const;

type Platform = NodeJS.Platform | string;

export type DesktopPetStoredState = {
  schemaVersion?: 1;
  enabled: boolean;
  lastVisible: boolean;
  unreadCount: number;
  boundAgentKey: string;
  appearanceId: string;
  selectedPetId?: string;
  position?: {
    x: number;
    y: number;
    displayId?: string;
  };
  window?: {
    edgeDock: "none" | "top";
    previewExpanded: boolean;
  };
};

type DesktopPetReadOptions = {
  isFirstInstall?: boolean;
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
type DesktopPetClampOptions = {
  allowVisibleEdgeDock?: boolean;
  stickToEdges?: boolean;
};
export type DesktopPetContextMenuAction = "dance" | "hide";

export type DesktopPetContextMenuItem = {
  action: DesktopPetContextMenuAction;
  label: string;
};

export type UserDesktopPetAsset = {
  id: string;
  petId: string;
  rootPath: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
};

const DEFAULT_OFFSET = {
  x: 20,
  y: 78
} as const;
const DESKTOP_PET_SCHEMA_VERSION = 1;
const DEFAULT_DESKTOP_PET_ID = "builtin:zenmi";
const DESKTOP_PET_CONFIG_FILE = "pet.json";
const LEGACY_DESKTOP_PET_CONFIG_FILE = "desktop-pet.json";
const DESKTOP_PET_STATE_FILE = "pet-state.json";
const DESKTOP_PET_EDGE_STICK_DISTANCE_PX = 24;
const DESKTOP_PET_MESSAGE_PREVIEW_MAX_LENGTH = 30;
const DESKTOP_PET_DONE_FALLBACK_HINT = "暂无回复预览";
const DESKTOP_PET_STATUS_HINTS = new Set(["思考中", "已完成", "回复已生成", "出错了", "目标智能体未在线", "打开对话查看完整回复", DESKTOP_PET_DONE_FALLBACK_HINT]);

function getDesktopPetRoot(app: App) {
  return path.dirname(getDesktopPetSettingsPath(app));
}

function getDesktopPetSettingsPath(app: App) {
  return resolveDesktopPetSettingsPath(app);
}

function getLegacyDesktopPetSettingsPath(app: App) {
  return path.join(getDesktopConfigRoot(app), LEGACY_DESKTOP_PET_CONFIG_FILE);
}

function getDesktopPetStatePath(app: App) {
  return path.join(getDesktopStateRoot(app), DESKTOP_PET_STATE_FILE);
}

function ensureDesktopPetRoot(app: App) {
  fs.mkdirSync(getDesktopPetRoot(app), { recursive: true });
}

function ensureDesktopPetStateRoot(app: App) {
  fs.mkdirSync(path.dirname(getDesktopPetStatePath(app)), { recursive: true });
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
    ...(isDesktopPetDanceAppearance(normalizedAppearanceId)
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

function sanitizeDesktopPetStoredState(
  value: unknown,
  supported: boolean,
  options: DesktopPetReadOptions = {}
): DesktopPetStoredState {
  const candidate = typeof value === "object" && value !== null
    ? value as Partial<DesktopPetStoredState>
    : {};
  const position = candidate.position && Number.isFinite(candidate.position.x) && Number.isFinite(candidate.position.y)
    ? {
        x: Math.round(candidate.position.x),
        y: Math.round(candidate.position.y),
        displayId: typeof candidate.position.displayId === "string" && candidate.position.displayId.trim()
          ? candidate.position.displayId.trim()
          : "primary"
      }
    : undefined;
  const windowState = candidate.window && typeof candidate.window === "object"
    ? candidate.window as { edgeDock?: unknown; previewExpanded?: unknown }
    : {};
  const appearanceId = typeof candidate.appearanceId === "string" && candidate.appearanceId.trim()
    ? sanitizeDesktopPetAppearanceId(candidate.appearanceId)
    : (typeof candidate.selectedPetId === "string" && candidate.selectedPetId.trim()
      ? candidate.selectedPetId.trim()
      : DEFAULT_DESKTOP_PET_ID) === DEFAULT_DESKTOP_PET_ID
      ? DEFAULT_DESKTOP_PET_APPEARANCE_ID
      : sanitizeDesktopPetAppearanceId(String(candidate.selectedPetId).replace(/^builtin:/u, ""));
  const selectedPetId = typeof candidate.selectedPetId === "string" && candidate.selectedPetId.trim()
    ? candidate.selectedPetId.trim()
    : selectedPetIdForAppearance(appearanceId);
  return {
    schemaVersion: DESKTOP_PET_SCHEMA_VERSION,
    enabled: supported ? candidate.enabled === true : false,
    lastVisible: supported ? candidate.lastVisible === true : false,
    unreadCount: sanitizeDesktopPetUnreadCount(candidate.unreadCount),
    boundAgentKey: sanitizeDesktopPetBoundAgentKey(candidate.boundAgentKey),
    appearanceId,
    selectedPetId,
    position: position ?? {
      x: DEFAULT_OFFSET.x,
      y: DEFAULT_OFFSET.y,
      displayId: "primary"
    },
    window: {
      edgeDock: windowState.edgeDock === "top" ? "top" : "none",
      previewExpanded: windowState.previewExpanded === true
    }
  };
}

function selectedPetIdForAppearance(appearanceId: string) {
  return appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
    ? DEFAULT_DESKTOP_PET_ID
    : `builtin:${appearanceId}`;
}

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).name === "SyntaxError") {
      return null;
    }
    throw error;
  }
}

function toDesktopPetConfigFile(state: DesktopPetStoredState) {
  return {
    schemaVersion: DESKTOP_PET_SCHEMA_VERSION,
    enabled: state.enabled,
    selectedPetId: state.selectedPetId,
    lastVisible: state.lastVisible,
    position: {
      x: state.position?.x ?? DEFAULT_OFFSET.x,
      y: state.position?.y ?? DEFAULT_OFFSET.y,
      displayId: state.position?.displayId || "primary"
    },
    window: {
      edgeDock: state.window?.edgeDock ?? "none",
      previewExpanded: state.window?.previewExpanded === true
    }
  };
}

function toDesktopPetStateFile(state: DesktopPetStoredState) {
  return {
    schemaVersion: DESKTOP_PET_SCHEMA_VERSION,
    unreadCount: state.unreadCount,
    updatedAt: new Date().toISOString()
  };
}

function mergeDesktopPetRuntimeState(config: unknown, runtimeState: unknown) {
  if (!runtimeState || typeof runtimeState !== "object" || Array.isArray(runtimeState)) {
    return config;
  }
  return {
    ...(config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {}),
    unreadCount: (runtimeState as { unreadCount?: unknown }).unreadCount
  };
}

function sanitizeUserPetDirectoryName(value: unknown) {
  const normalized = typeof value === "string"
    ? value.trim().replace(/^user:/u, "")
    : "";
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function normalizeUserDesktopPetId(value: unknown, fallbackDirectoryName: string) {
  const directoryName = sanitizeUserPetDirectoryName(value) || sanitizeUserPetDirectoryName(fallbackDirectoryName);
  return directoryName ? `user:${directoryName}` : "";
}

export function listUserDesktopPets(app: App): UserDesktopPetAsset[] {
  const root = getDesktopPetsDataRoot(app);
  if (!fs.existsSync(root)) {
    return [];
  }
  const pets: UserDesktopPetAsset[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rootPath = path.join(root, entry.name);
    const manifestPath = path.join(rootPath, "pet.json");
    const manifest = readJsonFile(manifestPath);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      continue;
    }
    const id = normalizeUserDesktopPetId((manifest as { id?: unknown }).id, entry.name);
    if (!id) {
      continue;
    }
    pets.push({
      id,
      petId: id.replace(/^user:/u, ""),
      rootPath,
      manifestPath,
      manifest: manifest as Record<string, unknown>
    });
  }
  return pets.sort((a, b) => a.petId.localeCompare(b.petId, "zh-CN"));
}

export function isDesktopPetSupportedPlatform(platform: Platform) {
  return platform === "darwin" || platform === "win32";
}

export function readDesktopPetStoredState(
  app: App,
  platform: Platform = process.platform,
  options: DesktopPetReadOptions = {}
) {
  const supported = isDesktopPetSupportedPlatform(platform);
  if (!supported) {
    return sanitizeDesktopPetStoredState(null, supported);
  }

  ensureDesktopPetRoot(app);
  const settingsPath = getDesktopPetSettingsPath(app);
  const statePath = getDesktopPetStatePath(app);
  const parsed = readJsonFile(settingsPath);
  if (parsed) {
    return sanitizeDesktopPetStoredState(
      mergeDesktopPetRuntimeState(parsed, readJsonFile(statePath)),
      supported,
      options
    );
  }

  const legacyPath = getLegacyDesktopPetSettingsPath(app);
  const legacy = readJsonFile(legacyPath);
  if (legacy) {
    const migrated = sanitizeDesktopPetStoredState(legacy, supported, options);
    writeDesktopPetStoredState(app, migrated, platform);
    return migrated;
  }
  return sanitizeDesktopPetStoredState(null, supported, options);
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
  ensureDesktopPetStateRoot(app);
  fs.writeFileSync(getDesktopPetSettingsPath(app), `${JSON.stringify(toDesktopPetConfigFile(sanitized), null, 2)}\n`, "utf8");
  fs.writeFileSync(getDesktopPetStatePath(app), `${JSON.stringify(toDesktopPetStateFile(sanitized), null, 2)}\n`, "utf8");
  return sanitized;
}

export function saveDesktopPetSettings(
  app: App,
  input: Partial<DesktopPetStoredState>,
  platform: Platform = process.platform
) {
  const current = readDesktopPetStoredState(app, platform);
  const nextAppearanceId = typeof input.appearanceId === "string"
    ? sanitizeDesktopPetAppearanceId(input.appearanceId)
    : current.appearanceId;
  return writeDesktopPetStoredState(app, {
    ...current,
    ...input,
    appearanceId: nextAppearanceId,
    selectedPetId: typeof input.selectedPetId === "string" && input.selectedPetId.trim()
      ? input.selectedPetId.trim()
      : typeof input.appearanceId === "string"
        ? selectedPetIdForAppearance(nextAppearanceId)
        : current.selectedPetId,
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
    activeTasks?: DesktopPetTaskItem[];
    previewPanel?: DesktopPetPreviewPanel | null;
    runningTaskCount?: unknown;
    edgeDock?: DesktopPetEdgeDock;
  } = {}
): DesktopPetState {
  const localStatus = options.localStatus ?? createDefaultDesktopPetLocalStatus(settings);
  const agentStatus = options.agentStatus ?? null;
  const mergedStatus = resolveMergedDesktopPetStatus(localStatus, agentStatus);
  const appearanceId = sanitizeDesktopPetAppearanceId(settings.appearanceId);
  const agentUnreadCount = agentStatus && !agentStatus.stale
    ? sanitizeDesktopPetUnreadCount(agentStatus.unreadCount)
    : 0;
  const activeAgentKey = agentStatus?.agentKey || settings.boundAgentKey;
  const agentDefaults = createDefaultDesktopPetAgentStatus(activeAgentKey);
  return {
    supported: options.supported ?? isDesktopPetSupportedPlatform(process.platform),
    enabled: settings.enabled,
    visible: Boolean(options.visible),
    ...mergedStatus,
    unreadCount: Math.max(mergedStatus.unreadCount, agentUnreadCount),
    appearanceId,
    appearanceOptions: [...DESKTOP_PET_APPEARANCE_OPTIONS],
    boundAgentKey: activeAgentKey,
    agentDisplayName: agentStatus?.displayName ?? agentDefaults.displayName,
    agentRole: agentStatus?.role ?? agentDefaults.role,
    agentPresence: agentStatus?.presence ?? agentDefaults.presence,
    agentStatusStale: agentStatus?.stale ?? agentDefaults.stale,
    agentOptions: options.agentOptions ?? [],
    activeTasks: options.activeTasks ?? [],
    previewPanel: options.previewPanel ?? null,
    runningTaskCount: sanitizeDesktopPetRunningTaskCount(options.runningTaskCount),
    edgeDock: options.edgeDock ?? null,
    updatedAt: new Date().toISOString()
  };
}

export function getDesktopPetWindowSize(mode: DesktopPetWindowMode = "base") {
  return DESKTOP_PET_WINDOW_SIZES[mode] ?? DESKTOP_PET_WINDOW_SIZES.base;
}

export function clampDesktopPetPosition(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  size: { width: number; height: number } = DESKTOP_PET_WINDOW_SIZE,
  options: DesktopPetClampOptions = {}
) {
  const width = size.width;
  const height = size.height;
  const allowVisibleEdgeDock = options.allowVisibleEdgeDock &&
    width === DESKTOP_PET_WINDOW_SIZE.width &&
    height === DESKTOP_PET_WINDOW_SIZE.height;
  const minX = allowVisibleEdgeDock
    ? displayArea.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x
    : displayArea.x;
  const minY = displayArea.y;
  const maxX = allowVisibleEdgeDock
    ? displayArea.x + Math.max(
      0,
      displayArea.width - DESKTOP_PET_VISIBLE_FOOTPRINT.x - DESKTOP_PET_VISIBLE_FOOTPRINT.width
    )
    : displayArea.x + Math.max(0, displayArea.width - width);
  const maxY = allowVisibleEdgeDock
    ? displayArea.y + Math.max(
      0,
      displayArea.height - DESKTOP_PET_VISIBLE_FOOTPRINT.y - DESKTOP_PET_VISIBLE_FOOTPRINT.height
    )
    : displayArea.y + Math.max(0, displayArea.height - height);
  const fallbackX = Math.min(maxX, displayArea.x + DEFAULT_OFFSET.x);
  const fallbackY = Math.min(maxY, displayArea.y + DEFAULT_OFFSET.y);
  const resolved = position ?? { x: fallbackX, y: fallbackY };
  let x = Math.round(resolved.x);
  let y = Math.round(resolved.y);
  if (allowVisibleEdgeDock && options.stickToEdges) {
    const rightEdge = displayArea.x + displayArea.width;
    const bottomEdge = displayArea.y + displayArea.height;
    const visibleLeft = x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
    const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
    const visibleTop = y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
    const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
    if (Math.abs(visibleLeft - displayArea.x) <= DESKTOP_PET_EDGE_STICK_DISTANCE_PX) {
      x = minX;
    } else if (Math.abs(visibleRight - rightEdge) <= DESKTOP_PET_EDGE_STICK_DISTANCE_PX) {
      x = maxX;
    }
    if (Math.abs(visibleTop - displayArea.y) <= DESKTOP_PET_EDGE_STICK_DISTANCE_PX) {
      y = minY;
    } else if (Math.abs(visibleBottom - bottomEdge) <= DESKTOP_PET_EDGE_STICK_DISTANCE_PX) {
      y = maxY;
    }
  }
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
    width,
    height
  };
}

export function resolveDesktopPetEdgeDock(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea
): DesktopPetEdgeDock {
  if (!position) {
    return null;
  }
  return position.y <= displayArea.y + DESKTOP_PET_EDGE_STICK_DISTANCE_PX ? "top" : null;
}

export function getAnchoredDesktopPetBounds(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  mode: DesktopPetWindowMode = "base"
) {
  const size = getDesktopPetWindowSize(mode);
  const baseBounds = clampDesktopPetPosition(position, displayArea, DESKTOP_PET_WINDOW_SIZE, {
    allowVisibleEdgeDock: true
  });
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
  DEFAULT_DESKTOP_PET_ID,
  DESKTOP_PET_CONFIG_FILE,
  LEGACY_DESKTOP_PET_CONFIG_FILE,
  DESKTOP_PET_STATE_FILE,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_RUNNING_TASK_ANIMATION_MIN_MS,
  DESKTOP_PET_WINDOW_SIZES,
  sanitizeDesktopPetStoredState,
  sanitizeDesktopPetAppearanceId,
  selectedPetIdForAppearance,
  sanitizeUserPetDirectoryName,
  normalizeUserDesktopPetId,
  sanitizeDesktopPetMessagePreview,
  sanitizeDesktopPetUnreadCount,
  resolveMergedDesktopPetStatus,
  resolveDesktopPetEdgeDock,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetRoot,
  getLegacyDesktopPetSettingsPath,
  getDesktopPetStatePath,
  listUserDesktopPets
};
