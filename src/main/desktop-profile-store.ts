import fs from "node:fs";
import path from "node:path";
import type { SupportedLocale } from "../shared/i18n";
import { DEFAULT_LOCALE, normalizeLocale } from "../shared/i18n";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  type DesktopCopilotPagePreferences
} from "../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../shared/page-copilot";

export const DESKTOP_PROFILE_FILE = "profile.json";
export const LEGACY_DESKTOP_PREFERENCES_FILE = "preferences.json";
export const LEGACY_ASSISTANT_SETTINGS_FILE = "settings.json";
export const DEFAULT_VOICE_CORRECTION_ENABLED = true;

export type DesktopThemePreference = "system" | "light" | "dark";

export type DesktopProfile = {
  schemaVersion: 1;
  appearance: {
    theme: DesktopThemePreference;
    locale: SupportedLocale;
  };
  assistant: {
    desktopHelperAgentKey: string;
    voiceCorrectionEnabled: boolean;
    quickAssistant: {
      enabled: boolean;
      agentKey: string;
    };
  };
  navigation: {
    mainOrder: string[];
    webOrder: string[];
    desktopCopilotPages: DesktopCopilotPagePreferences;
  };
};

type DesktopProfileReadOptions = {
  defaultLocale?: SupportedLocale;
};

type DesktopProfilePatch = Partial<{
  appearance: Partial<DesktopProfile["appearance"]>;
  assistant: Partial<Omit<DesktopProfile["assistant"], "quickAssistant">> & {
    quickAssistant?: Partial<DesktopProfile["assistant"]["quickAssistant"]>;
  };
  navigation: Partial<DesktopProfile["navigation"]>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTheme(value: unknown): DesktopThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function normalizeTextArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readText(item))
    .filter(Boolean);
}

function normalizeLegacyKanbanNavigation(value: unknown): { enabled?: boolean } {
  const record = isRecord(value) ? value : {};
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {})
  };
}

function readLegacyPreferences(rootDir: string) {
  const parsed = readJsonFile(path.join(rootDir, LEGACY_DESKTOP_PREFERENCES_FILE));
  return isRecord(parsed) ? parsed : {};
}

function readLegacyAssistantSettings(rootDir: string) {
  const parsed = readJsonFile(path.join(rootDir, LEGACY_ASSISTANT_SETTINGS_FILE));
  return isRecord(parsed) ? parsed : {};
}

function hasLegacyProfileInputs(rootDir: string) {
  return fs.existsSync(path.join(rootDir, LEGACY_DESKTOP_PREFERENCES_FILE)) ||
    fs.existsSync(path.join(rootDir, LEGACY_ASSISTANT_SETTINGS_FILE));
}

function normalizeDesktopProfile(
  value: unknown,
  rootDir: string,
  options: DesktopProfileReadOptions = {}
): DesktopProfile {
  const record = isRecord(value) ? value : {};
  const legacyPreferences = value ? {} : readLegacyPreferences(rootDir);
  const legacySettings = value ? {} : readLegacyAssistantSettings(rootDir);
  const appearance = isRecord(record.appearance) ? record.appearance : {};
  const assistant = isRecord(record.assistant) ? record.assistant : {};
  const quickAssistant = isRecord(assistant.quickAssistant) ? assistant.quickAssistant : {};
  const navigation = isRecord(record.navigation) ? record.navigation : {};
  const webOrder = normalizeTextArray(navigation.webOrder);
  const legacyWebsiteOrder = normalizeTextArray(navigation.websiteOrder);
  const legacyLocale = normalizeLocale(legacyPreferences.locale);
  const profileLocale = normalizeLocale(appearance.locale);
  const desktopHelperAgentKey =
    readText(assistant.desktopHelperAgentKey) ||
    readText(legacySettings.desktopHelperAgentKey) ||
    DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const quickAssistantAgentKey =
    readText(quickAssistant.agentKey) ||
    readText(legacySettings.quickAssistantAgentKey) ||
    DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const legacyQuickAssistantEnabled = typeof legacySettings.quickAssistantEnabled === "boolean"
    ? legacySettings.quickAssistantEnabled
    : DEFAULT_QUICK_ASSISTANT_ENABLED;
  const legacyVoiceCorrectionEnabled = typeof legacySettings.voiceCorrectionEnabled === "boolean"
    ? legacySettings.voiceCorrectionEnabled
    : DEFAULT_VOICE_CORRECTION_ENABLED;

  return {
    schemaVersion: 1,
    appearance: {
      theme: normalizeTheme(appearance.theme),
      locale: profileLocale || legacyLocale || options.defaultLocale || DEFAULT_LOCALE
    },
    assistant: {
      desktopHelperAgentKey,
      voiceCorrectionEnabled: typeof assistant.voiceCorrectionEnabled === "boolean"
        ? assistant.voiceCorrectionEnabled
        : legacyVoiceCorrectionEnabled,
      quickAssistant: {
        enabled: typeof quickAssistant.enabled === "boolean"
          ? quickAssistant.enabled
          : legacyQuickAssistantEnabled,
        agentKey: quickAssistantAgentKey
      }
    },
    navigation: {
      mainOrder: normalizeTextArray(navigation.mainOrder),
      webOrder: webOrder.length > 0 ? webOrder : legacyWebsiteOrder,
      desktopCopilotPages: sanitizeDesktopCopilotPagePreferences(
        navigation.desktopCopilotPages ?? legacySettings.desktopCopilotPages
      )
    }
  };
}

export function getDesktopProfilePath(rootDir: string) {
  return path.join(rootDir, DESKTOP_PROFILE_FILE);
}

export function readDesktopProfileFromRoot(
  rootDir: string,
  options: DesktopProfileReadOptions = {}
): DesktopProfile {
  fs.mkdirSync(rootDir, { recursive: true });
  const profilePath = getDesktopProfilePath(rootDir);
  const parsed = readJsonFile(profilePath);
  const profile = normalizeDesktopProfile(parsed, rootDir, options);
  if (!parsed && hasLegacyProfileInputs(rootDir)) {
    writeJsonFile(profilePath, profile);
  }
  return profile;
}

export function readLegacyKanbanNavigationPreferenceFromRoot(rootDir: string) {
  const parsed = readJsonFile(path.join(rootDir, DESKTOP_PROFILE_FILE));
  const record = isRecord(parsed) ? parsed : {};
  const navigation = isRecord(record.navigation) ? record.navigation : {};
  return normalizeLegacyKanbanNavigation(navigation.kanban);
}

export function writeDesktopProfileToRoot(rootDir: string, profile: DesktopProfile) {
  const normalized = normalizeDesktopProfile(profile, rootDir);
  writeJsonFile(getDesktopProfilePath(rootDir), normalized);
  return normalized;
}

export function updateDesktopProfileInRoot(rootDir: string, patch: DesktopProfilePatch) {
  const current = readDesktopProfileFromRoot(rootDir);
  return writeDesktopProfileToRoot(rootDir, {
    ...current,
    appearance: {
      ...current.appearance,
      ...patch.appearance
    },
    assistant: {
      ...current.assistant,
      ...patch.assistant,
      quickAssistant: {
        ...current.assistant.quickAssistant,
        ...patch.assistant?.quickAssistant
      }
    },
    navigation: {
      ...current.navigation,
      ...patch.navigation
    }
  });
}

export const __testInternals = {
  normalizeDesktopProfile,
  readLegacyPreferences,
  readLegacyAssistantSettings
};
