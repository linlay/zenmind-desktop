import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type { DesktopUpdateConfig } from "../../../shared/desktop-updates";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export function updateUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid update URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Update URLs must use HTTPS without credentials or fragments");
  }
  return url.href;
}
/** Initialization and canonical storage share one platform-neutral update entry. */
export function normalizeUpdateConfig(value: unknown, platform: NodeJS.Platform = process.platform): DesktopUpdateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid updates configuration");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("updates.enabled must be boolean");
  if (Object.prototype.hasOwnProperty.call(input, "feedUrls")) throw new Error("Use updates.feedUrl instead of updates.feedUrls");
  const feedUrl = input.feedUrl === undefined || input.feedUrl === "" ? "" : updateUrl(input.feedUrl);
  if (input.enabled && !feedUrl) throw new Error("updates.feedUrl is required when enabled");
  return { enabled: input.enabled, feedUrl };
}
export function getUpdateConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "updates.json");
}
export function writeUpdateConfig(app: App, value: unknown, platform: NodeJS.Platform = process.platform) {
  const config = normalizeUpdateConfig(value, platform);
  const target = getUpdateConfigPath(app, platform);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function readUpdateConfig(app: App, platform: NodeJS.Platform = process.platform): DesktopUpdateConfig {
  const target = getUpdateConfigPath(app, platform);
  if (!fs.existsSync(target)) return { enabled: false, feedUrl: "" };
  // Canonical storage keeps the shared entry; the request supplies the platform.
  const input: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid canonical updates configuration");
  const config = input as Record<string, unknown>;
  if (typeof config.enabled !== "boolean" || typeof config.feedUrl !== "string" || "feedUrls" in config) throw new Error("Invalid canonical updates configuration");
  const feedUrl = config.feedUrl ? updateUrl(config.feedUrl) : "";
  if (config.enabled && !feedUrl) throw new Error("Canonical updates.feedUrl is required when enabled");
  return { enabled: config.enabled, feedUrl };
}
