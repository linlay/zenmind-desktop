import fs from "node:fs";
import path from "node:path";
import type { App, Rectangle } from "electron";
import type {
  DesktopPetAppearanceOption,
  DesktopPetSignatureAction,
  DesktopPetStateAsset,
  DesktopPetStateAssets,
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
  DEFAULT_DESKTOP_PET_SELECTED_ID,
  DESKTOP_PET_USER_ASSET_PROTOCOL,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DESKTOP_PET_REQUIRED_STATE_KEYS,
  DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES,
  DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES,
  DESKTOP_PET_STATUS_HINT_TEXTS,
  applyDesktopPetActiveRunEvent,
  getDesktopPetSignatureActions,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey,
  normalizeDesktopPetWhitespaceText,
  resolveDesktopPetSignatureActions,
  resolveDesktopPetRunningTaskCount,
  sanitizeDesktopPetRunningTaskCount,
  sanitizeDesktopPetUnreadCount,
  truncateDesktopPetReplyPreview
} from "../../../shared/desktop-pet";
import { t } from "../../i18n/main-i18n";
import {
  getDesktopPetSettingsPath as resolveDesktopPetSettingsPath,
  getDesktopPetsDataRoot,
  getDesktopStateRoot
} from "../../user-paths";
export {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DEFAULT_DESKTOP_PET_SELECTED_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  applyDesktopPetActiveRunEvent,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey,
  resolveDesktopPetRunningTaskCount
} from "../../../shared/desktop-pet";

export const sanitizeDesktopPetAppearanceId = normalizeDesktopPetAppearanceId;
export const sanitizeDesktopPetBoundAgentKey = normalizeDesktopPetBoundAgentKey;

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

export type DesktopPetWindowMode =
  | "base"
  | "bubble"
  | "preview-collapsed"
  | "preview-expanded"
  | "task-list-compact"
  | "task-list";

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
  "task-list-compact": {
    width: 340,
    height: 282
  },
  "task-list": {
    width: 392,
    height: 360
  }
} as const;

type DesktopPetVisibleFootprint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS: Record<DesktopPetWindowMode, DesktopPetVisibleFootprint> = {
  base: DESKTOP_PET_VISIBLE_FOOTPRINT,
  bubble: {
    x: 64,
    y: 82,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "preview-collapsed": {
    x: 142,
    y: 142,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "preview-expanded": {
    x: 162,
    y: 294,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "task-list-compact": {
    x: 116,
    y: 156,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  },
  "task-list": {
    x: 148,
    y: 236,
    width: DESKTOP_PET_VISIBLE_FOOTPRINT.width,
    height: DESKTOP_PET_VISIBLE_FOOTPRINT.height
  }
} as const;

type Platform = NodeJS.Platform | string;

export type DesktopPetStoredState = {
  schemaVersion?: 1;
  enabled: boolean;
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
export type DesktopPetContextMenuItem =
  | {
      action: "signature";
      signatureId: string;
      label: string;
    }
  | {
      action: "hide";
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
const DEFAULT_DESKTOP_PET_ID = DEFAULT_DESKTOP_PET_SELECTED_ID;
const DESKTOP_PET_CONFIG_FILE = "pet.json";
const DESKTOP_PET_STATE_FILE = "pet-state.json";
const DESKTOP_PET_EDGE_STICK_DISTANCE_PX = 24;

function getDesktopPetRoot(app: App) {
  return path.dirname(getDesktopPetSettingsPath(app));
}

function getDesktopPetSettingsPath(app: App) {
  return resolveDesktopPetSettingsPath(app);
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

export function getDesktopPetContextMenuItems(
  appearanceId: unknown,
  signature: DesktopPetSignatureAction[] = getDesktopPetSignatureActions(appearanceId)
): DesktopPetContextMenuItem[] {
  const resolvedSignature = resolveDesktopPetSignatureActions(appearanceId, signature);
  return [
    ...resolvedSignature
      .filter((action) => action.trigger.includes("manual"))
      .map((action) => ({
        action: "signature" as const,
        signatureId: action.id,
        label: action.label
      })),
    {
      action: "hide",
      label: t("desktopPet.context.close")
    }
  ];
}

function sanitizeDesktopPetMessagePreview(value: unknown) {
  const normalized = normalizeDesktopPetWhitespaceText(value);
  if (!normalized || DESKTOP_PET_STATUS_HINT_TEXTS.has(normalized)) {
    return "";
  }
  return truncateDesktopPetReplyPreview(normalized);
}

function isGenericDesktopPetDoneHint(value: unknown) {
  const normalized = normalizeDesktopPetWhitespaceText(value);
  return !normalized || DESKTOP_PET_STATUS_HINT_TEXTS.has(normalized);
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
    ? normalizeDesktopPetAppearanceId(candidate.appearanceId)
    : (typeof candidate.selectedPetId === "string" && candidate.selectedPetId.trim()
      ? candidate.selectedPetId.trim()
      : DEFAULT_DESKTOP_PET_ID) === DEFAULT_DESKTOP_PET_ID
      ? DEFAULT_DESKTOP_PET_APPEARANCE_ID
      : normalizeDesktopPetAppearanceId(String(candidate.selectedPetId).replace(/^builtin:/u, ""));
  const rawSelectedPetId = typeof candidate.selectedPetId === "string" ? candidate.selectedPetId.trim() : "";
  const selectedPetId = rawSelectedPetId.startsWith("user:")
    ? rawSelectedPetId
    : selectedPetIdForAppearance(appearanceId);
  return {
    schemaVersion: DESKTOP_PET_SCHEMA_VERSION,
    enabled: supported ? candidate.enabled === true : false,
    unreadCount: sanitizeDesktopPetUnreadCount(candidate.unreadCount),
    boundAgentKey: normalizeDesktopPetBoundAgentKey(candidate.boundAgentKey),
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
  if (appearanceId.startsWith("user:")) {
    return appearanceId;
  }
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

function sanitizeDesktopPetAssetRelativePath(value: unknown) {
  const normalized = typeof value === "string"
    ? value.trim().replace(/\\/gu, "/").replace(/^\/+/u, "")
    : "";
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => part === "." || part === ".." || part.startsWith("."))
  ) {
    return "";
  }
  return parts.join("/");
}

function encodeDesktopPetAssetPath(relativePath: string) {
  return relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function userPetAssetBaseUrl(petId: string) {
  const safePetId = sanitizeUserPetDirectoryName(petId);
  return safePetId ? `${DESKTOP_PET_USER_ASSET_PROTOCOL}://${encodeURIComponent(safePetId)}/` : "";
}

function userPetAssetUrl(petId: string, relativePath: string) {
  const baseUrl = userPetAssetBaseUrl(petId);
  const safeRelative = sanitizeDesktopPetAssetRelativePath(relativePath);
  return baseUrl && safeRelative ? `${baseUrl}${encodeDesktopPetAssetPath(safeRelative)}` : "";
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

function readUserPetText(manifest: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = manifest[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

const FORBIDDEN_DESKTOP_PET_MANIFEST_KEYS = new Set(["previewAssetPath", "signatureActions", "capabilities"]);
const DESKTOP_PET_REQUIRED_STATE_KEY_SET: ReadonlySet<string> = new Set(DESKTOP_PET_REQUIRED_STATE_KEYS);

function isForbiddenDesktopPetAssetPath(relativePath: string) {
  const safeRelative = sanitizeDesktopPetAssetRelativePath(relativePath);
  const fileName = path.posix.basename(safeRelative);
  return fileName.startsWith("pet-") ||
    safeRelative === "task-run-left.webp" ||
    safeRelative === "dance.webp";
}

function isDesktopPetAssetFilePresent(rootPath: string, relativePath: string) {
  const safeRelative = sanitizeDesktopPetAssetRelativePath(relativePath);
  return Boolean(
    safeRelative &&
    !isForbiddenDesktopPetAssetPath(safeRelative) &&
    fs.existsSync(path.join(rootPath, safeRelative))
  );
}

function hasForbiddenDesktopPetManifestKey(manifest: Record<string, unknown>) {
  return Object.keys(manifest).some((key) => FORBIDDEN_DESKTOP_PET_MANIFEST_KEYS.has(key));
}

function userPetPreviewUrl(pet: UserDesktopPetAsset, preview: string) {
  return userPetAssetUrl(pet.petId, preview);
}

function sanitizeDesktopPetSignaturePath(value: unknown) {
  return sanitizeDesktopPetAssetRelativePath(value);
}

function sanitizeDesktopPetSignatureActions(value: unknown): DesktopPetSignatureAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const actions: DesktopPetSignatureAction[] = [];
  for (const action of value) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }
    const candidate = action as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const triggers = Array.isArray(candidate.trigger)
      ? candidate.trigger.filter((trigger): trigger is "manual" | "idle-random" =>
          trigger === "manual" || trigger === "idle-random"
        )
      : [];
    const variants = Array.isArray(candidate.variants)
      ? candidate.variants.flatMap((variant): DesktopPetSignatureAction["variants"] => {
          if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
            return [];
          }
          const rawVariant = variant as Record<string, unknown>;
          const path = sanitizeDesktopPetSignaturePath(rawVariant.path);
          const frameCount = Math.max(1, Math.round(Number(rawVariant.frameCount) || 0));
          const durationMs = Math.max(100, Math.round(Number(rawVariant.durationMs) || 0));
          if (!path) {
            return [];
          }
          return [{
            path,
            frameCount,
            durationMs,
            weight: Math.max(1, Math.round(Number(rawVariant.weight) || 1))
          }];
        })
      : [];
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) || !label || triggers.length === 0 || variants.length === 0) {
      continue;
    }
    actions.push({
      id,
      label,
      trigger: [...new Set(triggers)],
      variants
    });
  }
  return actions.length > 0 ? actions : undefined;
}

function isDesktopPetStandardFrameCount(frameCount: number) {
  return frameCount >= DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES &&
    frameCount <= DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES;
}

function sanitizeDesktopPetStateAsset(
  value: unknown,
  options: { requireStandardFrames?: boolean } = {}
): DesktopPetStateAsset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const path = sanitizeDesktopPetSignaturePath(candidate.path);
  if (!path) {
    return undefined;
  }
  const frameCount = Math.max(1, Math.round(Number(candidate.frameCount) || 1));
  const durationMs = Math.max(0, Math.round(Number(candidate.durationMs) || 0));
  const holdMs = Math.max(0, Math.round(Number(candidate.holdMs) || 0));
  const alts = sanitizeDesktopPetSignatureActions(candidate.alts);
  if (options.requireStandardFrames && (!isDesktopPetStandardFrameCount(frameCount) || durationMs <= 0)) {
    return undefined;
  }
  return {
    path,
    ...(frameCount > 1 ? { frameCount } : {}),
    ...(durationMs > 0 ? { durationMs } : {}),
    ...(typeof candidate.loop === "boolean" ? { loop: candidate.loop } : {}),
    ...(typeof candidate.mirror === "boolean" ? { mirror: candidate.mirror } : {}),
    ...(holdMs > 0 ? { holdMs } : {}),
    ...(alts ? { alts } : {})
  };
}

function sanitizeDesktopPetStates(value: unknown): DesktopPetStateAssets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rawStates = value as Record<string, unknown>;
  if (Object.keys(rawStates).some((key) => !DESKTOP_PET_REQUIRED_STATE_KEY_SET.has(key))) {
    return undefined;
  }
  const states: DesktopPetStateAssets = {};
  for (const key of DESKTOP_PET_REQUIRED_STATE_KEYS) {
    const asset = sanitizeDesktopPetStateAsset(rawStates[key], { requireStandardFrames: true });
    if (!asset) {
      return undefined;
    }
    states[key] = asset;
  }
  return states;
}

function areDesktopPetSignatureAssetsPresent(rootPath: string, actions: DesktopPetSignatureAction[] | undefined) {
  if (!actions) {
    return true;
  }
  return actions.every((action) =>
    action.variants.every((variant) => isDesktopPetAssetFilePresent(rootPath, variant.path))
  );
}

function areDesktopPetStateAssetsPresent(rootPath: string, states: DesktopPetStateAssets | undefined) {
  if (!states) {
    return false;
  }
  return DESKTOP_PET_REQUIRED_STATE_KEYS.every((key) => {
    const state = states[key];
    return state &&
      isDesktopPetAssetFilePresent(rootPath, state.path) &&
      areDesktopPetSignatureAssetsPresent(rootPath, state.alts);
  });
}

export function listUserDesktopPetAppearanceOptions(app: App): DesktopPetAppearanceOption[] {
  return listUserDesktopPets(app).flatMap((pet): DesktopPetAppearanceOption[] => {
    if (hasForbiddenDesktopPetManifestKey(pet.manifest)) {
      return [];
    }
    const preview = readUserPetText(pet.manifest, ["preview"]);
    const states = sanitizeDesktopPetStates(pet.manifest.states);
    const signature = sanitizeDesktopPetSignatureActions(pet.manifest.signature);
    if (
      !preview ||
      !states ||
      !isDesktopPetAssetFilePresent(pet.rootPath, preview) ||
      !areDesktopPetStateAssetsPresent(pet.rootPath, states) ||
      !areDesktopPetSignatureAssetsPresent(pet.rootPath, signature)
    ) {
      return [];
    }
    return [{
      id: pet.id,
      displayName: readUserPetText(pet.manifest, ["displayName", "name"], pet.petId),
      description: readUserPetText(pet.manifest, ["description"], ""),
      assetBasePath: userPetAssetBaseUrl(pet.petId),
      preview,
      previewUrl: userPetPreviewUrl(pet, preview),
      states,
      ...(signature ? { signature } : {})
    }];
  });
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
    ? normalizeDesktopPetAppearanceId(input.appearanceId)
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
    agentKey: normalizeDesktopPetBoundAgentKey(boundAgentKey),
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
    return t("desktopPet.status.thinking");
  }
  if (agentStatus.presence === "away") {
    return sanitizeDesktopPetMessagePreview(agentStatus.latestPreview) || t("desktopPet.doneFallback");
  }
  return "";
}

function normalizeLocalDesktopPetStatus(
  localStatus: DesktopPetLocalStatus
): Pick<DesktopPetState, "status" | "hint" | "messagePreview" | "unreadCount" | "chatId"> {
  if (localStatus.status === "done") {
    return {
      status: "done",
      hint: localStatus.hint.trim() || t("desktopPet.doneFallback"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "error") {
    return {
      status: "error",
      hint: localStatus.hint.trim() || t("desktopPet.status.error"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "awaiting") {
    return {
      status: "awaiting",
      hint: localStatus.hint.trim() || t("desktopPet.status.awaitingConfirm"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "running") {
    return {
      status: "running",
      hint: t("desktopPet.status.thinking"),
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

function hasAwaitingDesktopPetTask(activeTasks: DesktopPetTaskItem[] | undefined) {
  return (activeTasks ?? []).some((task) => task.status === "awaiting");
}

function resolveMergedDesktopPetStatus(
  localStatus: DesktopPetLocalStatus,
  agentStatus: DesktopPetBoundAgentStatus | null,
  activeTasks: DesktopPetTaskItem[] = []
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
      : agentStatus.hasPendingAwaiting || hasAwaitingDesktopPetTask(activeTasks)
        ? "awaiting"
        : agentStatus.presence === "busy"
          ? "running"
        : "idle";
    const awaitingHint = status === "awaiting"
      ? sanitizeDesktopPetMessagePreview(agentStatus.latestPreview) || t("desktopPet.status.awaitingConfirm")
      : hint;
    return {
      status,
      hint: awaitingHint,
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
    appearanceOptions?: DesktopPetAppearanceOption[];
    previewPanel?: DesktopPetPreviewPanel | null;
    runningTaskCount?: unknown;
    edgeDock?: DesktopPetEdgeDock;
  } = {}
): DesktopPetState {
  const localStatus = options.localStatus ?? createDefaultDesktopPetLocalStatus(settings);
  const agentStatus = options.agentStatus ?? null;
  const activeTasks = options.activeTasks ?? [];
  const mergedStatus = resolveMergedDesktopPetStatus(localStatus, agentStatus, activeTasks);
  const appearanceOptions: DesktopPetAppearanceOption[] = [
    ...DESKTOP_PET_APPEARANCE_OPTIONS,
    ...(options.appearanceOptions ?? [])
  ];
  const sanitizedAppearanceId = sanitizeDesktopPetAppearanceId(settings.appearanceId);
  const appearanceId = appearanceOptions.some((appearance) => appearance.id === sanitizedAppearanceId)
    ? sanitizedAppearanceId
    : DEFAULT_DESKTOP_PET_APPEARANCE_ID;
  const appearanceOption = appearanceOptions.find((appearance) => appearance.id === appearanceId);
  const signature = resolveDesktopPetSignatureActions(
    appearanceId,
    appearanceOption?.signature
  );
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
    appearanceOptions,
    boundAgentKey: activeAgentKey,
    agentDisplayName: agentStatus?.displayName ?? agentDefaults.displayName,
    agentRole: agentStatus?.role ?? agentDefaults.role,
    agentPresence: agentStatus?.presence ?? agentDefaults.presence,
    agentStatusStale: agentStatus?.stale ?? agentDefaults.stale,
    agentOptions: options.agentOptions ?? [],
    activeTasks,
    previewPanel: options.previewPanel ?? null,
    runningTaskCount: sanitizeDesktopPetRunningTaskCount(options.runningTaskCount),
    edgeDock: options.edgeDock ?? null,
    signature,
    updatedAt: new Date().toISOString()
  };
}

export function getDesktopPetWindowSize(mode: DesktopPetWindowMode = "base") {
  return DESKTOP_PET_WINDOW_SIZES[mode] ?? DESKTOP_PET_WINDOW_SIZES.base;
}

function getDesktopPetVisibleFootprintForMode(mode: DesktopPetWindowMode) {
  return DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode] ?? DESKTOP_PET_VISIBLE_FOOTPRINT;
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
  const footprint = getDesktopPetVisibleFootprintForMode(mode);
  return {
    x: baseBounds.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x - footprint.x,
    y: baseBounds.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y - footprint.y,
    width: size.width,
    height: size.height
  };
}

export function getDesktopPetLogicalPositionFromBounds(
  bounds: { x: number; y: number },
  mode: DesktopPetWindowMode = "base"
) {
  const footprint = getDesktopPetVisibleFootprintForMode(mode);
  return {
    x: Math.round(bounds.x + footprint.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x),
    y: Math.round(bounds.y + footprint.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y)
  };
}

export const __testInternals = {
  DEFAULT_OFFSET,
  DEFAULT_DESKTOP_PET_ID,
  DESKTOP_PET_CONFIG_FILE,
  DESKTOP_PET_STATE_FILE,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
  DESKTOP_PET_WINDOW_SIZES,
  sanitizeDesktopPetStoredState,
  normalizeDesktopPetAppearanceId,
  selectedPetIdForAppearance,
  sanitizeUserPetDirectoryName,
  sanitizeDesktopPetAssetRelativePath,
  userPetAssetBaseUrl,
  userPetAssetUrl,
  normalizeUserDesktopPetId,
  sanitizeDesktopPetMessagePreview,
  sanitizeDesktopPetUnreadCount,
  resolveMergedDesktopPetStatus,
  resolveDesktopPetEdgeDock,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetRoot,
  getDesktopPetStatePath,
  listUserDesktopPets,
  listUserDesktopPetAppearanceOptions
};
