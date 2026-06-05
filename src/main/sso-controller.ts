import type { App, BrowserWindow, CookiesSetDetails, Session } from "electron";
import {
  exchangeConfiguredDesktopSsoCookieForAccessToken,
  getDesktopSsoAccessTokenCookieDetails,
  getDesktopSsoCookieMirrorOrigins,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoProxyBrowserCookieDetails,
  getDesktopSsoStatus,
  getDesktopSsoWebSessionClearCookies,
  getDesktopSsoWebSessionExchangeConfig
} from "./oidc-sso";
import { getDesktopSsoBrowserUserAgent, type DesktopPlatform } from "./platform-adapter";
import { safeConsoleError } from "./safe-console";
import { STORAGE_NAMESPACE } from "../shared/generated/brand";

export const DESKTOP_SSO_WEBVIEW_PARTITION = `persist:${STORAGE_NAMESPACE}-sso`;

type DesktopSsoStatus = ReturnType<typeof getDesktopSsoStatus>;
type CookieAccessTokenFetch = Parameters<typeof exchangeConfiguredDesktopSsoCookieForAccessToken>[2];

type WebSessionExchangeFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  ok: boolean;
  status?: number;
  statusText?: string;
  headers: Headers;
  text?: () => Promise<string>;
}>;

type BrowserOpenInput = {
  url: string;
  label?: string;
  requireOperableTarget?: boolean;
  partition?: string;
  userAgent?: string;
};

type BrowserOpenResult = {
  ok: boolean;
  action: string;
  target: string;
  url: string;
  message: string;
  error?: string;
  title?: string;
  data?: unknown;
};

type ElectronSessionAccess = {
  defaultSession: Session;
  fromPartition(partition: string): Session;
};

export type DesktopSsoControllerOptions = {
  app: App;
  platform: DesktopPlatform;
  session: ElectronSessionAccess;
  getMainWindow(): BrowserWindow | null;
  openBrowserUrl(input: BrowserOpenInput): Promise<BrowserOpenResult>;
  openExternal(url: string): Promise<void>;
};

export function splitDesktopSsoSetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getDesktopSsoSetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoSetCookieHeader(setCookieHeader) : [];
}

function getDesktopSsoDefaultCookiePath(url: URL) {
  const pathname = url.pathname || "/";
  if (pathname === "/" || !pathname.startsWith("/")) {
    return "/";
  }
  const lastSlashIndex = pathname.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : pathname.slice(0, lastSlashIndex);
}

function toDesktopSsoSameSite(value: string): CookiesSetDetails["sameSite"] {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "none") {
    return "no_restriction";
  }
  if (normalizedValue === "strict") {
    return "strict";
  }
  if (normalizedValue === "lax") {
    return "lax";
  }
  return "unspecified";
}

export function rewriteDesktopSsoUrlOrigin(value: string, browserOrigin?: string) {
  if (!browserOrigin) {
    return value;
  }
  const url = new URL(value);
  const originUrl = new URL(browserOrigin);
  if (!["http:", "https:"].includes(originUrl.protocol)) {
    return value;
  }
  url.protocol = originUrl.protocol;
  url.host = originUrl.host;
  return url.toString();
}

export function parseDesktopSsoSetCookieHeader(header: string, responseUrl: string): CookiesSetDetails | null {
  const responseUrlObject = new URL(responseUrl);
  const [nameValuePair, ...attributes] = header.split(";");
  const separatorIndex = nameValuePair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const name = nameValuePair.slice(0, separatorIndex).trim();
  if (!name) {
    return null;
  }

  const details: CookiesSetDetails = {
    url: responseUrlObject.origin,
    name,
    value: nameValuePair.slice(separatorIndex + 1).trim(),
    path: getDesktopSsoDefaultCookiePath(responseUrlObject)
  };

  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }

    const attributeSeparatorIndex = attribute.indexOf("=");
    const attributeName = (attributeSeparatorIndex >= 0
      ? attribute.slice(0, attributeSeparatorIndex)
      : attribute).trim().toLowerCase();
    const attributeValue = attributeSeparatorIndex >= 0
      ? attribute.slice(attributeSeparatorIndex + 1).trim()
      : "";

    if (attributeName === "domain" && attributeValue) {
      details.domain = attributeValue;
    } else if (attributeName === "path" && attributeValue) {
      details.path = attributeValue;
    } else if (attributeName === "secure") {
      details.secure = true;
    } else if (attributeName === "httponly") {
      details.httpOnly = true;
    } else if (attributeName === "samesite" && attributeValue) {
      details.sameSite = toDesktopSsoSameSite(attributeValue);
    } else if (attributeName === "expires" && attributeValue) {
      const expiresAt = Date.parse(attributeValue);
      if (Number.isFinite(expiresAt)) {
        details.expirationDate = Math.floor(expiresAt / 1000);
      }
    } else if (attributeName === "max-age" && attributeValue) {
      const maxAgeSeconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(maxAgeSeconds)) {
        details.expirationDate = Math.floor(Date.now() / 1000) + maxAgeSeconds;
      }
    }
  }

  return details;
}

async function applyDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  setCookieHeaders: string[]
) {
  await Promise.all(setCookieHeaders.map(async (header) => {
    const cookieDetails = parseDesktopSsoSetCookieHeader(header, responseUrl);
    if (!cookieDetails) {
      return;
    }
    await ssoSession.cookies.set(cookieDetails);
  }));
}

async function applyDesktopSsoSetCookieHeadersToSessions(
  targetSessions: Session[],
  responseUrls: string[],
  setCookieHeaders: string[]
) {
  const uniqueResponseUrls = [...new Set(responseUrls)];
  await Promise.all(uniqueResponseUrls.flatMap((responseUrl) =>
    targetSessions.map((targetSession) =>
      applyDesktopSsoSetCookieHeaders(targetSession, responseUrl, setCookieHeaders)
    )
  ));
}

async function readDesktopSsoWebSessionExchangeError(response: {
  status?: number;
  statusText?: string;
  text?: () => Promise<string>;
}) {
  const status = typeof response.status === "number" && response.status > 0
    ? response.status
    : 0;
  const statusText = response.statusText?.trim() || "";
  let detail = "";
  if (typeof response.text === "function") {
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = "";
    }
  }
  return [status ? String(status) : "", statusText, detail]
    .filter(Boolean)
    .join(" - ") || "unknown error";
}

async function buildDesktopSsoCookieHeader(ssoSession: Session, targetUrl: string) {
  const cookies = await ssoSession.cookies.get({ url: targetUrl });
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function mirrorDesktopSsoSetCookieHeaders(
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

async function resolveDesktopSsoNavigationUrl(
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

function focusMainWindowAfterDesktopSso(options: DesktopSsoControllerOptions) {
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

export function createDesktopSsoController(options: DesktopSsoControllerOptions) {
  return {
    broadcastStatus(status: DesktopSsoStatus) {
      options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      if (status.authenticated) {
        focusMainWindowAfterDesktopSso(options);
      }
    },
    async openBrowserUrl(input: {
      url: string;
      label?: string;
      browserOrigin?: string;
      resolveRedirect?: boolean;
    }) {
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const userAgent = getDesktopSsoBrowserUserAgent(options.platform);
      await ssoSession.setProxy({ proxyRules: "direct://" });
      return options.openBrowserUrl({
        ...input,
        url: input.resolveRedirect === false
          ? rewriteDesktopSsoUrlOrigin(input.url, input.browserOrigin)
          : await resolveDesktopSsoNavigationUrl(ssoSession, input.url, userAgent, input.browserOrigin),
        requireOperableTarget: false,
        partition: DESKTOP_SSO_WEBVIEW_PARTITION,
        userAgent
      });
    },
    async openSystemBrowserUrl(input: {
      url: string;
      label?: string;
    }) {
      const targetUrl = input.url.trim();
      try {
        await options.openExternal(targetUrl);
        return {
          ok: true,
          action: "open_system_browser",
          target: targetUrl,
          url: targetUrl,
          message: `已在系统默认浏览器打开「${input.label || targetUrl}」。`
        };
      } catch (error) {
        return {
          ok: false,
          action: "open_system_browser",
          target: targetUrl,
          url: targetUrl,
          message: `无法在系统默认浏览器打开「${input.label || targetUrl}」。`,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    },
    async syncBrowserCookies() {
      const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
      const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(options.app);
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const targetSessions = [
        options.session.defaultSession,
        ssoSession
      ];
      await Promise.all(cookieDetails.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          await targetSession.cookies.set(details);
        })
      ));
      await Promise.all(mirrorOrigins.map(async (origin) => {
        const cookies = await ssoSession.cookies.get({ url: origin });
        await Promise.all(cookies.map(async (cookie) => {
          await options.session.defaultSession.cookies.set({
            url: origin,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || undefined,
            path: cookie.path || "/",
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expirationDate,
            sameSite: cookie.sameSite
          });
        }));
      }));
    },
    async exchangeBrowserCookieAccessToken(fetchImpl?: CookieAccessTokenFetch) {
      const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(options.app);
      if (!exchangeUrl) {
        return "";
      }
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, exchangeUrl);
      const accessTokenFetch = fetchImpl || ((url, init) => ssoSession.fetch(url, init));
      const accessToken = await exchangeConfiguredDesktopSsoCookieForAccessToken(options.app, cookieHeader, accessTokenFetch);
      if (!accessToken) {
        return "";
      }
      const cookieDetails = getDesktopSsoAccessTokenCookieDetails(options.app, accessToken);
      const targetSessions = [
        options.session.defaultSession,
        ssoSession
      ];
      await Promise.all(cookieDetails.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          await targetSession.cookies.set(details);
        })
      ));
      return accessToken;
    },
    async exchangeWebSession(idToken: string, fetchImpl: WebSessionExchangeFetch = fetch as unknown as WebSessionExchangeFetch) {
      const exchangeConfig = getDesktopSsoWebSessionExchangeConfig(options.app);
      const token = idToken.trim();
      if (!exchangeConfig || !token) {
        return false;
      }
      const response = await fetchImpl(exchangeConfig.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          provider: "google",
          id_token: token
        })
      });
      if (!response.ok) {
        throw new Error(`Desktop SSO web session exchange failed: ${await readDesktopSsoWebSessionExchangeError(response)}`);
      }
      const setCookieHeaders = getDesktopSsoSetCookieHeaders(response.headers);
      if (setCookieHeaders.length === 0) {
        return false;
      }
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await applyDesktopSsoSetCookieHeadersToSessions(
        targetSessions,
        [exchangeConfig.url, ...exchangeConfig.cookieOrigins],
        setCookieHeaders
      );
      return true;
    },
    async clearBrowserCookies() {
      const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
      const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(options.app);
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await Promise.all(cookieDetails.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          try {
            await targetSession.cookies.remove(details.url, details.name);
          } catch {
            // Cookie removal is best effort; local Desktop auth state is already cleared.
          }
        })
      ));
      await Promise.all(targetSessions.flatMap((targetSession) =>
        mirrorOrigins.map(async (origin) => {
          const cookies = await targetSession.cookies.get({ url: origin });
          await Promise.all(cookies.map(async (cookie) => {
            try {
              await targetSession.cookies.remove(origin, cookie.name);
            } catch {
              // Cookie removal is best effort; local Desktop auth state is already cleared.
            }
          }));
        })
      ));
    },
    async clearWebSessionCookies() {
      const clearCookies = getDesktopSsoWebSessionClearCookies(options.app);
      if (clearCookies.length === 0) {
        return;
      }
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await Promise.all(clearCookies.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          try {
            await targetSession.cookies.remove(details.url, details.name);
          } catch {
            // Cookie removal is best effort; local Desktop auth state is already cleared.
          }
        })
      ));
    }
  };
}
