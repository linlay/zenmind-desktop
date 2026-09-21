import type { DesktopPetReadOptions, DesktopPetStoredState, Platform } from "./pet-model";
import { DEFAULT_DESKTOP_PET_ID, DESKTOP_PET_SCHEMA_VERSION } from "./pet-model";
import {
  sanitizeDesktopPetUnreadCount,
  normalizeDesktopPetBoundAgentKey,
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  normalizeDesktopPetAppearanceId
} from "../../../shared/desktop-pet";
import { DEFAULT_OFFSET } from "./pet-window-metrics";
import fs from "node:fs";
import type { App } from "electron";
import { ensureDesktopPetRoot, getDesktopPetSettingsPath, getDesktopPetStatePath, ensureDesktopPetStateRoot } from "./pet-paths";
import type { DesktopPetSettings } from "../../../shared/contracts";

export function sanitizeDesktopPetStoredState(
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
  const rawSelectedPetId = typeof candidate.selectedPetId === "string" && candidate.selectedPetId.trim()
    ? candidate.selectedPetId.trim()
    : DEFAULT_DESKTOP_PET_ID;
  const appearanceId = appearanceForSelectedPetId(rawSelectedPetId);
  const selectedPetId = selectedPetIdForAppearance(appearanceId);
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

function appearanceForSelectedPetId(selectedPetId: string) {
  return selectedPetId === DEFAULT_DESKTOP_PET_ID
    ? DEFAULT_DESKTOP_PET_APPEARANCE_ID
    : normalizeDesktopPetAppearanceId(selectedPetId.replace(/^builtin:/u, ""));
}

export function selectedPetIdForAppearance(appearanceId: string) {
  if (appearanceId.startsWith("user:")) {
    return appearanceId;
  }
  return appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
    ? DEFAULT_DESKTOP_PET_ID
    : `builtin:${appearanceId}`;
}

export function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).name === "SyntaxError") {
      return null;
    }
    throw error;
  }
}

export function toDesktopPetConfigFile(state: DesktopPetStoredState) {
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

export function toDesktopPetStateFile(state: DesktopPetStoredState) {
  return {
    schemaVersion: DESKTOP_PET_SCHEMA_VERSION,
    unreadCount: state.unreadCount,
    updatedAt: Date.now()
  };
}

export function mergeDesktopPetRuntimeState(config: unknown, runtimeState: unknown) {
  return {
    ...(config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {}),
    unreadCount: runtimeState && typeof runtimeState === "object" && !Array.isArray(runtimeState)
      ? (runtimeState as { unreadCount?: unknown }).unreadCount
      : 0
  };
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

  ensureDesktopPetRoot(app, platform);
  const settingsPath = getDesktopPetSettingsPath(app, platform);
  const statePath = getDesktopPetStatePath(app, platform);
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

  ensureDesktopPetRoot(app, platform);
  ensureDesktopPetStateRoot(app, platform);
  fs.writeFileSync(getDesktopPetSettingsPath(app, platform), `${JSON.stringify(toDesktopPetConfigFile(sanitized), null, 2)}\n`, "utf8");
  fs.writeFileSync(getDesktopPetStatePath(app, platform), `${JSON.stringify(toDesktopPetStateFile(sanitized), null, 2)}\n`, "utf8");
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
