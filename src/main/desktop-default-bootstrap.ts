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
import { importWebsiteItems } from "./webs/website-actions";
import { resolveRuntimeRoot } from "./env-bootstrap";
import { resolveDesktopSsoConfigPath } from "./oidc-sso";
import { getDesktopConfigRoot, getDesktopStateRoot } from "./user-paths";
import { writeDesktopPetStoredState } from "./copilot/pet-copilot/desktop-pet";
import { writeMarketSettingsIfAbsent } from "./marketplace/common";
import { writeTaskBoardSettingsIfAbsent } from "./task-board-runtime";

const DESKTOP_DEFAULT_FILE = "desktop-default.json";
const BOOTSTRAP_STATE_FILE = "bootstrap.json";

type AppPathReader = Pick<App, "getPath">;

type BootstrapApplyResult = {
  profile: "applied" | "skipped" | "absent";
  kanban: "applied" | "skipped" | "absent";
  pet: "applied" | "skipped" | "absent";
  market: "applied" | "skipped" | "absent";
  sso: "applied" | "skipped" | "absent";
  webs: "applied" | "skipped" | "absent";
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

function removeDesktopDefaultFile(defaultPath: string) {
  try {
    fs.rmSync(defaultPath, { force: true });
  } catch (error) {
    console.warn(`[desktop-default] failed to remove consumed ${DESKTOP_DEFAULT_FILE}:`, error);
  }
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

function normalizeKanbanDefaults(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const cloudDefaults = isRecord(value.cloud) ? value.cloud : value;
  const cloud: {
    serverUrl?: string;
    token?: string;
    selectedProjectId?: string;
    remoteControlEnabled?: boolean;
    deviceAlias?: string;
  } = {};
  const serverUrl = readText(cloudDefaults.serverUrl);
  const token = readText(cloudDefaults.token);
  const selectedProjectId = readText(cloudDefaults.selectedProjectId);
  const deviceAlias = readText(cloudDefaults.deviceAlias);
  if (serverUrl) {
    cloud.serverUrl = serverUrl;
  }
  if (token) {
    cloud.token = token;
  }
  if (selectedProjectId) {
    cloud.selectedProjectId = selectedProjectId;
  }
  if (deviceAlias) {
    cloud.deviceAlias = deviceAlias;
  }
  if (typeof cloudDefaults.remoteControlEnabled === "boolean") {
    cloud.remoteControlEnabled = cloudDefaults.remoteControlEnabled;
  }
  const settings: { enabled?: boolean; cloud?: typeof cloud } = {};
  if (typeof value.enabled === "boolean") {
    settings.enabled = value.enabled;
  }
  if (Object.keys(cloud).length > 0) {
    settings.cloud = cloud;
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

function readLegacyProfileKanbanDefaults(profileDefaults: unknown) {
  if (!isRecord(profileDefaults)) {
    return null;
  }
  const navigation = isRecord(profileDefaults.navigation) ? profileDefaults.navigation : {};
  return normalizeKanbanDefaults(navigation.kanban);
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
      webOrder: Array.isArray(navigation.webOrder)
        ? navigation.webOrder.map(readText).filter(Boolean)
        : Array.isArray(navigation.websiteOrder)
          ? navigation.websiteOrder.map(readText).filter(Boolean)
          : current.navigation.webOrder,
      desktopCopilotPages: isRecord(navigation.desktopCopilotPages)
        ? navigation.desktopCopilotPages as never
        : current.navigation.desktopCopilotPages
    }
  });
  return "applied";
}

function applyKanbanDefaults(
  app: App,
  kanbanDefaults: unknown,
  profileDefaults: unknown
): BootstrapApplyResult["kanban"] {
  const settings = normalizeKanbanDefaults(kanbanDefaults) ?? readLegacyProfileKanbanDefaults(profileDefaults);
  if (!settings) {
    return "absent";
  }
  return writeTaskBoardSettingsIfAbsent(app, settings) ? "applied" : "skipped";
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
  const apiBaseUrl = readText(marketDefaults.apiBaseUrl);
  if (!apiBaseUrl) {
    return "absent";
  }
  return writeMarketSettingsIfAbsent(app, {
    enabled: marketDefaults.enabled !== false,
    apiBaseUrl
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
  const result = applySsoDefaults(app, defaults.sso, platform);
  if (fs.existsSync(resolveDesktopBootstrapStatePath(app))) {
    removeDesktopDefaultFile(defaultPath);
  }
  return result;
}

function normalizeWebsiteDefaults(webs: unknown, legacyWebsites: unknown) {
  if (isRecord(webs) && Array.isArray(webs.websites)) {
    return webs.websites;
  }
  if (Array.isArray(webs)) {
    return webs;
  }
  if (Array.isArray(legacyWebsites)) {
    return legacyWebsites;
  }
  if (isRecord(legacyWebsites) && Array.isArray(legacyWebsites.items)) {
    return legacyWebsites.items;
  }
  return [];
}

function applyWebsiteDefaults(app: App, webs: unknown, legacyWebsites: unknown): BootstrapApplyResult["webs"] {
  const items = normalizeWebsiteDefaults(webs, legacyWebsites);
  if (items.length === 0) {
    return "absent";
  }
  const result = importWebsiteItems(app, JSON.stringify({ items }));
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
    kanban: applyKanbanDefaults(app, defaults.kanban, defaults.profile),
    pet: applyPetDefaults(app, defaults.pet, platform),
    market: applyMarketDefaults(app, defaults.market),
    sso: applySsoDefaults(app, defaults.sso, platform),
    webs: applyWebsiteDefaults(app, defaults.webs, defaults.websites),
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
  removeDesktopDefaultFile(defaultPath);
  return { ok: true, applied: true, statePath, appliedResult: applied };
}

export const __testInternals = {
  DESKTOP_DEFAULT_FILE,
  BOOTSTRAP_STATE_FILE,
  pathApiForRuntimeRoot,
  applyProfileDefaults,
  applyKanbanDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyWebsiteDefaults
};
