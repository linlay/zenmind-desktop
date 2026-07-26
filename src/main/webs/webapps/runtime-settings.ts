import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappRuntimeSettings,
  WebappRuntimeSettingsInput
} from "../../../shared/contracts";
import { getDesktopWebsConfigRoot } from "../../user-paths";

const DEFAULT_SETTINGS: WebappRuntimeSettings = {
  schemaVersion: 1,
  javaExecutable: "",
  containerEngine: "auto"
};

export function getWebappRuntimeSettingsPath(app: App) {
  return path.join(getDesktopWebsConfigRoot(app), "runtime.json");
}

export function readWebappRuntimeSettings(app: App): WebappRuntimeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWebappRuntimeSettingsPath(app), "utf8")) as {
      javaExecutable?: unknown;
      containerEngine?: unknown;
    };
    const containerEngine = parsed.containerEngine === "docker" || parsed.containerEngine === "podman"
      ? parsed.containerEngine
      : "auto";
    return {
      schemaVersion: 1,
      javaExecutable: typeof parsed.javaExecutable === "string" ? parsed.javaExecutable.trim() : "",
      containerEngine
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeWebappRuntimeSettings(
  app: App,
  input: WebappRuntimeSettingsInput
): WebappRuntimeSettings {
  const current = readWebappRuntimeSettings(app);
  const containerEngine = input.containerEngine === "docker" || input.containerEngine === "podman"
    ? input.containerEngine
    : input.containerEngine === "auto"
      ? "auto"
      : current.containerEngine;
  const next: WebappRuntimeSettings = {
    schemaVersion: 1,
    javaExecutable: typeof input.javaExecutable === "string"
      ? input.javaExecutable.trim()
      : current.javaExecutable,
    containerEngine
  };
  const filePath = getWebappRuntimeSettingsPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
