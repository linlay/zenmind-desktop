import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  DESKTOP_COPILOT_PAGE_KEYS,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  normalizeQuickAssistantShortcut
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
import { saveKanbanSettings } from "./kanban-runtime";
import { saveTunnelHubSettings } from "./tunnel-hub-settings";
import {
  normalizeServiceLifecycleArgsConfig,
  writeServiceLifecycleArgsConfig
} from "./service-lifecycle-args";
import {
  normalizeServicePortDefaultsConfig,
  writeServicePortDefaultsConfig
} from "./service-port-defaults";
import {
  normalizeDesktopActionBridgeSettingsConfig,
  writeDesktopActionBridgeSettingsConfig
} from "./desktop-action-bridge-settings";

const DESKTOP_INIT_FILE = "desktop-init.json";
const DESKTOP_INIT_ASSISTANT_FILE = "assistant.json";
const DESKTOP_INIT_BOOTSTRAP_STATE_FILE = "bootstrap.json";

type AppPathReader = Pick<App, "getPath">;

type BootstrapSectionResult = "applied" | "absent" | "failed";
type BootstrapAssistantResult = "recorded" | "absent" | "failed";

type BootstrapApplyResult = {
  profile: BootstrapSectionResult;
  kanban: BootstrapSectionResult;
  pet: BootstrapSectionResult;
  market: BootstrapSectionResult;
  sso: BootstrapSectionResult;
  tunnelHub: BootstrapSectionResult;
  webs: BootstrapSectionResult;
  assistant: BootstrapAssistantResult;
  desktopActionBridge: BootstrapSectionResult;
  services: BootstrapSectionResult;
};

type DesktopInitBootstrapState = {
  schemaVersion: 1;
  appliedAt: string;
  sourcePath: string;
  consumed: boolean;
  appliedResult: BootstrapApplyResult;
  failedSections: string[];
  errors: Record<string, string>;
};

type DesktopInitAssistantDefaults = {
  defaultChatAgentKey?: string;
  bootstrapAgentKey?: string;
  bootstrapChatId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.host) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isValidRelayUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!parsed.host) {
      return false;
    }
    if (parsed.protocol === "wss:") {
      return true;
    }
    return parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isPlaceholderUrl(value: string) {
  return !value || value === "http://" || value === "https://" || value === "ws://" || value === "wss://";
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

function writeBootstrapState(
  app: App,
  state: DesktopInitBootstrapState,
  platform: NodeJS.Platform = process.platform
) {
  writeJsonFile(path.join(getDesktopStateRoot(app, platform), DESKTOP_INIT_BOOTSTRAP_STATE_FILE), state);
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
    if (path.win32.isAbsolute(runtimeRoot) && !path.posix.isAbsolute(runtimeRoot)) {
      return path.win32;
    }
    return path.posix;
  }
  return path.posix;
}

function normalizeKanbanDefaults(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const cloudDefaults = isRecord(value.cloud) ? value.cloud : value;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const cloud: {
    serverUrl?: string;
    token?: string;
    remoteControlEnabled?: boolean;
    deviceAlias?: string;
  } = {};
  const serverUrl = readText(cloudDefaults.serverUrl);
  const token = readText(cloudDefaults.token);
  const deviceAlias = readText(cloudDefaults.deviceAlias);
  if (serverUrl && (enabled === true || isValidHttpUrl(serverUrl))) {
    cloud.serverUrl = serverUrl;
  }
  if (token) {
    cloud.token = token;
  }
  if (deviceAlias) {
    cloud.deviceAlias = deviceAlias;
  }
  if (typeof cloudDefaults.remoteControlEnabled === "boolean") {
    cloud.remoteControlEnabled = cloudDefaults.remoteControlEnabled;
  }
  const settings: { enabled?: boolean; cloud?: typeof cloud } = {};
  if (typeof enabled === "boolean") {
    settings.enabled = enabled;
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
  const defaultChatAgentKey =
    readText(value.defaultChatAgentKey) || readText(value.defaultAgentKey);
  const bootstrapAgentKey = readText(value.bootstrapAgentKey);
  const bootstrapChatId = readText(value.bootstrapChatId);
  if (defaultChatAgentKey) {
    assistant.defaultChatAgentKey = defaultChatAgentKey;
  }
  if (bootstrapAgentKey) {
    assistant.bootstrapAgentKey = bootstrapAgentKey;
  }
  if (bootstrapChatId) {
    assistant.bootstrapChatId = bootstrapChatId;
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
  assistantDefaults: DesktopInitAssistantDefaults | null,
  platform: NodeJS.Platform = process.platform
): BootstrapAssistantResult {
  if (!assistantDefaults) {
    return "absent";
  }
  writeJsonFile(path.join(getDesktopConfigRoot(app, platform), DESKTOP_INIT_ASSISTANT_FILE), {
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
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(profileDefaults)) {
    return "absent";
  }
  const profileRoot = getDesktopConfigRoot(app, platform);
  const profile = isRecord(profileDefaults) ? profileDefaults : {};
  const general = isRecord(profile.general) ? profile.general : {};
  const appearance = isRecord(profile.appearance) ? profile.appearance : {};
  const legacyAssistant = isRecord(profile.assistant) ? profile.assistant : {};
  const assistantCopilot = isRecord(legacyAssistant.copilot) ? legacyAssistant.copilot : {};
  const assistantQuick = isRecord(legacyAssistant.quick) ? legacyAssistant.quick : {};
  const legacyQuickAssistant = isRecord(legacyAssistant.quickAssistant) ? legacyAssistant.quickAssistant : {};
  const navigation = isRecord(profile.navigation) ? profile.navigation : {};
  const current = readDesktopProfileFromRoot(profileRoot);
  const defaultAgentKey = readText(assistantCopilot.agentKey) ||
    readText(legacyAssistant.desktopHelperAgentKey) ||
    current.assistant.copilot.agentKey ||
    DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const quickAgentKey = readText(assistantQuick.agentKey) ||
    readText(legacyQuickAssistant.agentKey) ||
    current.assistant.quick.agentKey ||
    DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const quickShortcut = normalizeQuickAssistantShortcut(
    readText(assistantQuick.shortcut) ||
    readText(legacyQuickAssistant.shortcut) ||
    current.assistant.quick.shortcut
  );
  updateDesktopProfileInRoot(profileRoot, {
    general: {
      deviceName: "deviceName" in general
        ? readText(general.deviceName)
        : current.general.deviceName,
      preventSleepWhileRunning: typeof general.preventSleepWhileRunning === "boolean"
        ? general.preventSleepWhileRunning
        : current.general.preventSleepWhileRunning,
      desktopActionConfirmationEnabled: typeof general.desktopActionConfirmationEnabled === "boolean"
        ? general.desktopActionConfirmationEnabled
        : current.general.desktopActionConfirmationEnabled
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
        agentKey: quickAgentKey,
        shortcut: quickShortcut
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
        ? normalizeDesktopCopilotPageDefaults(navigation.desktopCopilotPages, current.navigation.desktopCopilotPages, defaultAgentKey)
        : current.navigation.desktopCopilotPages
    }
  });
  return "applied";
}

function applyKanbanDefaults(
  app: App,
  kanbanDefaults: unknown,
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  const settings = normalizeKanbanDefaults(kanbanDefaults);
  if (!settings) {
    return "absent";
  }
  const serverUrl = readText(settings.cloud?.serverUrl);
  if (settings.enabled === true && (!serverUrl || !isValidHttpUrl(serverUrl))) {
    throw new Error("Kanban server URL is invalid.");
  }
  saveKanbanSettings(app, settings, platform);
  const deviceAlias = readText(settings.cloud?.deviceAlias);
  if (deviceAlias) {
    const profileRoot = getDesktopConfigRoot(app, platform);
    const current = readDesktopProfileFromRoot(profileRoot);
    if (!current.general.deviceName) {
      updateDesktopProfileInRoot(profileRoot, {
        general: {
          deviceName: deviceAlias
        }
      });
    }
  }
  return "applied";
}

function applyPetDefaults(app: App, petDefaults: unknown, platform: NodeJS.Platform): Exclude<BootstrapSectionResult, "failed"> {
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

function applyMarketDefaults(
  app: App,
  marketDefaults: unknown,
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(marketDefaults)) {
    return "absent";
  }
  if (marketDefaults.enabled !== true) {
    return "absent";
  }
  const apiBaseUrl = readText(marketDefaults.apiBaseUrl);
  if (!apiBaseUrl) {
    return "absent";
  }
  saveMarketSettings(app, {
    enabled: true,
    apiBaseUrl
  }, platform);
  return "applied";
}

function applySsoDefaults(app: App, ssoDefaults: unknown, platform: NodeJS.Platform): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(ssoDefaults)) {
    return "absent";
  }
  const ssoPath = resolveDesktopSsoConfigPath(app, platform);
  writeJsonFile(ssoPath, ssoDefaults);
  return "applied";
}

function applyTunnelHubDefaults(
  app: App,
  tunnelHubDefaults: unknown,
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(tunnelHubDefaults)) {
    return "absent";
  }
  const enabled = tunnelHubDefaults.enabled === true;
  const relayUrl = readText(tunnelHubDefaults.relayUrl);
  if (enabled && !isValidRelayUrl(relayUrl)) {
    throw new Error("Tunnel Hub relay URL is invalid.");
  }
  const filteredRelayUrl = enabled || (relayUrl && !isPlaceholderUrl(relayUrl) && isValidRelayUrl(relayUrl))
    ? relayUrl
    : "";
  const result = saveTunnelHubSettings(app, {
    enabled: tunnelHubDefaults.enabled === true,
    relayUrl: filteredRelayUrl,
    deviceId: readText(tunnelHubDefaults.deviceId),
    relayToken: readText(tunnelHubDefaults.relayToken),
    rotateRelayToken: tunnelHubDefaults.rotateRelayToken === true,
    tlsInsecureSkipVerify: false,
    reconnectSeconds: typeof tunnelHubDefaults.reconnectSeconds === "number"
      ? tunnelHubDefaults.reconnectSeconds
      : 3
  }, platform);
  if (!result.ok) {
    throw new Error(result.message);
  }
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

function applyWebsiteDefaults(
  app: App,
  webs: unknown,
  legacyWebsites: unknown,
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!hasWebsiteDefaults(webs, legacyWebsites)) {
    return "absent";
  }
  const items = normalizeWebsiteDefaults(webs, legacyWebsites);
  if (items.length > 0) {
    importWebsiteItems(app, JSON.stringify({ items }), platform);
  }
  return "applied";
}

function applyServiceDefaults(
  app: App,
  serviceDefaults: unknown,
  platform: NodeJS.Platform
): Exclude<BootstrapSectionResult, "failed"> {
  const lifecycleArgsConfig = normalizeServiceLifecycleArgsConfig({ services: serviceDefaults }, platform);
  const portDefaultsConfig = normalizeServicePortDefaultsConfig({ services: serviceDefaults }, platform);
  if (!lifecycleArgsConfig && !portDefaultsConfig) {
    return "absent";
  }
  if (lifecycleArgsConfig) {
    writeServiceLifecycleArgsConfig(app, lifecycleArgsConfig, platform);
  }
  if (portDefaultsConfig) {
    writeServicePortDefaultsConfig(app, portDefaultsConfig, platform);
  }
  return "applied";
}

function applyDesktopActionBridgeDefaults(
  app: App,
  desktopActionBridgeDefaults: unknown,
  platform: NodeJS.Platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(desktopActionBridgeDefaults)) {
    return "absent";
  }
  const config = normalizeDesktopActionBridgeSettingsConfig(desktopActionBridgeDefaults, platform);
  if (!config) {
    if (Object.keys(desktopActionBridgeDefaults).length > 0) {
      throw new Error("Desktop Action Bridge port must be an integer from 1 to 65535.");
    }
    return "absent";
  }
  writeDesktopActionBridgeSettingsConfig(app, config, platform);
  return "applied";
}

function runBootstrapSection<T extends string>(
  sectionId: keyof BootstrapApplyResult,
  errors: Record<string, string>,
  apply: () => T
) {
  try {
    return apply();
  } catch (error) {
    const message = errorMessage(error);
    errors[sectionId] = message;
    console.warn(`[desktop-init] failed to apply ${String(sectionId)} defaults:`, error);
    return "failed" as const;
  }
}

function getFailedSections(result: BootstrapApplyResult) {
  return Object.entries(result)
    .filter(([, status]) => status === "failed")
    .map(([sectionId]) => sectionId);
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
    const kanbanDefaults = isRecord(defaults.kanban)
      ? defaults.kanban
      : readLegacyProfileKanbanDefaults(defaults.profile);
    const errors: Record<string, string> = {};

    const applied: BootstrapApplyResult = {
      profile: runBootstrapSection("profile", errors, () => applyProfileDefaults(app, defaults.profile, platform)),
      kanban: runBootstrapSection("kanban", errors, () => applyKanbanDefaults(app, kanbanDefaults, platform)),
      pet: runBootstrapSection("pet", errors, () => applyPetDefaults(app, defaults.pet, platform)),
      market: runBootstrapSection("market", errors, () => applyMarketDefaults(app, defaults.market, platform)),
      sso: runBootstrapSection("sso", errors, () => applySsoDefaults(app, defaults.sso, platform)),
      tunnelHub: runBootstrapSection("tunnelHub", errors, () => applyTunnelHubDefaults(app, defaults.tunnelHub, platform)),
      webs: runBootstrapSection("webs", errors, () => applyWebsiteDefaults(app, defaults.webs, defaults.websites, platform)),
      assistant: runBootstrapSection("assistant", errors, () => writeAssistantDefaults(app, assistant, platform)),
      desktopActionBridge: runBootstrapSection(
        "desktopActionBridge",
        errors,
        () => applyDesktopActionBridgeDefaults(app, defaults.desktopActionBridge, platform)
      ),
      services: runBootstrapSection("services", errors, () => applyServiceDefaults(app, defaults.services, platform))
    };
    const failedSections = getFailedSections(applied);
    removeDesktopInitFile(initPath);
    writeBootstrapState(app, {
      schemaVersion: 1,
      appliedAt: new Date().toISOString(),
      sourcePath: initPath,
      consumed: true,
      appliedResult: applied,
      failedSections,
      errors
    }, platform);
    return { ok: true, applied: true, appliedResult: applied, failedSections, errors };
  } catch (error) {
    console.warn(`[desktop-init] failed to apply ${DESKTOP_INIT_FILE}:`, error);
    return {
      ok: false,
      applied: false,
      reason: "invalid" as const,
      message: errorMessage(error)
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
  applyWebsiteDefaults,
  applyDesktopActionBridgeDefaults,
  applyServiceDefaults
};
