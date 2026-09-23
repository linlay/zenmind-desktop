import fs from "node:fs";
import path from "node:path";
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
/** Resolve initialization input for the target OS before persisting canonical config. */
export function normalizeUpdateConfig(value: unknown, platform: NodeJS.Platform = process.platform): DesktopUpdateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid updates configuration");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("updates.enabled must be boolean");
  if (Object.prototype.hasOwnProperty.call(input, "feedUrl")) throw new Error("Use updates.feedUrls instead of updates.feedUrl");
  const feeds = input.feedUrls;
  if (feeds !== undefined && (!feeds || typeof feeds !== "object" || Array.isArray(feeds))) throw new Error("updates.feedUrls must be an object");
  const urls = (feeds ?? {}) as Record<string, unknown>;
  for (const [target, url] of Object.entries(urls)) {
    if (!["win32", "darwin", "linux"].includes(target)) throw new Error("Unsupported updates.feedUrls platform");
    updateUrl(url);
  }
  let feedUrl = "";
  if (platform === "win32" && urls.win32 !== undefined) feedUrl = updateUrl(urls.win32);
  else if (platform === "darwin" && urls.darwin !== undefined) feedUrl = updateUrl(urls.darwin);
  else if (platform === "linux" && urls.linux !== undefined) feedUrl = updateUrl(urls.linux);
  if (input.enabled && !feedUrl) throw new Error(`updates.feedUrls.${platform} is required when enabled`);
  return { enabled: input.enabled, feedUrl };
}
export function getUpdateConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "updates.json");
}
export function writeUpdateConfig(app: App, value: unknown, platform: NodeJS.Platform = process.platform) {
  const config = normalizeUpdateConfig(value, platform);
  const target = getUpdateConfigPath(app, platform);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
}
export function readUpdateConfig(app: App, platform: NodeJS.Platform = process.platform): DesktopUpdateConfig {
  const target = getUpdateConfigPath(app, platform);
  if (!fs.existsSync(target)) return { enabled: false, feedUrl: "" };
  // Canonical storage contains only the address already selected at initialization.
  const input: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid canonical updates configuration");
  const config = input as Record<string, unknown>;
  if (typeof config.enabled !== "boolean" || typeof config.feedUrl !== "string" || "feedUrls" in config) throw new Error("Invalid canonical updates configuration");
  const feedUrl = config.feedUrl ? updateUrl(config.feedUrl) : "";
  if (config.enabled && !feedUrl) throw new Error("Canonical updates.feedUrl is required when enabled");
  return { enabled: config.enabled, feedUrl };
}
