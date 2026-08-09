import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappRuntimeSettings,
  WebappRuntimeSettingsInput
} from "../../../shared/contracts";
import {
  WEBAPP_ID_PATTERN,
  WEBAPP_SYSTEM_EXECUTABLE_PATTERN
} from "../../../shared/webapp-manifest";
import { getDesktopWebsConfigRoot } from "../../user-paths";

const DEFAULT_SETTINGS: WebappRuntimeSettings = {
  schemaVersion: 1,
  systemExecutables: {}
};

export function getWebappRuntimeSettingsPath(app: App) {
  return path.join(getDesktopWebsConfigRoot(app), "runtime.json");
}

export function getSystemExecutableBindingKey(webappId: string, executable: string) {
  if (!WEBAPP_ID_PATTERN.test(webappId) || !WEBAPP_SYSTEM_EXECUTABLE_PATTERN.test(executable)) {
    throw new Error("invalid WebApp system executable binding key.");
  }
  return `${webappId}:${executable}`;
}

function normalizeBindings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const bindings: Record<string, string> = {};
  for (const [key, rawPath] of Object.entries(value)) {
    if (typeof rawPath !== "string") {
      continue;
    }
    const separator = key.lastIndexOf(":");
    const webappId = separator > 0 ? key.slice(0, separator) : "";
    const executable = separator > 0 ? key.slice(separator + 1) : "";
    const executablePath = rawPath.trim();
    if (
      WEBAPP_ID_PATTERN.test(webappId) &&
      WEBAPP_SYSTEM_EXECUTABLE_PATTERN.test(executable) &&
      executablePath &&
      path.isAbsolute(executablePath)
    ) {
      bindings[key] = executablePath;
    }
  }
  return bindings;
}

export function readWebappRuntimeSettings(app: App): WebappRuntimeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWebappRuntimeSettingsPath(app), "utf8")) as {
      schemaVersion?: unknown;
      systemExecutables?: unknown;
    };
    if (parsed.schemaVersion !== 1) {
      return DEFAULT_SETTINGS;
    }
    return {
      schemaVersion: 1,
      systemExecutables: normalizeBindings(parsed.systemExecutables)
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeWebappRuntimeSettings(
  app: App,
  input: WebappRuntimeSettingsInput
): WebappRuntimeSettings {
  const next: WebappRuntimeSettings = {
    schemaVersion: 1,
    systemExecutables: normalizeBindings(input.systemExecutables)
  };
  const filePath = getWebappRuntimeSettingsPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function resolveConfiguredSystemExecutable(
  app: App,
  webappId: string,
  executable: string
) {
  const key = getSystemExecutableBindingKey(webappId, executable);
  return readWebappRuntimeSettings(app).systemExecutables[key] ?? "";
}
