import type {
  DesktopPetSignatureAction,
  DesktopPetStateAsset,
  DesktopPetStateAssets
} from "./contracts/pet-copilot";

export const DESKTOP_PET_ROUTE = "/desktop-pet";
export const DESKTOP_PET_USER_ASSET_PROTOCOL = "zenmind-pet";
export const DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY = "zenmi";
export const DEFAULT_DESKTOP_PET_APPEARANCE_ID = "classic";
export const DESKTOP_PET_DONE_FALLBACK_TEXT = "暂无回复预览";
export const DESKTOP_PET_REPLY_PREVIEW_MAX_LENGTH = 30;
export const DESKTOP_PET_GENERIC_PREVIEW_TEXTS = [
  "思考中",
  "已完成",
  "回复已生成",
  "打开对话查看完整回复"
] as const;
export const DESKTOP_PET_STATUS_HINT_TEXTS: ReadonlySet<string> = new Set([
  ...DESKTOP_PET_GENERIC_PREVIEW_TEXTS,
  "出错了",
  "目标智能体未在线",
  DESKTOP_PET_DONE_FALLBACK_TEXT
]);

export const DESKTOP_PET_REQUIRED_STATE_KEYS = [
  "idle",
  "jumping",
  "moving-left",
  "dragging",
  "done",
  "failed",
  "running",
  "awaiting",
  "review"
] as const;

export const DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES = 4;
export const DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES = 8;

const DESKTOP_PET_STATE_ASSET_KEY_SET: ReadonlySet<string> = new Set(DESKTOP_PET_REQUIRED_STATE_KEYS);

const DEFAULT_DESKTOP_PET_STATES: DesktopPetStateAssets = {
  awaiting: {
    path: "awaiting.webp",
    frameCount: 4,
    durationMs: 1200,
    loop: true
  },
  done: {
    path: "done.webp",
    frameCount: 6,
    durationMs: 1200,
    loop: false,
    holdMs: 2500
  },
  dragging: {
    path: "dragging.webp",
    frameCount: 4,
    durationMs: 900,
    loop: true
  },
  failed: {
    path: "failed.webp",
    frameCount: 4,
    durationMs: 1000,
    loop: false,
    holdMs: 3000
  },
  idle: {
    path: "idle.webp",
    frameCount: 4,
    durationMs: 6000,
    loop: true
  },
  jumping: {
    path: "jumping.webp",
    frameCount: 4,
    durationMs: 1000,
    loop: false
  },
  "moving-left": {
    path: "moving-left.webp",
    frameCount: 8,
    durationMs: 900,
    loop: true,
    mirror: true
  },
  review: {
    path: "review.webp",
    frameCount: 4,
    durationMs: 1400,
    loop: true
  },
  running: {
    path: "running.webp",
    frameCount: 8,
    durationMs: 1600,
    loop: true
  }
};

const DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS: DesktopPetSignatureAction[] = [
  {
    id: "chant",
    label: "念经",
    trigger: ["manual", "idle-random"],
    variants: [
      {
        path: "signature/chant.webp",
        frameCount: 30,
        durationMs: 5200,
        weight: 1
      }
    ]
  }
];

export const DESKTOP_PET_APPEARANCE_OPTIONS = [
  {
    id: DEFAULT_DESKTOP_PET_APPEARANCE_ID,
    displayName: "小禅",
    description: "戴圆眼镜、灰袍念珠的小和尚桌面宠物。",
    assetBasePath: "./desktop-pet",
    preview: "idle.webp",
    previewUrl: "./desktop-pet/idle.webp",
    states: DEFAULT_DESKTOP_PET_STATES,
    signature: DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS
  }
] as const;

const DESKTOP_PET_APPEARANCE_IDS: Set<string> = new Set(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id));
const USER_DESKTOP_PET_APPEARANCE_PATTERN = /^user:[a-z0-9][a-z0-9._-]{0,79}$/u;
const DESKTOP_PET_SIGNATURE_ACTIONS_BY_APPEARANCE_ID: Record<string, DesktopPetSignatureAction[]> = {
  [DEFAULT_DESKTOP_PET_APPEARANCE_ID]: DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS
};

export const DESKTOP_PET_STATUS_ASSET_NAMES: Record<string, string> = {
  awaiting: "awaiting.webp",
  done: "done.webp",
  "drag-moving": "moving-left.webp",
  "dragging-moving": "moving-left.webp",
  dragging: "dragging.webp",
  error: "failed.webp",
  failed: "failed.webp",
  hover: "idle.webp",
  idle: "idle.webp",
  jumping: "jumping.webp",
  message: "done.webp",
  "moving-left": "moving-left.webp",
  review: "review.webp",
  running: "running.webp",
  thinking: "running.webp",
  unread: "done.webp"
};

const DESKTOP_PET_RUN_START_EVENT_TYPES = new Set(["run.started", "run.start", "request.query"]);
const DESKTOP_PET_RUN_TERMINAL_EVENT_TYPES = new Set([
  "run.finished",
  "run.complete",
  "run.error",
  "run.cancel",
  "run.stopped",
  "run.interrupt",
  "run.expired",
  "done"
]);

type DesktopPetActiveRunEvent = {
  type?: unknown;
  runId?: unknown;
  runID?: unknown;
  data?: unknown;
};

export function toDesktopPetText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDesktopPetWhitespaceText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function truncateDesktopPetReplyPreview(value: unknown, maxLength = DESKTOP_PET_REPLY_PREVIEW_MAX_LENGTH) {
  const normalized = normalizeDesktopPetWhitespaceText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function readDesktopPetEventRunId(event: DesktopPetActiveRunEvent) {
  const data = typeof event.data === "object" && event.data !== null
    ? event.data as Record<string, unknown>
    : {};
  return toDesktopPetText(event.runId) ||
    toDesktopPetText(event.runID) ||
    toDesktopPetText(data.runId) ||
    toDesktopPetText(data.runID);
}

export function sanitizeDesktopPetRunningTaskCount(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

export function sanitizeDesktopPetUnreadCount(value: unknown) {
  return sanitizeDesktopPetRunningTaskCount(value);
}

export function getDesktopPetSignatureActions(appearanceId: unknown): DesktopPetSignatureAction[] {
  return DESKTOP_PET_SIGNATURE_ACTIONS_BY_APPEARANCE_ID[normalizeDesktopPetAppearanceId(appearanceId)] ?? [];
}

export function resolveDesktopPetSignatureActions(
  appearanceId: unknown,
  signature?: readonly DesktopPetSignatureAction[] | null
): DesktopPetSignatureAction[] {
  if (Array.isArray(signature) && signature.length > 0) {
    return [...signature];
  }
  return getDesktopPetSignatureActions(appearanceId);
}

export function normalizeDesktopPetStateAssetKey(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "drag-moving" || normalized === "dragging-moving") {
    return "moving-left";
  }
  if (normalized === "error") {
    return "failed";
  }
  if (normalized === "thinking") {
    return "running";
  }
  if (normalized === "waiting") {
    return "awaiting";
  }
  if (normalized === "hover") {
    return "idle";
  }
  if (normalized === "message" || normalized === "unread") {
    return "done";
  }
  return DESKTOP_PET_STATE_ASSET_KEY_SET.has(normalized) ? normalized : "idle";
}

export function getDesktopPetStateAsset(
  states: DesktopPetStateAssets | null | undefined,
  status: unknown
): DesktopPetStateAsset | null {
  if (!states || typeof states !== "object") {
    return null;
  }
  const key = normalizeDesktopPetStateAssetKey(status);
  return states[key] ?? null;
}

export function getDesktopPetStatusAssetName(status: unknown) {
  const normalized = normalizeDesktopPetStateAssetKey(status);
  return DESKTOP_PET_STATUS_ASSET_NAMES[normalized] ?? DESKTOP_PET_STATUS_ASSET_NAMES.idle;
}

export function isDesktopPetAnimatedAsset(asset: DesktopPetStateAsset | null | undefined) {
  return Boolean(
    asset &&
    asset.path.trim() &&
    Math.max(1, Math.round(Number(asset.frameCount) || 1)) > 1 &&
    Math.max(0, Math.round(Number(asset.durationMs) || 0)) > 0
  );
}

export function applyDesktopPetActiveRunEvent(
  activeRunIds: Iterable<string>,
  event: DesktopPetActiveRunEvent | null | undefined
) {
  const nextRunIds = new Set(activeRunIds);
  const type = toDesktopPetText(event?.type);
  const runId = event ? readDesktopPetEventRunId(event) : "";
  if (!type || !runId) {
    return {
      activeRunIds: nextRunIds,
      runningTaskCount: nextRunIds.size,
      changed: false
    };
  }

  const previousSize = nextRunIds.size;
  if (DESKTOP_PET_RUN_START_EVENT_TYPES.has(type)) {
    nextRunIds.add(runId);
  } else if (DESKTOP_PET_RUN_TERMINAL_EVENT_TYPES.has(type)) {
    nextRunIds.delete(runId);
  }
  return {
    activeRunIds: nextRunIds,
    runningTaskCount: nextRunIds.size,
    changed: nextRunIds.size !== previousSize
  };
}

function countUniqueDesktopPetRunIds(values: Iterable<unknown>) {
  const ids = new Set<string>();
  for (const value of values) {
    const runId = toDesktopPetText(value);
    if (runId) {
      ids.add(runId);
    }
  }
  return ids.size;
}

export function resolveDesktopPetRunningTaskCount(input: {
  activeRunIds?: Iterable<unknown>;
  taskBoardRunIds?: Iterable<unknown>;
  fallbackRunning?: boolean;
}) {
  const activeRunCount = countUniqueDesktopPetRunIds(input.activeRunIds ?? []);
  const taskBoardRunCount = countUniqueDesktopPetRunIds(input.taskBoardRunIds ?? []);
  const explicitCount = Math.max(activeRunCount, taskBoardRunCount);
  return explicitCount > 0 || !input.fallbackRunning ? explicitCount : 1;
}

export function normalizeDesktopPetBoundAgentKey(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY;
  }
  return normalized;
}

export function normalizeDesktopPetAppearanceId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (DESKTOP_PET_APPEARANCE_IDS.has(normalized)) {
    return normalized;
  }
  if (USER_DESKTOP_PET_APPEARANCE_PATTERN.test(normalized)) {
    return normalized;
  }
  return DEFAULT_DESKTOP_PET_APPEARANCE_ID;
}

export function getDesktopPetAppearanceOption(value: unknown) {
  const appearanceId = normalizeDesktopPetAppearanceId(value);
  return DESKTOP_PET_APPEARANCE_OPTIONS.find((option) => option.id === appearanceId) ??
    DESKTOP_PET_APPEARANCE_OPTIONS[0];
}

export function getDesktopPetStatusAssetPath(appearanceId: unknown, status: string) {
  const appearance = getDesktopPetAppearanceOption(appearanceId);
  const stateAsset = getDesktopPetStateAsset(appearance.states, status);
  const fileName = stateAsset?.path ?? getDesktopPetStatusAssetName(status);
  return `${appearance.assetBasePath}/${fileName}`;
}
