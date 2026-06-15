import type {
  DesktopPetCapabilities,
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
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_BASE_MS = 1500;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_STEP_MS = 250;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_MIN_MS = 900;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_MAX_TASKS = 4;

const DEFAULT_DESKTOP_PET_STATES: DesktopPetStateAssets = {
  awaiting: {
    path: "awaiting.png"
  },
  done: {
    path: "done.png",
    holdMs: 2500
  },
  "drag-moving": {
    path: "drag-moving.webp",
    frameCount: 15,
    durationMs: 900,
    loop: true,
    mirror: true
  },
  dragging: {
    path: "dragging.png"
  },
  error: {
    path: "error.png",
    holdMs: 3000
  },
  hover: {
    path: "hover.png"
  },
  idle: {
    path: "idle.png"
  },
  running: {
    path: "running.png"
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
    preview: "idle.png",
    previewAssetPath: "./desktop-pet/idle.png",
    states: DEFAULT_DESKTOP_PET_STATES,
    signature: DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS
  }
] as const;

const LEGACY_DESKTOP_PET_BOUND_AGENT_KEY_ALIASES: Record<string, string> = {
  // Early desktop-pet builds used the display-name pinyin; agent-platform stores 小宅 as zenmi.
  xiaozhai: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
};

const DESKTOP_PET_APPEARANCE_IDS: Set<string> = new Set(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id));
const DESKTOP_PET_TASK_RUNNING_APPEARANCE_IDS: Set<string> = new Set();
const DESKTOP_PET_DANCE_APPEARANCE_IDS: Set<string> = new Set();
const USER_DESKTOP_PET_APPEARANCE_PATTERN = /^user:[a-z0-9][a-z0-9._-]{0,79}$/u;
const DESKTOP_PET_SIGNATURE_ACTIONS_BY_APPEARANCE_ID: Record<string, DesktopPetSignatureAction[]> = {
  [DEFAULT_DESKTOP_PET_APPEARANCE_ID]: DEFAULT_DESKTOP_PET_SIGNATURE_ACTIONS
};

export const DESKTOP_PET_STATUS_ASSET_NAMES: Record<string, string> = {
  awaiting: "awaiting.png",
  dancing: "idle.png",
  done: "done.png",
  "drag-moving": "drag-moving.webp",
  dragging: "dragging.png",
  error: "error.png",
  hover: "hover.png",
  idle: "idle.png",
  message: "done.png",
  running: "running.png",
  thinking: "running.png",
  unread: "done.png"
};

export const LEGACY_DESKTOP_PET_STATUS_ASSET_NAMES: Record<string, string> = {
  awaiting: "pet-awaiting.png",
  dancing: "pet-idle.png",
  done: "pet-done.png",
  "drag-moving": "pet-dragging-moving.png",
  dragging: "pet-dragging.png",
  "dragging-moving": "pet-dragging-moving.png",
  error: "pet-error.png",
  hover: "pet-hover.png",
  idle: "pet-idle.png",
  running: "pet-running.png"
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

export function getDesktopPetRunningTaskAnimationDurationMs(runningTaskCount: unknown) {
  const count = sanitizeDesktopPetRunningTaskCount(runningTaskCount);
  if (count <= 0) {
    return DESKTOP_PET_RUNNING_TASK_ANIMATION_BASE_MS;
  }
  const effectiveCount = Math.min(count, DESKTOP_PET_RUNNING_TASK_ANIMATION_MAX_TASKS);
  return Math.max(
    DESKTOP_PET_RUNNING_TASK_ANIMATION_MIN_MS,
    DESKTOP_PET_RUNNING_TASK_ANIMATION_BASE_MS - ((effectiveCount - 1) * DESKTOP_PET_RUNNING_TASK_ANIMATION_STEP_MS)
  );
}

export function getDesktopPetCapabilities(appearanceId: unknown): DesktopPetCapabilities {
  const normalized = normalizeDesktopPetAppearanceId(appearanceId);
  return {
    taskRun: DESKTOP_PET_TASK_RUNNING_APPEARANCE_IDS.has(normalized),
    dance: DESKTOP_PET_DANCE_APPEARANCE_IDS.has(normalized)
  };
}

export function getDesktopPetSignatureActions(appearanceId: unknown): DesktopPetSignatureAction[] {
  return DESKTOP_PET_SIGNATURE_ACTIONS_BY_APPEARANCE_ID[normalizeDesktopPetAppearanceId(appearanceId)] ?? [];
}

export function resolveDesktopPetSignatureActions(
  appearanceId: unknown,
  signatureActions?: readonly DesktopPetSignatureAction[] | null
): DesktopPetSignatureAction[] {
  if (Array.isArray(signatureActions) && signatureActions.length > 0) {
    return [...signatureActions];
  }
  return getDesktopPetSignatureActions(appearanceId);
}

export function normalizeDesktopPetStateAssetKey(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "dragging-moving") {
    return "drag-moving";
  }
  if (normalized === "thinking") {
    return "running";
  }
  if (normalized === "message" || normalized === "unread") {
    return "done";
  }
  return normalized || "idle";
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

export function getDesktopPetLegacyStatusAssetName(status: unknown) {
  const raw = typeof status === "string" ? status.trim() : "";
  const normalized = normalizeDesktopPetStateAssetKey(raw);
  return LEGACY_DESKTOP_PET_STATUS_ASSET_NAMES[raw] ??
    LEGACY_DESKTOP_PET_STATUS_ASSET_NAMES[normalized] ??
    LEGACY_DESKTOP_PET_STATUS_ASSET_NAMES.idle;
}

export function getDesktopPetStatusAssetName(status: unknown) {
  const raw = typeof status === "string" ? status.trim() : "";
  const normalized = normalizeDesktopPetStateAssetKey(raw);
  return DESKTOP_PET_STATUS_ASSET_NAMES[raw] ??
    DESKTOP_PET_STATUS_ASSET_NAMES[normalized] ??
    DESKTOP_PET_STATUS_ASSET_NAMES.idle;
}

export function isDesktopPetAnimatedAsset(asset: DesktopPetStateAsset | null | undefined) {
  return Boolean(
    asset &&
    asset.path.trim() &&
    Math.max(1, Math.round(Number(asset.frameCount) || 1)) > 1 &&
    Math.max(0, Math.round(Number(asset.durationMs) || 0)) > 0
  );
}

export function shouldUseDesktopPetTaskRunningAnimation(
  appearanceId: unknown,
  runningTaskCount: unknown,
  capabilities?: DesktopPetCapabilities
) {
  const supportsTaskRun = typeof capabilities?.taskRun === "boolean"
    ? capabilities.taskRun
    : DESKTOP_PET_TASK_RUNNING_APPEARANCE_IDS.has(normalizeDesktopPetAppearanceId(appearanceId));
  return supportsTaskRun &&
    sanitizeDesktopPetRunningTaskCount(runningTaskCount) > 0;
}

export function isDesktopPetDanceAppearance(appearanceId: unknown) {
  return DESKTOP_PET_DANCE_APPEARANCE_IDS.has(normalizeDesktopPetAppearanceId(appearanceId));
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
  return LEGACY_DESKTOP_PET_BOUND_AGENT_KEY_ALIASES[normalized] ?? normalized;
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
