import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { AssistantSettingsInput, AssistantSettingsPublic } from "../../shared/contracts";

const SETTINGS_FILE = "settings.json";
const DEFAULT_VOICE_CORRECTION_ENABLED = true;

export type AssistantSettingsPrivate = {
  baseURL: string;
  model: string;
  apiKey: string;
  voiceCorrectionEnabled: boolean;
};

function getAssistantRoot(app: App) {
  return path.join(app.getPath("userData"), "assistant");
}

function getSettingsPath(rootDir: string) {
  return path.join(rootDir, SETTINGS_FILE);
}

function ensureRoot(rootDir: string) {
  fs.mkdirSync(rootDir, { recursive: true });
}

function normalizeStoredSettings(value: unknown): AssistantSettingsPrivate {
  const candidate = typeof value === "object" && value !== null
    ? value as Partial<AssistantSettingsPrivate>
    : {};
  return {
    baseURL: "",
    model: "",
    apiKey: "",
    voiceCorrectionEnabled: typeof candidate.voiceCorrectionEnabled === "boolean"
      ? candidate.voiceCorrectionEnabled
      : DEFAULT_VOICE_CORRECTION_ENABLED
  };
}

function toStoredAssistantSettings(settings: AssistantSettingsPrivate) {
  return {
    voiceCorrectionEnabled: settings.voiceCorrectionEnabled
  };
}

function needsSanitizedWrite(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return "apiKey" in candidate || "baseURL" in candidate || "model" in candidate || "clearApiKey" in candidate;
}

export function toPublicAssistantSettings(
  settings: AssistantSettingsPrivate,
  source: AssistantSettingsPublic["source"] = "desktop",
  sourceLabel?: string
): AssistantSettingsPublic {
  const apiKeyConfigured = settings.apiKey.trim().length > 0;
  return {
    baseURL: settings.baseURL,
    model: settings.model,
    configured: Boolean(settings.baseURL.trim() && settings.model.trim() && apiKeyConfigured),
    apiKeyConfigured,
    voiceCorrectionEnabled: settings.voiceCorrectionEnabled,
    source,
    ...(sourceLabel ? { sourceLabel } : {})
  };
}

export function readAssistantSettingsFromRoot(rootDir: string): AssistantSettingsPrivate {
  ensureRoot(rootDir);
  const settingsPath = getSettingsPath(rootDir);
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    const settings = normalizeStoredSettings(parsed);
    if (needsSanitizedWrite(parsed)) {
      fs.writeFileSync(settingsPath, `${JSON.stringify(toStoredAssistantSettings(settings), null, 2)}\n`, "utf8");
    }
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return normalizeStoredSettings(null);
    }
    throw error;
  }
}

export function getAssistantSettingsFromRoot(rootDir: string): AssistantSettingsPublic {
  return toPublicAssistantSettings(readAssistantSettingsFromRoot(rootDir));
}

export function saveAssistantSettingsToRoot(
  rootDir: string,
  input: AssistantSettingsInput
): AssistantSettingsPublic {
  ensureRoot(rootDir);
  const current = readAssistantSettingsFromRoot(rootDir);
  const next: AssistantSettingsPrivate = {
    baseURL: "",
    model: "",
    apiKey: "",
    voiceCorrectionEnabled: typeof input.voiceCorrectionEnabled === "boolean"
      ? input.voiceCorrectionEnabled
      : current.voiceCorrectionEnabled
  };

  fs.writeFileSync(getSettingsPath(rootDir), `${JSON.stringify(toStoredAssistantSettings(next), null, 2)}\n`, "utf8");
  return toPublicAssistantSettings(next);
}

export function readAssistantSettings(app: App): AssistantSettingsPrivate {
  return readAssistantSettingsFromRoot(getAssistantRoot(app));
}

export function getAssistantSettings(app: App): AssistantSettingsPublic {
  return getAssistantSettingsFromRoot(getAssistantRoot(app));
}

export function saveAssistantSettings(app: App, input: AssistantSettingsInput): AssistantSettingsPublic {
  return saveAssistantSettingsToRoot(getAssistantRoot(app), input);
}

export const __testInternals = {
  DEFAULT_VOICE_CORRECTION_ENABLED,
  getAssistantRoot,
  normalizeStoredSettings,
  toStoredAssistantSettings
};
