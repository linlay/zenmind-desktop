import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { AssistantSettingsInput, AssistantSettingsPublic } from "../../../shared/contracts";
import {
  DEFAULT_CHAT_DEFAULT_AGENT_KEY,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  normalizeQuickAssistantShortcut,
  type DesktopCopilotPagePreferences
} from "../../../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../../../shared/page-copilot";
import { getAssistantSettingsRoot } from "../../user-paths";
import {
  DEFAULT_VOICE_CORRECTION_ENABLED,
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
  voiceCorrectionEnabled: boolean;
  desktopHelperAgentKey: string;
  chatDefaultAgentKey: string;
  bootstrapAgentKey: string;
  bootstrapChatId: string;
  quickAssistantEnabled: boolean;
  quickAssistantAgentKey: string;
  quickAssistantShortcut: string;
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
  const quickAssistantAgentKey = typeof candidate.quickAssistantAgentKey === "string" && candidate.quickAssistantAgentKey.trim()
    ? candidate.quickAssistantAgentKey.trim()
    : DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const quickAssistantShortcut = normalizeQuickAssistantShortcut(candidate.quickAssistantShortcut);
  const desktopCopilotPages = sanitizeDesktopCopilotPagePreferences(candidate.desktopCopilotPages);
  return {
    baseURL: "",
    model: "",
    apiKey: "",
    voiceCorrectionEnabled: typeof candidate.voiceCorrectionEnabled === "boolean"
      ? candidate.voiceCorrectionEnabled
      : DEFAULT_VOICE_CORRECTION_ENABLED,
    desktopHelperAgentKey,
    chatDefaultAgentKey,
    bootstrapAgentKey: typeof candidate.bootstrapAgentKey === "string" ? candidate.bootstrapAgentKey.trim() : "",
    bootstrapChatId: typeof candidate.bootstrapChatId === "string" ? candidate.bootstrapChatId.trim() : "",
    quickAssistantEnabled: typeof candidate.quickAssistantEnabled === "boolean"
      ? candidate.quickAssistantEnabled
      : DEFAULT_QUICK_ASSISTANT_ENABLED,
    quickAssistantAgentKey,
    quickAssistantShortcut,
    desktopCopilotPages
  };
}

function toStoredAssistantSettings(settings: AssistantSettingsPrivate) {
  return {
    voiceCorrectionEnabled: settings.voiceCorrectionEnabled,
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    chatDefaultAgentKey: settings.chatDefaultAgentKey,
    quickAssistantEnabled: settings.quickAssistantEnabled,
    quickAssistantAgentKey: settings.quickAssistantAgentKey,
    quickAssistantShortcut: settings.quickAssistantShortcut,
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
    voiceCorrectionEnabled: settings.voiceCorrectionEnabled,
    desktopHelperAgentKey: settings.desktopHelperAgentKey,
    chatDefaultAgentKey: settings.chatDefaultAgentKey,
    bootstrapAgentKey: settings.bootstrapAgentKey,
    bootstrapChatId: settings.bootstrapChatId,
    quickAssistantEnabled: settings.quickAssistantEnabled,
    quickAssistantAgentKey: settings.quickAssistantAgentKey,
    quickAssistantShortcut: settings.quickAssistantShortcut,
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
    voiceCorrectionEnabled: profile.assistant.voiceCorrectionEnabled,
    desktopHelperAgentKey: profile.assistant.copilot.agentKey,
    chatDefaultAgentKey:
      profile.assistant.chat.agentKey || desktopInitAssistant.chatDefaultAgentKey,
    bootstrapAgentKey: desktopInitAssistant.bootstrapAgentKey,
    bootstrapChatId: desktopInitAssistant.bootstrapChatId,
    quickAssistantEnabled: profile.assistant.quick.enabled,
    quickAssistantAgentKey: profile.assistant.quick.agentKey,
    quickAssistantShortcut: profile.assistant.quick.shortcut,
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
    voiceCorrectionEnabled: typeof input.voiceCorrectionEnabled === "boolean"
      ? input.voiceCorrectionEnabled
      : current.voiceCorrectionEnabled,
    desktopHelperAgentKey: typeof input.desktopHelperAgentKey === "string" && input.desktopHelperAgentKey.trim()
      ? input.desktopHelperAgentKey.trim()
      : current.desktopHelperAgentKey,
    chatDefaultAgentKey: typeof input.chatDefaultAgentKey === "string" && input.chatDefaultAgentKey.trim()
      ? input.chatDefaultAgentKey.trim()
      : current.chatDefaultAgentKey,
    bootstrapAgentKey: current.bootstrapAgentKey,
    bootstrapChatId: current.bootstrapChatId,
    quickAssistantEnabled: typeof input.quickAssistantEnabled === "boolean"
      ? input.quickAssistantEnabled
      : current.quickAssistantEnabled,
    quickAssistantAgentKey: typeof input.quickAssistantAgentKey === "string" && input.quickAssistantAgentKey.trim()
      ? input.quickAssistantAgentKey.trim()
      : current.quickAssistantAgentKey,
    quickAssistantShortcut: typeof input.quickAssistantShortcut === "string"
      ? normalizeQuickAssistantShortcut(input.quickAssistantShortcut)
      : current.quickAssistantShortcut,
    desktopCopilotPages: mergeDesktopCopilotPagePreferences(current.desktopCopilotPages, input.desktopCopilotPages)
  };

  updateDesktopProfileInRoot(rootDir, {
    assistant: {
      voiceCorrectionEnabled: next.voiceCorrectionEnabled,
      copilot: {
        agentKey: next.desktopHelperAgentKey
      },
      chat: {
        agentKey: next.chatDefaultAgentKey
      },
      quick: {
        enabled: next.quickAssistantEnabled,
        agentKey: next.quickAssistantAgentKey,
        shortcut: next.quickAssistantShortcut
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
  DEFAULT_VOICE_CORRECTION_ENABLED,
  SETTINGS_FILE,
  getAssistantRoot,
  getSettingsPath,
  normalizeStoredSettings,
  toStoredAssistantSettings
};
