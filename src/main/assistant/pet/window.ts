import { BrowserWindow, type Rectangle } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

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
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else if (isWindows) {
    win.setAlwaysOnTop(true);
  }

  win.on("closed", options.onClosed);
  return win;
}
