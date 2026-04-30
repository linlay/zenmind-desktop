import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { AssistantSettingsInput, AssistantSettingsPublic } from "../../shared/contracts";

const SETTINGS_FILE = "settings.json";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export type AssistantSettingsPrivate = {
  baseURL: string;
  model: string;
  apiKey: string;
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
    baseURL: typeof candidate.baseURL === "string" && candidate.baseURL.trim()
      ? candidate.baseURL.trim()
      : DEFAULT_BASE_URL,
    model: typeof candidate.model === "string" && candidate.model.trim()
      ? candidate.model.trim()
      : DEFAULT_MODEL,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : ""
  };
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
    source,
    ...(sourceLabel ? { sourceLabel } : {})
  };
}

export function readAssistantSettingsFromRoot(rootDir: string): AssistantSettingsPrivate {
  ensureRoot(rootDir);
  const settingsPath = getSettingsPath(rootDir);
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return normalizeStoredSettings(JSON.parse(raw));
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
    baseURL: typeof input.baseURL === "string" && input.baseURL.trim()
      ? input.baseURL.trim()
      : current.baseURL,
    model: typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : current.model,
    apiKey: input.clearApiKey
      ? ""
      : typeof input.apiKey === "string"
        ? input.apiKey.trim()
        : current.apiKey
  };

  fs.writeFileSync(getSettingsPath(rootDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  getAssistantRoot,
  normalizeStoredSettings
};
