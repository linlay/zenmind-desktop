import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export type TransitHubSettings = {
  enabled: boolean;
  baseUrl: string;
  auth: { mode: "access-token" } | { mode: "apikey"; providerKey: string };
};

export function normalizeTransitHubSettings(value: unknown): TransitHubSettings {
  const input = value as Partial<TransitHubSettings> | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.enabled !== "boolean") {
    throw new Error("Transit Hub enabled must be boolean.");
  }
  if (!input.enabled) return { enabled: false, baseUrl: "", auth: { mode: "access-token" } };
  let url: URL;
  try { url = new URL(input.baseUrl ?? ""); } catch { throw new Error("Transit Hub baseUrl is invalid."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Transit Hub baseUrl must be a remote HTTPS or loopback HTTP origin without credentials, path, query or fragment.");
  }
  if (input.auth?.mode === "access-token") {
    return { enabled: true, baseUrl: url.origin, auth: { mode: "access-token" } };
  }
  if (input.auth?.mode === "apikey" && typeof input.auth.providerKey === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.auth.providerKey)) {
    return { enabled: true, baseUrl: url.origin, auth: { mode: "apikey", providerKey: input.auth.providerKey } };
  }
  throw new Error("Transit Hub auth must specify access-token or apikey with a providerKey.");
}

export function getTransitHubSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "transit-hub.json");
}

export function writeTransitHubSettings(app: App, value: unknown, platform: NodeJS.Platform = process.platform) {
  const settings = normalizeTransitHubSettings(value);
  const filePath = getTransitHubSettingsPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readTransitHubSettings(app: App, platform: NodeJS.Platform = process.platform): TransitHubSettings | null {
  try {
    return normalizeTransitHubSettings(JSON.parse(fs.readFileSync(getTransitHubSettingsPath(app, platform), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
