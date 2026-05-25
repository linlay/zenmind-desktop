export const DESKTOP_PET_ROUTE = "/desktop-pet";
export const DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY = "zenmi";
export const DEFAULT_DESKTOP_PET_APPEARANCE_ID = "classic";
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_BASE_MS = 1500;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_STEP_MS = 250;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_MIN_MS = 900;
export const DESKTOP_PET_RUNNING_TASK_ANIMATION_MAX_TASKS = 4;

export const DESKTOP_PET_APPEARANCE_OPTIONS = [
  {
    id: DEFAULT_DESKTOP_PET_APPEARANCE_ID,
    displayName: "小宅",
    description: "默认蓝色形象，保持现有宠物外观。",
    assetBasePath: "./desktop-pet",
    previewAssetPath: "./desktop-pet/pet-idle.png"
  },
  {
    id: "dario",
    displayName: "Dario",
    description: "皱眉卷发的宠物，适合高压专注时刻。",
    assetBasePath: "./desktop-pet/dario",
    previewAssetPath: "./desktop-pet/dario/pet-idle.png"
  },
  {
    id: "mini-sama",
    displayName: "Mini Sama",
    description: "焦虑又机灵的宠物，适合董事会混乱能量。",
    assetBasePath: "./desktop-pet/mini-sama",
    previewAssetPath: "./desktop-pet/mini-sama/pet-idle.png"
  },
  {
    id: "xiao",
    displayName: "小肖",
    description: "黑发西装形象，带着花束和金色奖杯。",
    assetBasePath: "./desktop-pet/xiao",
    previewAssetPath: "./desktop-pet/xiao/pet-idle.png"
  },
  {
    id: "idol-pony",
    displayName: "小凌",
    description: "侧马尾 Q 版形象，带着爱心和麦克风。",
    assetBasePath: "./desktop-pet/idol-pony",
    previewAssetPath: "./desktop-pet/idol-pony/pet-idle.png"
  }
] as const;

const LEGACY_DESKTOP_PET_BOUND_AGENT_KEY_ALIASES: Record<string, string> = {
  // Early desktop-pet builds used the display-name pinyin; agent-platform stores 小宅 as zenmi.
  xiaozhai: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
};

const DESKTOP_PET_APPEARANCE_IDS: Set<string> = new Set(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id));
const DESKTOP_PET_TASK_RUNNING_APPEARANCE_IDS: Set<string> = new Set(["idol-pony", "xiao"]);

const LEGACY_DESKTOP_PET_APPEARANCE_ID_ALIASES: Record<string, string> = {
  sprout: "dario",
  starlight: "mini-sama"
};

const DESKTOP_PET_STATUS_ASSET_NAMES: Record<string, string> = {
  awaiting: "pet-awaiting.png",
  dancing: "pet-idle.png",
  done: "pet-done.png",
  dragging: "pet-dragging.png",
  "dragging-left": "pet-dragging-left.png",
  "dragging-right": "pet-dragging-right.png",
  error: "pet-error.png",
  hover: "pet-hover.png",
  idle: "pet-idle.png",
  message: "pet-message.png",
  thinking: "pet-thinking.png",
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

function toDesktopPetText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

export function shouldUseDesktopPetTaskRunningAnimation(appearanceId: unknown, runningTaskCount: unknown) {
  return DESKTOP_PET_TASK_RUNNING_APPEARANCE_IDS.has(normalizeDesktopPetAppearanceId(appearanceId)) &&
    sanitizeDesktopPetRunningTaskCount(runningTaskCount) > 0;
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
  const aliased = LEGACY_DESKTOP_PET_APPEARANCE_ID_ALIASES[normalized] ?? normalized;
  if (DESKTOP_PET_APPEARANCE_IDS.has(normalized)) {
    return normalized;
  }
  if (DESKTOP_PET_APPEARANCE_IDS.has(aliased)) {
    return aliased;
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
  const fileName = DESKTOP_PET_STATUS_ASSET_NAMES[status] ?? DESKTOP_PET_STATUS_ASSET_NAMES.idle;
  return `${appearance.assetBasePath}/${fileName}`;
}
