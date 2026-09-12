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
export function normalizeUpdateConfig(value: unknown): DesktopUpdateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid updates configuration");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("updates.enabled must be boolean");
  const channel = input.channel ?? "stable";
  if (typeof channel !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) throw new Error("Invalid updates channel");
  const feedUrl = input.feedUrl ? updateUrl(input.feedUrl) : "";
  if (input.enabled && !feedUrl) throw new Error("updates.feedUrl is required when enabled");
  return { enabled: input.enabled, feedUrl, channel };
}
export function getUpdateConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "updates.json");
}
export function writeUpdateConfig(app: App, value: unknown, platform: NodeJS.Platform = process.platform) {
  const config = normalizeUpdateConfig(value);
  const target = getUpdateConfigPath(app, platform);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
}
export function readUpdateConfig(app: App): DesktopUpdateConfig {
  const target = getUpdateConfigPath(app);
  if (!fs.existsSync(target)) return { enabled: false, feedUrl: "", channel: "stable" };
  return normalizeUpdateConfig(JSON.parse(fs.readFileSync(target, "utf8")));
}
