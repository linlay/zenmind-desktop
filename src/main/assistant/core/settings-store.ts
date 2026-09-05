import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { AssistantSettingsInput, AssistantSettingsPublic } from "../../../shared/contracts";
import {
  DEFAULT_CHAT_DEFAULT_AGENT_KEY,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  type DesktopCopilotPagePreferences
} from "../../../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../../../shared/page-copilot";
import { getAssistantSettingsRoot } from "../../user-paths";
import {
  DESKTOP_PROFILE_FILE,
  getDesktopProfilePath,
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} from "../../desktop-profile-store";

const SETTINGS_FILE = DESKTOP_PROFILE_FILE;
const DESKTOP_INIT_ASSISTANT_FILE = "assistant.json";

export type AssistantSettingsPrivate = {
  baseURL: string;
  model: string;
  apiKey: string;
  desktopHelperAgentKey: string;
  chatDefaultAgentKey: string;
  bootstrapAgentKey: string;
  bootstrapChatId: string;
  desktopCopilotPages: DesktopCopilotPagePreferences;
};

function getAssistantRoot(app: App) {
  return getAssistantSettingsRoot(app);
}

function getSettingsPath(rootDir: string) {
  return getDesktopProfilePath(rootDir);
}

function ensureRoot(rootDir: string) {
  fs.mkdirSync(rootDir, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readDesktopInitAssistantSettingsFromRoot(rootDir: string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(rootDir, DESKTOP_INIT_ASSISTANT_FILE), "utf8")
    ) as unknown;
    if (!isRecord(parsed)) {
      return { bootstrapAgentKey: "", bootstrapChatId: "", chatDefaultAgentKey: "" };
    }
    return {
      bootstrapAgentKey: readText(parsed.bootstrapAgentKey),
      bootstrapChatId: readText(parsed.bootstrapChatId),
      chatDefaultAgentKey: readText(parsed.defaultChatAgentKey),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[assistant] failed to read ${DESKTOP_INIT_ASSISTANT_FILE}:`, error);
    }
    return { bootstrapAgentKey: "", bootstrapChatId: "", chatDefaultAgentKey: "" };
  }
}

function normalizeStoredSettings(value: unknown): AssistantSettingsPrivate {
  const candidate = typeof value === "object" && value !== null
    ? value as Partial<AssistantSettingsPrivate>
    : {};
  const desktopHelperAgentKey = typeof candidate.desktopHelperAgentKey === "string" && candidate.desktopHelperAgentKey.trim()
    ? candidate.desktopHelperAgentKey.trim()
    : DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const chatDefaultAgentKey = typeof candidate.chatDefaultAgentKey === "string" && candidate.chatDefaultAgentKey.trim()
    ? candidate.chatDefaultAgentKey.trim()
    : DEFAULT_CHAT_DEFAULT_AGENT_KEY;
  const desktopCopilotPages = sanitizeDesktopCopilotPagePreferences(candidate.desktopCopilotPages);
  return {
    baseURL: "",
    model: "",
    apiKey: "",
    desktopHelperAgentKey,
    chatDefaultAgentKey,
    bootstrapAgentKey: typeof candidate.bootstrapAgentKey === "string" ? candidate.bootstrapAgentKey.trim() : "",
    bootstrapChatId: typeof candidate.bootstrapChatId === "string" ? candidate.bootstrapChatId.trim() : "",
    desktopCopilotPages
  };
}

function toStoredAssistantSettings(settings: AssistantSettingsPrivate) {
  return {
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    chatDefaultAgentKey: settings.chatDefaultAgentKey,
    desktopCopilotPages: settings.desktopCopilotPages
  };
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
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    chatDefaultAgentKey: settings.chatDefaultAgentKey,
    bootstrapAgentKey: settings.bootstrapAgentKey,
    bootstrapChatId: settings.bootstrapChatId,
    desktopCopilotPages: settings.desktopCopilotPages,
    source,
    ...(sourceLabel ? { sourceLabel } : {})
  };
}

export function readAssistantSettingsFromRoot(rootDir: string): AssistantSettingsPrivate {
  ensureRoot(rootDir);
  const profile = readDesktopProfileFromRoot(rootDir);
  const desktopInitAssistant = readDesktopInitAssistantSettingsFromRoot(rootDir);
  const settings = normalizeStoredSettings({
    desktopHelperAgentKey: profile.assistant.copilot.agentKey,
    chatDefaultAgentKey:
      profile.assistant.chat.agentKey || desktopInitAssistant.chatDefaultAgentKey,
    bootstrapAgentKey: desktopInitAssistant.bootstrapAgentKey,
    bootstrapChatId: desktopInitAssistant.bootstrapChatId,
    desktopCopilotPages: profile.navigation.desktopCopilotPages
  });
  return settings;
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
    desktopHelperAgentKey: typeof input.desktopHelperAgentKey === "string" && input.desktopHelperAgentKey.trim()
      ? input.desktopHelperAgentKey.trim()
      : current.desktopHelperAgentKey,
    chatDefaultAgentKey: typeof input.chatDefaultAgentKey === "string" && input.chatDefaultAgentKey.trim()
      ? input.chatDefaultAgentKey.trim()
      : current.chatDefaultAgentKey,
    bootstrapAgentKey: current.bootstrapAgentKey,
    bootstrapChatId: current.bootstrapChatId,
    desktopCopilotPages: mergeDesktopCopilotPagePreferences(current.desktopCopilotPages, input.desktopCopilotPages)
  };

  updateDesktopProfileInRoot(rootDir, {
    assistant: {
      copilot: {
        agentKey: next.desktopHelperAgentKey
      },
      chat: {
        agentKey: next.chatDefaultAgentKey
      }
    },
    navigation: {
      desktopCopilotPages: next.desktopCopilotPages
    }
  });
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
  SETTINGS_FILE,
  getAssistantRoot,
  getSettingsPath,
  normalizeStoredSettings,
  toStoredAssistantSettings
};
