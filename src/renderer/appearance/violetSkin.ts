import violetLight from "./assets/violet-light.svg";
import violetDark from "./assets/violet-dark.svg";
import type { DesktopSkinDefinition, DesktopSkinToken } from "./model";

type SkinTokens = Readonly<Partial<Record<DesktopSkinToken, string>>>;

const light: SkinTokens = Object.freeze({
  "--bg-base": "#F0EDF3",
  "--surface": "rgba(245, 241, 249, 0.35)",
  "--surface-strong": "rgba(250, 247, 252, 0.94)",
  "--surface-soft": "rgba(234, 229, 239, 0.9)",
  "--surface-sidebar": "rgba(229, 222, 236, 0.72)",
  "--ink": "#2F233C",
  "--ink-soft": "#544860",
  "--ink-muted": "#6F657A",
  "--line": "rgba(75, 58, 93, 0.13)",
  "--line-strong": "rgba(75, 58, 93, 0.24)",
  "--accent": "#7950A9",
  "--accent-rgb": "121, 80, 169",
  "--accent-strong": "#3F205F",
  "--accent-soft": "#E6DEEE",
  "--control-button-bg": "rgba(248, 244, 252, 0.85)",
  "--control-input-bg": "rgba(250, 247, 253, 0.9)",
  "--control-hover-bg": "rgba(77, 52, 103, 0.09)",
  "--control-active-bg": "rgba(77, 52, 103, 0.16)",
  "--control-disabled-bg": "rgba(88, 72, 105, 0.07)",
  "--control-primary-active": "#33194D",
  "--control-tab-strip-bg": "#E3DDE9",
  "--control-tab-active-bg": "#F4F0F8",
  "--control-tab-hover-bg": "rgba(244, 240, 248, 0.6)",
  "--nav-selected-bg": "rgba(82, 57, 108, 0.14)",
  "--sidebar-operation-menu-bg": "rgba(245, 240, 250, 0.96)",
  "--sidebar-operation-menu-border": "rgba(75, 58, 93, 0.19)",
  "--desktop-overlay-panel-bg": "#F4F0F8",
  "--shell-sidebar-bg": "rgba(236, 230, 241, 0.42)",
  "--shell-content-bg": "rgba(246, 242, 250, 0.88)",
  "--shell-titlebar-bg": "rgba(236, 230, 241, 0.84)",
  "--shell-background-tint": "rgba(246, 242, 250, 0.06)"
});

const dark: SkinTokens = Object.freeze({
  "--bg-base": "#1F142A",
  "--surface": "rgba(46, 33, 59, 0.35)",
  "--surface-strong": "rgba(38, 28, 49, 0.96)",
  "--surface-soft": "rgba(55, 44, 67, 0.92)",
  "--surface-sidebar": "rgba(31, 20, 42, 0.72)",
  "--ink": "#E8E3EE",
  "--ink-soft": "#C4BBCE",
  "--ink-muted": "#A094AD",
  "--line": "rgba(181, 163, 199, 0.12)",
  "--line-strong": "rgba(181, 163, 199, 0.25)",
  "--accent": "#C2A2E6",
  "--accent-rgb": "194, 162, 230",
  "--accent-strong": "#BCA1D7",
  "--accent-soft": "rgba(165, 131, 199, 0.16)",
  "--accent-on": "#21132F",
  "--control-button-bg": "rgba(93, 76, 110, 0.2)",
  "--control-input-bg": "#2D203A",
  "--control-hover-bg": "rgba(167, 147, 188, 0.13)",
  "--control-active-bg": "rgba(167, 147, 188, 0.22)",
  "--control-disabled-bg": "rgba(128, 109, 147, 0.09)",
  "--control-primary-active": "#8E6EAF",
  "--control-tab-strip-bg": "#291D35",
  "--control-tab-active-bg": "#352842",
  "--control-tab-hover-bg": "rgba(167, 147, 188, 0.12)",
  "--nav-selected-bg": "rgba(167, 147, 188, 0.18)",
  "--sidebar-operation-menu-bg": "rgba(36, 25, 47, 0.97)",
  "--sidebar-operation-menu-border": "rgba(181, 163, 199, 0.22)",
  "--desktop-overlay-panel-bg": "#271C33",
  "--shell-sidebar-bg": "rgba(27, 17, 38, 0.4)",
  "--shell-content-bg": "rgba(29, 20, 39, 0.9)",
  "--shell-titlebar-bg": "rgba(29, 20, 39, 0.88)",
  "--shell-background-tint": "rgba(17, 9, 26, 0.12)"
});

export const VIOLET_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "violet",
  tokens: Object.freeze({ light, dark }),
  backgrounds: Object.freeze({
    light: Object.freeze({ imageUrl: violetLight, position: "center" }),
    dark: Object.freeze({ imageUrl: violetDark, position: "center" })
  })
});
