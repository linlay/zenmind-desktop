import { randomUUID } from "node:crypto";
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

function recoverLeadingJsonObject(raw: string) {
  let start = 0;
  while (start < raw.length && /\s/u.test(raw[start] ?? "")) {
    start += 1;
  }
  if (raw[start] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character !== "}" && character !== "]") {
      continue;
    }
    depth -= 1;
    if (depth !== 0) {
      if (depth < 0) return null;
      continue;
    }
    if (!raw.slice(index + 1).trim()) {
      return null;
    }
    try {
      return JSON.parse(raw.slice(start, index + 1)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

function writeJsonFile(filePath: string, value: unknown) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readJsonFile(filePath: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const recovered = recoverLeadingJsonObject(raw);
    if (recovered === null) {
      throw error;
    }
    const backupPath = `${filePath}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
    fs.renameSync(filePath, backupPath);
    try {
      writeJsonFile(filePath, recovered);
    } catch (writeError) {
      fs.renameSync(backupPath, filePath);
      throw writeError;
    }
    console.warn(`[desktop-profile] recovered trailing corruption; backup=${backupPath}`);
    return recovered;
  }
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
      voiceCorrectionEnabled: typeof assistant.voiceCorrectionEnabled === "boolean"
        ? assistant.voiceCorrectionEnabled
        : DEFAULT_VOICE_CORRECTION_ENABLED,
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
