import {
  DESKTOP_PET_USER_ASSET_PROTOCOL,
  DESKTOP_PET_REQUIRED_STATE_KEYS,
  DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES,
  DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES
} from "../../../shared/desktop-pet";
import type { App } from "electron";
import type { UserDesktopPetAsset } from "./pet-model";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./pet-settings";
import type { DesktopPetSignatureAction, DesktopPetStateAsset, DesktopPetStateAssets, DesktopPetAppearanceOption } from "../../../shared/contracts";

export function sanitizeUserPetDirectoryName(value: unknown) {
  const normalized = typeof value === "string"
    ? value.trim().replace(/^user:/u, "")
    : "";
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

export function normalizeUserDesktopPetId(value: unknown, fallbackDirectoryName: string) {
  const directoryName = sanitizeUserPetDirectoryName(value) || sanitizeUserPetDirectoryName(fallbackDirectoryName);
  return directoryName ? `user:${directoryName}` : "";
}

export function sanitizeDesktopPetAssetRelativePath(value: unknown) {
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

export function encodeDesktopPetAssetPath(relativePath: string) {
  return relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function userPetAssetBaseUrl(petId: string) {
  const safePetId = sanitizeUserPetDirectoryName(petId);
  return safePetId ? `${DESKTOP_PET_USER_ASSET_PROTOCOL}://${encodeURIComponent(safePetId)}/` : "";
}

export function userPetAssetUrl(petId: string, relativePath: string) {
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

export function readUserPetText(manifest: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = manifest[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

export const FORBIDDEN_DESKTOP_PET_MANIFEST_KEYS = new Set(["previewAssetPath", "signatureActions", "capabilities"]);

export const DESKTOP_PET_REQUIRED_STATE_KEY_SET: ReadonlySet<string> = new Set(DESKTOP_PET_REQUIRED_STATE_KEYS);

export function isForbiddenDesktopPetAssetPath(relativePath: string) {
  const safeRelative = sanitizeDesktopPetAssetRelativePath(relativePath);
  const fileName = path.posix.basename(safeRelative);
  return fileName.startsWith("pet-") ||
    safeRelative === "task-run-left.webp" ||
    safeRelative === "dance.webp";
}

export function isDesktopPetAssetFilePresent(rootPath: string, relativePath: string) {
  const safeRelative = sanitizeDesktopPetAssetRelativePath(relativePath);
  return Boolean(
    safeRelative &&
    !isForbiddenDesktopPetAssetPath(safeRelative) &&
    fs.existsSync(path.join(rootPath, safeRelative))
  );
}

export function hasForbiddenDesktopPetManifestKey(manifest: Record<string, unknown>) {
  return Object.keys(manifest).some((key) => FORBIDDEN_DESKTOP_PET_MANIFEST_KEYS.has(key));
}

export function userPetPreviewUrl(pet: UserDesktopPetAsset, preview: string) {
  return userPetAssetUrl(pet.petId, preview);
}

export function sanitizeDesktopPetSignaturePath(value: unknown) {
  return sanitizeDesktopPetAssetRelativePath(value);
}

export function sanitizeDesktopPetSignatureActions(value: unknown): DesktopPetSignatureAction[] | undefined {
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

export function isDesktopPetStandardFrameCount(frameCount: number) {
  return frameCount >= DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES &&
    frameCount <= DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES;
}

export function sanitizeDesktopPetStateAsset(
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

export function sanitizeDesktopPetStates(value: unknown): DesktopPetStateAssets | undefined {
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

export function areDesktopPetSignatureAssetsPresent(rootPath: string, actions: DesktopPetSignatureAction[] | undefined) {
  if (!actions) {
    return true;
  }
  return actions.every((action) =>
    action.variants.every((variant) => isDesktopPetAssetFilePresent(rootPath, variant.path))
  );
}

export function areDesktopPetStateAssetsPresent(rootPath: string, states: DesktopPetStateAssets | undefined) {
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
