import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getSecretsRoot } from "./user-paths";

const SSO_SITE_TOKEN_FILE_NAME = "sso-site-token.json";

export type DesktopSsoSiteTokenUser = {
  sub: string;
  name: string;
  email: string;
};

export type DesktopSsoSiteTokenFile = {
  token: string;
  payload: Record<string, unknown>;
  expiresAtMs: number;
  user: DesktopSsoSiteTokenUser | null;
};

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readJwtExpiresAtMs(payload: Record<string, unknown>) {
  const exp = Number(payload.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function readSiteTokenUser(payload: Record<string, unknown>): DesktopSsoSiteTokenUser | null {
  const sub = readText(payload.sub);
  if (!sub) {
    return null;
  }
  const email = readText(payload.email);
  const name = readText(payload.name) ||
    readText(payload.preferred_username) ||
    readText(payload.username) ||
    email ||
    sub;
  return {
    sub,
    name,
    email
  };
}

export function getDesktopSsoSiteTokenPath(app: App) {
  return path.join(getSecretsRoot(app), SSO_SITE_TOKEN_FILE_NAME);
}

export function readDesktopSsoSiteTokenFile(app: App): DesktopSsoSiteTokenFile | null {
  const tokenPath = getDesktopSsoSiteTokenPath(app);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const token = readText(record.accessToken) || readText(record.access_token);
    if (!token) {
      return null;
    }
    const payload = readJwtPayload(token);
    if (!payload) {
      return null;
    }
    const expiresAtMs = readJwtExpiresAtMs(payload);
    if (expiresAtMs > 0 && expiresAtMs <= Date.now()) {
      return null;
    }
    return {
      token,
      payload,
      expiresAtMs,
      user: readSiteTokenUser(payload)
    };
  } catch {
    return null;
  }
}

export function readDesktopSsoSiteAccessToken(app: App) {
  return readDesktopSsoSiteTokenFile(app)?.token ?? "";
}

export function readDesktopSsoSiteTokenUser(app: App) {
  return readDesktopSsoSiteTokenFile(app)?.user ?? null;
}
