import {
  Menu,
  type MenuItemConstructorOptions,
  type BrowserWindow
} from "electron";
import type { TranslateFunction } from "../../../shared/i18n";

export type BuildApplicationMenuOptions = {
  appName: string;
  platform: NodeJS.Platform;
  t: TranslateFunction;
  openSettings: () => void;
  openHelp: () => void;
  requestCloseWindow: () => void;
  requestQuit: () => void;
  quitWithoutConfirmation: () => void;
};

const windowsMenus = new Map<string, Menu>();

export function popupWindowsApplicationMenu(window: BrowserWindow, request: unknown): Promise<boolean> {
  const input = request as { menu?: string; x?: number; y?: number } | null;
  const menu = input && windowsMenus.get(input.menu ?? "");
  if (!menu || !Number.isFinite(input?.x) || !Number.isFinite(input?.y)) {
    return Promise.resolve(false);
  }
  const [width, height] = window.getContentSize();
  return new Promise((resolve) => menu.popup({
    window,
    x: Math.max(0, Math.min(width - 1, Math.round(input!.x!))),
    y: Math.max(0, Math.min(height - 1, Math.round(input!.y!))),
    callback: () => resolve(true)
  }));
}

export function buildApplicationMenu(options: BuildApplicationMenuOptions) {
  if (options.platform === "win32") {
    Menu.setApplicationMenu(null);
    windowsMenus.clear();
    const editRoles = ["undo", "redo", "cut", "copy", "paste", "selectAll"] as const;
    windowsMenus.set("file", Menu.buildFromTemplate([
      { label: options.t("menu.settings"), click: options.openSettings },
      { type: "separator" },
      { label: options.t("menu.closeWindow"), click: options.requestCloseWindow },
      { label: options.t("menu.quit", { appName: options.appName }), click: options.requestQuit }
    ]));
    windowsMenus.set("edit", Menu.buildFromTemplate(editRoles.map((role) => ({
      role,
      label: options.t(`webviewContextMenu.edit.${role === "selectAll" ? "select-all" : role}`)
    }))));
    windowsMenus.set("view", Menu.buildFromTemplate([
      { role: "reload", label: options.t("webviewContextMenu.page.reload") },
      { type: "separator" },
      { role: "resetZoom", label: options.t("menu.resetZoom") },
      { role: "zoomIn", label: options.t("menu.zoomIn") },
      { role: "zoomOut", label: options.t("menu.zoomOut") },
      { type: "separator" },
      { role: "toggleDevTools", label: options.t("menu.devTools") }
    ]));
    windowsMenus.set("help", Menu.buildFromTemplate([
      { label: options.t("nav.help"), click: options.openHelp },
      { role: "about", label: options.t("menu.about", { appName: options.appName }) }
    ]));
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
