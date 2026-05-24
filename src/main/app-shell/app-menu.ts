import {
  Menu,
  type MenuItemConstructorOptions
} from "electron";

export type BuildApplicationMenuOptions = {
  appName: string;
  platform: NodeJS.Platform;
  t: (key: "menu.file" | "menu.settings" | "menu.settingsEllipsis") => string;
  openSettings: () => void;
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
            { role: "quit" }
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
