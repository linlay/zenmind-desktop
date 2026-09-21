import type { OidcConfig, DesktopSsoBrowserCookieDetails, DesktopSsoProxyState } from "./sso-model";
import { DEFAULT_OIDC_CONFIG } from "./sso-defaults";
import {
  getDesktopSsoBrowserCookieOrigins,
  getDesktopSsoProxyTargetOrigin,
  getDesktopSsoProxySetCookieHeaders,
  rewriteDesktopSsoProxyLocation,
  rewriteDesktopSsoProxySetCookieHeader
} from "./sso-proxy-urls";
import { desktopSsoRuntimeState } from "./sso-state";
import type { App } from "electron";
import { loadDesktopSsoConfig } from "./sso-config";
import { getCallbackOrigin } from "./callback-lifecycle";
import http from "node:http";

export function buildDesktopSsoBrowserCookieDetails(
  cookies: Map<string, string>,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): DesktopSsoBrowserCookieDetails[] {
  const origins = getDesktopSsoBrowserCookieOrigins(config);
  const cookieDetails: DesktopSsoBrowserCookieDetails[] = [];
  for (const origin of origins) {
    for (const [name, value] of cookies) {
      cookieDetails.push({
        url: origin,
        name,
        value,
        path: "/",
        secure: origin.startsWith("https:"),
        httpOnly: true,
        sameSite: "lax"
      });
    }
  }
  return cookieDetails;
}

export function getDesktopSsoProxyBrowserCookieDetails() {
  if (!desktopSsoRuntimeState.desktopSsoProxyState) {
    return [];
  }
  return buildDesktopSsoBrowserCookieDetails(desktopSsoRuntimeState.desktopSsoProxyState.cookies, desktopSsoRuntimeState.desktopSsoProxyState.config);
}

export function getDesktopSsoCookieMirrorOrigins(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return [];
  }
  return getDesktopSsoBrowserCookieOrigins(configResult.config);
}

export function activateDesktopSsoProxy(config: OidcConfig, options: { resetCookies?: boolean } = {}) {
  const currentTargetOrigin = desktopSsoRuntimeState.desktopSsoProxyState
    ? getDesktopSsoProxyTargetOrigin(desktopSsoRuntimeState.desktopSsoProxyState.config)
    : "";
  const nextTargetOrigin = getDesktopSsoProxyTargetOrigin(config);
  if (!desktopSsoRuntimeState.desktopSsoProxyState || options.resetCookies || currentTargetOrigin !== nextTargetOrigin) {
    desktopSsoRuntimeState.desktopSsoProxyState = {
      config,
      cookies: new Map()
    };
    return desktopSsoRuntimeState.desktopSsoProxyState;
  }
  desktopSsoRuntimeState.desktopSsoProxyState.config = config;
  return desktopSsoRuntimeState.desktopSsoProxyState;
}

export function updateDesktopSsoProxyCookies(proxyState: DesktopSsoProxyState, setCookieHeaders: string[]) {
  for (const header of setCookieHeaders) {
    const [nameValuePair, ...attributes] = header.split(";");
    const separatorIndex = nameValuePair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = nameValuePair.slice(0, separatorIndex).trim();
    const value = nameValuePair.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    let expired = false;
    for (const rawAttribute of attributes) {
      const attribute = rawAttribute.trim();
      const attributeSeparatorIndex = attribute.indexOf("=");
      const attributeName = (attributeSeparatorIndex >= 0
        ? attribute.slice(0, attributeSeparatorIndex)
        : attribute).trim().toLowerCase();
      const attributeValue = attributeSeparatorIndex >= 0
        ? attribute.slice(attributeSeparatorIndex + 1).trim()
        : "";
      if (attributeName === "max-age" && Number.parseInt(attributeValue, 10) <= 0) {
        expired = true;
      } else if (attributeName === "expires") {
        const expiresAt = Date.parse(attributeValue);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          expired = true;
        }
      }
    }
    if (expired) {
      proxyState.cookies.delete(name);
    } else {
      proxyState.cookies.set(name, value);
    }
  }
}

export function mergeDesktopSsoProxyCookies(browserCookieHeader: string | undefined, proxyState: DesktopSsoProxyState) {
  const cookies = new Map<string, string>();
  for (const cookie of (browserCookieHeader ?? "").split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  for (const [name, value] of proxyState.cookies) {
    cookies.set(name, value);
  }
  return [...cookies]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function rewriteDesktopSsoProxyHeaderUrl(value: string, config: OidcConfig, origin = getCallbackOrigin()) {
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  return value
    .replaceAll(origin, targetOrigin)
    .replaceAll(origin.replace("localhost", "127.0.0.1"), targetOrigin);
}

export function getDesktopSsoProxyRequestHeaders(
  request: http.IncomingMessage,
  upstreamUrl: URL,
  proxyState: DesktopSsoProxyState,
  origin = getCallbackOrigin()
) {
  const blockedHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
    "upgrade"
  ]);
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (blockedHeaders.has(name) || rawValue === undefined) {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers[name] = value;
  }

  headers["accept-encoding"] = "identity";
  if (headers.origin) {
    headers.origin = getDesktopSsoProxyTargetOrigin(proxyState.config);
  }
  if (headers.referer) {
    headers.referer = rewriteDesktopSsoProxyHeaderUrl(headers.referer, proxyState.config, origin);
  }
  const cookieHeader = mergeDesktopSsoProxyCookies(request.headers.cookie, proxyState);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  } else {
    delete headers.cookie;
  }
  return headers;
}

export function readDesktopSsoProxyRequestBody(request: http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function shouldRewriteDesktopSsoProxyBody(contentType: string) {
  return /(?:text|json|javascript|ecmascript|xml|x-www-form-urlencoded)/iu.test(contentType);
}

export function rewriteDesktopSsoProxyBody(body: Buffer, contentType: string, config: OidcConfig, origin = getCallbackOrigin()) {
  if (!shouldRewriteDesktopSsoProxyBody(contentType)) {
    return body;
  }
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  const httpTargetOrigin = targetOrigin.replace(/^https:/iu, "http:");
  const rewrittenBody = body
    .toString("utf8")
    .replaceAll(targetOrigin, origin)
    .replaceAll(httpTargetOrigin, origin);
  return Buffer.from(rewrittenBody, "utf8");
}

export async function proxyDesktopSsoRequest(
  proxyState: DesktopSsoProxyState,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL
) {
  const origin = requestUrl.origin;
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, getDesktopSsoProxyTargetOrigin(proxyState.config));
  const method = (request.method || "GET").toUpperCase();
  const requestBodyBuffer = method === "GET" || method === "HEAD"
    ? undefined
    : await readDesktopSsoProxyRequestBody(request);
  const requestBody = requestBodyBuffer
    ? Uint8Array.from(requestBodyBuffer).buffer
    : undefined;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: getDesktopSsoProxyRequestHeaders(request, upstreamUrl, proxyState, origin),
    body: requestBody as BodyInit | undefined,
    redirect: "manual"
  });
  const setCookieHeaders = getDesktopSsoProxySetCookieHeaders(upstreamResponse.headers);
  updateDesktopSsoProxyCookies(proxyState, setCookieHeaders);

  const blockedResponseHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "set-cookie",
    "transfer-encoding"
  ]);
  const responseHeaders: http.OutgoingHttpHeaders = {};
  upstreamResponse.headers.forEach((value, name) => {
    const headerName = name.toLowerCase();
    if (blockedResponseHeaders.has(headerName)) {
      return;
    }
    if (headerName === "location") {
      responseHeaders.location = rewriteDesktopSsoProxyLocation(value, upstreamUrl, proxyState.config, origin);
      return;
    }
    responseHeaders[name] = value;
  });

  const rewrittenCookies = setCookieHeaders
    .map((header) => rewriteDesktopSsoProxySetCookieHeader(header))
    .filter(Boolean);
  if (rewrittenCookies.length > 0) {
    responseHeaders["set-cookie"] = rewrittenCookies;
  }

  const rawBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const body = rewriteDesktopSsoProxyBody(rawBody, upstreamResponse.headers.get("content-type") ?? "", proxyState.config, origin);
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(method === "HEAD" ? undefined : body);
}
