import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  DESKTOP_COPILOT_PAGE_KEYS,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY
} from "../shared/assistant-settings";
import { DEFAULT_LOCALE, normalizeLocale } from "../shared/i18n";
import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} from "./desktop-profile-store";
import { importWebsiteItems } from "./webs/websites/actions";
import { resolveRuntimeRoot } from "./env-bootstrap";
import { resolveDesktopSsoConfigPath } from "./oidc-sso";
import { getDesktopConfigRoot, getDesktopStateRoot } from "./user-paths";
import { saveDesktopPetSettings } from "./assistant/pet/desktop-pet";
import { saveMarketSettings } from "./marketplace/common";
import { saveTaskBoardSettings } from "./task-board-runtime";
import { saveTunnelHubAgentSettings } from "./tunnel-hub-agent-settings";

const DESKTOP_INIT_FILE = "desktop-init.json";
const DESKTOP_INIT_ASSISTANT_FILE = "assistant.json";
const DESKTOP_INIT_BOOTSTRAP_STATE_FILE = "bootstrap.json";

type AppPathReader = Pick<App, "getPath">;

type BootstrapApplyResult = {
  profile: "applied" | "absent";
  kanban: "applied" | "absent";
  pet: "applied" | "absent";
  market: "applied" | "absent";
  sso: "applied" | "absent";
  tunnelHub: "applied" | "absent";
  webs: "applied" | "absent";
  assistant: "recorded" | "absent";
};

type DesktopInitBootstrapState = {
  schemaVersion: 1;
  appliedAt: string;
  sourcePath: string;
  consumed: boolean;
  appliedResult: BootstrapApplyResult;
};

type DesktopInitAssistantDefaults = {
  defaultAgentKey?: string;
  bootstrapAgentKey?: string;
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

function writeBootstrapState(app: App, state: DesktopInitBootstrapState) {
  writeJsonFile(path.join(getDesktopStateRoot(app), DESKTOP_INIT_BOOTSTRAP_STATE_FILE), state);
}

function removeDesktopInitFile(initPath: string) {
  try {
    fs.rmSync(initPath, { force: true });
  } catch (error) {
    console.warn(`[desktop-init] failed to remove consumed ${DESKTOP_INIT_FILE}:`, error);
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

function normalizeDesktopInitAssistantDefaults(value: unknown): DesktopInitAssistantDefaults | null {
  if (!isRecord(value)) {
    return null;
  }
  const assistant: DesktopInitAssistantDefaults = {};
  const defaultAgentKey = readText(value.defaultAgentKey);
  const bootstrapAgentKey = readText(value.bootstrapAgentKey);
  if (defaultAgentKey) {
    assistant.defaultAgentKey = defaultAgentKey;
  }
  if (bootstrapAgentKey) {
    assistant.bootstrapAgentKey = bootstrapAgentKey;
  }
  return Object.keys(assistant).length > 0 ? assistant : null;
}

function normalizeDesktopCopilotPageDefaults(
  value: unknown,
  current: ReturnType<typeof readDesktopProfileFromRoot>["navigation"]["desktopCopilotPages"],
  defaultAgentKey: string
) {
  const source = isRecord(value) ? value : {};
  return DESKTOP_COPILOT_PAGE_KEYS.reduce((pages, pageKey) => {
    const rawPage = isRecord(source[pageKey]) ? source[pageKey] : {};
    const currentPage = current[pageKey];
    pages[pageKey] = {
      enabled: typeof rawPage.enabled === "boolean" ? rawPage.enabled : (currentPage?.enabled ?? true),
      agentKey: readText(rawPage.agentKey) ||
        defaultAgentKey ||
        currentPage?.agentKey ||
        DEFAULT_DESKTOP_HELPER_AGENT_KEY
    };
    return pages;
  }, {} as ReturnType<typeof readDesktopProfileFromRoot>["navigation"]["desktopCopilotPages"]);
}

function writeAssistantDefaults(
  app: App,
  assistantDefaults: DesktopInitAssistantDefaults | null
): BootstrapApplyResult["assistant"] {
  if (!assistantDefaults) {
    return "absent";
  }
  writeJsonFile(path.join(getDesktopConfigRoot(app), DESKTOP_INIT_ASSISTANT_FILE), {
    schemaVersion: 1,
    ...assistantDefaults
  });
  return "recorded";
}

export function resolveDesktopInitPath(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  const pathApi = pathApiForRuntimeRoot(platform, runtimeRoot);
  return pathApi.join(runtimeRoot, DESKTOP_INIT_FILE);
}

function applyProfileDefaults(
  app: App,
  profileDefaults: unknown,
  assistantDefaults: DesktopInitAssistantDefaults | null
): BootstrapApplyResult["profile"] {
  if (!isRecord(profileDefaults) && !assistantDefaults?.defaultAgentKey) {
    return "absent";
  }
  const profileRoot = getDesktopConfigRoot(app);
  const profile = isRecord(profileDefaults) ? profileDefaults : {};
  const general = isRecord(profile.general) ? profile.general : {};
  const appearance = isRecord(profile.appearance) ? profile.appearance : {};
  const legacyAssistant = isRecord(profile.assistant) ? profile.assistant : {};
  const assistantCopilot = isRecord(legacyAssistant.copilot) ? legacyAssistant.copilot : {};
  const assistantQuick = isRecord(legacyAssistant.quick) ? legacyAssistant.quick : {};
  const legacyQuickAssistant = isRecord(legacyAssistant.quickAssistant) ? legacyAssistant.quickAssistant : {};
  const navigation = isRecord(profile.navigation) ? profile.navigation : {};
  const current = readDesktopProfileFromRoot(profileRoot);
  const defaultAgentKey = readText(assistantDefaults?.defaultAgentKey) ||
    readText(assistantCopilot.agentKey) ||
    readText(legacyAssistant.desktopHelperAgentKey) ||
    current.assistant.copilot.agentKey ||
    DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const quickAgentKey = readText(assistantQuick.agentKey) ||
    readText(legacyQuickAssistant.agentKey) ||
    readText(assistantDefaults?.defaultAgentKey) ||
    current.assistant.quick.agentKey ||
    DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  updateDesktopProfileInRoot(profileRoot, {
    general: {
      preventSleepWhileRunning: typeof general.preventSleepWhileRunning === "boolean"
        ? general.preventSleepWhileRunning
        : current.general.preventSleepWhileRunning
    },
    appearance: {
      theme: appearance.theme === "light" || appearance.theme === "dark" || appearance.theme === "system"
        ? appearance.theme
        : current.appearance.theme,
      locale: normalizeLocale(appearance.locale) || current.appearance.locale || DEFAULT_LOCALE
    },
    assistant: {
      voiceCorrectionEnabled: typeof legacyAssistant.voiceCorrectionEnabled === "boolean"
        ? legacyAssistant.voiceCorrectionEnabled
        : current.assistant.voiceCorrectionEnabled,
      copilot: {
        agentKey: defaultAgentKey
      },
      quick: {
        enabled: typeof assistantQuick.enabled === "boolean"
          ? assistantQuick.enabled
          : typeof legacyQuickAssistant.enabled === "boolean"
            ? legacyQuickAssistant.enabled
            : current.assistant.quick.enabled,
        agentKey: quickAgentKey
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
      desktopCopilotPages: isRecord(navigation.desktopCopilotPages) || readText(assistantDefaults?.defaultAgentKey)
        ? normalizeDesktopCopilotPageDefaults(navigation.desktopCopilotPages, current.navigation.desktopCopilotPages, defaultAgentKey)
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
  saveTaskBoardSettings(app, settings);
  return "applied";
}

function applyPetDefaults(app: App, petDefaults: unknown, platform: NodeJS.Platform): BootstrapApplyResult["pet"] {
  if (!isRecord(petDefaults)) {
    return "absent";
  }
  const patch: Parameters<typeof saveDesktopPetSettings>[1] = {
    schemaVersion: 1,
    ...(typeof petDefaults.enabled === "boolean" ? { enabled: petDefaults.enabled } : {}),
    ...(readText(petDefaults.selectedPetId) ? { selectedPetId: readText(petDefaults.selectedPetId) } : {})
  };
  if (isRecord(petDefaults.position)) {
    patch.position = {
      x: Number(petDefaults.position.x),
      y: Number(petDefaults.position.y),
      displayId: readText(petDefaults.position.displayId) || "primary"
    };
  }
  if (isRecord(petDefaults.window)) {
    patch.window = {
      edgeDock: petDefaults.window.edgeDock === "top" ? "top" : "none",
      previewExpanded: petDefaults.window.previewExpanded === true
    };
  }
  saveDesktopPetSettings(app, patch, platform);
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
  saveMarketSettings(app, {
    enabled: marketDefaults.enabled !== false,
    apiBaseUrl
  });
  return "applied";
}

function applySsoDefaults(app: App, ssoDefaults: unknown, platform: NodeJS.Platform): BootstrapApplyResult["sso"] {
  if (!isRecord(ssoDefaults)) {
    return "absent";
  }
  const ssoPath = resolveDesktopSsoConfigPath(app, platform);
  writeJsonFile(ssoPath, ssoDefaults);
  return "applied";
}

function applyTunnelHubDefaults(app: App, tunnelHubDefaults: unknown): BootstrapApplyResult["tunnelHub"] {
  if (!isRecord(tunnelHubDefaults)) {
    return "absent";
  }
  saveTunnelHubAgentSettings(app, {
    enabled: tunnelHubDefaults.enabled === true,
    relayUrl: readText(tunnelHubDefaults.relayUrl),
    deviceId: readText(tunnelHubDefaults.deviceId),
    agentToken: readText(tunnelHubDefaults.agentToken),
    registrationToken: readText(tunnelHubDefaults.registrationToken),
    rotateAgentToken: tunnelHubDefaults.rotateAgentToken === true,
    tlsInsecureSkipVerify: tunnelHubDefaults.tlsInsecureSkipVerify === true,
    reconnectSeconds: typeof tunnelHubDefaults.reconnectSeconds === "number"
      ? tunnelHubDefaults.reconnectSeconds
      : 3
  });
  return "applied";
}

function hasWebsiteDefaults(webs: unknown, legacyWebsites: unknown) {
  return (isRecord(webs) && Array.isArray(webs.websites)) ||
    Array.isArray(webs) ||
    Array.isArray(legacyWebsites) ||
    (isRecord(legacyWebsites) && Array.isArray(legacyWebsites.items));
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
  if (!hasWebsiteDefaults(webs, legacyWebsites)) {
    return "absent";
  }
  const items = normalizeWebsiteDefaults(webs, legacyWebsites);
  if (items.length > 0) {
    importWebsiteItems(app, JSON.stringify({ items }));
  }
  return "applied";
}

export function applyDesktopInitBootstrap(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const initPath = resolveDesktopInitPath(app, platform);
  let defaults: unknown;
  try {
    defaults = readJsonFile(initPath);
  } catch (error) {
    console.warn(`[desktop-init] failed to read ${DESKTOP_INIT_FILE}:`, error);
    return {
      ok: false,
      applied: false,
      reason: "invalid" as const,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  if (!isRecord(defaults)) {
    return { ok: true, applied: false, reason: "missing" as const };
  }
  try {
    const assistant = normalizeDesktopInitAssistantDefaults(defaults.assistant);

    const applied: BootstrapApplyResult = {
      profile: applyProfileDefaults(app, defaults.profile, assistant),
      kanban: applyKanbanDefaults(app, defaults.kanban, defaults.profile),
      pet: applyPetDefaults(app, defaults.pet, platform),
      market: applyMarketDefaults(app, defaults.market),
      sso: applySsoDefaults(app, defaults.sso, platform),
      tunnelHub: applyTunnelHubDefaults(app, defaults.tunnelHub),
      webs: applyWebsiteDefaults(app, defaults.webs, defaults.websites),
      assistant: writeAssistantDefaults(app, assistant)
    };
    removeDesktopInitFile(initPath);
    writeBootstrapState(app, {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      sourcePath: initPath,
      consumed: true,
      appliedResult: applied
    });
    return { ok: true, applied: true, appliedResult: applied };
  } catch (error) {
    console.warn(`[desktop-init] failed to apply ${DESKTOP_INIT_FILE}:`, error);
    return {
      ok: false,
      applied: false,
      reason: "invalid" as const,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export const __testInternals = {
  DESKTOP_INIT_FILE,
  DESKTOP_INIT_BOOTSTRAP_STATE_FILE,
  pathApiForRuntimeRoot,
  normalizeDesktopInitAssistantDefaults,
  applyProfileDefaults,
  applyKanbanDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyTunnelHubDefaults,
  applyWebsiteDefaults
};
