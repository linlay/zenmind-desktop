import {
  Menu,
  type MenuItemConstructorOptions
} from "electron";

export type BuildApplicationMenuOptions = {
  appName: string;
  platform: NodeJS.Platform;
  openSettings: () => void;
};

export function buildApplicationMenu(options: BuildApplicationMenuOptions) {
  const isMac = options.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? "设置..." : "设置",
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
          label: "File",
          submenu: [settingsItem, { type: "separator" }, { role: "quit" }]
        },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
