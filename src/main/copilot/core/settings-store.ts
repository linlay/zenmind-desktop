import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { AssistantSettingsInput, AssistantSettingsPublic } from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  type DesktopCopilotPagePreferences
} from "../../../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../../../shared/page-copilot";
import { getAssistantSettingsRoot } from "../../user-paths";

const SETTINGS_FILE = "settings.json";
const DEFAULT_VOICE_CORRECTION_ENABLED = true;

export type AssistantSettingsPrivate = {
  baseURL: string;
  model: string;
  apiKey: string;
  voiceCorrectionEnabled: boolean;
  desktopHelperAgentKey: string;
  quickAssistantEnabled: boolean;
  quickAssistantAgentKey: string;
  desktopCopilotPages: DesktopCopilotPagePreferences;
};

function getAssistantRoot(app: App) {
  return getAssistantSettingsRoot(app);
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
  const desktopHelperAgentKey = typeof candidate.desktopHelperAgentKey === "string" && candidate.desktopHelperAgentKey.trim()
    ? candidate.desktopHelperAgentKey.trim()
    : DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const quickAssistantAgentKey = typeof candidate.quickAssistantAgentKey === "string" && candidate.quickAssistantAgentKey.trim()
    ? candidate.quickAssistantAgentKey.trim()
    : DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const desktopCopilotPages = sanitizeDesktopCopilotPagePreferences(candidate.desktopCopilotPages);
  return {
    baseURL: "",
    model: "",
    apiKey: "",
    voiceCorrectionEnabled: typeof candidate.voiceCorrectionEnabled === "boolean"
      ? candidate.voiceCorrectionEnabled
      : DEFAULT_VOICE_CORRECTION_ENABLED,
    desktopHelperAgentKey,
    quickAssistantEnabled: typeof candidate.quickAssistantEnabled === "boolean"
      ? candidate.quickAssistantEnabled
      : DEFAULT_QUICK_ASSISTANT_ENABLED,
    quickAssistantAgentKey,
    desktopCopilotPages
  };
}

function toStoredAssistantSettings(settings: AssistantSettingsPrivate) {
  return {
    voiceCorrectionEnabled: settings.voiceCorrectionEnabled,
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    quickAssistantEnabled: settings.quickAssistantEnabled,
    quickAssistantAgentKey: settings.quickAssistantAgentKey,
    desktopCopilotPages: settings.desktopCopilotPages
  };
}

function needsSanitizedWrite(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return "apiKey" in candidate || "baseURL" in candidate || "model" in candidate || "clearApiKey" in candidate;
}

function mergeDesktopCopilotPagePreferences(
  current: DesktopCopilotPagePreferences,
  patch: AssistantSettingsInput["desktopCopilotPages"]
) {
  if (!patch) {
    return current;
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [pageKey, value] of Object.entries(patch)) {
    const currentPreference = current[pageKey as keyof DesktopCopilotPagePreferences];
    merged[pageKey] = value && typeof value === "object" && !Array.isArray(value)
      ? {
          ...currentPreference,
          ...value
        }
      : value;
  }
  return sanitizeDesktopCopilotPagePreferences(merged);
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
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    quickAssistantEnabled: settings.quickAssistantEnabled,
    quickAssistantAgentKey: settings.quickAssistantAgentKey,
    desktopCopilotPages: settings.desktopCopilotPages,
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
      : current.voiceCorrectionEnabled,
    desktopHelperAgentKey: typeof input.desktopHelperAgentKey === "string" && input.desktopHelperAgentKey.trim()
      ? input.desktopHelperAgentKey.trim()
      : current.desktopHelperAgentKey,
    quickAssistantEnabled: typeof input.quickAssistantEnabled === "boolean"
      ? input.quickAssistantEnabled
      : current.quickAssistantEnabled,
    quickAssistantAgentKey: typeof input.quickAssistantAgentKey === "string" && input.quickAssistantAgentKey.trim()
      ? input.quickAssistantAgentKey.trim()
      : current.quickAssistantAgentKey,
    desktopCopilotPages: mergeDesktopCopilotPagePreferences(current.desktopCopilotPages, input.desktopCopilotPages)
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
