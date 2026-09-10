import type { DesktopSkinView } from "../../shared/desktop-appearance";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

// Skin overrides are visual properties only; layout and guest surfaces retain
// their own contracts. Extend this list as shell controls adopt shared tokens.
export type DesktopSkinToken =
  | "--bg-base"
  | "--surface"
  | "--surface-strong"
  | "--surface-soft"
  | "--surface-sidebar"
  | "--ink"
  | "--ink-soft"
  | "--ink-muted"
  | "--line"
  | "--line-strong"
  | "--accent"
  | "--accent-strong"
  | "--accent-soft"
  | "--accent-rgb"
  | "--accent-on"
  | "--accent-glow"
  | "--control-radius"
  | "--control-radius-sm"
  | "--control-radius-lg"
  | "--control-button-bg"
  | "--control-select-bg"
  | "--control-input-bg"
  | "--control-border"
  | "--control-hover-bg"
  | "--control-active-bg"
  | "--control-disabled-bg"
  | "--control-disabled-opacity"
  | "--control-icon-color"
  | "--control-icon-hover-color"
  | "--control-primary-bg"
  | "--control-primary-hover"
  | "--control-primary-active"
  | "--control-primary-shadow"
  | "--control-popover-bg"
  | "--control-tab-strip-bg"
  | "--control-tab-active-bg"
  | "--control-tab-hover-bg"
  | "--nav-hover-bg"
  | "--nav-selected-bg"
  | "--nav-selected-text"
  | "--nav-accent-selected-bg"
  | "--overlay-radius"
  | "--desktop-overlay-panel-bg"
  | "--sidebar-operation-menu-bg"
  | "--sidebar-operation-menu-border"
  | "--sidebar-operation-menu-shadow"
  | "--modal-mask-bg"
  | "--panel-shadow"
  | "--panel-shadow-hover"
  | "--shell-sidebar-bg"
  | "--shell-content-bg"
  | "--shell-titlebar-bg"
  | "--shell-background-tint";

export type DesktopSkinBackground = Readonly<{
  imageUrl: string;
  position: string;
}>;

export type DesktopSkinDefinition = Readonly<{
  id: string;
  tokens: Readonly<Record<ResolvedThemeMode, Readonly<Partial<Record<DesktopSkinToken, string>>>>>;
  backgrounds?: Readonly<Record<ResolvedThemeMode, DesktopSkinBackground>>;
}>;

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
