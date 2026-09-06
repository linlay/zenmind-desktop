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

import { BootstrapApplyResult, BootstrapSectionResult, BootstrapWebsReport, DESKTOP_INIT_ASSISTANT_FILE, DESKTOP_INIT_BOOTSTRAP_STATE_FILE, DESKTOP_INIT_FILE, applyKanbanDefaults, applyMarketDefaults, applyPetDefaults, applyProfileDefaults, applySsoDefaults, applyTunnelHubDefaults, applyWebsiteDefaults, errorMessage, isRecord, isValidHttpUrl, isValidRelayUrl, normalizeDesktopInitAssistantDefaults, normalizeKanbanDefaults, pathApiForRuntimeRoot, readJsonFile, readText, removeDesktopInitFile, removeDesktopInitSitesStaging, resolveDesktopInitPath, writeAssistantDefaults, writeBootstrapState, writeJsonFile } from "./desktop-init.part-1";

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

export function runBootstrapSection<T extends string>(
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

export function getFailedSections(result: BootstrapApplyResult) {
  return Object.entries(result)
    .filter(([, status]) => status === "failed")
    .map(([sectionId]) => sectionId);
}

export type DesktopInitUpgradeBackupEntry = {
  index: number;
  targetPath: string;
  existed: boolean;
};

export type DesktopInitUpgradeBackupManifest = {
  schemaVersion: 1;
  entries: DesktopInitUpgradeBackupEntry[];
};

export function desktopInitUpgradeCanonicalPaths(app: App, platform: NodeJS.Platform) {
  const configRoot = getDesktopConfigRoot(app, platform);
  return [
    getServiceLifecycleArgsConfigPath(app, platform),
    getServicePortDefaultsConfigPath(app, platform),
    path.join(configRoot, DESKTOP_INIT_ASSISTANT_FILE),
    resolveDesktopSsoConfigPath(app, platform),
    path.join(configRoot, "kanban.json"),
    path.join(configRoot, "market.json"),
    path.join(configRoot, "tunnel-hub.json"),
    getDesktopActionBridgeSettingsConfigPath(app, platform),
    getEnterpriseImSettingsPath(app, platform),
    getHelpSettingsPath(app, platform)
  ];
}

export function validateDesktopInitUpgradeDefaults(defaults: Record<string, unknown>, platform: NodeJS.Platform) {
  const present = (key: string) => Object.prototype.hasOwnProperty.call(defaults, key);
  const requireObjectWhenPresent = (key: string) => {
    if (present(key) && !isRecord(defaults[key])) {
      throw new Error(`desktop-init ${key} must be an object when present.`);
    }
  };
  for (const key of [
    "services",
    "assistant",
    "sso",
    "kanban",
    "market",
    "tunnelHub",
    "desktopActionBridge",
    "enterpriseIm",
    "help"
  ]) {
    requireObjectWhenPresent(key);
  }

  const services = isRecord(defaults.services) ? defaults.services : {};
  const lifecycleArgs = normalizeServiceLifecycleArgsConfig({ services }, platform);
  const portDefaults = normalizeServicePortDefaultsConfig({ services }, platform);
  if (present("services") && Object.keys(services).length > 0 && !lifecycleArgs && !portDefaults) {
    throw new Error("desktop-init services does not contain supported lifecycle args or ports.");
  }
  const assistant = normalizeDesktopInitAssistantDefaults(defaults.assistant);
  const kanban = normalizeKanbanDefaults(defaults.kanban);
  if (present("kanban") && Object.keys(defaults.kanban as Record<string, unknown>).length > 0 && !kanban) {
    throw new Error("desktop-init kanban is invalid.");
  }
  if (kanban?.enabled === true && !isValidHttpUrl(readText(kanban.cloud?.serverUrl))) {
    throw new Error("Kanban server URL is invalid.");
  }
  if (isRecord(defaults.market) && defaults.market.enabled === true) {
    normalizeMarketApiBaseUrl(defaults.market.apiBaseUrl);
  }
  if (isRecord(defaults.tunnelHub)) {
    const relayUrl = readText(defaults.tunnelHub.relayUrl);
    if (defaults.tunnelHub.enabled === true && !isValidRelayUrl(relayUrl)) {
      throw new Error("Tunnel Hub relay URL is invalid.");
    }
  }
  const desktopActionBridge = present("desktopActionBridge")
    ? normalizeDesktopActionBridgeSettingsConfig(defaults.desktopActionBridge, platform)
    : null;
  if (
    isRecord(defaults.desktopActionBridge) &&
    Object.keys(defaults.desktopActionBridge).length > 0 &&
    !desktopActionBridge
  ) {
    throw new Error("Desktop Action Bridge port must be an integer from 1 to 65535.");
  }
  const enterpriseIm = present("enterpriseIm")
    ? normalizeEnterpriseImSettings(defaults.enterpriseIm)
    : null;
  if (present("enterpriseIm") && !enterpriseIm) {
    throw new Error("Enterprise IM enabled must be boolean and base URL must use loopback HTTP or remote HTTPS.");
  }
  const help = present("help") ? normalizeHelpSettings(defaults.help) : null;
  if (present("help") && !help) {
    throw new Error("Help URL must use loopback HTTP or remote HTTPS.");
  }
  return {
    present,
    lifecycleArgs,
    portDefaults,
    assistant,
    kanban,
    desktopActionBridge,
    enterpriseIm,
    help
  };
}

export function prepareDesktopInitUpgradeBackup(
  targets: string[],
  backupDir: string,
  platform: NodeJS.Platform
) {
  const manifestPath = path.join(backupDir, "desktop-config-backup.json");
  if (fs.existsSync(manifestPath)) {
    const existing = readJsonFile(manifestPath);
    const rawEntries = isRecord(existing) ? existing.entries : undefined;
    if (
      !isRecord(existing) ||
      existing.schemaVersion !== 1 ||
      !Array.isArray(rawEntries) ||
      rawEntries.length !== targets.length
    ) {
      throw new Error(`Desktop config upgrade backup manifest is invalid: ${manifestPath}`);
    }
    const entries = targets.map((targetPath, index) => {
      const entry = rawEntries[index];
      if (
        !isRecord(entry) ||
        entry.index !== index ||
        entry.targetPath !== targetPath ||
        typeof entry.existed !== "boolean"
      ) {
        throw new Error(`Desktop config upgrade backup manifest is unsafe: ${manifestPath}`);
      }
      if (entry.existed) {
        const backupPath = path.join(backupDir, `${index}-${path.basename(targetPath)}`);
        const stat = fs.lstatSync(backupPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Desktop config upgrade backup file is unsafe: ${backupPath}`);
        }
      }
      return { index, targetPath, existed: entry.existed };
    });
    return { schemaVersion: 1, entries } satisfies DesktopInitUpgradeBackupManifest;
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const entries = targets.map((targetPath, index) => {
    const existed = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
    if (existed) {
      const backupPath = path.join(backupDir, `${index}-${path.basename(targetPath)}`);
      fs.copyFileSync(targetPath, backupPath);
      if (platform !== "win32") {
        fs.chmodSync(backupPath, 0o600);
      }
    }
    return { index, targetPath, existed };
  });
  const manifest: DesktopInitUpgradeBackupManifest = { schemaVersion: 1, entries };
  writeJsonFile(manifestPath, manifest);
  if (platform !== "win32") {
    fs.chmodSync(backupDir, 0o700);
    fs.chmodSync(manifestPath, 0o600);
  }
  return manifest;
}

export function restoreDesktopInitUpgradeBackup(
  manifest: DesktopInitUpgradeBackupManifest,
  backupDir: string
) {
  for (const entry of manifest.entries) {
    fs.rmSync(entry.targetPath, { force: true });
    if (!entry.existed) {
      continue;
    }
    fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
    fs.copyFileSync(
      path.join(backupDir, `${entry.index}-${path.basename(entry.targetPath)}`),
      entry.targetPath
    );
  }
}

export function applyDesktopInitVersionUpgrade(
  app: App,
  defaultsValue: unknown,
  backupDir: string,
  platform: NodeJS.Platform = process.platform
) {
  if (!isRecord(defaultsValue)) {
    throw new Error("Bundled desktop-init.json must be a JSON object.");
  }
  const prepared = validateDesktopInitUpgradeDefaults(defaultsValue, platform);
  const targets = desktopInitUpgradeCanonicalPaths(app, platform);
  const backup = prepareDesktopInitUpgradeBackup(targets, backupDir, platform);
  try {
    for (const targetPath of targets) {
      fs.rmSync(targetPath, { force: true });
    }
    if (prepared.lifecycleArgs) {
      writeServiceLifecycleArgsConfig(app, prepared.lifecycleArgs, platform);
    }
    if (prepared.portDefaults) {
      writeServicePortDefaultsConfig(app, prepared.portDefaults, platform);
    }
    writeAssistantDefaults(app, prepared.assistant, platform);
    if (prepared.present("sso")) {
      applySsoDefaults(app, defaultsValue.sso, platform);
    }
    if (prepared.present("kanban")) {
      applyKanbanDefaults(app, defaultsValue.kanban, platform, false);
    }
    if (prepared.present("market")) {
      applyMarketDefaults(app, defaultsValue.market, platform);
    }
    if (prepared.present("tunnelHub")) {
      applyTunnelHubDefaults(app, defaultsValue.tunnelHub, platform);
    }
    if (prepared.desktopActionBridge) {
      writeDesktopActionBridgeSettingsConfig(app, prepared.desktopActionBridge, platform);
    }
    if (prepared.enterpriseIm) {
      writeEnterpriseImSettings(app, prepared.enterpriseIm, platform);
    }
    if (prepared.help) {
      writeHelpSettings(app, prepared.help, platform);
    }
    return { applied: true, backupDir };
  } catch (error) {
    try {
      restoreDesktopInitUpgradeBackup(backup, backupDir);
    } catch (restoreError) {
      throw new Error(
        `${errorMessage(error)}; Desktop config rollback failed: ${errorMessage(restoreError)}`
      );
    }
    throw error;
  }
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
    const bootstrapStatePath = path.join(
      getDesktopStateRoot(app, platform),
      DESKTOP_INIT_BOOTSTRAP_STATE_FILE
    );
    const preserveSites = fs.existsSync(bootstrapStatePath);
    const assistant = normalizeDesktopInitAssistantDefaults(defaults.assistant);
    const kanbanDefaults = isRecord(defaults.kanban) ? defaults.kanban : null;
    const errors: Record<string, string> = {};
    let websReport: BootstrapWebsReport = {
      mode: preserveSites ? "preserve" : "initialize",
      items: [],
      warnings: []
    };

    const applied: BootstrapApplyResult = {
      profile: runBootstrapSection("profile", errors, () => applyProfileDefaults(app, defaults.profile, platform)),
      kanban: runBootstrapSection("kanban", errors, () => applyKanbanDefaults(app, kanbanDefaults, platform)),
      pet: runBootstrapSection("pet", errors, () => applyPetDefaults(app, defaults.pet, platform)),
      market: runBootstrapSection("market", errors, () => applyMarketDefaults(app, defaults.market, platform)),
      sso: runBootstrapSection("sso", errors, () => applySsoDefaults(app, defaults.sso, platform)),
      tunnelHub: runBootstrapSection("tunnelHub", errors, () => applyTunnelHubDefaults(app, defaults.tunnelHub, platform)),
      webs: runBootstrapSection("webs", errors, () => {
        const result = applyWebsiteDefaults(
          app,
          initPath,
          defaults.webs,
          preserveSites,
          platform
        );
        websReport = result.report;
        return result.status;
      }),
      assistant: runBootstrapSection("assistant", errors, () => writeAssistantDefaults(app, assistant, platform)),
      desktopActionBridge: runBootstrapSection(
        "desktopActionBridge",
        errors,
        () => applyDesktopActionBridgeDefaults(app, defaults.desktopActionBridge, platform)
      ),
      enterpriseIm: runBootstrapSection(
        "enterpriseIm",
        errors,
        () => applyEnterpriseImDefaults(app, defaults.enterpriseIm, platform)
      ),
      help: runBootstrapSection(
        "help",
        errors,
        () => applyHelpDefaults(app, defaults.help, platform)
      ),
      services: runBootstrapSection("services", errors, () => applyServiceDefaults(app, defaults.services, platform))
    };
    const failedSections = getFailedSections(applied);
    if (applied.webs === "failed" && errors.webs) {
      websReport.warnings.push(errors.webs);
    }
    removeDesktopInitFile(initPath);
    removeDesktopInitSitesStaging(initPath);
    writeBootstrapState(app, {
      schemaVersion: 2,
      appliedAt: new Date().toISOString(),
      sourcePath: initPath,
      consumed: true,
      appliedResult: applied,
      failedSections,
      errors,
      websReport
    }, platform);
    return { ok: true, applied: true, appliedResult: applied, failedSections, errors, websReport };
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
  applyEnterpriseImDefaults,
  applyHelpDefaults,
  applyServiceDefaults
};
