import type { OidcConfig } from "./sso-model";
import { DEFAULT_OIDC_CONFIG } from "./sso-defaults";
import { getCallbackOrigin } from "./callback-lifecycle";

export function getDesktopSsoProxyTargetOrigin(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return new URL(config.authorizeUrl).origin;
}

export function buildDesktopSsoProxyUrl(value: string, origin = getCallbackOrigin()) {
  const targetUrl = new URL(value);
  return `${origin}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
}

export function rewriteDesktopSsoProxyLocation(
  location: string,
  upstreamRequestUrl: URL,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  origin = getCallbackOrigin()
) {
  const resolvedLocation = new URL(location, upstreamRequestUrl);
  if (resolvedLocation.origin === origin) {
    return resolvedLocation.toString();
  }
  if (resolvedLocation.origin === getDesktopSsoProxyTargetOrigin(config)) {
    return buildDesktopSsoProxyUrl(resolvedLocation.toString(), origin);
  }
  return resolvedLocation.toString();
}

export function splitDesktopSsoProxySetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getDesktopSsoProxySetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoProxySetCookieHeader(setCookieHeader) : [];
}

export function rewriteDesktopSsoProxySetCookieHeader(header: string) {
  const [nameValuePair, ...attributes] = header.split(";");
  const rewrittenAttributes: string[] = [];
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }
    const separatorIndex = attribute.indexOf("=");
    const attributeName = (separatorIndex >= 0 ? attribute.slice(0, separatorIndex) : attribute)
      .trim()
      .toLowerCase();
    const attributeValue = separatorIndex >= 0 ? attribute.slice(separatorIndex + 1).trim() : "";
    if (attributeName === "domain" || attributeName === "secure") {
      continue;
    }
    if (attributeName === "samesite" && attributeValue.toLowerCase() === "none") {
      rewrittenAttributes.push("SameSite=Lax");
      continue;
    }
    rewrittenAttributes.push(attribute);
  }
  return [nameValuePair.trim(), ...rewrittenAttributes].filter(Boolean).join("; ");
}

export function getDesktopSsoBrowserCookieOrigins(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const origins = new Set<string>();
  origins.add(getDesktopSsoProxyTargetOrigin(config));
  if (config.loginUrl) {
    origins.add(new URL(config.loginUrl).origin);
  }
  if (config.browserOrigin) {
    origins.add(config.browserOrigin);
  }
  if (config.cookieAccessTokenExchange) {
    origins.add(new URL(config.cookieAccessTokenExchange.url).origin);
  }
  if (config.browserSession) {
    origins.add(new URL(config.browserSession.url).origin);
  }
  if (config.userInfo?.authMode === "cookie") {
    origins.add(new URL(config.userInfo.url).origin);
  }
  return [...origins];
}
