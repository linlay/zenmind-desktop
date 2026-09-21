import {
  isRecord,
  readText,
  isValidHttpUrl,
  DesktopInitAssistantDefaults,
  BootstrapSectionResult,
  writeJsonFile,
  isValidRelayUrl,
  isPlaceholderUrl
} from "./desktop-init-state";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot } from "../../infrastructure/filesystem/profile-store";
import { DESKTOP_COPILOT_PAGE_KEYS, DEFAULT_DESKTOP_HELPER_AGENT_KEY } from "../../../shared/assistant-settings";
import { type App } from "electron";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { normalizeLocale, DEFAULT_LOCALE } from "../../../shared/i18n";
import { saveKanbanSettings } from "../../modules/kanban";
import { saveDesktopPetSettings } from "../../modules/pet";
import { saveMarketSettings } from "../../modules/marketplace";
import { resolveDesktopSsoConfigPath } from "../../modules/identity";
import { saveTunnelHubSettings } from "../../modules/tunnel";
import {
  normalizeServiceLifecycleArgsConfig,
  normalizeServicePortDefaultsConfig,
  writeServiceLifecycleArgsConfig,
  writeServicePortDefaultsConfig
} from "../../modules/services";
import { normalizeDesktopActionBridgeSettingsConfig, writeDesktopActionBridgeSettingsConfig } from "../../modules/desktop-actions";
import { normalizeEnterpriseImSettings, writeEnterpriseImSettings } from "../../modules/enterprise-chat";
import { normalizeHelpSettings, writeHelpSettings } from "../../modules/settings";

export function normalizeKanbanDefaults(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const cloudDefaults = isRecord(value.cloud) ? value.cloud : {};
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const cloud: {
    serverUrl?: string;
    remoteControlEnabled?: boolean;
  } = {};
  const serverUrl = readText(cloudDefaults.serverUrl);
  if (typeof cloudDefaults.serverUrl === "string" && (!serverUrl || enabled === true || isValidHttpUrl(serverUrl))) {
    cloud.serverUrl = serverUrl;
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

export function normalizeDesktopInitAssistantDefaults(value: unknown): DesktopInitAssistantDefaults | null {
  if (!isRecord(value)) {
    return null;
  }
  const assistant: DesktopInitAssistantDefaults = {};
  const defaultChatAgentKey = readText(value.defaultChatAgentKey);
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

export function normalizeDesktopCopilotPageDefaults(
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

export function applyProfileDefaults(
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
  const assistant = isRecord(profile.assistant) ? profile.assistant : {};
  const assistantCopilot = isRecord(assistant.copilot) ? assistant.copilot : {};
  const navigation = isRecord(profile.navigation) ? profile.navigation : {};
  const current = readDesktopProfileFromRoot(profileRoot);
  const defaultAgentKey = readText(assistantCopilot.agentKey) ||
    current.assistant.copilot.agentKey ||
    DEFAULT_DESKTOP_HELPER_AGENT_KEY;
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
      copilot: {
        agentKey: defaultAgentKey
      }
    },
    navigation: {
      desktopCopilotPages: isRecord(navigation.desktopCopilotPages)
        ? normalizeDesktopCopilotPageDefaults(navigation.desktopCopilotPages, current.navigation.desktopCopilotPages, defaultAgentKey)
        : current.navigation.desktopCopilotPages
    }
  });
  return "applied";
}

export function applyKanbanDefaults(
  app: App,
  kanbanDefaults: unknown,
  platform: NodeJS.Platform = process.platform
): Exclude<BootstrapSectionResult, "failed"> {
  const settings = normalizeKanbanDefaults(kanbanDefaults);
  if (!settings) {
    return "absent";
  }
  const serverUrl = readText(settings.cloud?.serverUrl);
  if (settings.enabled === true && (serverUrl || settings.cloud?.remoteControlEnabled === true) && !isValidHttpUrl(serverUrl)) {
    throw new Error("Kanban server URL is invalid.");
  }
  saveKanbanSettings(app, settings, platform);
  return "applied";
}

export function applyPetDefaults(app: App, petDefaults: unknown, platform: NodeJS.Platform): Exclude<BootstrapSectionResult, "failed"> {
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

export function applyMarketDefaults(
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

export function applySsoDefaults(app: App, ssoDefaults: unknown, platform: NodeJS.Platform): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(ssoDefaults)) {
    return "absent";
  }
  const ssoPath = resolveDesktopSsoConfigPath(app, platform);
  const canonicalSsoDefaults = { ...ssoDefaults };
  delete canonicalSsoDefaults.siteTokenBridge;
  writeJsonFile(ssoPath, canonicalSsoDefaults);
  return "applied";
}

export function applyTunnelHubDefaults(
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

export function applyServiceDefaults(
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

export function applyDesktopActionBridgeDefaults(
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

export function applyEnterpriseImDefaults(
  app: App,
  enterpriseImDefaults: unknown,
  platform: NodeJS.Platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (typeof enterpriseImDefaults === "undefined") {
    return "absent";
  }
  if (!isRecord(enterpriseImDefaults)) {
    throw new Error("Enterprise IM must be an object with boolean enabled and a valid base URL.");
  }
  const settings = normalizeEnterpriseImSettings(enterpriseImDefaults);
  if (!settings) {
    throw new Error("Enterprise IM enabled must be boolean and base URL must use loopback HTTP or remote HTTPS.");
  }
  writeEnterpriseImSettings(app, settings, platform);
  return "applied";
}

export function applyHelpDefaults(
  app: App,
  helpDefaults: unknown,
  platform: NodeJS.Platform
): Exclude<BootstrapSectionResult, "failed"> {
  if (!isRecord(helpDefaults)) {
    return "absent";
  }
  const settings = normalizeHelpSettings(helpDefaults);
  if (!settings) {
    throw new Error("Help URL must use loopback HTTP or remote HTTPS.");
  }
  writeHelpSettings(app, settings, platform);
  return "applied";
}
