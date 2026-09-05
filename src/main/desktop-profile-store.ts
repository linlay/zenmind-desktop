import fs from "node:fs";
import path from "node:path";
import type { SupportedLocale } from "../shared/i18n";
import { DEFAULT_LOCALE, normalizeLocale } from "../shared/i18n";
import {
  DEFAULT_CHAT_DEFAULT_AGENT_KEY,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  type DesktopCopilotPagePreferences
} from "../shared/assistant-settings";
import { sanitizeDesktopCopilotPagePreferences } from "../shared/page-copilot";
import type { AssistantChatSortMode } from "../shared/contracts/copilot";

export const DESKTOP_PROFILE_FILE = "profile.json";

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
    copilot: {
      agentKey: string;
    };
    chat: {
      agentKey: string;
    };
  };
  navigation: {
    mainOrder: string[];
    webOrder: string[];
    chatSortMode: AssistantChatSortMode;
    desktopCopilotPages: DesktopCopilotPagePreferences;
  };
};

type DesktopProfileReadOptions = {
  defaultLocale?: SupportedLocale;
};

type DesktopProfilePatch = Partial<{
  general: Partial<DesktopProfile["general"]>;
  appearance: Partial<DesktopProfile["appearance"]>;
  assistant: Partial<Omit<DesktopProfile["assistant"], "copilot" | "chat">> & {
    copilot?: Partial<DesktopProfile["assistant"]["copilot"]>;
    chat?: Partial<DesktopProfile["assistant"]["chat"]>;
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

function normalizeChatSortMode(value: unknown): AssistantChatSortMode {
  return value === "manual" ? "manual" : "recent";
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
  const navigation = isRecord(record.navigation) ? record.navigation : {};
  const profileLocale = normalizeLocale(appearance.locale);
  const copilotAgentKey = readText(copilot.agentKey) || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const chatAgentKey = readText(chat.agentKey) || DEFAULT_CHAT_DEFAULT_AGENT_KEY;

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
      copilot: {
        agentKey: copilotAgentKey
      },
      chat: {
        agentKey: chatAgentKey
      }
    },
    navigation: {
      mainOrder: normalizeTextArray(navigation.mainOrder),
      webOrder: normalizeTextArray(navigation.webOrder),
      chatSortMode: normalizeChatSortMode(navigation.chatSortMode),
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
      }
    },
    navigation: {
      ...current.navigation,
      ...patch.navigation
    }
  });
}
