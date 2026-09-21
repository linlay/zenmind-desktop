import type { Session } from "electron";
import { applyDesktopSsoSetCookieHeaders, rewriteDesktopSsoUrlOrigin, getDesktopSsoSetCookieHeaders } from "./sso-browser-cookies";
import { safeConsoleError } from "../../support/logging/safe-console";
import type { DesktopSsoControllerOptions } from "./sso-controller-model";

export async function buildDesktopSsoCookieHeader(ssoSession: Session, targetUrl: string) {
  const cookies = await ssoSession.cookies.get({ url: targetUrl });
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function mirrorDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  browserOrigin: string | undefined,
  setCookieHeaders: string[]
) {
  await applyDesktopSsoSetCookieHeaders(ssoSession, responseUrl, setCookieHeaders);
  const mirroredResponseUrl = rewriteDesktopSsoUrlOrigin(responseUrl, browserOrigin);
  if (mirroredResponseUrl !== responseUrl) {
    await applyDesktopSsoSetCookieHeaders(ssoSession, mirroredResponseUrl, setCookieHeaders);
  }
}

export async function resolveDesktopSsoNavigationUrl(
  ssoSession: Session,
  targetUrl: string,
  userAgent: string,
  browserOrigin?: string
) {
  try {
    const requestUrl = new URL(targetUrl);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, targetUrl);
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": userAgent
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await fetch(targetUrl, {
      redirect: "manual",
      headers
    });
    await mirrorDesktopSsoSetCookieHeaders(
      ssoSession,
      response.url || targetUrl,
      browserOrigin,
      getDesktopSsoSetCookieHeaders(response.headers)
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const resolvedLocation = new URL(location, requestUrl).toString();
        return rewriteDesktopSsoUrlOrigin(resolvedLocation, browserOrigin);
      }
    }
  } catch (error) {
    safeConsoleError("failed to resolve desktop sso navigation url", {
      url: targetUrl,
      error
    });
  }
  return rewriteDesktopSsoUrlOrigin(targetUrl, browserOrigin);
}

export function focusMainWindowAfterDesktopSso(options: DesktopSsoControllerOptions) {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  if (options.platform === "darwin") {
    options.app.focus({ steal: true });
    mainWindow.focus();
    return;
  }
  if (options.platform === "win32") {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  mainWindow.focus();
}
