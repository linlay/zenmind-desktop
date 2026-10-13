import type { App } from "electron";
import { DESKTOP_OPEN_PROTOCOL_SCHEME } from "../../shared/brand";
import type { NativeShareTransfer } from "../../shared/native-share";

export const DESKTOP_OPEN_DEEP_LINK = `${DESKTOP_OPEN_PROTOCOL_SCHEME}://open`;

export type DesktopShareOpenRequest = { batchId: string; transfer?: NativeShareTransfer };

/** A share URL carries one fixed loopback capability, never a URL or filesystem path. */
export function readDesktopShareOpenRequest(value: unknown): DesktopShareOpenRequest | null {
  if (typeof value !== "string") return null;
  const prefix = `${DESKTOP_OPEN_PROTOCOL_SCHEME}://share?batch=`;
  if (!value.startsWith(prefix)) return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:&port=([1-9]\d{0,4})&ticket=([A-Za-z0-9_-]{43}))?$/u.exec(value.slice(prefix.length));
  if (!match) return null;
  const batchId = match[1];
  if (!match[2]) return { batchId };
  const port = Number(match[2]);
  if (port > 65535) return null;
  return { batchId, transfer: { batchId, port, ticket: match[3] } };
}

export function readDesktopShareDeepLink(value: unknown): string | null {
  return readDesktopShareOpenRequest(value)?.batchId ?? null;
}

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
    return parsed.protocol === `${DESKTOP_OPEN_PROTOCOL_SCHEME}:` &&
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
    return app.setAsDefaultProtocolClient(DESKTOP_OPEN_PROTOCOL_SCHEME);
  }
  if (platform === "win32" && options.isDefaultApp && options.appEntryPath) {
    return app.setAsDefaultProtocolClient(DESKTOP_OPEN_PROTOCOL_SCHEME, options.execPath, [options.appEntryPath]);
  }
  return false;
}
