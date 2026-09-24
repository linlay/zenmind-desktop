import violetLight from "./assets/violet-light.svg";
import violetDark from "./assets/violet-dark.svg";
import type { DesktopSkinDefinition, DesktopSkinToken } from "./model";

type SkinTokens = Readonly<Partial<Record<DesktopSkinToken, string>>>;

const light: SkinTokens = Object.freeze({
  "--bg-base": "#F0EDF3",
  "--surface": "rgba(245, 241, 249, var(--alpha-surface))",
  "--surface-strong": "rgba(250, 247, 252, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(234, 229, 239, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(229, 222, 236, var(--alpha-surface-sidebar))",
  "--ink": "#2F233C",
  "--ink-soft": "#544860",
  "--ink-muted": "#6F657A",
  "--line": "rgba(75, 58, 93, var(--alpha-line))",
  "--line-strong": "rgba(75, 58, 93, var(--alpha-line-strong))",
  "--accent": "#7950A9",
  "--accent-rgb": "121, 80, 169",
  "--accent-strong": "#3F205F",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--control-button-bg": "rgba(248, 244, 252, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(250, 247, 253, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(77, 52, 103, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(77, 52, 103, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(88, 72, 105, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#33194D",
  "--control-tab-strip-bg": "#E3DDE9",
  "--control-tab-active-bg": "#F4F0F8",
  "--control-tab-hover-bg": "rgba(244, 240, 248, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(82, 57, 108, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(245, 240, 250, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(75, 58, 93, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#F4F0F8",
  "--shell-sidebar-bg": "rgba(236, 230, 241, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(246, 242, 250, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(236, 230, 241, var(--alpha-shell-titlebar-bg))",
});

const dark: SkinTokens = Object.freeze({
  "--bg-base": "#1F142A",
  "--surface": "rgba(46, 33, 59, var(--alpha-surface))",
  "--surface-strong": "rgba(38, 28, 49, var(--alpha-surface-strong))",
  "--surface-soft": "rgba(55, 44, 67, var(--alpha-surface-soft))",
  "--surface-sidebar": "rgba(31, 20, 42, var(--alpha-surface-sidebar))",
  "--ink": "#E8E3EE",
  "--ink-soft": "#C4BBCE",
  "--ink-muted": "#A094AD",
  "--line": "rgba(181, 163, 199, var(--alpha-line))",
  "--line-strong": "rgba(181, 163, 199, var(--alpha-line-strong))",
  "--accent": "#C2A2E6",
  "--accent-rgb": "194, 162, 230",
  "--accent-strong": "#BCA1D7",
  "--accent-soft": "rgba(var(--accent-rgb), var(--alpha-accent-soft))",
  "--accent-on": "#21132F",
  "--control-button-bg": "rgba(93, 76, 110, var(--alpha-control-button-bg))",
  "--control-select-bg": "rgba(45, 32, 58, var(--alpha-control-select-bg))",
  "--control-hover-bg": "rgba(167, 147, 188, var(--alpha-control-hover-bg))",
  "--control-active-bg": "rgba(167, 147, 188, var(--alpha-control-active-bg))",
  "--control-disabled-bg": "rgba(128, 109, 147, var(--alpha-control-disabled-bg))",
  "--control-primary-active": "#8E6EAF",
  "--control-tab-strip-bg": "#291D35",
  "--control-tab-active-bg": "#352842",
  "--control-tab-hover-bg": "rgba(167, 147, 188, var(--alpha-control-tab-hover-bg))",
  "--nav-selected-bg": "rgba(167, 147, 188, var(--alpha-nav-selected-bg))",
  "--sidebar-operation-menu-bg": "rgba(36, 25, 47, var(--alpha-sidebar-operation-menu-bg))",
  "--sidebar-operation-menu-border": "rgba(181, 163, 199, var(--alpha-sidebar-operation-menu-border))",
  "--desktop-overlay-panel-bg": "#271C33",
  "--shell-sidebar-bg": "rgba(27, 17, 38, var(--alpha-shell-sidebar-bg))",
  "--shell-content-bg": "rgba(29, 20, 39, var(--alpha-shell-content-bg))",
  "--shell-titlebar-bg": "rgba(29, 20, 39, var(--alpha-shell-titlebar-bg))",
});

export const VIOLET_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "violet",
  tokens: Object.freeze({ light, dark }),
  backgrounds: Object.freeze({
    light: Object.freeze({ imageUrl: violetLight, position: "center" }),
    dark: Object.freeze({ imageUrl: violetDark, position: "center" })
  })
});
