export const APP_ICON_ASSET_FILENAMES = {
  brandIcon: "brand-icon.png",
  brandMark: "brand-mark.png",
  trayIcon: "tray-icon.png",
  macDockIcon: "icon.png",
  windowsAppIcon: "icon.ico",
  fallbackSmallIcon: "icon-16.png"
} as const;

export const APP_ICON_ASSET_DIRECTORIES = {
  brandAssets: "build/generated/brand-assets",
  buildIcons: "build/icons",
  distRenderer: "dist-renderer",
  packagedResources: "."
} as const;
