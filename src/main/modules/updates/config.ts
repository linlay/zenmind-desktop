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
export function normalizeUpdateConfig(value: unknown, platform: NodeJS.Platform = process.platform): DesktopUpdateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid updates configuration");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("updates.enabled must be boolean");
  if (input.feedUrl !== undefined && input.feedUrls !== undefined) {
    throw new Error("updates.feedUrl and updates.feedUrls cannot be combined");
  }
  let feedUrl = input.feedUrl ? updateUrl(input.feedUrl) : "";
  if (input.feedUrls !== undefined) {
    if (!input.feedUrls || typeof input.feedUrls !== "object" || Array.isArray(input.feedUrls)) throw new Error("updates.feedUrls must be an object");
    const feeds = input.feedUrls as Record<string, unknown>;
    for (const [target, url] of Object.entries(feeds)) {
      if (!["win32", "darwin", "linux"].includes(target)) throw new Error("Unsupported updates.feedUrls platform");
      updateUrl(url);
    }
    // A platform map has no implicit fallback. Legacy single-feed inputs still work.
    if (platform === "win32" && feeds.win32 !== undefined) feedUrl = updateUrl(feeds.win32);
    else if (platform === "darwin" && feeds.darwin !== undefined) feedUrl = updateUrl(feeds.darwin);
    else if (platform === "linux" && feeds.linux !== undefined) feedUrl = updateUrl(feeds.linux);
  }
  if (input.enabled && !feedUrl) {
    const field = input.feedUrls === undefined ? "updates.feedUrl" : `updates.feedUrls.${platform}`;
    throw new Error(`${field} is required when enabled`);
  }
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
export function readUpdateConfig(app: App): DesktopUpdateConfig {
  const target = getUpdateConfigPath(app);
  if (!fs.existsSync(target)) return { enabled: false, feedUrl: "" };
  return normalizeUpdateConfig(JSON.parse(fs.readFileSync(target, "utf8")));
}
