import type { DesktopSkinView } from "../../shared/desktop-appearance";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

export type { DesktopSkinToken, DesktopSkinBackground, DesktopSkinDefinition } from "../../shared/desktop-skin-definition";
import type { DesktopSkinDefinition, DesktopSkinBackground } from "../../shared/desktop-skin-definition";

// Existing theme.css remains the default palette's single source of truth.
// The default skin deliberately has no overrides, preserving today's visuals.
export const DEFAULT_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "default",
  tokens: Object.freeze({
    light: Object.freeze({}),
    dark: Object.freeze({})
  })
});

export type DesktopAppearanceSnapshot = Readonly<{
  themeMode: ThemePreference;
  resolvedTheme: ResolvedThemeMode;
  skin: DesktopSkinDefinition;
  skinSettings: DesktopSkinView;
  skinLoadState: "loading" | "ready" | "error";
  skinSaving: boolean;
  background: DesktopSkinBackground | null;
}>;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemUsesDarkColors: boolean
): ResolvedThemeMode {
  return preference === "system" ? (systemUsesDarkColors ? "dark" : "light") : preference;
}

export function createAppearanceSnapshot(
  themeMode: ThemePreference,
  systemUsesDarkColors: boolean,
  skin: DesktopSkinDefinition = DEFAULT_DESKTOP_SKIN,
  settings: DesktopSkinView = { skinId: "default", background: null, backgroundDataUrl: null },
  skinLoadState: DesktopAppearanceSnapshot["skinLoadState"] = "ready",
  skinSaving = false
): DesktopAppearanceSnapshot {
  const resolvedTheme = resolveThemePreference(themeMode, systemUsesDarkColors);
  return {
    themeMode,
    resolvedTheme,
    skin,
    skinSettings: settings,
    skinLoadState,
    skinSaving,
    background: settings.backgroundDataUrl
      ? { imageUrl: settings.backgroundDataUrl, position: "center" }
      : skin.backgrounds?.[resolvedTheme] ?? null
  };
}
