import mistLight from "./assets/mist-light.svg";
import mistDark from "./assets/mist-dark.svg";
import { DEFAULT_DESKTOP_SKIN, type DesktopSkinDefinition, type DesktopSkinToken } from "./model";
import { OCEAN_DESKTOP_SKIN } from "./oceanSkin";
import { VIOLET_DESKTOP_SKIN } from "./violetSkin";

type SkinTokens = Readonly<Partial<Record<DesktopSkinToken, string>>>;

const light: SkinTokens = Object.freeze({
  "--bg-base": "#EDF3ED",
  "--surface": "rgba(244, 249, 241, var(--alpha-surface))",
  "--surface-strong": "rgba(249, 252, 247, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(229, 239, 229, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(222, 236, 224, var(--alpha-surface-sidebar))",
  "--ink": "#233C33",
  "--ink-soft": "#486055",
  "--ink-muted": "#657A6E",
  "--line": "rgba(58, 93, 72, var(--alpha-line))",
  "--line-strong": "rgba(58, 93, 72, var(--alpha-line-strong))",
  "--accent": "#287653",
  "--accent-rgb": "40, 118, 83",
  "--accent-strong": "#205F43",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--control-button-bg": "rgba(246, 252, 244, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(249, 253, 247, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(52, 103, 72, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(52, 103, 72, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(72, 105, 80, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#194D35",
  "--control-tab-strip-bg": "#DDE9DE",
  "--control-tab-active-bg": "#F3F8F0",
  "--control-tab-hover-bg": "rgba(243, 248, 240, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(57, 108, 77, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(244, 250, 240, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(58, 93, 72, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#F3F8F0",
  "--shell-sidebar-bg": "rgba(231, 241, 230, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(246, 250, 242, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(231, 241, 230, var(--alpha-shell-titlebar-bg))",
});

const dark: SkinTokens = Object.freeze({
  "--bg-base": "#142A22",
  "--surface": "rgba(33, 59, 46, var(--alpha-surface))",
  "--surface-strong": "rgba(28, 49, 39, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(44, 67, 53, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(20, 42, 32, var(--alpha-surface-sidebar))",
  "--ink": "#E3EEE4",
  "--ink-soft": "#BBCEBE",
  "--ink-muted": "#94AD99",
  "--line": "rgba(163, 199, 172, var(--alpha-line))",
  "--line-strong": "rgba(163, 199, 172, var(--alpha-line-strong))",
  "--accent": "#83C79A",
  "--accent-rgb": "131, 199, 154",
  "--accent-strong": "#A1D7B0",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--accent-on": "#132F20",
  "--control-button-bg": "rgba(76, 110, 84, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(32, 58, 43, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(147, 188, 154, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(147, 188, 154, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(109, 147, 116, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#6EAF83",
  "--control-tab-strip-bg": "#1D352A",
  "--control-tab-active-bg": "#284233",
  "--control-tab-hover-bg": "rgba(147, 188, 154, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(147, 188, 154, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(25, 47, 34, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(163, 199, 172, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#1C3326",
  "--shell-sidebar-bg": "rgba(17, 38, 28, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(20, 39, 29, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(20, 39, 29, var(--alpha-shell-titlebar-bg))",
});

const MIST_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "mist",
  tokens: Object.freeze({ light, dark }),
  backgrounds: Object.freeze({
    light: Object.freeze({ imageUrl: mistLight, position: "center" }),
    dark: Object.freeze({ imageUrl: mistDark, position: "center" })
  })
});

// Bundled definitions; imported packages use the separate Main-owned registry.
export const DESKTOP_SKINS = Object.freeze([
  DEFAULT_DESKTOP_SKIN, MIST_DESKTOP_SKIN, OCEAN_DESKTOP_SKIN, VIOLET_DESKTOP_SKIN
]);

export function findDesktopSkin(id: string): DesktopSkinDefinition | undefined {
  return DESKTOP_SKINS.find((skin) => skin.id === id);
}
