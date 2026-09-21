import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { LocaleSettings } from "../../../shared/i18n/types";
import type { MainWindowOptions, MainRendererDevToolsContentsLike, MainWindowRendererLoadLike } from "./window-model";
import { createInitialLocaleArguments } from "../../../shared/i18n/initial-locale-args";
import { PRODUCT_NAME } from "../../../shared/brand";
import { MAC_TRAFFIC_LIGHT_POSITION, WINDOWS_BACKGROUND_DARK, WINDOWS_BACKGROUND_LIGHT } from "./window-model";
import type { BrowserWindow } from "electron";

export function buildMainWindowOptions(input: {
  platform: DesktopPlatform;
  preloadPath: string;
  initialLocaleSettings?: LocaleSettings;
  shouldUseDarkColors?: boolean;
  iconPath?: string;
}): MainWindowOptions {
  const initialLocaleArguments = input.initialLocaleSettings
    ? createInitialLocaleArguments(input.initialLocaleSettings)
    : [];
  return {
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: PRODUCT_NAME,
    show: false,
    backgroundColor: input.platform === "darwin"
      ? "#00000000"
      : input.platform === "win32"
        ? resolveWindowsBackgroundColor(input.shouldUseDarkColors ?? false)
        : "#F6F8FC",
    ...(input.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
          // Allow an inactive macOS window to begin a header drag on the first press.
          acceptFirstMouse: true,
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const
        }
      : input.platform === "win32"
        ? {
            // The renderer owns the thin Windows system bar and window controls.
            titleBarStyle: "hidden" as const,
            ...(input.iconPath ? { icon: input.iconPath } : {})
          }
        : {}),
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      ...(initialLocaleArguments.length > 0 ? { additionalArguments: initialLocaleArguments } : {})
    }
  };
}

export function applyWindowsDevelopmentAppDetails(
  targetWindow: Pick<BrowserWindow, "setAppDetails">,
  input: {
    platform: DesktopPlatform;
    appId: string;
    iconPath?: string;
  }
) {
  if (input.platform !== "win32" || !input.iconPath) {
    return;
  }
  targetWindow.setAppDetails({
    appId: input.appId,
    appIconPath: input.iconPath,
    appIconIndex: 0
  });
}

export function resolveWindowsBackgroundColor(shouldUseDarkColors: boolean) {
  return shouldUseDarkColors ? WINDOWS_BACKGROUND_DARK : WINDOWS_BACKGROUND_LIGHT;
}

export function toggleMainRendererDevTools(
  contents: MainRendererDevToolsContentsLike
) {
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
    return;
  }

  // Keep the renderer-owned system bar spanning the whole Windows window.
  // Right-docked DevTools would split the inspected renderer horizontally and
  // move its custom window controls away from the window's right edge.
  contents.openDevTools({ mode: "bottom" });
}

export async function loadMainWindowRenderer(
  targetWindow: MainWindowRendererLoadLike,
  options: {
    mode: "dev" | "file";
    rendererEntry: string;
    quit(): void;
    report(message: string, error: unknown): void;
  }
) {
  try {
    if (options.mode === "dev") {
      await targetWindow.loadURL(options.rendererEntry);
      return;
    }

    await targetWindow.loadFile(options.rendererEntry);
  } catch (error) {
    options.report(options.mode === "dev" ? "failed to load dev renderer" : "failed to load renderer file", error);
    options.quit();
  }
}
