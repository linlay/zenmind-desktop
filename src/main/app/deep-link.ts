import type { App } from "electron";
import { BRAND_ID } from "../../shared/brand";

export const DESKTOP_OPEN_DEEP_LINK = `${BRAND_ID}://open`;

type ProtocolClientApp = Pick<App, "isPackaged" | "setAsDefaultProtocolClient">;

export function isDesktopOpenDeepLink(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    return false;
  }
  if (value !== DESKTOP_OPEN_DEEP_LINK) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === `${BRAND_ID}:` &&
      parsed.hostname === "open" &&
      parsed.pathname === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "";
  } catch {
    return false;
  }
}

export function findDesktopOpenDeepLink(commandLine: readonly string[]): string | null {
  return commandLine.find((value) => isDesktopOpenDeepLink(value)) ?? null;
}

export function registerDesktopOpenProtocolClient(
  app: ProtocolClientApp,
  platform: NodeJS.Platform,
  options: {
    isDefaultApp: boolean;
    execPath: string;
    appEntryPath?: string;
  },
): boolean {
  if (platform !== "darwin" && platform !== "win32") {
    return false;
  }
  if (app.isPackaged) {
    return app.setAsDefaultProtocolClient(BRAND_ID);
  }
  if (platform === "win32" && options.isDefaultApp && options.appEntryPath) {
    return app.setAsDefaultProtocolClient(BRAND_ID, options.execPath, [options.appEntryPath]);
  }
  return false;
}
