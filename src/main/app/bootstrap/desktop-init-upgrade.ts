import { type App } from "electron";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import {
  getServiceLifecycleArgsConfigPath,
  getServicePortDefaultsConfigPath,
  normalizeServiceLifecycleArgsConfig,
  normalizeServicePortDefaultsConfig,
  writeServiceLifecycleArgsConfig,
  writeServicePortDefaultsConfig
} from "../../modules/services";
import path from "node:path";
import {
  DESKTOP_INIT_ASSISTANT_FILE,
  isRecord,
  readText,
  isValidHttpUrl,
  isValidRelayUrl,
  readJsonFile,
  writeJsonFile,
  writeAssistantDefaults,
  errorMessage
} from "./desktop-init-state";
import { resolveDesktopSsoConfigPath } from "../../modules/identity";
import { getUpdateConfigPath, writeUpdateConfig } from "../../modules/updates";
import {
  getDesktopActionBridgeSettingsConfigPath,
  normalizeDesktopActionBridgeSettingsConfig,
  writeDesktopActionBridgeSettingsConfig
} from "../../modules/desktop-actions";
import { getEnterpriseImSettingsPath, normalizeEnterpriseImSettings, writeEnterpriseImSettings } from "../../modules/enterprise-chat";
import { getHelpSettingsPath, normalizeHelpSettings, writeHelpSettings } from "../../modules/settings";
import {
  normalizeDesktopInitAssistantDefaults,
  normalizeKanbanDefaults,
  applySsoDefaults,
  applyKanbanDefaults,
  applyMarketDefaults,
  applyTunnelHubDefaults
} from "./desktop-init-settings";
import { normalizeMarketApiBaseUrl } from "../../modules/marketplace";
import fs from "node:fs";

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
    getUpdateConfigPath(app, platform),
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
  const kanbanServerUrl = readText(kanban?.cloud?.serverUrl);
  if (kanban?.enabled === true && (kanbanServerUrl || kanban.cloud?.remoteControlEnabled === true) && !isValidHttpUrl(kanbanServerUrl)) {
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
  const updateConfigPath = getUpdateConfigPath(app, platform);
  try {
    for (const targetPath of targets) {
      // Keep the last valid update source until its replacement is validated.
      if (targetPath === updateConfigPath) continue;
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
      applyKanbanDefaults(app, defaultsValue.kanban, platform);
    }
    try {
      if (prepared.present("updates")) writeUpdateConfig(app, defaultsValue.updates, platform);
      else fs.rmSync(updateConfigPath, { force: true });
    } catch (error) {
      console.warn("[updates] optional configuration upgrade failed; continuing startup", error);
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
