import path from "node:path";
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions
} from "electron";
import { APP_ICON_ASSET_DIRECTORIES, APP_ICON_ASSET_FILENAMES } from "../../../shared/app-icon-assets";
import type { TranslationKey, TranslateFunction } from "../../../shared/i18n";

export type AppTrayControllerOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appName: string;
  t: TranslateFunction;
  mainDir: string;
  resourcesPath: string;
  getDesktopPetEnabled: () => boolean;
  isDesktopPetSupported: () => boolean;
  openAssistantChat: () => void;
  showMainWindow: () => void;
  openSettings: () => void;
  showDesktopPet: () => void;
  hideDesktopPet: () => void;
  quitWithoutConfirmation: () => void;
};

export type AppTrayIconPathOptions = Pick<
  AppTrayControllerOptions,
  "platform" | "isPackaged" | "mainDir" | "resourcesPath"
>;

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function projectRootFromMainDir(mainDir: string, platform: NodeJS.Platform) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "win32") {
    return pathApi.resolve(pathApi.join(mainDir, ".."));
  }
  if (platform === "darwin") {
    return pathApi.resolve(pathApi.join(mainDir, ".."));
  }
  return pathApi.resolve(pathApi.join(mainDir, ".."));
}

function projectAssetPath(options: AppTrayIconPathOptions, directoryName: string, fileName: string) {
  const pathApi = pathApiForPlatform(options.platform);
  return pathApi.join(projectRootFromMainDir(options.mainDir, options.platform), directoryName, fileName);
}

function packagedResourcePath(options: AppTrayIconPathOptions, fileName: string) {
  const pathApi = pathApiForPlatform(options.platform);
  return pathApi.join(options.resourcesPath, APP_ICON_ASSET_DIRECTORIES.packagedResources, fileName);
}

function platformFallbackIconPath(options: AppTrayIconPathOptions) {
  if (options.platform === "win32") {
    return projectAssetPath(
      options,
      APP_ICON_ASSET_DIRECTORIES.buildIcons,
      APP_ICON_ASSET_FILENAMES.windowsAppIcon
    );
  }
  if (options.platform === "darwin") {
    return projectAssetPath(
      options,
      APP_ICON_ASSET_DIRECTORIES.buildIcons,
      APP_ICON_ASSET_FILENAMES.fallbackSmallIcon
    );
  }
  return projectAssetPath(
    options,
    APP_ICON_ASSET_DIRECTORIES.buildIcons,
    APP_ICON_ASSET_FILENAMES.fallbackSmallIcon
  );
}

export function getWindowsDevelopmentAppIconPath(options: AppTrayIconPathOptions) {
  if (options.platform !== "win32" || options.isPackaged) {
    return undefined;
  }
  return platformFallbackIconPath(options);
}

export function getAppTrayIconCandidatePaths(options: AppTrayIconPathOptions) {
  const generatedTrayIconPath = projectAssetPath(
    options,
    APP_ICON_ASSET_DIRECTORIES.brandAssets,
    APP_ICON_ASSET_FILENAMES.trayIcon
  );
  const generatedBrandIconPath = projectAssetPath(
    options,
    APP_ICON_ASSET_DIRECTORIES.brandAssets,
    APP_ICON_ASSET_FILENAMES.brandIcon
  );
  const rendererTrayIconPath = projectAssetPath(
    options,
    APP_ICON_ASSET_DIRECTORIES.distRenderer,
    APP_ICON_ASSET_FILENAMES.trayIcon
  );
  const rendererBrandIconPath = projectAssetPath(
    options,
    APP_ICON_ASSET_DIRECTORIES.distRenderer,
    APP_ICON_ASSET_FILENAMES.brandIcon
  );
  const fallbackIconPath = platformFallbackIconPath(options);

  if (options.isPackaged) {
    if (options.platform === "darwin") {
      return [
        packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.trayIcon),
        rendererTrayIconPath,
        generatedTrayIconPath,
        fallbackIconPath,
        packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.brandIcon),
        rendererBrandIconPath,
        generatedBrandIconPath
      ];
    }

    return [
      packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.trayIcon),
      rendererTrayIconPath,
      fallbackIconPath,
      packagedResourcePath(options, APP_ICON_ASSET_FILENAMES.brandIcon),
      rendererBrandIconPath,
      generatedTrayIconPath,
      generatedBrandIconPath
    ];
  }

  if (options.platform === "darwin") {
    return [
      generatedTrayIconPath,
      fallbackIconPath,
      generatedBrandIconPath
    ];
  }

  if (options.platform === "win32") {
    return [
      generatedTrayIconPath,
      fallbackIconPath,
      generatedBrandIconPath
    ];
  }

  return [
    generatedTrayIconPath,
    fallbackIconPath,
    generatedBrandIconPath
  ];
}

export class AppTrayController {
  private tray: Tray | null = null;

  constructor(private readonly options: AppTrayControllerOptions) {}

  create() {
    if (this.tray) {
      return this.tray;
    }

    this.tray = new Tray(this.createIcon());
    this.tray.setToolTip(this.options.appName);
    if (this.options.platform !== "darwin") {
      this.tray.setContextMenu(this.buildMenu());
    }
    this.tray.on("click", () => {
      this.options.showMainWindow();
    });
    this.tray.on("right-click", () => this.tray?.popUpContextMenu(this.buildMenu()));

    return this.tray;
  }

  refreshContextMenu() {
    if (!this.tray) {
      return;
    }
    this.tray.setToolTip(this.options.appName);
    if (this.options.platform === "darwin") {
      return;
    }
    this.tray.setContextMenu(this.buildMenu());
  }

  destroy() {
    if (!this.tray) {
      return;
    }
    this.tray.destroy();
    this.tray = null;
  }

  private createIcon() {
    const iconPaths = getAppTrayIconCandidatePaths(this.options);
    const icon =
      iconPaths
        .map((iconPath) => nativeImage.createFromPath(iconPath))
        .find((candidate) => !candidate.isEmpty()) ?? nativeImage.createEmpty();
    const resizedIcon = icon.resize({ width: 20, height: 20 });
    if (this.options.platform === "darwin") {
      resizedIcon.setTemplateImage(true);
    }
    return resizedIcon;
  }

  private buildMenu() {
    const t = (key: TranslationKey, params?: Parameters<TranslateFunction>[1]) => this.options.t(key, params);
    const template: MenuItemConstructorOptions[] = [
      {
        label: t("tray.chatWithApp", { appName: this.options.appName }),
        click: () => this.options.openAssistantChat()
      },
      {
        label: t("tray.openApp", { appName: this.options.appName }),
        click: () => this.options.showMainWindow()
      },
      {
        label: t("tray.settings"),
        click: () => this.options.openSettings()
      },
      ...(this.options.isDesktopPetSupported()
        ? [
            { type: "separator" as const },
            {
              label: this.options.getDesktopPetEnabled() ? t("tray.hideDesktopPet") : t("tray.showDesktopPet"),
              click: () => {
                if (this.options.getDesktopPetEnabled()) {
                  this.options.hideDesktopPet();
                  return;
                }
                this.options.showDesktopPet();
              }
            }
          ]
        : []),
      { type: "separator" },
      {
        label: t("tray.quit"),
        click: () => this.options.quitWithoutConfirmation()
      }
    ];
    return Menu.buildFromTemplate(template);
  }
}
