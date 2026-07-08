import { BrowserWindow, type Rectangle } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

type DesktopPetLayeredWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "moveTop" | "setAlwaysOnTop" | "setVisibleOnAllWorkspaces"
>;

export function applyDesktopPetBrowserWindowLayering(
  win: DesktopPetLayeredWindow | null | undefined,
  platform: NodeJS.Platform | string,
  options: { preserveProcessType?: boolean; moveTop?: boolean } = {}
) {
  if (!win || win.isDestroyed()) {
    return;
  }

  if (platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      ...(options.preserveProcessType ? { skipTransformProcessType: true } : {})
    });
  } else if (platform === "win32") {
    win.setAlwaysOnTop(true);
  }

  if (options.moveTop) {
    win.moveTop();
  }
}

export function createDesktopPetBrowserWindow(options: {
  bounds: Rectangle;
  platform: NodeJS.Platform | string;
  preloadPath: string;
  focusable?: boolean;
  onClosed: () => void;
}) {
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

  applyDesktopPetBrowserWindowLayering(win, options.platform);

  win.on("closed", options.onClosed);
  return win;
}
