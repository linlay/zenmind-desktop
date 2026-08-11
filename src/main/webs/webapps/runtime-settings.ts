import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappRuntimeSettings,
  WebappRuntimeSettingsInput
} from "../../../shared/contracts";
import {
  WEBAPP_ID_PATTERN
} from "../../../shared/webapp-manifest";
import { getDesktopWebsConfigRoot } from "../../user-paths";

const DEFAULT_SETTINGS: WebappRuntimeSettings = {
  schemaVersion: 1,
  runtimeExecutables: {}
};
const WEBAPP_RUNTIME_PATTERN = /^(?:python|java)$/u;

export function getWebappRuntimeSettingsPath(app: App) {
  return path.join(getDesktopWebsConfigRoot(app), "runtime.json");
}

export function getRuntimeExecutableBindingKey(webappId: string, runtime: string) {
  if (!WEBAPP_ID_PATTERN.test(webappId) || !WEBAPP_RUNTIME_PATTERN.test(runtime)) {
    throw new Error("invalid WebApp runtime executable binding key.");
  }
  return `${webappId}:${runtime}`;
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
    const runtime = separator > 0 ? key.slice(separator + 1) : "";
    const executablePath = rawPath.trim();
    if (
      WEBAPP_ID_PATTERN.test(webappId) &&
      WEBAPP_RUNTIME_PATTERN.test(runtime) &&
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
      runtimeExecutables?: unknown;
    };
    if (parsed.schemaVersion !== 1) {
      return DEFAULT_SETTINGS;
    }
    return {
      schemaVersion: 1,
      runtimeExecutables: normalizeBindings(parsed.runtimeExecutables)
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
    runtimeExecutables: normalizeBindings(input.runtimeExecutables)
  };
  const filePath = getWebappRuntimeSettingsPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function resolveConfiguredRuntimeExecutable(
  app: App,
  webappId: string,
  runtime: string
) {
  const key = getRuntimeExecutableBindingKey(webappId, runtime);
  return readWebappRuntimeSettings(app).runtimeExecutables[key] ?? "";
}
