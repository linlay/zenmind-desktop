import { STORAGE_NAMESPACE } from "./brand";

export const DESKTOP_HELP_WEBVIEW_PARTITION = `persist:${STORAGE_NAMESPACE}-help`;

export type DesktopHelpSettings = {
  schemaVersion: 1;
  url: string;
};

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

export function isSafeHelpExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return Boolean(url.host) &&
      !url.username &&
      !url.password &&
      (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export function isSafeHelpUrl(value: string) {
  if (!isSafeHelpExternalUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return url.protocol === "https:" || isLoopbackHost(url.hostname);
}

export function isAllowedHelpNavigationUrl(configuredUrl: string, candidateUrl: string) {
  if (!isSafeHelpUrl(configuredUrl) || !isSafeHelpUrl(candidateUrl)) {
    return false;
  }
  return new URL(configuredUrl).origin === new URL(candidateUrl).origin;
}
