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
  requestCloseWindow: () => void;
  requestQuit: () => void;
  quitWithoutConfirmation: () => void;
};

export function buildApplicationMenu(options: BuildApplicationMenuOptions) {
  if (options.platform === "win32") {
    Menu.setApplicationMenu(null);
    return;
  }

  const isMac = options.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? options.t("menu.settingsEllipsis") : options.t("menu.settings"),
    accelerator: "CmdOrCtrl+,",
    click: () => options.openSettings()
  };
  const windowMenuItem: MenuItemConstructorOptions = isMac
    ? {
        label: options.t("menu.window"),
        submenu: [
          {
            label: options.t("menu.closeWindow"),
            accelerator: "Command+W",
            click: () => options.requestCloseWindow()
          },
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" }
        ]
      }
    : { role: "windowMenu" };

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
              click: (_menuItem, _window, event) => {
                if (event.triggeredByAccelerator) {
                  options.requestQuit();
                  return;
                }
                options.quitWithoutConfirmation();
              }
            }
          ]
        }
      : {
          label: options.t("menu.file"),
          submenu: [settingsItem, { type: "separator" }, { role: "quit" }]
        },
    { role: "editMenu" },
    { role: "viewMenu" },
    windowMenuItem
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
