import { DESKTOP_OPEN_PROTOCOL_SCHEME } from "../../shared/brand";
import { NATIVE_SHARE_PROTOCOL_HOST, NATIVE_SHARE_PROTOCOL_SCHEME } from "../../shared/native-share";
import { DESKTOP_OPEN_DEEP_LINK } from "./deep-link";

type BusinessLinkHandler = (params: ReadonlyMap<string, string>) => void | Promise<void>;

export function isDesktopBusinessLink(value: string): boolean {
  const scheme = value.trim().split(":", 1)[0].toLowerCase();
  const route = value.trim().slice(scheme.length + 1).replace(/^\/\//u, "");
  return /[/?#]/u.test(route) && scheme === DESKTOP_OPEN_PROTOCOL_SCHEME &&
    value !== DESKTOP_OPEN_DEEP_LINK &&
    !(scheme === NATIVE_SHARE_PROTOCOL_SCHEME && value.startsWith(`${scheme}://${NATIVE_SHARE_PROTOCOL_HOST}?`));
}

export async function dispatchDesktopBusinessLink(
  value: string,
  routes: ReadonlyMap<string, BusinessLinkHandler>,
): Promise<void> {
  // Check the raw authority and path before URL normalization can erase segments.
  const prefix = `${DESKTOP_OPEN_PROTOCOL_SCHEME}://`;
  const match = /^([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)\?([^#\s\p{Cc}]+)$/u.exec(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !match || match[0] !== value.slice(prefix.length)) {
    throw new Error("Invalid desktop business link");
  }
  const handler = routes.get(match[1]);
  if (!handler) throw new Error("Unknown desktop business route");

  const params = new Map<string, string>();
  for (const entry of match[2].split("&")) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("Invalid desktop business parameter");
    const key = decodeURIComponent(entry.slice(0, separator).replace(/\+/gu, " "));
    const value = decodeURIComponent(entry.slice(separator + 1).replace(/\+/gu, " "));
    if (params.has(key)) throw new Error("Duplicate desktop business parameter");
    params.set(key, value);
  }
  if (params.get("v") !== "1") throw new Error("Unsupported desktop business link version");
  params.delete("v");
  await handler(params);
}
