import {
  Menu,
  type MenuItemConstructorOptions
} from "electron";
import type { TranslateFunction } from "../../shared/i18n";

export type BuildApplicationMenuOptions = {
  appName: string;
  platform: NodeJS.Platform;
  t: TranslateFunction;
  openSettings: () => void;
  requestQuit: () => void;
};

export function buildApplicationMenu(options: BuildApplicationMenuOptions) {
  const isMac = options.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? options.t("menu.settingsEllipsis") : options.t("menu.settings"),
    accelerator: "CmdOrCtrl+,",
    click: () => options.openSettings()
  };

  const template: MenuItemConstructorOptions[] = [
    isMac
      ? {
          label: options.appName,
          submenu: [
            { role: "about" },
            { type: "separator" },
            settingsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: options.t("menu.quit", { appName: options.appName }),
              accelerator: "Command+Q",
              click: () => options.requestQuit()
            }
          ]
        }
      : {
          label: options.t("menu.file"),
          submenu: [settingsItem, { type: "separator" }, { role: "quit" }]
        },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
