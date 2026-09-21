import { BrowserWindow, type Rectangle } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

type DesktopPetLayeredWindow = Pick<BrowserWindow, "isDestroyed" | "setAlwaysOnTop">;

export function applyDesktopPetMouseInteractivity(
  win: Pick<BrowserWindow, "setIgnoreMouseEvents">,
  platform: NodeJS.Platform | string,
  interactive: boolean
) {
  if (platform === "darwin") {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    return;
  }
  if (platform === "win32") {
    // Electron forwards mouse movement on Windows too, so the renderer can
    // restore interaction when the cursor returns to an opaque pet pixel.
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    return;
  }
  win.setIgnoreMouseEvents(false);
}

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
  const focusable = options.focusable ?? true;

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
    focusable,
    hasShadow: false,
    title: `${PRODUCT_NAME} Desktop Xianzun`,
    backgroundColor: "#00000000",
    // macOS non-activating panels are suitable for the sprite, not a reply editor.
    // The interactive panel must become a key window to receive keyboard/IME input.
    ...(isMac && !focusable ? { type: "panel" as const } : {}),
    ...(isMac && focusable ? { acceptFirstMouse: true } : {}),
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
