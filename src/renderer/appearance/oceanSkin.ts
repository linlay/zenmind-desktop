import oceanLight from "./assets/ocean-light.svg";
import oceanDark from "./assets/ocean-dark.svg";
import type { DesktopSkinDefinition, DesktopSkinToken } from "./model";

type SkinTokens = Readonly<Partial<Record<DesktopSkinToken, string>>>;

const light: SkinTokens = Object.freeze({
  "--bg-base": "#EDF0F3",
  "--surface": "rgba(241, 245, 249, var(--alpha-surface))",
  "--surface-strong": "rgba(247, 250, 252, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(229, 234, 239, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(222, 229, 236, var(--alpha-surface-sidebar))",
  "--ink": "#232F3C",
  "--ink-soft": "#485460",
  "--ink-muted": "#656F7A",
  "--line": "rgba(58, 75, 93, var(--alpha-line))",
  "--line-strong": "rgba(58, 75, 93, var(--alpha-line-strong))",
  "--accent": "#2565AA",
  "--accent-rgb": "37, 101, 170",
  "--accent-strong": "#203F5F",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--control-button-bg": "rgba(244, 248, 252, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(247, 250, 253, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(52, 77, 103, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(52, 77, 103, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(72, 88, 105, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#19334D",
  "--control-tab-strip-bg": "#DDE3E9",
  "--control-tab-active-bg": "#F0F4F8",
  "--control-tab-hover-bg": "rgba(240, 244, 248, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(57, 82, 108, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(240, 245, 250, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(58, 75, 93, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#F0F4F8",
  "--shell-sidebar-bg": "rgba(230, 236, 241, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(242, 246, 250, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(230, 236, 241, var(--alpha-shell-titlebar-bg))",
});

const dark: SkinTokens = Object.freeze({
  "--bg-base": "#141F2A",
  "--surface": "rgba(33, 46, 59, var(--alpha-surface))",
  "--surface-strong": "rgba(28, 38, 49, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(44, 55, 67, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(20, 31, 42, var(--alpha-surface-sidebar))",
  "--ink": "#E3E8EE",
  "--ink-soft": "#BBC4CE",
  "--ink-muted": "#94A0AD",
  "--line": "rgba(163, 181, 199, var(--alpha-line))",
  "--line-strong": "rgba(163, 181, 199, var(--alpha-line-strong))",
  "--accent": "#8BBCED",
  "--accent-rgb": "139, 188, 237",
  "--accent-strong": "#A1BCD7",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--accent-on": "#13212F",
  "--control-button-bg": "rgba(76, 93, 110, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(32, 45, 58, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(147, 167, 188, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(147, 167, 188, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(109, 128, 147, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#6E8EAF",
  "--control-tab-strip-bg": "#1D2935",
  "--control-tab-active-bg": "#283542",
  "--control-tab-hover-bg": "rgba(147, 167, 188, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(147, 167, 188, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(25, 36, 47, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(163, 181, 199, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#1C2733",
  "--shell-sidebar-bg": "rgba(17, 27, 38, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(20, 29, 39, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(20, 29, 39, var(--alpha-shell-titlebar-bg))",
});

export const OCEAN_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "ocean",
  tokens: Object.freeze({ light, dark }),
  backgrounds: Object.freeze({
    light: Object.freeze({ imageUrl: oceanLight, position: "center" }),
    dark: Object.freeze({ imageUrl: oceanDark, position: "center" })
  })
});
