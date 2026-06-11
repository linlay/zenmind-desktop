import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY
} from "../shared/assistant-settings";
import { DEFAULT_LOCALE, normalizeLocale } from "../shared/i18n";
import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} from "./desktop-profile-store";
import { importCustomSidebarItems } from "./navigation/custom-sidebar-store";
import { resolveRuntimeRoot } from "./env-bootstrap";
import { resolveDesktopSsoConfigPath } from "./oidc-sso";
import { getDesktopConfigRoot, getDesktopStateRoot } from "./user-paths";
import { writeDesktopPetStoredState } from "./copilot/pet-copilot/desktop-pet";
import { writeMarketSettingsIfAbsent } from "./marketplace/common";

const DESKTOP_DEFAULT_FILE = "desktop-default.json";
const BOOTSTRAP_STATE_FILE = "bootstrap.json";

type AppPathReader = Pick<App, "getPath">;

type BootstrapApplyResult = {
  profile: "applied" | "skipped" | "absent";
  pet: "applied" | "skipped" | "absent";
  market: "applied" | "skipped" | "absent";
  sso: "applied" | "skipped" | "absent";
  websites: "applied" | "skipped" | "absent";
  bootstrapAssistant: "recorded" | "absent";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function pathApiForRuntimeRoot(platform: NodeJS.Platform, runtimeRoot: string) {
  if (platform === "win32") {
    // Cross-platform tests inject POSIX temp directories while simulating Windows behavior.
    if (path.posix.isAbsolute(runtimeRoot)) {
      return path.posix;
    }
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  return path.posix;
}

export function resolveDesktopDefaultPath(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  const pathApi = pathApiForRuntimeRoot(platform, runtimeRoot);
  return pathApi.join(runtimeRoot, DESKTOP_DEFAULT_FILE);
}

export function resolveDesktopBootstrapStatePath(app: AppPathReader) {
  return path.join(getDesktopStateRoot(app as App), BOOTSTRAP_STATE_FILE);
}

function applyProfileDefaults(app: App, profileDefaults: unknown): BootstrapApplyResult["profile"] {
  if (!isRecord(profileDefaults)) {
    return "absent";
  }
  const profileRoot = getDesktopConfigRoot(app);
  if (
    fs.existsSync(path.join(profileRoot, "profile.json")) ||
    fs.existsSync(path.join(profileRoot, "preferences.json")) ||
    fs.existsSync(path.join(profileRoot, "settings.json"))
  ) {
    return "skipped";
  }
  const appearance = isRecord(profileDefaults.appearance) ? profileDefaults.appearance : {};
  const assistant = isRecord(profileDefaults.assistant) ? profileDefaults.assistant : {};
  const quickAssistant = isRecord(assistant.quickAssistant) ? assistant.quickAssistant : {};
  const navigation = isRecord(profileDefaults.navigation) ? profileDefaults.navigation : {};
  const current = readDesktopProfileFromRoot(profileRoot);
  updateDesktopProfileInRoot(profileRoot, {
    appearance: {
      theme: appearance.theme === "light" || appearance.theme === "dark" || appearance.theme === "system"
        ? appearance.theme
        : current.appearance.theme,
      locale: normalizeLocale(appearance.locale) || current.appearance.locale || DEFAULT_LOCALE
    },
    assistant: {
      desktopHelperAgentKey: readText(assistant.desktopHelperAgentKey) ||
        current.assistant.desktopHelperAgentKey ||
        DEFAULT_DESKTOP_HELPER_AGENT_KEY,
      voiceCorrectionEnabled: typeof assistant.voiceCorrectionEnabled === "boolean"
        ? assistant.voiceCorrectionEnabled
        : current.assistant.voiceCorrectionEnabled,
      quickAssistant: {
        enabled: typeof quickAssistant.enabled === "boolean"
          ? quickAssistant.enabled
          : current.assistant.quickAssistant.enabled,
        agentKey: readText(quickAssistant.agentKey) ||
          current.assistant.quickAssistant.agentKey ||
          DEFAULT_QUICK_ASSISTANT_AGENT_KEY
      }
    },
    navigation: {
      mainOrder: Array.isArray(navigation.mainOrder)
        ? navigation.mainOrder.map(readText).filter(Boolean)
        : current.navigation.mainOrder,
      websiteOrder: Array.isArray(navigation.websiteOrder)
        ? navigation.websiteOrder.map(readText).filter(Boolean)
        : current.navigation.websiteOrder,
      desktopCopilotPages: isRecord(navigation.desktopCopilotPages)
        ? navigation.desktopCopilotPages as never
        : current.navigation.desktopCopilotPages
    }
  });
  return "applied";
}

function applyPetDefaults(app: App, petDefaults: unknown, platform: NodeJS.Platform): BootstrapApplyResult["pet"] {
  if (!isRecord(petDefaults)) {
    return "absent";
  }
  const petPath = path.join(getDesktopConfigRoot(app), "pet.json");
  const legacyPetPath = path.join(getDesktopConfigRoot(app), "desktop-pet.json");
  if (fs.existsSync(petPath) || fs.existsSync(legacyPetPath)) {
    return "skipped";
  }
  writeDesktopPetStoredState(app, {
    schemaVersion: 1,
    enabled: petDefaults.enabled === true,
    lastVisible: petDefaults.lastVisible === true,
    unreadCount: 0,
    boundAgentKey: "",
    appearanceId: "",
    selectedPetId: readText(petDefaults.selectedPetId) || "builtin:zenmi",
    position: isRecord(petDefaults.position)
      ? {
          x: Number(petDefaults.position.x),
          y: Number(petDefaults.position.y),
          displayId: readText(petDefaults.position.displayId) || "primary"
        }
      : undefined,
    window: isRecord(petDefaults.window)
      ? {
          edgeDock: petDefaults.window.edgeDock === "top" ? "top" : "none",
          previewExpanded: petDefaults.window.previewExpanded === true
        }
      : {
          edgeDock: "none",
          previewExpanded: false
        }
  }, platform);
  return "applied";
}

function applyMarketDefaults(app: App, marketDefaults: unknown): BootstrapApplyResult["market"] {
  if (!isRecord(marketDefaults)) {
    return "absent";
  }
  const marketApiBaseUrl = readText(marketDefaults.apiBaseUrl) || readText(marketDefaults.marketApiBaseUrl);
  const skillsApiBaseUrl = readText(marketDefaults.skillsApiBaseUrl);
  if (!marketApiBaseUrl && !skillsApiBaseUrl) {
    return "absent";
  }
  return writeMarketSettingsIfAbsent(app, {
    marketApiBaseUrl: marketApiBaseUrl || undefined,
    skillsApiBaseUrl: skillsApiBaseUrl || undefined
  }) ? "applied" : "skipped";
}

function applySsoDefaults(app: App, ssoDefaults: unknown, platform: NodeJS.Platform): BootstrapApplyResult["sso"] {
  if (!isRecord(ssoDefaults)) {
    return "absent";
  }
  const ssoPath = resolveDesktopSsoConfigPath(app, platform);
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  const pathApi = pathApiForRuntimeRoot(platform, runtimeRoot);
  const legacySsoPath = pathApi.join(runtimeRoot, "desktop-sso.json");
  const rootSsoPath = pathApi.join(runtimeRoot, "sso.json");
  if (fs.existsSync(ssoPath) || fs.existsSync(legacySsoPath) || fs.existsSync(rootSsoPath)) {
    return "skipped";
  }
  writeJsonFile(ssoPath, ssoDefaults);
  return "applied";
}

export function applyDesktopDefaultSsoDefaults(
  app: App,
  platform: NodeJS.Platform = process.platform
): BootstrapApplyResult["sso"] {
  const defaultPath = resolveDesktopDefaultPath(app, platform);
  const defaults = readJsonFile(defaultPath);
  if (!isRecord(defaults)) {
    return "absent";
  }
  return applySsoDefaults(app, defaults.sso, platform);
}

function normalizeWebsiteDefaults(websites: unknown) {
  if (Array.isArray(websites)) {
    return websites;
  }
  if (isRecord(websites) && Array.isArray(websites.items)) {
    return websites.items;
  }
  return [];
}

function applyWebsiteDefaults(app: App, websites: unknown): BootstrapApplyResult["websites"] {
  const items = normalizeWebsiteDefaults(websites);
  if (items.length === 0) {
    return "absent";
  }
  const result = importCustomSidebarItems(app, JSON.stringify({ items }));
  return result.ok ? "applied" : "skipped";
}

export function applyDesktopDefaultBootstrap(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const statePath = resolveDesktopBootstrapStatePath(app);
  if (fs.existsSync(statePath)) {
    return { ok: true, applied: false, reason: "already-applied" as const, statePath };
  }
  const defaultPath = resolveDesktopDefaultPath(app, platform);
  const defaults = readJsonFile(defaultPath);
  if (!isRecord(defaults)) {
    return { ok: true, applied: false, reason: "missing" as const, statePath };
  }

  const applied: BootstrapApplyResult = {
    profile: applyProfileDefaults(app, defaults.profile),
    pet: applyPetDefaults(app, defaults.pet, platform),
    market: applyMarketDefaults(app, defaults.market),
    sso: applySsoDefaults(app, defaults.sso, platform),
    websites: applyWebsiteDefaults(app, defaults.websites),
    bootstrapAssistant: isRecord(defaults.bootstrapAssistant) ? "recorded" : "absent"
  };
  writeJsonFile(statePath, {
    schemaVersion: 1,
    appliedAt: new Date().toISOString(),
    sourcePath: defaultPath,
    applied,
    ...(isRecord(defaults.bootstrapAssistant)
      ? { bootstrapAssistant: defaults.bootstrapAssistant }
      : {})
  });
  return { ok: true, applied: true, statePath, appliedResult: applied };
}

export const __testInternals = {
  DESKTOP_DEFAULT_FILE,
  BOOTSTRAP_STATE_FILE,
  pathApiForRuntimeRoot,
  applyProfileDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyWebsiteDefaults
};
