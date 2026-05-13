export const DESKTOP_PET_ROUTE = "/desktop-pet";
export const DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY = "zenmi";
export const DEFAULT_DESKTOP_PET_APPEARANCE_ID = "classic";

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
  }
] as const;

const LEGACY_DESKTOP_PET_BOUND_AGENT_KEY_ALIASES: Record<string, string> = {
  // Early desktop-pet builds used the display-name pinyin; agent-platform stores 小宅 as zenmi.
  xiaozhai: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
};

const DESKTOP_PET_APPEARANCE_IDS: Set<string> = new Set(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id));

const LEGACY_DESKTOP_PET_APPEARANCE_ID_ALIASES: Record<string, string> = {
  sprout: "dario",
  starlight: "mini-sama"
};

const DESKTOP_PET_STATUS_ASSET_NAMES: Record<string, string> = {
  awaiting: "pet-awaiting.png",
  dancing: "pet-idle.png",
  done: "pet-done.png",
  dragging: "pet-dragging.png",
  error: "pet-error.png",
  hover: "pet-hover.png",
  idle: "pet-idle.png",
  message: "pet-message.png",
  thinking: "pet-thinking.png",
  running: "pet-running.png"
};

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
