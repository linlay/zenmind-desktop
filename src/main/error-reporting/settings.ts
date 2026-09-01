import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  isDesktopDevelopmentRuntime,
  type DesktopDevelopmentRuntimeContext
} from "../development-runtime";
import { getDesktopConfigRoot } from "../user-paths";

export type ErrorReportingSettings = {
  schemaVersion: 1;
  enabled: boolean;
  endpoint: string;
};

const FILE_NAME = "error-reporting.json";

function isLoopback(hostname: string) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export function normalizeErrorReportingEndpoint(value: unknown, packaged: boolean) {
  if (typeof value !== "string" || !value.trim()) return "";
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && (packaged || url.protocol !== "http:" || !isLoopback(url.hostname))) {
    throw new Error("Production error reporting endpoint must use HTTPS; development HTTP must be loopback.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function getErrorReportingSettingsPath(app: App, platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), FILE_NAME);
}

export function readErrorReportingSettings(
  app: App,
  platform = process.platform,
  developmentContext: DesktopDevelopmentRuntimeContext = { platform }
): ErrorReportingSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(getErrorReportingSettingsPath(app, platform), "utf8")) as Record<string, unknown>;
    return {
      schemaVersion: 1,
      enabled: raw.enabled !== false,
      endpoint: normalizeErrorReportingEndpoint(
        raw.endpoint,
        !isDesktopDevelopmentRuntime(app, developmentContext)
      )
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[error-reporting] invalid settings", error);
    return { schemaVersion: 1, enabled: true, endpoint: "" };
  }
}

export function writeErrorReportingSettings(
  app: App,
  input: { enabled?: unknown; endpoint?: unknown },
  platform = process.platform,
  developmentContext: DesktopDevelopmentRuntimeContext = { platform }
) {
  const current = readErrorReportingSettings(app, platform, developmentContext);
  const next: ErrorReportingSettings = {
    schemaVersion: 1,
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    endpoint: input.endpoint === undefined
      ? current.endpoint
      : normalizeErrorReportingEndpoint(
          input.endpoint,
          !isDesktopDevelopmentRuntime(app, developmentContext)
        )
  };
  const target = getErrorReportingSettingsPath(app, platform);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}
