import type { DesktopSkinId } from "./desktop-appearance";

export type DesktopSkinSummary = {
  skinId: DesktopSkinId;
  name: string;
  source: "builtin" | "installed";
  version?: string;
  available: boolean;
};

export type DesktopSkinState = {
  skinId: DesktopSkinId;
  activeSkinId: DesktopSkinId;
  available: boolean;
  customBackground: { configured: boolean; available: boolean };
};

export type DesktopSkinActionInputs = {
  "desktop.skin.get": Record<string, never>;
  "desktop.skin.list": Record<string, never>;
  "desktop.skin.import": { filePath: string };
  "desktop.skin.set": { skinId: DesktopSkinId; keepBackground?: boolean };
  "desktop.skin.remove": { skinId: DesktopSkinId };
};

export type DesktopSkinActionResults = {
  "desktop.skin.get": DesktopSkinState;
  "desktop.skin.list": { skins: DesktopSkinSummary[] };
  "desktop.skin.import": DesktopSkinSummary;
  "desktop.skin.set": DesktopSkinState;
  "desktop.skin.remove": { skinId: DesktopSkinId; activeSkinId: DesktopSkinId };
};
