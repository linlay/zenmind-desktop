import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../../../shared/contracts";
import {
  rewriteServiceLifecycleArgsForDesktopConfigUpgrade
} from "../../service-lifecycle-args";
import {
  rewriteServicePortDefaultsForDesktopConfigUpgrade
} from "../../service-port-defaults";
import {
  getDataRoot,
  getDesktopStateRoot,
} from "../../user-paths";

export const DESKTOP_SERVICE_CONFIG_VERSION_FILE = "service-config-version.json";
export const DESKTOP_SERVICE_CONFIG_UPGRADE_FILE = "service-config-upgrade.json";
export const DESKTOP_SERVICE_CONFIG_UPGRADE_IDS = [
  "agent-container-hub",
  "identity-center",
  "agent-platform",
  "agent-webclient"
] as const satisfies readonly ServiceId[];

type CoreServiceConfigUpgradeId = typeof DESKTOP_SERVICE_CONFIG_UPGRADE_IDS[number];
type ServiceUpgradeStatus = "pending" | "resetting" | "succeeded" | "failed";

type DesktopServiceConfigVersionState = {
  schemaVersion: 1;
  desktopVersion: string;
  completedAt: string;
};

type DesktopServiceConfigUpgradeServiceState = {
  status: ServiceUpgradeStatus;
  attempts: number;
  updatedAt: string;
  lastError?: string;
};

export type DesktopServiceConfigUpgradeJournal = {
  schemaVersion: 2;
  mode: "fresh-install" | "version-change";
  status: "in-progress" | "awaiting-core-health" | "failed";
  fromVersion: string;
  toVersion: string;
  backupRoot: string;
  startedAt: string;
  updatedAt: string;
  desktopConfig: {
    status: "pending" | "applied" | "failed" | "not-required";
    updatedAt: string;
    sourceZipPath?: string;
    previousSourceZipPath?: string;
    sha256?: string;
    size?: number;
    lastError?: string;
  };
  services: Record<CoreServiceConfigUpgradeId, DesktopServiceConfigUpgradeServiceState>;
  lastError?: string;
};

export type DesktopServiceConfigResetContext = {
  desktopConfigReset?: boolean;
  backupDir: string;
  fromVersion: string;
  toVersion: string;
  runtimeResourceSource?: string;
  runtimeResourcePreviousSource?: string;
  runtimeResourceMode?: "version-change" | "manual-import";
};

export type DesktopVersionUpgradeInput = {
  sourceZipPath: string;
  previousSourceZipPath?: string;
  sha256: string;
  size: number;
};

export type DesktopVersionUpgradeInputRequired = {
  kind: "env-zip";
  message: string;
  fromVersion: string;
  toVersion: string;
};

export type DesktopVersionUpgradeConfigurationPreparation =
  | DesktopVersionUpgradeInput
  | { inputRequired: { message: string } };

type DesktopServiceConfigUpgradeCallbacks = {
  currentDesktopDefaultPorts: Record<string, number>;
  isFirstDesktopInstall?: boolean;
  onBegin?: () => void;
  onProgress?: (serviceId: ServiceId, message: string) => void;
  stopService: (serviceId: ServiceId) => Promise<void>;
  installCurrentService: (serviceId: ServiceId) => Promise<void>;
  prepareDesktopConfiguration: (context: {
    fromVersion: string;
    toVersion: string;
    backupDir: string;
    inputDir: string;
    apply: boolean;
    sourceZipPath?: string;
    expectedSha256?: string;
  }) => Promise<DesktopVersionUpgradeConfigurationPreparation>;
  resetServiceConfig: (
    serviceId: ServiceId,
    context: DesktopServiceConfigResetContext
  ) => Promise<void>;
};

export type DesktopServiceConfigUpgradePreparationResult = {
  mode: "none" | "fresh-install" | "version-change";
  desktopVersion: string;
  failures: string[];
  journal: DesktopServiceConfigUpgradeJournal | null;
  inputRequired?: DesktopVersionUpgradeInputRequired;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeDesktopServiceConfigVersion(value: unknown) {
  const version = String(value ?? "").trim().replace(/^v/iu, "");
  return version ? `v${version}` : "";
}

function getVersionStatePath(app: App, platform: NodeJS.Platform) {
  return path.join(getDesktopStateRoot(app, platform), DESKTOP_SERVICE_CONFIG_VERSION_FILE);
}

function getUpgradeJournalPath(app: App, platform: NodeJS.Platform) {
  return path.join(getDesktopStateRoot(app, platform), DESKTOP_SERVICE_CONFIG_UPGRADE_FILE);
}

function secureDirectory(targetPath: string, platform: NodeJS.Platform) {
  fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    fs.chmodSync(targetPath, 0o700);
  }
}

function writeSecureJsonAtomic(filePath: string, value: unknown, platform: NodeJS.Platform) {
  secureDirectory(path.dirname(filePath), platform);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  if (platform !== "win32") {
    fs.chmodSync(tempPath, 0o600);
  }
  fs.renameSync(tempPath, filePath);
}

function readVersionState(app: App, platform: NodeJS.Platform) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getVersionStatePath(app, platform), "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const desktopVersion = normalizeDesktopServiceConfigVersion(parsed.desktopVersion);
    const completedAt = typeof parsed.completedAt === "string" ? parsed.completedAt : "";
    return desktopVersion && completedAt
      ? {
          schemaVersion: 1,
          desktopVersion,
          completedAt
        } satisfies DesktopServiceConfigVersionState
      : null;
  } catch {
    return null;
  }
}

function readServiceUpgradeState(value: unknown): DesktopServiceConfigUpgradeServiceState | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  if (status !== "pending" && status !== "resetting" && status !== "succeeded" && status !== "failed") {
    return null;
  }
  const attempts = typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0
    ? value.attempts
    : 0;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  const lastError = typeof value.lastError === "string" && value.lastError.trim()
    ? value.lastError
    : undefined;
  return {
    status,
    attempts,
    updatedAt,
    ...(lastError ? { lastError } : {})
  };
}

function readUpgradeJournal(app: App, platform: NodeJS.Platform) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getUpgradeJournalPath(app, platform), "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const mode = parsed.mode === "fresh-install" || parsed.mode === "version-change"
      ? parsed.mode
      : null;
    const status = parsed.status === "in-progress" || parsed.status === "awaiting-core-health" || parsed.status === "failed"
      ? parsed.status
      : null;
    const fromVersion = parsed.fromVersion === "legacy"
      ? "legacy"
      : normalizeDesktopServiceConfigVersion(parsed.fromVersion);
    const toVersion = normalizeDesktopServiceConfigVersion(parsed.toVersion);
    const backupRoot = typeof parsed.backupRoot === "string" ? parsed.backupRoot : "";
    const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (!mode || !status || !fromVersion || !toVersion || !startedAt || !updatedAt) {
      return null;
    }
    const expectedBackupRoot = mode === "version-change"
      ? getTransactionBackupRoot(app, fromVersion, toVersion, platform)
      : "";
    if (
      (mode === "version-change" && path.resolve(backupRoot) !== path.resolve(expectedBackupRoot)) ||
      (mode === "fresh-install" && backupRoot !== "")
    ) {
      return null;
    }
    const rawServices = isRecord(parsed.services) ? parsed.services : {};
    const services = {} as DesktopServiceConfigUpgradeJournal["services"];
    for (const serviceId of DESKTOP_SERVICE_CONFIG_UPGRADE_IDS) {
      services[serviceId] = readServiceUpgradeState(rawServices[serviceId]) ?? {
        status: "pending",
        attempts: 0,
        updatedAt: startedAt
      };
    }
    const lastError = typeof parsed.lastError === "string" && parsed.lastError.trim()
      ? parsed.lastError
      : undefined;
    const rawDesktopConfig = isRecord(parsed.desktopConfig) ? parsed.desktopConfig : {};
    const desktopConfigStatus = rawDesktopConfig.status === "applied" ||
      rawDesktopConfig.status === "failed" ||
      rawDesktopConfig.status === "not-required" ||
      rawDesktopConfig.status === "pending"
      ? rawDesktopConfig.status
      : mode === "fresh-install" ? "not-required" : "pending";
    const desktopConfig = {
      status: desktopConfigStatus,
      updatedAt: typeof rawDesktopConfig.updatedAt === "string"
        ? rawDesktopConfig.updatedAt
        : updatedAt,
      ...(typeof rawDesktopConfig.sourceZipPath === "string" ? { sourceZipPath: rawDesktopConfig.sourceZipPath } : {}),
      ...(typeof rawDesktopConfig.previousSourceZipPath === "string"
        ? { previousSourceZipPath: rawDesktopConfig.previousSourceZipPath }
        : {}),
      ...(typeof rawDesktopConfig.sha256 === "string" ? { sha256: rawDesktopConfig.sha256 } : {}),
      ...(typeof rawDesktopConfig.size === "number" ? { size: rawDesktopConfig.size } : {}),
      ...(typeof rawDesktopConfig.lastError === "string" ? { lastError: rawDesktopConfig.lastError } : {})
    } satisfies DesktopServiceConfigUpgradeJournal["desktopConfig"];
    return {
      schemaVersion: 2,
      mode,
      status,
      fromVersion,
      toVersion,
      backupRoot,
      startedAt,
      updatedAt,
      desktopConfig,
      services,
      ...(lastError ? { lastError } : {})
    } satisfies DesktopServiceConfigUpgradeJournal;
  } catch {
    return null;
  }
}

function versionPathSegment(version: string) {
  return version.replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function getServiceBackupsRoot(app: App, platform: NodeJS.Platform) {
  return path.join(getDataRoot(app, platform), "config", "service-backups");
}

function getTransactionBackupRoot(
  app: App,
  fromVersion: string,
  toVersion: string,
  platform: NodeJS.Platform
) {
  return path.join(
    getServiceBackupsRoot(app, platform),
    `${versionPathSegment(fromVersion)}-to-${versionPathSegment(toVersion)}`
  );
}

function createServicesState(now: string) {
  return Object.fromEntries(DESKTOP_SERVICE_CONFIG_UPGRADE_IDS.map((serviceId) => [
    serviceId,
    {
      status: "pending",
      attempts: 0,
      updatedAt: now
    }
  ])) as DesktopServiceConfigUpgradeJournal["services"];
}

function createJournal(
  app: App,
  mode: DesktopServiceConfigUpgradeJournal["mode"],
  fromVersion: string,
  toVersion: string,
  platform: NodeJS.Platform
) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    mode,
    status: mode === "fresh-install" ? "awaiting-core-health" : "in-progress",
    fromVersion,
    toVersion,
    backupRoot: mode === "version-change"
      ? getTransactionBackupRoot(app, fromVersion, toVersion, platform)
      : "",
    startedAt: now,
    updatedAt: now,
    desktopConfig: {
      status: mode === "fresh-install" ? "not-required" : "pending",
      updatedAt: now
    },
    services: createServicesState(now)
  } satisfies DesktopServiceConfigUpgradeJournal;
}

function writeJournal(app: App, journal: DesktopServiceConfigUpgradeJournal, platform: NodeJS.Platform) {
  journal.updatedAt = new Date().toISOString();
  writeSecureJsonAtomic(getUpgradeJournalPath(app, platform), journal, platform);
}

function removeUpgradeJournal(app: App, platform: NodeJS.Platform) {
  fs.rmSync(getUpgradeJournalPath(app, platform), { force: true });
}

function cleanupSuccessfulUpgradeBackups(
  app: App,
  journal: DesktopServiceConfigUpgradeJournal,
  platform: NodeJS.Platform
) {
  if (journal.mode !== "version-change" || !journal.backupRoot) {
    return;
  }
  const backupsRoot = getServiceBackupsRoot(app, platform);
  if (!fs.existsSync(backupsRoot)) {
    return;
  }
  const retainedName = path.basename(journal.backupRoot);
  for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
    const targetPath = path.join(backupsRoot, entry.name);
    if (entry.name !== retainedName) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    for (const child of fs.readdirSync(targetPath, { withFileTypes: true })) {
      if (child.name.endsWith(".failed")) {
        fs.rmSync(path.join(targetPath, child.name), { recursive: true, force: true });
      }
    }
  }
}

function writeCompletedVersion(
  app: App,
  desktopVersion: string,
  platform: NodeJS.Platform
) {
  const state: DesktopServiceConfigVersionState = {
    schemaVersion: 1,
    desktopVersion,
    completedAt: new Date().toISOString()
  };
  writeSecureJsonAtomic(getVersionStatePath(app, platform), state, platform);
}

function retargetFreshInstallJournal(
  journal: DesktopServiceConfigUpgradeJournal,
  desktopVersion: string
) {
  journal.toVersion = desktopVersion;
  journal.status = "awaiting-core-health";
  delete journal.lastError;
  return journal;
}

export async function prepareDesktopServiceConfigUpgrade(
  app: App,
  desktopVersionValue: string,
  callbacks: DesktopServiceConfigUpgradeCallbacks,
  platform: NodeJS.Platform = process.platform
): Promise<DesktopServiceConfigUpgradePreparationResult> {
  const desktopVersion = normalizeDesktopServiceConfigVersion(desktopVersionValue);
  if (!desktopVersion) {
    return {
      mode: "none",
      desktopVersion: "",
      failures: ["Desktop version is empty; service config version cannot be evaluated"],
      journal: null
    };
  }

  const completedVersion = readVersionState(app, platform)?.desktopVersion ?? "";
  let journal = readUpgradeJournal(app, platform);
  if (
    completedVersion === desktopVersion &&
    (!journal || journal.toVersion === desktopVersion)
  ) {
    if (journal) {
      cleanupSuccessfulUpgradeBackups(app, journal, platform);
      removeUpgradeJournal(app, platform);
    }
    return { mode: "none", desktopVersion, failures: [], journal: null };
  }

  if (journal?.mode === "fresh-install") {
    if (journal.toVersion !== desktopVersion) {
      journal = retargetFreshInstallJournal(journal, desktopVersion);
      writeJournal(app, journal, platform);
    }
    return { mode: "fresh-install", desktopVersion, failures: [], journal };
  }

  // Desktop intentionally treats each service config directory as opaque. The
  // first-install signal comes from the startup bootstrap instead of inspecting
  // files owned by individual services.
  const isFreshInstall = callbacks.isFirstDesktopInstall === true;
  if (!journal && !completedVersion && isFreshInstall) {
    journal = createJournal(app, "fresh-install", "legacy", desktopVersion, platform);
    writeJournal(app, journal, platform);
    return { mode: "fresh-install", desktopVersion, failures: [], journal };
  }

  if (!journal || journal.toVersion !== desktopVersion) {
    const fromVersion = journal?.toVersion || completedVersion || "legacy";
    journal = createJournal(
      app,
      "version-change",
      fromVersion,
      desktopVersion,
      platform
    );
    writeJournal(app, journal, platform);
  }

  const shouldApplyDesktopConfiguration = journal.desktopConfig.status !== "applied";
  try {
    const preparation = await callbacks.prepareDesktopConfiguration({
      fromVersion: journal.fromVersion,
      toVersion: journal.toVersion,
      backupDir: path.join(journal.backupRoot, "desktop"),
      inputDir: path.join(journal.backupRoot, "input"),
      apply: shouldApplyDesktopConfiguration,
      ...(journal.desktopConfig.sourceZipPath
        ? { sourceZipPath: journal.desktopConfig.sourceZipPath }
        : {}),
      ...(journal.desktopConfig.sha256
        ? { expectedSha256: journal.desktopConfig.sha256 }
        : {})
    });
    if ("inputRequired" in preparation) {
      journal.desktopConfig.status = "pending";
      journal.desktopConfig.updatedAt = new Date().toISOString();
      delete journal.desktopConfig.lastError;
      journal.status = "in-progress";
      delete journal.lastError;
      writeJournal(app, journal, platform);
      return {
        mode: "version-change",
        desktopVersion,
        failures: [],
        journal,
        inputRequired: {
          kind: "env-zip",
          message: preparation.inputRequired.message,
          fromVersion: journal.fromVersion,
          toVersion: journal.toVersion
        }
      };
    }
    const input = preparation;
    if (
      journal.desktopConfig.sha256 &&
      journal.desktopConfig.sha256.toLowerCase() !== input.sha256.toLowerCase()
    ) {
      throw new Error(
        `bundled env.zip changed during the unfinished upgrade: expected ${journal.desktopConfig.sha256}, got ${input.sha256}`
      );
    }
    journal.desktopConfig = {
      status: "applied",
      updatedAt: new Date().toISOString(),
      sourceZipPath: input.sourceZipPath,
      ...(input.previousSourceZipPath ? { previousSourceZipPath: input.previousSourceZipPath } : {}),
      sha256: input.sha256.toLowerCase(),
      size: input.size
    };
    writeJournal(app, journal, platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.desktopConfig.status = "failed";
    journal.desktopConfig.updatedAt = new Date().toISOString();
    journal.desktopConfig.lastError = message;
    journal.status = "failed";
    journal.lastError = `Desktop environment configuration failed: ${message}`;
    writeJournal(app, journal, platform);
    return {
      mode: "version-change",
      desktopVersion,
      failures: [journal.lastError],
      journal
    };
  }

  callbacks.onBegin?.();
  try {
    const ports = rewriteServicePortDefaultsForDesktopConfigUpgrade(
      app,
      callbacks.currentDesktopDefaultPorts,
      platform
    );
    rewriteServiceLifecycleArgsForDesktopConfigUpgrade(
      app,
      ports.services["agent-platform"].defaultPort,
      platform
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    journal.status = "failed";
    journal.lastError = `Desktop service config normalization failed: ${message}`;
    writeJournal(app, journal, platform);
    return {
      mode: "version-change",
      desktopVersion,
      failures: [journal.lastError],
      journal
    };
  }

  secureDirectory(journal.backupRoot, platform);
  for (const serviceId of DESKTOP_SERVICE_CONFIG_UPGRADE_IDS) {
    const serviceState = journal.services[serviceId];
    if (serviceState.status === "succeeded") {
      continue;
    }
    serviceState.status = "resetting";
    serviceState.attempts += 1;
    serviceState.updatedAt = new Date().toISOString();
    delete serviceState.lastError;
    journal.status = "in-progress";
    delete journal.lastError;
    writeJournal(app, journal, platform);

    try {
      callbacks.onProgress?.(serviceId, "Stopping the previous service process");
      await callbacks.stopService(serviceId);
      callbacks.onProgress?.(serviceId, "Installing the current Desktop service package");
      await callbacks.installCurrentService(serviceId);
      callbacks.onProgress?.(serviceId, "Rebuilding service-owned configuration");
      await callbacks.resetServiceConfig(serviceId, {
        backupDir: path.join(journal.backupRoot, serviceId),
        fromVersion: journal.fromVersion,
        toVersion: journal.toVersion,
        ...(journal.desktopConfig.sourceZipPath
          ? {
              runtimeResourceSource: journal.desktopConfig.sourceZipPath,
              ...(journal.desktopConfig.previousSourceZipPath
                ? { runtimeResourcePreviousSource: journal.desktopConfig.previousSourceZipPath }
                : {}),
              runtimeResourceMode: "version-change" as const
            }
          : {})
      });
      serviceState.status = "succeeded";
      serviceState.updatedAt = new Date().toISOString();
      writeJournal(app, journal, platform);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      serviceState.status = "failed";
      serviceState.updatedAt = new Date().toISOString();
      serviceState.lastError = message;
      journal.status = "failed";
      journal.lastError = `${serviceId}: ${message}`;
      writeJournal(app, journal, platform);
      return {
        mode: "version-change",
        desktopVersion,
        failures: [journal.lastError],
        journal
      };
    }
  }

  journal.status = "awaiting-core-health";
  delete journal.lastError;
  writeJournal(app, journal, platform);
  return { mode: "version-change", desktopVersion, failures: [], journal };
}

export function recordDesktopServiceConfigCoreHealthFailure(
  app: App,
  desktopVersionValue: string,
  failures: string[],
  platform: NodeJS.Platform = process.platform
) {
  const desktopVersion = normalizeDesktopServiceConfigVersion(desktopVersionValue);
  const journal = readUpgradeJournal(app, platform);
  if (!desktopVersion || !journal || journal.toVersion !== desktopVersion) {
    return;
  }
  const now = new Date().toISOString();
  for (const serviceId of DESKTOP_SERVICE_CONFIG_UPGRADE_IDS) {
    const failure = failures.find((item) => item.startsWith(`${serviceId}:`));
    if (!failure) {
      continue;
    }
    journal.services[serviceId].status = "failed";
    journal.services[serviceId].updatedAt = now;
    journal.services[serviceId].lastError = failure.slice(serviceId.length + 1).trim();
  }
  journal.status = "failed";
  journal.lastError = failures.join("; ") || "core service health verification failed";
  writeJournal(app, journal, platform);
}

export function completeDesktopServiceConfigUpgrade(
  app: App,
  desktopVersionValue: string,
  platform: NodeJS.Platform = process.platform
) {
  const desktopVersion = normalizeDesktopServiceConfigVersion(desktopVersionValue);
  if (!desktopVersion) {
    throw new Error("Desktop version is empty; service config version cannot be committed");
  }
  const journal = readUpgradeJournal(app, platform);
  if (journal && journal.toVersion !== desktopVersion) {
    throw new Error(
      `service config transaction targets ${journal.toVersion}, not current Desktop ${desktopVersion}`
    );
  }
  writeCompletedVersion(app, desktopVersion, platform);
  if (journal) {
    if (journal.mode === "version-change" && journal.backupRoot) {
      fs.rmSync(path.join(journal.backupRoot, "input"), { recursive: true, force: true });
    }
    cleanupSuccessfulUpgradeBackups(app, journal, platform);
    removeUpgradeJournal(app, platform);
  }
}

export const __testInternals = {
  getVersionStatePath,
  getUpgradeJournalPath,
  getServiceBackupsRoot,
  readVersionState,
  readUpgradeJournal,
  versionPathSegment
};
