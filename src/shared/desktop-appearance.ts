export const DESKTOP_SKIN_IDS = ["default", "mist"] as const;
export type DesktopSkinId = typeof DESKTOP_SKIN_IDS[number];

export type DesktopBackgroundAsset = Readonly<{
  id: string;
  name: string;
  width: number;
  height: number;
}>;

export type DesktopSkinSettings = Readonly<{
  skinId: DesktopSkinId;
  background: DesktopBackgroundAsset | null;
}>;

// Image bytes are a bounded, runtime projection; never persisted in profile or
// browser storage. Null with asset metadata means the saved file is unavailable.
export type DesktopSkinView = DesktopSkinSettings & { backgroundDataUrl: string | null };
export type DesktopSkinError = "invalidImage" | "imageTooLarge" | "storageFailed" | "unavailable";
export type DesktopSkinResult =
  | { ok: true; settings: DesktopSkinView; cancelled?: boolean }
  | { ok: false; error: DesktopSkinError };

export function isDesktopSkinId(value: unknown): value is DesktopSkinId {
  return value === "default" || value === "mist";
}

export function isDesktopBackgroundId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function normalizeDesktopBackground(value: unknown): DesktopBackgroundAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asset = value as Record<string, unknown>;
  if (!isDesktopBackgroundId(asset.id) || typeof asset.name !== "string" ||
    !Number.isInteger(asset.width) || !Number.isInteger(asset.height) ||
    (asset.width as number) < 1 || (asset.height as number) < 1 ||
    (asset.width as number) > 3840 || (asset.height as number) > 3840) return null;
  return { id: asset.id, name: asset.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180),
    width: asset.width as number, height: asset.height as number };
}
