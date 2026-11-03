import { getDesktopSsoStatus } from "./sso-restore";
import { exchangeConfiguredDesktopSsoCookieForAccessToken } from "./sso-browser-session";
import type { Session, App, BrowserWindow } from "electron";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";

export type DesktopSsoStatus = ReturnType<typeof getDesktopSsoStatus>;

export type CookieAccessTokenFetch = Parameters<typeof exchangeConfiguredDesktopSsoCookieForAccessToken>[2];

export type BrowserCookieFetch = (url: string, init: {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Headers;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export type WebSessionExchangeFetch = (url: string, init: {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status?: number;
  statusText?: string;
  headers: Headers;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export type BrowserOpenInput = {
  url: string;
  label?: string;
  requireOperableTarget?: boolean;
  partition?: string;
  userAgent?: string;
};

export type BrowserOpenResult = {
  ok: boolean;
  action: string;
  target: string;
  url: string;
  message: string;
  error?: string;
  title?: string;
  data?: unknown;
};

export type EmbeddedLoginDialogOpenInput = {
  url: string;
  label?: string;
  browserOrigin?: string;
  resolveRedirect?: boolean;
};

export type ElectronSessionAccess = {
  defaultSession: Session;
};

export type DesktopSsoControllerOptions = {
  app: App;
  platform: DesktopPlatform;
  session: ElectronSessionAccess;
  getMainWindow(): BrowserWindow | null;
  openBrowserUrl(input: BrowserOpenInput): Promise<BrowserOpenResult>;
  openExternal(url: string): Promise<void>;
  onRestoreResult?(result: DesktopSsoRestoreResult): void;
};

export type DesktopSsoRestoreResult = {
  state: "authenticated" | "signed_out" | "temporarily_unavailable";
  status: DesktopSsoStatus;
  accessToken?: string;
};

export class DesktopSsoRestoreRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DesktopSsoRestoreRequestError";
  }
}
