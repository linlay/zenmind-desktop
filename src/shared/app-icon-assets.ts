export const APP_ICON_ASSET_FILENAMES = {
  brandIcon: "brand-icon.png",
  trayIcon: "tray-icon.png",
  macDockIcon: "icon.png",
  windowsAppIcon: "icon.ico",
  fallbackSmallIcon: "icon-16.png"
} as const;

export const APP_ICON_ASSET_DIRECTORIES = {
  buildIcons: "build/icons",
  public: "public",
  distRenderer: "dist-renderer",
  packagedResources: "."
} as const;
