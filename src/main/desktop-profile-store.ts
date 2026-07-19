import fs from "node:fs";
import path from "node:path";
import type { SupportedLocale } from "../shared/i18n";
import { DEFAULT_LOCALE, normalizeLocale } from "../shared/i18n";
import {
  DEFAULT_CHAT_DEFAULT_AGENT_KEY,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_ENABLED,
  normalizeQuickAssistantShortcut,
  type DesktopCopilotPagePreferences
} from "../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../shared/page-copilot";

export const DESKTOP_PROFILE_FILE = "profile.json";
export const DEFAULT_VOICE_CORRECTION_ENABLED = true;

export type DesktopThemePreference = "system" | "light" | "dark";

export type DesktopGeneralSettings = {
  deviceName: string;
  preventSleepWhileRunning: boolean;
  desktopWsServerEnabled: boolean;
  desktopActionConfirmationEnabled: boolean;
};

export type DesktopProfile = {
  schemaVersion: 1;
  general: DesktopGeneralSettings;
  appearance: {
    theme: DesktopThemePreference;
    locale: SupportedLocale;
  };
  assistant: {
    voiceCorrectionEnabled: boolean;
    copilot: {
      agentKey: string;
    };
    chat: {
      agentKey: string;
    };
    quick: {
      enabled: boolean;
      agentKey: string;
      shortcut: string;
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
  general: Partial<DesktopProfile["general"]>;
  appearance: Partial<DesktopProfile["appearance"]>;
  assistant: Partial<Omit<DesktopProfile["assistant"], "copilot" | "chat" | "quick">> & {
    copilot?: Partial<DesktopProfile["assistant"]["copilot"]>;
    chat?: Partial<DesktopProfile["assistant"]["chat"]>;
    quick?: Partial<DesktopProfile["assistant"]["quick"]>;
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

function normalizeDesktopProfile(
  value: unknown,
  options: DesktopProfileReadOptions = {}
): DesktopProfile {
  const record = isRecord(value) ? value : {};
  const general = isRecord(record.general) ? record.general : {};
  const appearance = isRecord(record.appearance) ? record.appearance : {};
  const assistant = isRecord(record.assistant) ? record.assistant : {};
  const copilot = isRecord(assistant.copilot) ? assistant.copilot : {};
  const chat = isRecord(assistant.chat) ? assistant.chat : {};
  const quick = isRecord(assistant.quick) ? assistant.quick : {};
  const navigation = isRecord(record.navigation) ? record.navigation : {};
  const profileLocale = normalizeLocale(appearance.locale);
  const copilotAgentKey = readText(copilot.agentKey) || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const quickAgentKey = readText(quick.agentKey) || DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const chatAgentKey = readText(chat.agentKey) || DEFAULT_CHAT_DEFAULT_AGENT_KEY;
  const quickShortcut = normalizeQuickAssistantShortcut(readText(quick.shortcut));

  return {
    schemaVersion: 1,
    general: {
      deviceName: readText(general.deviceName),
      preventSleepWhileRunning: typeof general.preventSleepWhileRunning === "boolean"
        ? general.preventSleepWhileRunning
        : true,
      desktopWsServerEnabled: typeof general.desktopWsServerEnabled === "boolean"
        ? general.desktopWsServerEnabled
        : false,
      desktopActionConfirmationEnabled: typeof general.desktopActionConfirmationEnabled === "boolean"
        ? general.desktopActionConfirmationEnabled
        : true
    },
    appearance: {
      theme: normalizeTheme(appearance.theme),
      locale: profileLocale || options.defaultLocale || DEFAULT_LOCALE
    },
    assistant: {
      voiceCorrectionEnabled: typeof assistant.voiceCorrectionEnabled === "boolean"
        ? assistant.voiceCorrectionEnabled
        : DEFAULT_VOICE_CORRECTION_ENABLED,
      copilot: {
        agentKey: copilotAgentKey
      },
      chat: {
        agentKey: chatAgentKey
      },
      quick: {
        enabled: typeof quick.enabled === "boolean"
          ? quick.enabled
          : DEFAULT_QUICK_ASSISTANT_ENABLED,
        agentKey: quickAgentKey,
        shortcut: quickShortcut
      }
    },
    navigation: {
      mainOrder: normalizeTextArray(navigation.mainOrder),
      webOrder: normalizeTextArray(navigation.webOrder),
      desktopCopilotPages: sanitizeDesktopCopilotPagePreferences(
        navigation.desktopCopilotPages
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
  return normalizeDesktopProfile(parsed, options);
}

export function writeDesktopProfileToRoot(rootDir: string, profile: DesktopProfile) {
  const normalized = normalizeDesktopProfile(profile);
  writeJsonFile(getDesktopProfilePath(rootDir), normalized);
  return normalized;
}

export function updateDesktopProfileInRoot(rootDir: string, patch: DesktopProfilePatch) {
  const current = readDesktopProfileFromRoot(rootDir);
  return writeDesktopProfileToRoot(rootDir, {
    ...current,
    general: {
      ...current.general,
      ...patch.general
    },
    appearance: {
      ...current.appearance,
      ...patch.appearance
    },
    assistant: {
      ...current.assistant,
      ...patch.assistant,
      copilot: {
        ...current.assistant.copilot,
        ...patch.assistant?.copilot
      },
      chat: {
        ...current.assistant.chat,
        ...patch.assistant?.chat
      },
      quick: {
        ...current.assistant.quick,
        ...patch.assistant?.quick
      }
    },
    navigation: {
      ...current.navigation,
      ...patch.navigation
    }
  });
}
