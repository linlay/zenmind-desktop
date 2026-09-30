import type { CookiesSetDetails } from "electron";

export class WebappAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function resolveSessionExchangeUrl(pageUrl: string, input: unknown, localWebapp: boolean) {
  const page = new URL(pageUrl);
  const loopback = page.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(page.hostname);
  if (page.username || page.password || (page.protocol !== "https:" && !(localWebapp && loopback))) {
    throw new WebappAuthError("insecure_origin", "Remote authentication requires HTTPS.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => key !== "exchangePath")) throw new WebappAuthError("invalid_args", "Provide exchangePath only.");
  const value = (input as { exchangePath?: unknown }).exchangePath;
  if (typeof value !== "string" || value.length > 1024 || !/^\/(?!\/)[A-Za-z0-9/_\-.]+$/u.test(value) ||
      value.split("/").some(part => part === "." || part === "..") || value.startsWith("/__desktop/")) {
    throw new WebappAuthError("invalid_args", "exchangePath must be an absolute same-origin path without query or fragment.");
  }
  const url = new URL(value, page.origin);
  if (url.origin !== page.origin) throw new WebappAuthError("invalid_args", "Cross-origin exchange is not allowed.");
  return url;
}

/** Only bounded host-only session cookies; reject the entire response on any invalid cookie. */
export function parseSessionCookies(lines: string[], url: URL, expiresAt: number, now = Date.now()): (CookiesSetDetails & { name: string })[] {
  const fail = () => { throw new WebappAuthError("invalid_cookie", "The exchange must return host-only HttpOnly cookies with Path=/ and SameSite=Lax or Strict."); };
  if (!lines.length || lines.length > 4 || !Number.isFinite(expiresAt) || expiresAt <= now) return fail();
  const names = new Set<string>();
  return lines.map(line => {
    if (line.length > 4096 || /[\r\n\x00]/u.test(line)) return fail();
    const [pair, ...parts] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return fail();
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~\w]+$/u.test(name) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(value) || names.has(name)) return fail();
    names.add(name);
    const attrs = new Map<string, string>();
    for (const part of parts) {
      const index = part.indexOf("="), key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
      if (attrs.has(key)) return fail();
      attrs.set(key, index < 0 ? "" : part.slice(index + 1).trim());
    }
    const secure = attrs.has("secure"), sameSite = attrs.get("samesite")?.toLowerCase();
    if (attrs.has("domain") || attrs.has("partitioned") || attrs.get("path") !== "/" || !attrs.has("httponly") ||
        !["lax", "strict"].includes(sameSite || "") || (url.protocol === "https:" && !secure) ||
        (url.protocol === "http:" && secure)) return fail();
    let expirationDate = Math.min(expiresAt, now + 8 * 3600_000) / 1000;
    if (attrs.has("max-age")) {
      const age = attrs.get("max-age")!;
      if (!/^\d+$/u.test(age) || Number(age) <= 0) return fail();
      expirationDate = Math.min(expirationDate, now / 1000 + Number(age));
    } else if (attrs.has("expires")) {
      const expires = Date.parse(attrs.get("expires")!);
      if (!Number.isFinite(expires) || expires <= now) return fail();
      expirationDate = Math.min(expirationDate, expires / 1000);
    }
    return { url: url.origin + "/", name, value, path: "/", httpOnly: true, secure,
      sameSite: sameSite as "lax" | "strict", expirationDate };
  });
}
