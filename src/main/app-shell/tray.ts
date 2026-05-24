import path from "node:path";
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions
} from "electron";
import { APP_ICON_ASSET_DIRECTORIES, APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import type { TranslationKey, TranslateFunction } from "../../shared/i18n";

export type AppTrayControllerOptions = {
  platform: NodeJS.Platform;
  appName: string;
  t: TranslateFunction;
  mainDir: string;
  resourcesPath: string;
  getDesktopPetEnabled: () => boolean;
  isDesktopPetSupported: () => boolean;
  openAssistantChat: () => void;
  openAssistantTarget: (source: "tray-click" | "tray-menu") => void;
  openSettings: () => void;
  showDesktopPet: () => void;
  hideDesktopPet: () => void;
  quit: () => void;
};

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
      this.options.openAssistantTarget("tray-click");
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

  private createIcon() {
    const platformIconPath =
      this.options.platform === "win32"
        ? path.join(
            this.options.mainDir,
            "..",
            "..",
            ...APP_ICON_ASSET_DIRECTORIES.buildIcons.split("/"),
            APP_ICON_ASSET_FILENAMES.windowsAppIcon
          )
        : path.join(
            this.options.mainDir,
            "..",
            "..",
            ...APP_ICON_ASSET_DIRECTORIES.buildIcons.split("/"),
            APP_ICON_ASSET_FILENAMES.fallbackSmallIcon
          );
    const iconPaths = [
      path.join(
        this.options.resourcesPath,
        APP_ICON_ASSET_DIRECTORIES.packagedResources,
        APP_ICON_ASSET_FILENAMES.trayIcon
      ),
      path.join(
        this.options.mainDir,
        "..",
        "..",
        APP_ICON_ASSET_DIRECTORIES.distRenderer,
        APP_ICON_ASSET_FILENAMES.trayIcon
      ),
      path.join(this.options.mainDir, "..", "..", APP_ICON_ASSET_DIRECTORIES.public, APP_ICON_ASSET_FILENAMES.trayIcon),
      platformIconPath,
      path.join(this.options.mainDir, "..", "..", APP_ICON_ASSET_DIRECTORIES.public, APP_ICON_ASSET_FILENAMES.brandIcon)
    ];
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
        click: () => this.options.openAssistantTarget("tray-menu")
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
        click: () => this.options.quit()
      }
    ];
    return Menu.buildFromTemplate(template);
  }
}
