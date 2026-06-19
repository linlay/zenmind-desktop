import { BRAND_ID } from "./brand";

export const APP_ICON_ASSET_FILENAMES = {
  brandIcon: "brand-icon.png",
  brandMark: "brand-mark.png",
  trayIcon: "tray-icon.png",
  macDockIcon: "icon.png",
  windowsAppIcon: "icon.ico",
  fallbackSmallIcon: "icon-16.png"
} as const;

export const APP_ICON_ASSET_DIRECTORIES = {
  brandAssets: `build/brands/${BRAND_ID}/brand-assets`,
  buildIcons: `build/brands/${BRAND_ID}/icons`,
  distRenderer: `build/brands/${BRAND_ID}/renderer`,
  packagedResources: "."
} as const;
