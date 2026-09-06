import fs from "node:fs";

import path from "node:path";

import type { App } from "electron";

import {
  DESKTOP_COPILOT_PAGE_KEYS,
  DEFAULT_DESKTOP_HELPER_AGENT_KEY
} from "../../../shared/assistant-settings";

import { DEFAULT_LOCALE, normalizeLocale } from "../../../shared/i18n";

import type { WebappEntry, WebEntryKey, WebsiteEntry } from "../../../shared/contracts";

import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} from "../../infrastructure/filesystem/profile-store";

import { MAX_WEBSITE_ITEMS } from "../../modules/webs";

import {
  createWebsiteItem,
  getWebsiteDir,
  readWebsiteItems,
  writeWebsiteItem
} from "../../modules/webs";

import { webappManager } from "../../modules/webs";

import { readWebOrderKeys, writeWebOrderKeys } from "../../modules/webs";

import { normalizeWebId } from "../../modules/webs";

import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

import { resolveDesktopSsoConfigPath } from "../../modules/identity";

import {
  getDesktopConfigRoot,
  getDesktopStateRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebsitesDataRoot
} from "../../infrastructure/filesystem/user-paths";

import { saveDesktopPetSettings } from "../../modules/pet";

import { normalizeMarketApiBaseUrl, saveMarketSettings } from "../../modules/marketplace";

import { saveKanbanSettings } from "../../modules/kanban";

import { saveTunnelHubSettings } from "../../modules/tunnel";

import {
  normalizeServiceLifecycleArgsConfig,
  getServiceLifecycleArgsConfigPath,
  writeServiceLifecycleArgsConfig
} from "../../modules/services";

import {
  normalizeServicePortDefaultsConfig,
  getServicePortDefaultsConfigPath,
  writeServicePortDefaultsConfig
} from "../../modules/services";

import {
  normalizeDesktopActionBridgeSettingsConfig,
  getDesktopActionBridgeSettingsConfigPath,
  writeDesktopActionBridgeSettingsConfig
} from "../../modules/desktop-actions";

import {
  normalizeEnterpriseImSettings,
  getEnterpriseImSettingsPath,
  writeEnterpriseImSettings
} from "../../modules/enterprise-chat";

import {
  normalizeHelpSettings,
  getHelpSettingsPath,
  writeHelpSettings
} from "../../modules/settings";

export const DESKTOP_INIT_FILE = "desktop-init.json";

export const DESKTOP_INIT_ASSISTANT_FILE = "assistant.json";

export const DESKTOP_INIT_BOOTSTRAP_STATE_FILE = "bootstrap.json";

export type AppPathReader = Pick<App, "getPath">;

export type BootstrapSectionResult = "applied" | "absent" | "failed" | "preserved";

export type BootstrapAssistantResult = "recorded" | "absent" | "failed";

export type BootstrapApplyResult = {
  profile: BootstrapSectionResult;
  kanban: BootstrapSectionResult;
  pet: BootstrapSectionResult;
  market: BootstrapSectionResult;
  sso: BootstrapSectionResult;
  tunnelHub: BootstrapSectionResult;
  webs: BootstrapSectionResult;
  assistant: BootstrapAssistantResult;
  desktopActionBridge: BootstrapSectionResult;
  enterpriseIm: BootstrapSectionResult;
  help: BootstrapSectionResult;
  services: BootstrapSectionResult;
};

export type BootstrapSiteItemResult = {
  entryKey: WebEntryKey;
  status: "installed" | "skipped";
  message?: string;
};

export type BootstrapWebsReport = {
  mode: "initialize" | "preserve";
  items: BootstrapSiteItemResult[];
  warnings: string[];
};

export type DesktopInitBootstrapState = {
  schemaVersion: 2;
  appliedAt: string;
  sourcePath: string;
  consumed: boolean;
  appliedResult: BootstrapApplyResult;
  failedSections: string[];
  errors: Record<string, string>;
  websReport: BootstrapWebsReport;
};

export type DesktopInitAssistantDefaults = {
  defaultChatAgentKey?: string;
  bootstrapAgentKey?: string;
  bootstrapChatId?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.host) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

export function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isValidRelayUrl(value: string) {
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

export function isPlaceholderUrl(value: string) {
  return !value || value === "http://" || value === "https://" || value === "ws://" || value === "wss://";
}

export function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function writeBootstrapState(
  app: App,
  state: DesktopInitBootstrapState,
  platform: NodeJS.Platform = process.platform
) {
  writeJsonFile(path.join(getDesktopStateRoot(app, platform), DESKTOP_INIT_BOOTSTRAP_STATE_FILE), state);
}

export function removeDesktopInitFile(initPath: string) {
  try {
    fs.rmSync(initPath, { force: true });
  } catch (error) {
    console.warn(`[desktop-init] failed to remove consumed ${DESKTOP_INIT_FILE}:`, error);
  }
}

export function removeDesktopInitSitesStaging(initPath: string) {
  const desktopInitDir = path.join(path.dirname(initPath), "desktop-init");
  const sitesDir = path.join(desktopInitDir, "sites");
  try {
    fs.rmSync(sitesDir, { recursive: true, force: true });
    if (fs.existsSync(desktopInitDir) && fs.readdirSync(desktopInitDir).length === 0) {
      fs.rmdirSync(desktopInitDir);
    }
  } catch (error) {
    console.warn("[desktop-init] failed to remove consumed Sites staging:", error);
  }
}

export function pathApiForRuntimeRoot(platform: NodeJS.Platform, runtimeRoot: string) {
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

export function normalizeKanbanDefaults(value: unknown) {
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

export function writeAssistantDefaults(
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
      mainOrder: Array.isArray(navigation.mainOrder)
        ? navigation.mainOrder.map(readText).filter(Boolean)
        : current.navigation.mainOrder,
      webOrder: Array.isArray(navigation.webOrder)
        ? navigation.webOrder.map(readText).filter(Boolean)
        : current.navigation.webOrder,
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
  platform: NodeJS.Platform = process.platform,
  updateProfileDeviceAlias = true
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
  if (deviceAlias && updateProfileDeviceAlias) {
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

export type PreparedBootstrapWebsite = {
  kind: "website";
  id: string;
  entryKey: WebEntryKey;
  item: WebsiteEntry;
};

export type PreparedBootstrapWebapp = {
  kind: "webapp";
  id: string;
  entryKey: WebEntryKey;
  item: WebappEntry;
  sourceDir: string;
};

export type PreparedBootstrapSite = PreparedBootstrapWebsite | PreparedBootstrapWebapp;

export type BootstrapWebsApplyResult = {
  status: Exclude<BootstrapSectionResult, "failed">;
  report: BootstrapWebsReport;
};

export function hasWebsiteDefaults(webs: unknown) {
  return isRecord(webs) && Array.isArray(webs.items);
}

export function assertSafeBootstrapId(rawId: unknown, itemIndex: number) {
  const id = readText(rawId);
  if (!id || normalizeWebId(id) !== id) {
    throw new Error(`webs.items[${itemIndex}].id must be a normalized Site id.`);
  }
  return id;
}

export function assertPathInsideRoot(
  rootDir: string,
  targetDir: string,
  pathApi: typeof path.posix | typeof path.win32,
  message: string
) {
  const relative = pathApi.relative(rootDir, targetDir);
  if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(message);
  }
}

export function assertBootstrapTreeHasNoSymlinks(rootDir: string) {
  const visit = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`WebApp seed cannot contain symbolic links: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  };
  visit(rootDir);
}

export function prepareBootstrapSites(
  initPath: string,
  webs: unknown,
  platform: NodeJS.Platform
) {
  const rawItems = isRecord(webs) && Array.isArray(webs.items) ? webs.items : [];
  const pathApi = pathApiForRuntimeRoot(platform, path.dirname(initPath));
  const sitesRoot = pathApi.join(pathApi.dirname(initPath), "desktop-init", "sites");
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const prepared: PreparedBootstrapSite[] = [];

  for (const [index, rawItem] of rawItems.entries()) {
    if (!isRecord(rawItem)) {
      throw new Error(`webs.items[${index}] must be an object.`);
    }
    const kind = readText(rawItem.kind);
    if (kind !== "website" && kind !== "webapp") {
      throw new Error(`webs.items[${index}].kind must be website or webapp.`);
    }
    const explicitId = assertSafeBootstrapId(rawItem.id, index);

    if (kind === "website") {
      const item = createWebsiteItem({
        id: explicitId || undefined,
        label: readText(rawItem.label) || undefined,
        url: readText(rawItem.url),
        copilotAgentKey: readText(rawItem.copilotAgentKey) || undefined
      });
      if (seenIds.has(item.id)) {
        throw new Error(`Duplicate Site id in desktop-init: ${item.id}`);
      }
      if (seenUrls.has(item.url)) {
        throw new Error(`Duplicate Website URL in desktop-init: ${item.url}`);
      }
      seenIds.add(item.id);
      seenUrls.add(item.url);
      prepared.push({ kind, id: item.id, entryKey: item.entryKey, item });
      continue;
    }

    const id = explicitId;
    if (seenIds.has(id)) {
      throw new Error(`Duplicate Site id in desktop-init: ${id}`);
    }
    const sourceDir = pathApi.join(sitesRoot, id);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`WebApp seed directory does not exist: desktop-init/sites/${id}`);
    }
    if (fs.lstatSync(sitesRoot).isSymbolicLink() || fs.lstatSync(sourceDir).isSymbolicLink()) {
      throw new Error(`WebApp seed path cannot be a symbolic link: ${id}`);
    }
    const sitesRootReal = fs.realpathSync(sitesRoot);
    const sourceDirReal = fs.realpathSync(sourceDir);
    assertPathInsideRoot(
      sitesRootReal,
      sourceDirReal,
      pathApi,
      `WebApp seed path escapes desktop-init/sites: ${id}`
    );
    assertBootstrapTreeHasNoSymlinks(sourceDirReal);
    const rawManifest = readJsonFile(pathApi.join(sourceDirReal, webappManager.manifestFileName));
    if (!webappManager.isManifest(rawManifest) || !isRecord(rawManifest)) {
      throw new Error(`WebApp seed manifest is invalid: ${id}/${webappManager.manifestFileName}`);
    }
    if (readText(rawManifest.id) !== id) {
      throw new Error(`WebApp seed manifest id must match directory id: ${id}`);
    }
    const item = webappManager.readPackage(sourceDirReal, id);
    if (!item || item.id !== id) {
      throw new Error(`WebApp seed manifest is invalid: ${id}/${webappManager.manifestFileName}`);
    }
    seenIds.add(id);
    prepared.push({ kind, id, entryKey: item.entryKey, item, sourceDir: sourceDirReal });
  }
  return prepared;
}

export function applyWebsiteDefaults(
  app: App,
  initPath: string,
  webs: unknown,
  preserve: boolean,
  platform: NodeJS.Platform = process.platform
): BootstrapWebsApplyResult {
  const mode = preserve ? "preserve" : "initialize";
  const emptyReport: BootstrapWebsReport = { mode, items: [], warnings: [] };
  if (!hasWebsiteDefaults(webs)) {
    return { status: "absent", report: emptyReport };
  }
  if (preserve) {
    return { status: "preserved", report: emptyReport };
  }

  // Validate every declared Site and packaged WebApp before touching user data.
  const prepared = prepareBootstrapSites(initPath, webs, platform);
  const existingWebsites = readWebsiteItems(app, platform);
  const existingWebapps = webappManager.listInstalled(app, platform);
  const websiteById = new Map(existingWebsites.map((item) => [item.id, item] as const));
  const websiteByUrl = new Map(existingWebsites.map((item) => [item.url, item] as const));
  const webappById = new Map(existingWebapps.map((item) => [item.id, item] as const));
  const report: BootstrapWebsReport = { mode, items: [], warnings: [] };
  const declaredOrder: WebEntryKey[] = [];
  const websitesToInstall: PreparedBootstrapWebsite[] = [];
  const webappsToInstall: PreparedBootstrapWebapp[] = [];

  for (const site of prepared) {
    if (site.kind === "website") {
      const existing = websiteById.get(site.id) ?? websiteByUrl.get(site.item.url);
      if (existing) {
        declaredOrder.push(existing.entryKey);
        const message = `Preserved existing Website for seed ${site.id}.`;
        report.items.push({ entryKey: existing.entryKey, status: "skipped", message });
        report.warnings.push(message);
        continue;
      }
      const targetDir = getWebsiteDir(app, site.id, platform);
      if (fs.existsSync(targetDir)) {
        const message = `Preserved unknown Website directory for seed ${site.id}.`;
        report.items.push({ entryKey: site.entryKey, status: "skipped", message });
        report.warnings.push(message);
        continue;
      }
      websitesToInstall.push(site);
      declaredOrder.push(site.entryKey);
      continue;
    }

    const existing = webappById.get(site.id);
    const targetDir = path.join(getDesktopWebappsDataRoot(app, platform), site.id);
    if (existing || fs.existsSync(targetDir)) {
      const entryKey = existing?.entryKey ?? site.entryKey;
      const message = `Preserved existing WebApp for seed ${site.id}.`;
      if (existing) {
        declaredOrder.push(entryKey);
      }
      report.items.push({ entryKey, status: "skipped", message });
      report.warnings.push(message);
      continue;
    }
    webappsToInstall.push(site);
    declaredOrder.push(site.entryKey);
  }

  if (existingWebsites.length + websitesToInstall.length > MAX_WEBSITE_ITEMS) {
    throw new Error(`Website seed would exceed the ${MAX_WEBSITE_ITEMS} Website limit.`);
  }

  const webappsRoot = getDesktopWebappsDataRoot(app, platform);
  const stagedWebapps: Array<{ site: PreparedBootstrapWebapp; stagedDir: string; targetDir: string }> = [];
  const createdDirs: string[] = [];
  let stagingRoot = "";
  try {
    if (webappsToInstall.length > 0) {
      fs.mkdirSync(webappsRoot, { recursive: true });
      stagingRoot = fs.mkdtempSync(path.join(webappsRoot, ".desktop-init-"));
      for (const site of webappsToInstall) {
        const stagedDir = path.join(stagingRoot, site.id);
        fs.cpSync(site.sourceDir, stagedDir, { recursive: true, errorOnExist: true });
        const stagedItem = webappManager.canonicalizePackage(stagedDir, site.id);
        if (stagedItem.id !== site.id) {
          throw new Error(`Staged WebApp id changed unexpectedly: ${site.id}`);
        }
        stagedWebapps.push({ site, stagedDir, targetDir: path.join(webappsRoot, site.id) });
      }
    }

    for (const staged of stagedWebapps) {
      fs.renameSync(staged.stagedDir, staged.targetDir);
      createdDirs.push(staged.targetDir);
      report.items.push({ entryKey: staged.site.entryKey, status: "installed" });
    }
    for (const site of websitesToInstall) {
      writeWebsiteItem(app, site.item, platform);
      createdDirs.push(getWebsiteDir(app, site.id, platform));
      report.items.push({ entryKey: site.entryKey, status: "installed" });
    }

    const availableEntryKeys = [
      ...existingWebsites.map((item) => item.entryKey),
      ...existingWebapps.map((item) => item.entryKey),
      ...websitesToInstall.map((item) => item.entryKey),
      ...webappsToInstall.map((item) => item.entryKey)
    ];
    const currentOrder = readWebOrderKeys(app, availableEntryKeys, platform);
    writeWebOrderKeys(app, [...declaredOrder, ...currentOrder, ...availableEntryKeys], platform);
  } catch (error) {
    for (const createdDir of createdDirs.reverse()) {
      fs.rmSync(createdDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (stagingRoot) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  return { status: "applied", report };
}
