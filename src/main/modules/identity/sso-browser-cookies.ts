import type { CookiesSetDetails, Session } from "electron";

export function splitDesktopSsoSetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getDesktopSsoSetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoSetCookieHeader(setCookieHeader) : [];
}

export function getDesktopSsoDefaultCookiePath(url: URL) {
  const pathname = url.pathname || "/";
  if (pathname === "/" || !pathname.startsWith("/")) {
    return "/";
  }
  const lastSlashIndex = pathname.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : pathname.slice(0, lastSlashIndex);
}

export function toDesktopSsoSameSite(value: string): CookiesSetDetails["sameSite"] {
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

export async function applyDesktopSsoSetCookieHeaders(
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

export async function applyDesktopSsoSetCookieHeadersToSessions(
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
