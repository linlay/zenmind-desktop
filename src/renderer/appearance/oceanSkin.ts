import oceanLight from "./assets/ocean-light.svg";
import oceanDark from "./assets/ocean-dark.svg";
import type { DesktopSkinDefinition, DesktopSkinToken } from "./model";

type SkinTokens = Readonly<Partial<Record<DesktopSkinToken, string>>>;

const light: SkinTokens = Object.freeze({
  "--bg-base": "#EDF0F3",
  "--surface": "rgba(241, 245, 249, 0.35)",
  "--surface-strong": "rgba(247, 250, 252, 0.94)",
  "--surface-soft": "rgba(229, 234, 239, 0.9)",
  "--surface-sidebar": "rgba(222, 229, 236, 0.72)",
  "--ink": "#232F3C",
  "--ink-soft": "#485460",
  "--ink-muted": "#656F7A",
  "--line": "rgba(58, 75, 93, 0.13)",
  "--line-strong": "rgba(58, 75, 93, 0.24)",
  "--accent": "#2565AA",
  "--accent-rgb": "37, 101, 170",
  "--accent-strong": "#203F5F",
  "--accent-soft": "#DEE6EE",
  "--control-button-bg": "rgba(244, 248, 252, 0.85)",
  "--control-input-bg": "rgba(247, 250, 253, 0.9)",
  "--control-hover-bg": "rgba(52, 77, 103, 0.09)",
  "--control-active-bg": "rgba(52, 77, 103, 0.16)",
  "--control-disabled-bg": "rgba(72, 88, 105, 0.07)",
  "--control-primary-active": "#19334D",
  "--control-tab-strip-bg": "#DDE3E9",
  "--control-tab-active-bg": "#F0F4F8",
  "--control-tab-hover-bg": "rgba(240, 244, 248, 0.6)",
  "--nav-selected-bg": "rgba(57, 82, 108, 0.14)",
  "--sidebar-operation-menu-bg": "rgba(240, 245, 250, 0.96)",
  "--sidebar-operation-menu-border": "rgba(58, 75, 93, 0.19)",
  "--desktop-overlay-panel-bg": "#F0F4F8",
  "--shell-sidebar-bg": "rgba(230, 236, 241, 0.42)",
  "--shell-content-bg": "rgba(242, 246, 250, 0.88)",
  "--shell-titlebar-bg": "rgba(230, 236, 241, 0.84)",
  "--shell-background-tint": "rgba(242, 246, 250, 0.06)"
});

const dark: SkinTokens = Object.freeze({
  "--bg-base": "#141F2A",
  "--surface": "rgba(33, 46, 59, 0.35)",
  "--surface-strong": "rgba(28, 38, 49, 0.96)",
  "--surface-soft": "rgba(44, 55, 67, 0.92)",
  "--surface-sidebar": "rgba(20, 31, 42, 0.72)",
  "--ink": "#E3E8EE",
  "--ink-soft": "#BBC4CE",
  "--ink-muted": "#94A0AD",
  "--line": "rgba(163, 181, 199, 0.12)",
  "--line-strong": "rgba(163, 181, 199, 0.25)",
  "--accent": "#8BBCED",
  "--accent-rgb": "139, 188, 237",
  "--accent-strong": "#A1BCD7",
  "--accent-soft": "rgba(131, 165, 199, 0.16)",
  "--accent-on": "#13212F",
  "--control-button-bg": "rgba(76, 93, 110, 0.2)",
  "--control-input-bg": "#202D3A",
  "--control-hover-bg": "rgba(147, 167, 188, 0.13)",
  "--control-active-bg": "rgba(147, 167, 188, 0.22)",
  "--control-disabled-bg": "rgba(109, 128, 147, 0.09)",
  "--control-primary-active": "#6E8EAF",
  "--control-tab-strip-bg": "#1D2935",
  "--control-tab-active-bg": "#283542",
  "--control-tab-hover-bg": "rgba(147, 167, 188, 0.12)",
  "--nav-selected-bg": "rgba(147, 167, 188, 0.18)",
  "--sidebar-operation-menu-bg": "rgba(25, 36, 47, 0.97)",
  "--sidebar-operation-menu-border": "rgba(163, 181, 199, 0.22)",
  "--desktop-overlay-panel-bg": "#1C2733",
  "--shell-sidebar-bg": "rgba(17, 27, 38, 0.4)",
  "--shell-content-bg": "rgba(20, 29, 39, 0.9)",
  "--shell-titlebar-bg": "rgba(20, 29, 39, 0.88)",
  "--shell-background-tint": "rgba(9, 17, 26, 0.12)"
});

export const OCEAN_DESKTOP_SKIN: DesktopSkinDefinition = Object.freeze({
  id: "ocean",
  tokens: Object.freeze({ light, dark }),
  backgrounds: Object.freeze({
    light: Object.freeze({ imageUrl: oceanLight, position: "center" }),
    dark: Object.freeze({ imageUrl: oceanDark, position: "center" })
  })
});
