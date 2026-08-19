import { BrowserWindow, type Rectangle } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

type DesktopPetLayeredWindow = Pick<BrowserWindow, "isDestroyed" | "setAlwaysOnTop">;

export function applyDesktopPetBrowserWindowLayering(
  win: DesktopPetLayeredWindow | null | undefined,
  platform: NodeJS.Platform | string
) {
  if (!win || win.isDestroyed()) {
    return;
  }

  if (platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
  } else if (platform === "win32") {
    win.setAlwaysOnTop(true);
  }
}

export function createDesktopPetBrowserWindow(options: {
  bounds: Rectangle;
  platform: NodeJS.Platform | string;
  preloadPath: string;
  focusable?: boolean;
  onClosed: () => void;
}) {
  const isMac = options.platform === "darwin";
  const isWindows = options.platform === "win32";

  const win = new BrowserWindow({
    ...options.bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: options.focusable ?? true,
    hasShadow: false,
    title: `${PRODUCT_NAME} Desktop Xianzun`,
    backgroundColor: "#00000000",
    ...(isMac ? { type: "panel" as const } : {}),
    ...(isWindows ? { thickFrame: false } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false
    }
  });

  if (isMac) {
    win.excludedFromShownWindowsMenu = true;
  }

  applyDesktopPetBrowserWindowLayering(win, options.platform);

  win.on("closed", options.onClosed);
  return win;
}
