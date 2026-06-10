import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { App } from "electron";
import type {
  ServiceCommandResult,
  ServiceConfigReadResult,
  ServiceDesiredStatus,
  ServiceId,
  ManifestDesktopCapabilityPhase,
  ManifestDesktopCapabilityRequirement,
  ServiceImportResult,
  ServiceLogReadOptions,
  ServiceLogReadResult,
  ServiceLogStreamEvent,
  ServiceLogStreamOptions,
  ServiceLogTarget,
  ServiceLogsMeta,
  ServiceState,
  ServiceVerification,
  StartupRestoreMode,
  StartupRestoreServicePhase
} from "../../../shared/contracts";
import type { ServiceDefinition } from "../../manifest-utils";
import { getAllServices, getService } from "../service-registry";
import { issueAgentAccessToken } from "../../agent-auth";
import { readEnvFile, parseEnvFileContent } from "../../env-file";
import { extractArchiveToDir } from "../../archive-utils";
import {
  buildServiceLayoutEnv,
  getInitializationStatePath,
  getInstallDir,
  getServiceLayout,
  resolveConfigPath,
  resolveConfigTemplatePath,
  resolveProgramPath,
  resolveServiceRuntimePath,
  type ServiceLayout
} from "./layout";
import {
  LOG_READ_WINDOW_BYTES,
  readLogRange,
  readServiceLogFile,
  normalizeLogStreamOffset,
  normalizeLogStreamPollInterval
} from "./logs";
import {
  beginStartupTiming,
  flushStartupTimingSummary
} from "../../startup-timing";
import {
  agentPlatformInstallNeedsRefresh,
  agentWebclientInstallNeedsRefresh,
  serviceInstallNeedsRefresh,
  zenmindAppServerInstallNeedsRefresh
} from "./install-refresh";
import {
  formatDesktopAgentPlatformRuntimeRoot,
  expandHomeShortcut,
  hasConfiguredAgentPlatformRuntimePath,
  resolveAgentPlatformAgentsDir,
  resolveAgentPlatformInitializationRuntimeRoot,
  resolveHomeDir,
  resolvePreferredAgentPlatformRuntimeRoot
} from "./runtime-paths";
import {
  resolveNodeBin
} from "./command-env";
import { ensureDesktopRegisterApiKey } from "../../desktop-register";
import { getDesktopDeviceId } from "../../device-identity";
import {
  decodePowerShellCapturePayload,
  runExecFile,
  SERVICE_COMMAND_TIMEOUT_MS
} from "./command-runner";
import {
  upsertEnvFileContent,
  writeEnvFileUpdates
} from "./env-content";
import {
  DEFAULT_STARTUP_SERVICE_IDS,
  getDefaultStartupServiceIds,
  getLastRunningServicesStatePath,
  getOptionalServiceIdsToRestore,
  getServiceIdsToRestore,
  INSTALL_ONLY_STARTUP_SERVICE_IDS,
  OPTIONAL_AUTO_STARTUP_SERVICE_IDS,
  isNonBlockingRestoreFailure,
  orderServiceIdsForRestore,
  readInitializationState,
  readLastRunningServices,
  writeInitializationState,
  writeLastRunningServices
} from "./state-files";
import {
  fixShellScriptPermissions,
  patchProgramCommonForLayeredLayout
} from "./program-layout";
import {
  computeAssetSignature,
  ensureArchiveHealthy,
  ensureBundleAssetHealthy,
  getOptionalBundleAssetPath,
  isInstallHealthy,
  listMissingBundleEntries,
  listMissingRuntimeFiles,
  moveExtractedBuiltinRoot,
  readBuiltinAssetSignature
} from "./bundle-assets";
import {
  buildProcessTreePids,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromWindowsPowerShell,
  type ProcessTreeRow
} from "./process-tree";
import {
  isProcessRunning,
  terminateProcessList,
  terminateProcessTree
} from "./process-cleanup";
import {
  matchProcessInstallDir,
  pidMatchesInstallDir
} from "./process-identity";
import {
  AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS,
  LEGACY_PROVIDER_APIKEY_KEY_PART,
  LEGACY_PROVIDER_APIKEY_KEY_PART_DEFAULT,
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID,
  PROCESS_EXEC_PATH_PLACEHOLDER,
  applyAgentPlatformWindowsHostShellDefaults,
  ensureLocalCliAcpRelayDesktopConfig,
  normalizeAgentContainerHubEnvContentForDesktop,
  normalizeAgentPlatformBashConfigContent,
  normalizeAgentPlatformDeprecatedConfigFiles,
  normalizeAgentPlatformEnvContentForRuntime,
  normalizeAgentPlatformEnvContentForSave,
  normalizeAgentPlatformFileToolsConfigContent,
  normalizeAgentWebclientEnvContentForDesktop,
  normalizePreservedBuiltinEnvForInstall,
  normalizeShellSourcedAgentPlatformEnvUpdates,
  resolveAcpCommandForDesktop
} from "./env-normalization";
import {
  clearContainerEngineProbeCache,
  containerEngineAvailable,
  probeContainerEngines
} from "./container-engine";
import {
  CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS,
  delay,
  getServiceVerificationDelayMs,
  normalizeProbeUrl,
  probeHttpUrl,
  type HttpProbeResult
} from "./service-probes";
import {
  CONTAINER_HUB_SERVICE_HOSTS,
  DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
  DESKTOP_MANAGED_PLATFORM_URL_PORTS,
  LOCAL_SERVICE_HOSTS,
  getServicePortEnvKeys,
  getWebUrl,
  isDesktopManagedHttpUrl,
  parsePort
} from "./service-network";
import {
  getManagedPidFilePaths,
  readManagedPidFile,
  resolveRuntimePath,
  writeManagedPidFiles
} from "./pid-files";
import {
  syncZenmindAppServerDesktopEnv
} from "./app-server-env";
import {
  TUNNEL_HUB_AGENT_SERVICE_ID,
  syncTunnelHubAgentSettingsToEnv
} from "../../tunnel-hub-agent-settings";
import {
  captureManagedProcessCleanupSnapshot,
  collectManagedRootPids,
  collectManagedServiceStopState,
  detectManagedServicePid,
  ensureManagedServiceStoppedForPlatform,
  forceStopServiceInstallDir,
  listListeningPids,
  mergeCleanupTargets
} from "./managed-cleanup";
import {
  listBuiltinSiblingInstallDirs,
  readPreservedEnvFromSiblingInstallDirs,
  reconcileBuiltinSiblingInstallDirs,
  stopBuiltinInstallDir
} from "./builtin-install";
import {
  getAgentWebclientHostState,
  isHostManagedAgentWebclientService,
  startAgentWebclientHost,
  stopAgentWebclientHost
} from "../agent-webclient-host";
import { resolveDesktopCapability } from "./capabilities";

export { getInstallDir } from "./layout";
export { fixShellScriptPermissions } from "./program-layout";
export {
  captureManagedProcessCleanupSnapshot,
  forceCleanupManagedProcesses
} from "./managed-cleanup";

const startedThisSession = new Set<ServiceId>();
const inFlightBuiltinInstalls = new Map<string, Promise<string>>();
const backgroundStartupPreparationTasks = new Set<Promise<void>>();

type ServiceLogStreamCallback = (event: ServiceLogStreamEvent) => void;

type StartupPreparationProgressPhase =
  | "pending"
  | "installing"
  | "initializing"
  | "starting"
  | "succeeded"
  | "failed"
  | "skipped";

type StartupPreparationResult = {
  mode: StartupRestoreMode;
  started: ServiceId[];
  failures: string[];
  preparedChanged: boolean;
};

type StartupPreparationOptions = {
  onModeResolved?: (mode: StartupRestoreMode) => void;
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
};

type ServiceStateReadMode = "strict" | "responsive";

type ServiceStateReadOptions = {
  mode?: ServiceStateReadMode;
  cacheContainerEngineProbe?: boolean;
};

type ServiceVerificationOptions = {
  stateReadOptions?: ServiceStateReadOptions;
  skipManagedPortProbe?: boolean;
};

const SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 2_500;
const WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS = 30_000;

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function fileExists(targetPath: string) {
  return fs.existsSync(targetPath);
}

function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
}

function removeEmptyDirectoryIfExists(targetPath: string) {
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() && fs.readdirSync(targetPath).length === 0) {
      fs.rmdirSync(targetPath);
    }
  } catch {
    // Leave non-empty or unreadable directories untouched.
  }
}

function cleanupAgentPlatformServiceDataRuntimeSkeleton(layout: ServiceLayout) {
  for (const relativePath of AGENT_PLATFORM_SERVICE_DATA_RUNTIME_SKELETON_DIRS) {
    removeEmptyDirectoryIfExists(path.join(layout.dataDir, relativePath));
  }
  removeEmptyDirectoryIfExists(layout.dataDir);
}

function isAssetNewerThanInstall(
  assetPath: string,
  layoutOrInstallDir: ServiceLayout | string,
  app?: App,
  service?: ServiceDefinition
) {
  try {
    const initStatePath = getInitializationStatePath(layoutOrInstallDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    const initializationState = readInitializationState(layoutOrInstallDir);
    if (initializationState?.assetSignature) {
      const assetSignature = app && service
        ? readBuiltinAssetSignature(app, service) ?? computeAssetSignature(assetPath)
        : computeAssetSignature(assetPath);
      return initializationState.assetSignature !== assetSignature;
    }
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

function needsBundledAssetRefresh(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  let assetPath: string;
  try {
    assetPath = ensureBundleAssetHealthy(app, service);
  } catch {
    return false;
  }

  if (!fs.existsSync(installDir)) {
    return true;
  }

  try {
    if (serviceInstallNeedsRefresh(service, installDir)) {
      return true;
    }
    return isAssetNewerThanInstall(assetPath, layout, app, service);
  } catch {
    return false;
  }
}

function installedBuiltinNeedsStartupRepair(app: App, service: ServiceDefinition, current: ServiceState) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
    return true;
  }

  const initializationState = readInitializationState(layout);
  if (
    initializationState?.status !== "succeeded" ||
    initializationState.version !== service.version
  ) {
    return true;
  }

  return shouldReinitializeMissingCoreServiceConfig(service, current);
}

const CORE_SERVICE_IDS = new Set<ServiceId>([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "zenmind-app-server"
]);
const MAX_TCP_PORT = 65535;
const AGENT_WEBCLIENT_PLATFORM_URL_KEYS = ["BASE_URL"] as const;
const AGENT_PLATFORM_SERVICE_DATA_RUNTIME_SKELETON_DIRS = [
  path.join("registries", "providers"),
  path.join("registries", "models"),
  path.join("registries", "mcp-servers"),
  path.join("registries", "viewport-servers"),
  "registries",
  "tools",
  "viewports",
  "owner",
  "agents",
  "teams",
  "root",
  "schedules",
  "automations",
  "chats",
  "memory",
  "pan",
  "skills-market"
] as const;

function isHostManagedService(service: ServiceDefinition) {
  return isHostManagedAgentWebclientService(service);
}

function collectPrerequisites(
  service: ServiceDefinition,
  layout: ServiceLayout,
  options: { cacheContainerEngineProbe?: boolean } = {}
) {
  const prerequisites: string[] = [];
  const envPath = layout.envPath;
  if (!fs.existsSync(envPath)) {
    prerequisites.push("缺少 .env 配置文件");
  }

  for (const target of service.importTargets) {
    const targetPath = resolveConfigPath(layout, target.relativePath);
    if (target.required && !fs.existsSync(targetPath)) {
      prerequisites.push(`缺少 ${target.label}`);
    }
  }

  if (service.id === TUNNEL_HUB_AGENT_SERVICE_ID) {
    const token = fs.existsSync(envPath) ? readEnvFile(envPath).get("AGENT_TOKEN")?.trim() ?? "" : "";
    if (!token) {
      prerequisites.push("Tunnel Hub Agent 缺少 AGENT_TOKEN，请先在设置中配置 token");
    }
  }

  if (service.id === "agent-container-hub") {
    const engineProbe = probeContainerEngines({ cache: options.cacheContainerEngineProbe });
    if (!engineProbe.engine) {
      const installed = engineProbe.probes.filter((probe) => probe.installed);
      if (installed.length > 0) {
        const names = installed.map((probe) => probe.engine).join(" / ");
        prerequisites.push(`${names} 已安装，但 daemon/VM 未连接，请先启动 Docker Desktop 或执行 podman machine start`);
      } else {
        prerequisites.push("未检测到 Docker 或 Podman");
      }
    }
  }

  if (false && service.id === "agent-container-hub" && !containerEngineAvailable()) {
    prerequisites.push("未检测到 Docker 或 Podman");
  }

  return prerequisites;
}

function ensureDefaultConfig(service: ServiceDefinition, layout: ServiceLayout) {
  for (const configFile of service.configFiles) {
    const targetPath = resolveConfigPath(layout, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}

function copyDirectoryEntriesIfMissing(sourceDir: string, targetDir: string) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryEntriesIfMissing(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(targetPath)) {
      continue;
    }
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function ensureAgentContainerHubDesktopConfig(layout: ServiceLayout) {
  copyDirectoryEntriesIfMissing(
    resolveConfigTemplatePath(layout, path.join("configs", "environments")),
    resolveConfigPath(layout, path.join("configs", "environments"))
  );
}

async function ensureInitializationRequirements(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, layout);
  }

  if (CORE_SERVICE_IDS.has(service.id)) {
    await syncCoreServiceDesktopInitializationConfig(app, service, layout);
    return;
  }

  if (service.id === TUNNEL_HUB_AGENT_SERVICE_ID) {
    syncTunnelHubAgentSettingsToEnv(app);
  }

  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates);
  syncCoreServiceDefaultPortEnv(service, env, updates);
  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

async function ensureMutableInstallDir(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id, { source: "ensureMutableInstallDir" });
    return getInstallDir(app, service);
  }

  throw new Error(`${service.name} 尚未导入，请先导入插件。`);
}

type InstallBuiltinServiceOptions = {
  force?: boolean;
  archivePath?: string;
  source?: string;
};

export async function installBuiltinService(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const service = getService(serviceId);
  if (service.kind !== "builtin") {
    throw new Error(`service ${serviceId} is not a builtin service`);
  }

  const installKey = createBuiltinInstallKey(app, service, options);
  const existingInstall = inFlightBuiltinInstalls.get(installKey);
  if (existingInstall) {
    return existingInstall;
  }

  const installTask = installBuiltinServiceInternal(app, serviceId, options);
  const trackedInstallTask = installTask.finally(() => {
    if (inFlightBuiltinInstalls.get(installKey) === trackedInstallTask) {
      inFlightBuiltinInstalls.delete(installKey);
    }
  });
  inFlightBuiltinInstalls.set(installKey, trackedInstallTask);
  return trackedInstallTask;
}

function createBuiltinInstallKey(app: App, service: ServiceDefinition, options: InstallBuiltinServiceOptions) {
  const appScope = (() => {
    try {
      return app.getPath("userData");
    } catch {
      return "unknown-user-data";
    }
  })();
  const assetScope = options.archivePath ? path.resolve(options.archivePath) : "bundled";
  return [
    appScope,
    service.id,
    service.version,
    options.force ? "force" : "normal",
    assetScope
  ].join("\0");
}

async function installBuiltinServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const timing = beginStartupTiming("installBuiltinService", {
    serviceId,
    force: Boolean(options.force),
    source: options.source ?? "direct"
  });
  let didExtract = false;
  const service = getService(serviceId);
  try {
    if (service.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    const assetPath = options.archivePath
      ? ensureArchiveHealthy(service, options.archivePath, "安装包")
      : ensureBundleAssetHealthy(app, service);
    const initializationAssetSignature = options.archivePath ? computeAssetSignature(assetPath) : undefined;

    const finalInstallDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, finalInstallDir);
    const needsExtract =
      options.force ||
      !fs.existsSync(finalInstallDir) ||
      !isInstallHealthy(service, finalInstallDir) ||
      serviceInstallNeedsRefresh(service, finalInstallDir) ||
      isAssetNewerThanInstall(assetPath, layout, options.archivePath ? undefined : app, service);

    const preservedEnvPath = layout.envPath;
    const hasCurrentEnv = fileExists(preservedEnvPath);
    const preservedEnvRaw = hasCurrentEnv
      ? fs.readFileSync(preservedEnvPath, "utf8")
      : readPreservedEnvFromSiblingInstallDirs(siblingInstallDirs);
    const preservedEnv = preservedEnvRaw
      ? normalizePreservedBuiltinEnvForInstall(service, preservedEnvRaw)
      : { content: "" };

    await reconcileBuiltinSiblingInstallDirs(app, service, finalInstallDir);

    if (!needsExtract) {
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    }

    const versionRoot = path.dirname(finalInstallDir);
    ensureDir(versionRoot);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${service.id}-extract-`));
    try {
      await extractArchiveToDir(assetPath, tempRoot);
      didExtract = true;
      const entries = fs.readdirSync(tempRoot);
      if (entries.length !== 1) {
        throw new Error(`unexpected archive layout for ${service.id}`);
      }
      const extractedRoot = path.join(tempRoot, entries[0]);
      if (fs.existsSync(finalInstallDir)) {
        await stopBuiltinInstallDir(service, finalInstallDir);
      }
      fs.rmSync(finalInstallDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      moveExtractedBuiltinRoot(extractedRoot, finalInstallDir);
      patchProgramCommonForLayeredLayout(finalInstallDir);
      if (preservedEnv.content) {
        ensureDir(path.dirname(layout.envPath));
        fs.writeFileSync(layout.envPath, preservedEnv.content, "utf8");
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } finally {
    timing.end({ extracted: didExtract });
  }
}

export async function initializeService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return initializeServiceInternal(app, serviceId);
}

async function initializeServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: { skipInstallRefresh?: boolean; assetSignatureOverride?: string } = {}
): Promise<ServiceCommandResult> {
  const timing = beginStartupTiming("initializeServiceInternal", {
    serviceId,
    skipInstallRefresh: Boolean(options.skipInstallRefresh)
  });
  const service = getService(serviceId);
  try {
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const currentState = await getServiceState(app, serviceId);

    if (!currentState.installed) {
      return {
        ok: false,
        message: service.kind === "plugin" ? `${service.name} 尚未导入，请先导入插件。` : `${service.name} 尚未安装。`,
        service: currentState
      };
    }

    if (!isInstallHealthy(service, installDir)) {
      return {
        ok: false,
        message: currentState.message,
        service: currentState
      };
    }

    if (!options.skipInstallRefresh && service.kind === "builtin" && serviceInstallNeedsRefresh(service, installDir)) {
      try {
        await installBuiltinService(app, service.id, { force: true, source: "initializeServiceInternal:refresh" });
      } catch (error) {
        const nextState = await getServiceState(app, serviceId);
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          service: nextState
        };
      }

      const nextState = await getServiceState(app, serviceId);
      return {
        ok: true,
        message: `${service.name} 已重新安装并初始化。`,
        service: nextState
      };
    }

    try {
      fixShellScriptPermissions(installDir);
      patchProgramCommonForLayeredLayout(layout.programDir);
      prepareServiceExecutionLayout(service, layout);
      if (service.id === "agent-container-hub") {
        ensureAgentContainerHubDesktopConfig(layout);
      }
      if (service.deployCommand) {
        await runExecFile(service.deployCommand[0], service.deployCommand.slice(1), installDir, {
          env: buildServiceLayoutEnv(layout)
        });
      }
      await ensureInitializationRequirements(app, service, layout);
      const assetSignature = options.assetSignatureOverride ?? readBuiltinAssetSignature(app, service);
      writeInitializationState(layout, {
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        ...(assetSignature ? { assetSignature } : {})
      });
    } catch (error) {
      writeInitializationState(layout, {
        version: service.version,
        status: "failed",
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
      const nextState = await getServiceState(app, serviceId);
      return {
        ok: false,
        message: nextState.message,
        service: nextState
      };
    }

    const nextState = await getServiceState(app, serviceId);
    return {
      ok: true,
      message: `${service.name} 已初始化。`,
      service: nextState
    };
  } finally {
    timing.end();
  }
}

function shouldUseResponsiveServiceState(options: ServiceStateReadOptions = {}) {
  return process.platform === "win32" && options.mode === "responsive";
}

function getResponsiveServiceStateReadOptions(): ServiceStateReadOptions {
  return process.platform === "win32" ? { mode: "responsive" } : {};
}

function getStartupServiceStateReadOptions(
  options: ServiceStateReadOptions = {}
): ServiceStateReadOptions {
  return {
    ...options,
    cacheContainerEngineProbe: true
  };
}

function getStartupResponsiveServiceStateReadOptions(): ServiceStateReadOptions {
  return getStartupServiceStateReadOptions(getResponsiveServiceStateReadOptions());
}

export async function listServices(app: App) {
  const readOptions = getResponsiveServiceStateReadOptions();
  return Promise.all(getAllServices().map((service) => getServiceState(app, service.id, readOptions)));
}

export async function getResponsiveServiceState(app: App, serviceId: ServiceId): Promise<ServiceState> {
  return getServiceState(app, serviceId, getResponsiveServiceStateReadOptions());
}

export async function getServiceState(
  app: App,
  serviceId: ServiceId,
  options: ServiceStateReadOptions = {}
): Promise<ServiceState> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const responsiveRead = shouldUseResponsiveServiceState(options);
  const installed = fs.existsSync(installDir);
  const pidFilePath = resolveRuntimePath(layout, service.runtime.pidRelativePath);
  const pidFilePaths = getManagedPidFilePaths(service, layout);
  const logFilePath = resolveRuntimePath(layout, service.runtime.logRelativePath);
  const errorLogFilePath = resolveRuntimePath(layout, service.runtime.errorLogRelativePath);
  const configFiles = service.configFiles.map((configFile) => {
    const absolutePath = resolveConfigPath(layout, configFile.relativePath);
    return {
      key: configFile.key,
      label: configFile.label,
      relativePath: configFile.relativePath,
      absolutePath,
      required: configFile.required,
      exists: fs.existsSync(absolutePath)
    };
  });

  const env = installed ? readEnvFile(layout.envPath) : new Map<string, string>();
  const port = parsePort(service, env);
  const webUrl = installed ? getWebUrl(service, env) : getWebUrl(service, new Map<string, string>());
  const pidFromFile = installed
    ? readManagedPidFile(pidFilePaths, installDir, {
        isProcessRunningImpl: isProcessRunning,
        verifyInstallDir: !responsiveRead
      })
    : null;
  const missingRuntimeFiles = installed ? listMissingRuntimeFiles(service, installDir) : [];
  const initializationState =
    installed && missingRuntimeFiles.length === 0 ? readInitializationState(layout) : null;
  const initializationSucceeded =
    initializationState?.status === "succeeded" && initializationState.version === service.version;
  const prerequisites =
    installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !responsiveRead
      ? collectPrerequisites(service, layout, {
        cacheContainerEngineProbe: options.cacheContainerEngineProbe
      })
      : [];
  const hostManaged = isHostManagedService(service);
  const hostState = hostManaged ? getAgentWebclientHostState(service.id) : null;
  const hostRunning = Boolean(
    hostManaged &&
    hostState?.running &&
    hostState.port === port
  );
  let pid = hostRunning ? process.pid : pidFromFile;
  let running = hostManaged
    ? installed && missingRuntimeFiles.length === 0 && hostRunning
    : installed && missingRuntimeFiles.length === 0 && isProcessRunning(pid);
  let conflictingPortPid: number | null = null;

  if (!hostManaged && running && pidFromFile) {
    writeManagedPidFiles(pidFilePaths, pidFromFile);
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && port > 0 && !responsiveRead) {
    if (hostManaged) {
      conflictingPortPid = listListeningPids(port).find((candidatePid) => candidatePid !== process.pid) ?? null;
    } else {
      const detectedPid = detectManagedServicePid(installDir, port);
      if (detectedPid) {
        pid = detectedPid;
        running = true;
        writeManagedPidFiles(pidFilePaths, detectedPid);
      } else {
        conflictingPortPid = listListeningPids(port).find((candidatePid) => candidatePid !== pidFromFile) ?? null;
      }
    }
  }

  let status: ServiceState["status"] = "not-installed";
  let statusLabel = "未安装";
  let message = "尚未安装到本地运行目录。";

  if (installed) {
    status = "stopped";
    statusLabel = "已停止";
    message = "服务已安装，可手动启动。";
  }

  if (installed && missingRuntimeFiles.length > 0) {
    status = "error";
    statusLabel = "安装损坏";
    message = `安装目录缺少关键文件：${missingRuntimeFiles.join(", ")}`;
  }

  if (installed && missingRuntimeFiles.length === 0 && !initializationSucceeded) {
    if (initializationState?.status === "failed" && initializationState.version === service.version) {
      status = "error";
      statusLabel = "初始化失败";
      message = initializationState.lastError ? `初始化失败：${initializationState.lastError}` : "初始化失败，请重试。";
    } else {
      status = "initialization-required";
      statusLabel = "待初始化";
      message = service.kind === "plugin" ? "插件已导入，请先完成初始化。" : "服务已安装，请先完成初始化。";
    }
  }

  if (!installed && service.kind === "builtin") {
    try {
      ensureBundleAssetHealthy(app, service);
    } catch (error) {
      status = "error";
      statusLabel = "资源损坏";
      message = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && prerequisites.length > 0) {
    const hasDependencyError = prerequisites.some((item) => item.includes("Docker") || item.includes("Podman"));
    status = hasDependencyError ? "dependency-missing" : "config-required";
    statusLabel = hasDependencyError ? "依赖未满足" : "待配置";
    message = prerequisites.join("；");
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && conflictingPortPid) {
    status = "error";
    statusLabel = "端口冲突";
    message = `端口 ${port} 已被其他进程占用（PID ${conflictingPortPid}）。`;
  }

  if (running && initializationSucceeded) {
    status = "running";
    statusLabel = "运行中";
    message = `服务进程正在运行。${webUrl ? `入口：${webUrl}` : ""}`.trim();
  }

  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    version: service.version,
    description: service.description,
    installDir,
    paths: {
      programDir: layout.programDir,
      configDir: layout.configDir,
      dataDir: layout.dataDir,
      stateDir: layout.stateDir,
      logDir: layout.logDir
    },
    installed,
    status,
    statusLabel,
    message,
    frontendMode: service.frontend.mode,
    configFiles,
    healthMeta: {
      pid,
      pidFilePath,
      logFilePath,
      errorLogFilePath,
      webUrl,
      port,
      prerequisites
    }
  };
}

function buildVerificationResult(
  service: ServiceDefinition,
  state: ServiceState,
  desired: ServiceDesiredStatus,
  probes: HttpProbeResult[] = [],
  options: Pick<ServiceVerificationOptions, "skipManagedPortProbe"> = {}
): ServiceVerification {
  const installDir = getInstallDirFromState(state);
  const pid = state.healthMeta.pid;
  const pidAlive = desired === "running" ? isProcessRunning(pid) : !pid || !isProcessRunning(pid);
  const port = state.healthMeta.port ?? 0;
  const skipManagedPortProbe =
    options.skipManagedPortProbe === true &&
    desired === "running" &&
    service.id !== "agent-container-hub";
  const hostManagedState = isHostManagedService(service) ? getAgentWebclientHostState(service.id) : null;
  const hostManagedPortPid = hostManagedState?.running && hostManagedState.port === port
    ? process.pid
    : null;
  const listeningPids = port > 0 && !skipManagedPortProbe && !hostManagedPortPid ? listListeningPids(port) : [];
  const managedPortPid = hostManagedPortPid ?? (skipManagedPortProbe
    ? null
    : listeningPids.find((candidatePid) => (
      installDir ? pidMatchesInstallDir(candidatePid, installDir) : true
    )) ?? null);
  const portListening = hostManagedPortPid
    ? true
    : skipManagedPortProbe
    ? state.status === "running"
    : port > 0 ? Boolean(managedPortPid) : desired === "running";
  const httpProbe = probes.find((probe) => probe.target === state.healthMeta.webUrl);
  const runtimeInfoProbe = probes.find((probe) => probe.target.includes("/api/runtime-info"));
  const issues: string[] = [];

  if (desired === "running") {
    if (state.status !== "running") {
      issues.push(`复查后服务状态仍为 ${state.status}`);
    }
    if (pid && !isProcessRunning(pid)) {
      issues.push(`PID ${pid} 已不存在`);
    }
    if (!pid) {
      issues.push("没有读取到有效 PID");
    }
    if (service.id === "agent-container-hub") {
      if (port > 0 && !managedPortPid) {
        issues.push(`端口 ${port} 无受管进程监听`);
      }
      if (httpProbe && !httpProbe.ok) {
        issues.push(`${httpProbe.target} 探测失败：${httpProbe.message || "HTTP 不可用"}`);
      }
      if (runtimeInfoProbe) {
        const looksJson = /application\/json/iu.test(runtimeInfoProbe.contentType || "")
          || /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "");
        if (!runtimeInfoProbe.ok || !looksJson) {
          issues.push(runtimeInfoProbe.ok
            ? `HTTP ${runtimeInfoProbe.statusCode} 但 /api/runtime-info 返回的不是 JSON`
            : `/api/runtime-info 探测失败：${runtimeInfoProbe.message || "HTTP 不可用"}`);
        }
      } else {
        issues.push("缺少 /api/runtime-info 验证结果");
      }
    }
  } else {
    if (state.status === "running") {
      issues.push("复查后服务仍处于 running");
    }
    if (pid && isProcessRunning(pid)) {
      issues.push(`PID ${pid} 仍在运行`);
    }
    if (port > 0 && managedPortPid) {
      issues.push(`端口 ${port} 仍被受管进程 PID ${managedPortPid} 监听`);
    }
  }

  const baseVerified = desired === "running"
    ? state.status === "running" && pidAlive
    : state.status !== "running" && pidAlive && !managedPortPid;
  const strictVerified = service.id === "agent-container-hub" && desired === "running"
    ? baseVerified && portListening && probes.every((probe) => probe.ok) && Boolean(runtimeInfoProbe)
    : baseVerified;

  return {
    verified: strictVerified && issues.length === 0,
    desired,
    actualStatus: state.status,
    pidAlive,
    portListening,
    managedPortPid,
    httpOk: httpProbe ? httpProbe.ok : null,
    runtimeInfoOk: runtimeInfoProbe ? runtimeInfoProbe.ok && (
      /application\/json/iu.test(runtimeInfoProbe.contentType || "") ||
      /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "")
    ) : null,
    checkedAt: new Date().toISOString(),
    issues,
    probes: probes.map((probe) => ({
      target: probe.target,
      ok: probe.ok,
      statusCode: probe.statusCode,
      contentType: probe.contentType,
      message: probe.message
    }))
  };
}

function getInstallDirFromState(state: ServiceState) {
  return state.installDir || "";
}

function hasVerifyRunningRequirements(service: ServiceDefinition) {
  return service.desktop.capabilities.requires.some((requirement) => requirement.phase === "verifyRunning");
}

function getDependencyRunningVerificationTimeoutMs() {
  const raw = Number.parseInt(process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS;
}

async function collectServiceVerification(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus,
  options: ServiceVerificationOptions = {}
): Promise<{ state: ServiceState; verification: ServiceVerification }> {
  const service = getService(serviceId);
  const state = await getServiceState(app, serviceId, options.stateReadOptions);
  const probes: HttpProbeResult[] = [];

  if (desired === "running" && state.status === "running" && state.healthMeta.webUrl) {
    const webUrl = state.healthMeta.webUrl;
    probes.push(await probeHttpUrl(webUrl));
    if (service.id === "agent-container-hub") {
      probes.push(await probeHttpUrl(normalizeProbeUrl(webUrl, "/api/runtime-info")));
    }
  }

  const layout = getServiceLayout(app, service);
  const baseVerification = buildVerificationResult(service, state, desired, probes, options);
  if (desired !== "running" || state.status !== "running") {
    return {
      state,
      verification: baseVerification
    };
  }

  const requirementIssues = await collectDesktopCapabilityRequirementIssues(
    app,
    service,
    layout,
    "verifyRunning",
    options
  );
  if (requirementIssues.length === 0) {
    return {
      state,
      verification: baseVerification
    };
  }

  return {
    state,
    verification: {
      ...baseVerification,
      verified: false,
      issues: [...baseVerification.issues, ...requirementIssues]
    }
  };
}

export async function verifyServiceState(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus,
  options: ServiceVerificationOptions = {}
): Promise<ServiceVerification> {
  const timing = beginStartupTiming("verifyServiceState", { serviceId, desired });
  let verified = false;
  try {
    const delayMs = getServiceVerificationDelayMs();
    const service = getService(serviceId);
    const retryUntil =
      service.id === "agent-container-hub" && desired === "running"
        ? Date.now() + CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS
        : hasVerifyRunningRequirements(service) && desired === "running"
        ? Date.now() + getDependencyRunningVerificationTimeoutMs()
        : 0;
    let current = await collectServiceVerification(app, serviceId, desired, options);
    if (current.verification.verified && delayMs <= 0) {
      verified = true;
      return current.verification;
    }

    do {
      await delay(delayMs > 0 ? delayMs : 1500);
      current = await collectServiceVerification(app, serviceId, desired, options);
      if (current.verification.verified) {
        verified = true;
        return current.verification;
      }
    } while (
      retryUntil > 0 &&
      Date.now() < retryUntil &&
      shouldRetryServiceVerification(service, desired, current.verification)
    );

    verified = current.verification.verified;
    return current.verification;
  } finally {
    timing.end({ verified });
  }
}

function serviceVerificationFailureMessage(actionMessage: string, verification: ServiceVerification) {
  const issues = verification.issues.length > 0 ? verification.issues.join("；") : `状态为 ${verification.actualStatus}`;
  return `${actionMessage}，但复查失败：${issues}`;
}

function shouldRetryServiceVerification(
  service: ServiceDefinition,
  desired: ServiceDesiredStatus,
  verification: ServiceVerification
) {
  const retriesContainerHub =
    service.id === "agent-container-hub" &&
    desired === "running" &&
    !verification.verified &&
    verification.actualStatus === "running" &&
    verification.pidAlive;
  const retriesVerifyRunningRequirements =
    hasVerifyRunningRequirements(service) &&
    desired === "running" &&
    !verification.verified &&
    verification.actualStatus === "running" &&
    verification.pidAlive;
  return retriesContainerHub || retriesVerifyRunningRequirements;
}

async function attachServiceVerification(
  app: App,
  serviceId: ServiceId,
  result: ServiceCommandResult,
  desired: ServiceDesiredStatus,
  actionMessage: string,
  options: ServiceVerificationOptions = {}
): Promise<ServiceCommandResult> {
  const verification = await verifyServiceState(app, serviceId, desired, options);
  const service = await getServiceState(app, serviceId, options.stateReadOptions);
  if (!verification.verified) {
    return {
      ...result,
      ok: false,
      message: serviceVerificationFailureMessage(actionMessage, verification),
      service,
      verification
    };
  }
  return {
    ...result,
    ok: true,
    service,
    verification
  };
}

function renderEnvBindingTemplate(value: string, values: Record<string, string>) {
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

function getEnvBindingTemplateValues(app: App, service: ServiceDefinition) {
  const layout = getServiceLayout(app, service);
  return {
    "service.programDir": layout.programDir,
    "service.configDir": layout.configDir,
    "service.dataDir": layout.dataDir,
    "service.stateDir": layout.stateDir,
    "service.logDir": layout.logDir,
    "service.envPath": layout.envPath,
    serviceDefaultPort: String(service.web.defaultPort)
  };
}

function getEnvBindingDefaultValues(
  app: App,
  service: ServiceDefinition,
  binding: ServiceDefinition["desktop"]["envBindings"][number]
) {
  const values = getEnvBindingTemplateValues(app, service);
  return (binding.defaults ?? [""]).map((item) => renderEnvBindingTemplate(item, values));
}

function resolveEnvBindingLiteralValue(app: App, service: ServiceDefinition, value: string) {
  return renderEnvBindingTemplate(value, getEnvBindingTemplateValues(app, service));
}

async function applyEnvBindings(app: App, service: ServiceDefinition, env: Map<string, string>, updates: Map<string, string>) {
  for (const binding of service.desktop.envBindings) {
    const bindingKey = binding.key;
    if (service.id === "agent-webclient" && AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS.has(bindingKey)) {
      continue;
    }
    const currentValue = env.get(bindingKey) ?? "";

    if (binding.onlyIfDefault) {
      const defaults = new Set(getEnvBindingDefaultValues(app, service, binding));
      if (!defaults.has(currentValue)) {
        continue;
      }
    }

    if (binding.fromService && binding.template) {
      try {
        const depState = await getServiceState(app, binding.fromService);
        const port = depState.healthMeta.port ?? 0;
        const resolved = binding.template.replace("{{port}}", String(port));
        updates.set(bindingKey, resolved);
      } catch {
        // Dependency service not registered; skip this binding.
      }
      continue;
    }

    if (binding.value !== undefined) {
      if (
        bindingKey === "NODE_BIN" &&
        binding.value.trim() === PROCESS_EXEC_PATH_PLACEHOLDER &&
        NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)
      ) {
        continue;
      }
      const resolved = resolveEnvBindingLiteralValue(app, service, binding.value);
      updates.set(bindingKey, resolved);
    }
  }
}

function getEnvValueWithUpdates(env: Map<string, string>, updates: Map<string, string>, key: string) {
  return updates.get(key) ?? env.get(key) ?? "";
}

function resolveAgentPlatformEnvPath(app: App, value: string) {
  return path.resolve(expandHomeShortcut(value, resolveHomeDir(app)));
}

function resolveAgentPlatformProviderRegistryDir(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  fallbackRuntimeRoot: string
) {
  const registriesDir = getEnvValueWithUpdates(env, updates, "REGISTRIES_DIR").trim();
  if (registriesDir) {
    return path.join(resolveAgentPlatformEnvPath(app, registriesDir), "providers");
  }

  const runtimeRoot = getEnvValueWithUpdates(env, updates, "RUNTIME_DIR").trim();
  const resolvedRuntimeRoot = runtimeRoot
    ? resolveAgentPlatformEnvPath(app, runtimeRoot)
    : fallbackRuntimeRoot;
  return path.join(resolvedRuntimeRoot, "registries", "providers");
}

function providerRegistryHasAesWrappedApiKey(providersDir: string) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(providersDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .some((entry) => {
      const providerPath = path.join(providersDir, entry.name);
      const content = fs.readFileSync(providerPath, "utf8");
      return /^(?!\s*#)\s*apiKey\s*:\s*['"]?AES\(/imu.test(content);
    });
}

function syncAgentPlatformProviderApiKeyEnvPart(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  fallbackRuntimeRoot: string
) {
  if (getEnvValueWithUpdates(env, updates, LEGACY_PROVIDER_APIKEY_KEY_PART).trim()) {
    return false;
  }

  const providersDir = resolveAgentPlatformProviderRegistryDir(app, env, updates, fallbackRuntimeRoot);
  if (!providerRegistryHasAesWrappedApiKey(providersDir)) {
    return false;
  }

  updates.set(LEGACY_PROVIDER_APIKEY_KEY_PART, LEGACY_PROVIDER_APIKEY_KEY_PART_DEFAULT);
  return true;
}

function resolveEnvBindingValue(service: ServiceDefinition, bindingKey: string) {
  const binding = service.desktop.envBindings.find((item) => {
    return item.key === bindingKey && item.value !== undefined;
  });
  if (!binding?.value) {
    return String(service.web.defaultPort);
  }
  return binding.value.replace("{{serviceDefaultPort}}", String(service.web.defaultPort));
}

function canApplyDefaultEnvBinding(service: ServiceDefinition, bindingKey: string, currentValue: string) {
  const binding = service.desktop.envBindings.find((item) => {
    return item.key === bindingKey && item.value !== undefined;
  });
  if (!binding) {
    return false;
  }
  if (!binding.onlyIfDefault) {
    return true;
  }
  return new Set(binding.defaults ?? [""]).has(currentValue);
}

function syncCoreServiceDefaultPortEnv(
  service: ServiceDefinition,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  if (!CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  for (const key of getServicePortEnvKeys(service)) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (!options.force && !canApplyDefaultEnvBinding(service, key, currentValue)) {
      continue;
    }
    updates.set(key, resolveEnvBindingValue(service, key));
  }
}

function isDesktopManagedContainerHubUrl(value: string) {
  return isDesktopManagedHttpUrl(
    value,
    DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
    CONTAINER_HUB_SERVICE_HOSTS,
    true
  );
}

function addManagedUrlPort(ports: Set<string>, port: number | null | undefined) {
  if (port && port > 0 && port <= MAX_TCP_PORT) {
    ports.add(String(port));
  }
}

function isDesktopManagedPlatformUrl(
  value: string,
  currentPlatformPort: number | null,
  additionalManagedPorts: Array<number | null | undefined> = []
) {
  const managedPorts = new Set(DESKTOP_MANAGED_PLATFORM_URL_PORTS);
  addManagedUrlPort(managedPorts, currentPlatformPort);
  for (const port of additionalManagedPorts) {
    addManagedUrlPort(managedPorts, port);
  }
  return isDesktopManagedHttpUrl(value, managedPorts, LOCAL_SERVICE_HOSTS);
}

async function getServicePortForEnvSync(app: App, serviceId: ServiceId) {
  try {
    const state = await getServiceState(app, serviceId);
    return state.healthMeta.port ?? getService(serviceId).web.defaultPort;
  } catch {
    try {
      return getService(serviceId).web.defaultPort;
    } catch {
      return null;
    }
  }
}

async function syncAgentPlatformContainerHubUrl(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  if (!hubPort) {
    return;
  }

  const currentValue = getEnvValueWithUpdates(env, updates, "CONTAINER_HUB_BASE_URL");
  if (!options.force && currentValue && !isDesktopManagedContainerHubUrl(currentValue)) {
    return;
  }

  updates.set("CONTAINER_HUB_BASE_URL", `http://127.0.0.1:${hubPort}`);
}

function syncAgentWebclientPlatformUrlsToPort(
  env: Map<string, string>,
  updates: Map<string, string>,
  platformPort: number | null,
  additionalManagedPorts: Array<number | null | undefined> = [],
  options: { force?: boolean } = {}
) {
  if (!platformPort) {
    return;
  }

  const platformUrl = `http://127.0.0.1:${platformPort}`;
  for (const key of AGENT_WEBCLIENT_PLATFORM_URL_KEYS) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (!options.force && currentValue && !isDesktopManagedPlatformUrl(currentValue, platformPort, additionalManagedPorts)) {
      continue;
    }
    updates.set(key, platformUrl);
  }
}

async function syncAgentWebclientPlatformUrls(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  const platformPort = await getServicePortForEnvSync(app, "agent-platform");
  syncAgentWebclientPlatformUrlsToPort(env, updates, platformPort, [], options);
}

async function syncCoreServiceDesktopInitializationConfig(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  if (service.id === "agent-container-hub") {
    ensureAgentContainerHubDesktopConfig(layout);
  }

  const envPath = layout.envPath;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (service.id === "agent-container-hub") {
    const normalizedContent = normalizeAgentContainerHubEnvContentForDesktop(content);
    if (normalizedContent !== content) {
      ensureDir(path.dirname(envPath));
      fs.writeFileSync(envPath, normalizedContent, "utf8");
      content = normalizedContent;
    }
  }
  if (service.id === "agent-webclient") {
    const normalizedContent = normalizeAgentWebclientEnvContentForDesktop(content);
    if (normalizedContent !== content) {
      ensureDir(path.dirname(envPath));
      fs.writeFileSync(envPath, normalizedContent, "utf8");
      content = normalizedContent;
    }
  }

  const env = parseEnvFileContent(content);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates);
  syncCoreServiceDefaultPortEnv(service, env, updates, { force: true });

  if (service.id === "zenmind-app-server") {
    syncZenmindAppServerDesktopEnv(layout, content, updates);
  }

  if (service.id === "agent-platform") {
    await syncAgentPlatformContainerHubUrl(app, env, updates, { force: true });
    const runtimeRoot = resolveAgentPlatformInitializationRuntimeRoot(app);
    updates.set("RUNTIME_DIR", formatDesktopAgentPlatformRuntimeRoot(app, runtimeRoot));
  }

  if (service.id === "agent-webclient") {
    await syncAgentWebclientPlatformUrls(app, env, updates, { force: true });
  }

  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates, {
      uncommentExisting: service.id === "agent-platform"
    });
  }

  await applyDesktopCapabilityRequirements(app, service, layout, "preStart");
  if (service.id === "agent-platform") {
    cleanupAgentPlatformServiceDataRuntimeSkeleton(layout);
  }
}

function shouldReinitializeMissingCoreServiceConfig(service: ServiceDefinition, state: ServiceState) {
  return (
    service.kind === "builtin" &&
    CORE_SERVICE_IDS.has(service.id) &&
    state.status === "config-required" &&
    state.configFiles.some((configFile) => configFile.required && !configFile.exists)
  );
}

async function ensureAgentPlatformContainerHubDependency(app: App, layout: ServiceLayout) {
  let hubService: ServiceDefinition;
  try {
    hubService = getService("agent-container-hub");
  } catch {
    return;
  }

  const env = readEnvFile(layout.envPath);
  const baseURL = env.get("CONTAINER_HUB_BASE_URL")?.trim() ?? "";
  if (!isDesktopManagedContainerHubUrl(baseURL)) {
    return;
  }

  const hubState = await getServiceState(app, hubService.id);
  if (hubState.status === "running") {
    return;
  }
  if (hubState.status === "not-installed") {
    return;
  }

  // Container Hub powers optional sandbox/runtime metadata. agent-platform can
  // start without it and falls back internally, so the Desktop default startup
  // must not install or start it as a hard dependency.
  console.warn(
    `[service-manager] Container Hub is not running (${hubState.status}); starting agent-platform without it.`
  );
}

function getCapabilityRequirementAction(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.action) {
    return requirement.action;
  }
  return requirement.capability ? "preload" : "waitHttp";
}

function describeCapabilityRequirement(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.capability) {
    return `capability ${requirement.capability}`;
  }
  return `service ${requirement.service ?? "(unknown)"}`;
}

function getDefaultRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string) {
  if (requiredService.id === "agent-platform" || requiredService.id === "agent-container-hub") {
    return normalizeProbeUrl(webUrl, "/api/runtime-info");
  }
  return webUrl;
}

function resolveRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string, target: string | undefined) {
  const trimmed = target?.trim() ?? "";
  if (!trimmed) {
    return getDefaultRequirementHttpTarget(requiredService, webUrl);
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return trimmed;
  }
  return normalizeProbeUrl(webUrl, trimmed);
}

function resolveAgentPlatformReadinessFallbackTarget(
  requiredServiceId: string,
  target: string,
  probe: Pick<HttpProbeResult, "statusCode">
) {
  if (requiredServiceId !== "agent-platform" || probe.statusCode !== 404) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.pathname !== "/api/runtime-info") {
    return null;
  }
  return normalizeProbeUrl(target, "/api/agents");
}

async function ensureRequiredServiceHttpReachable(
  app: App,
  requirement: ManifestDesktopCapabilityRequirement,
  options: ServiceVerificationOptions = {}
) {
  const requiredServiceId = requirement.service as ServiceId | undefined;
  if (!requiredServiceId) {
    throw new Error("HTTP dependency requirement missing service id.");
  }

  let requiredService: ServiceDefinition;
  try {
    requiredService = getService(requiredServiceId);
  } catch {
    throw new Error(`missing required service provider: ${requiredServiceId}`);
  }

  const state = await getServiceState(app, requiredService.id, options.stateReadOptions);
  if (state.status !== "running") {
    throw new Error(`${requiredService.name} is ${state.status}.`);
  }

  const webUrl = state.healthMeta.webUrl;
  if (!webUrl) {
    throw new Error(`${requiredService.name} does not expose a Desktop web URL.`);
  }

  const target = resolveRequirementHttpTarget(requiredService, webUrl, requirement.target);
  const authCapability = requirement.authCapability?.trim() ?? "";
  const authResult = authCapability
    ? await resolveDesktopCapability(app, authCapability, {
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService);
      }
    })
    : null;
  const authToken = authResult?.token || authResult?.text || "";
  const probe = await probeHttpUrl(target, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  });
  if (!probe.ok) {
    const fallbackTarget = resolveAgentPlatformReadinessFallbackTarget(requiredService.id, target, probe);
    if (fallbackTarget) {
      const fallbackProbe = await probeHttpUrl(fallbackTarget, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });
      if (fallbackProbe.ok) {
        return;
      }
      throw new Error(
        `${target} 探测失败：${probe.message || "HTTP 不可用"}；` +
        `${fallbackTarget} 探测失败：${fallbackProbe.message || "HTTP 不可用"}`
      );
    }
    throw new Error(`${target} 探测失败：${probe.message || "HTTP 不可用"}`);
  }
}

async function applyDesktopCapabilityRequirement(
  app: App,
  _service: ServiceDefinition,
  layout: ServiceLayout,
  requirement: ManifestDesktopCapabilityRequirement,
  options: ServiceVerificationOptions = {}
) {
  const action = getCapabilityRequirementAction(requirement);

  if (requirement.capability) {
    if (action === "waitHttp") {
      throw new Error(`${describeCapabilityRequirement(requirement)} cannot use waitHttp.`);
    }
    const result = await resolveDesktopCapability(app, requirement.capability, {
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService);
      }
    });

    if (action === "copyFile") {
      if (!requirement.target) {
        throw new Error(`${describeCapabilityRequirement(requirement)} copyFile missing target.`);
      }
      if (!result.filePath) {
        throw new Error(`${describeCapabilityRequirement(requirement)} did not produce file output.`);
      }
      const targetPath = resolveConfigPath(layout, requirement.target);
      const nextContent = result.text ?? fs.readFileSync(result.filePath, "utf8");
      ensureDir(path.dirname(targetPath));
      const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      if (currentContent !== nextContent) {
        fs.writeFileSync(targetPath, nextContent, "utf8");
      }
      return;
    }

    if (action !== "preload") {
      throw new Error(`${describeCapabilityRequirement(requirement)} unsupported action ${action}.`);
    }
    return;
  }

  if (requirement.service) {
    if (action !== "waitHttp") {
      throw new Error(`${describeCapabilityRequirement(requirement)} must use waitHttp.`);
    }
    await ensureRequiredServiceHttpReachable(app, requirement, options);
    return;
  }

  throw new Error("Desktop capability requirement missing capability or service.");
}

async function applyDesktopCapabilityRequirements(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  phase: ManifestDesktopCapabilityPhase,
  options: ServiceVerificationOptions = {}
) {
  const requirements = service.desktop.capabilities.requires.filter((requirement) => requirement.phase === phase);
  for (const requirement of requirements) {
    await applyDesktopCapabilityRequirement(app, service, layout, requirement, options);
  }
}

async function collectDesktopCapabilityRequirementIssues(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  phase: ManifestDesktopCapabilityPhase,
  options: ServiceVerificationOptions = {}
) {
  const issues: string[] = [];
  const requirements = service.desktop.capabilities.requires.filter((requirement) => requirement.phase === phase);
  for (const requirement of requirements) {
    try {
      await applyDesktopCapabilityRequirement(app, service, layout, requirement, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${describeCapabilityRequirement(requirement)} 未就绪：${message}`);
    }
  }
  return issues;
}

async function ensureAgentPlatformDesktopConfig(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  normalizeAgentPlatformDeprecatedConfigFiles(layout);

  const envPath = layout.envPath;
  const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const normalizedContent = normalizeAgentPlatformEnvContentForRuntime(currentContent, layout);
  if (normalizedContent !== currentContent) {
    ensureDir(path.dirname(envPath));
    fs.writeFileSync(envPath, normalizedContent, "utf8");
  }
  const env = parseEnvFileContent(normalizedContent);
  const updates = new Map<string, string>();

  await applyEnvBindings(app, service, env, updates);
  await syncAgentPlatformContainerHubUrl(app, env, updates);

  applyAgentPlatformWindowsHostShellDefaults(env, updates);

  const desktopRuntimeRoot = resolvePreferredAgentPlatformRuntimeRoot(app);
  if (!hasConfiguredAgentPlatformRuntimePath(env)) {
    updates.set("RUNTIME_DIR", formatDesktopAgentPlatformRuntimeRoot(app, desktopRuntimeRoot));
  }

  syncAgentPlatformProviderApiKeyEnvPart(app, env, updates, desktopRuntimeRoot);

  if (updates.size > 0) {
    normalizeShellSourcedAgentPlatformEnvUpdates(updates);
    writeEnvFileUpdates(envPath, updates);
  }

  cleanupAgentPlatformServiceDataRuntimeSkeleton(layout);
}

async function ensurePreStartRequirements(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  prepareServiceExecutionLayout(service, layout);
  patchProgramCommonForLayeredLayout(layout.programDir);

  if (service.id === "agent-platform") {
    await ensureAgentPlatformDesktopConfig(app, service, layout);
    await ensureDesktopRegisterApiKey(app);
    await ensureAgentPlatformContainerHubDependency(app, layout);
  }

  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, layout);
  }

  if (service.id === TUNNEL_HUB_AGENT_SERVICE_ID) {
    syncTunnelHubAgentSettingsToEnv(app);
  }

  if (service.id === "agent-webclient") {
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = agentWebclientInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, layout, app, service))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh,
        source: "ensurePreStartRequirements:agent-webclient-refresh"
      });
    }
  }

  if (service.id === "zenmind-app-server") {
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = zenmindAppServerInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, layout, app, service))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh,
        source: "ensurePreStartRequirements:app-server-refresh"
      });
    }
  }

  if (service.id === "zenmind-app-server") {
    const envPath = layout.envPath;
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const env = parseEnvFileContent(content);
    const updates = new Map<string, string>();
    syncCoreServiceDefaultPortEnv(service, env, updates, { force: true });
    syncZenmindAppServerDesktopEnv(layout, content, updates);
    if (updates.size > 0) {
      writeEnvFileUpdates(envPath, updates);
    }
  }

  await applyDesktopCapabilityRequirements(app, service, layout, "preStart");
}

type RunServiceCommandOptions = {
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stateReadOptions?: ServiceStateReadOptions;
};

type StartServiceOptions = {
  skipPreStartRequirements?: boolean;
  skipBuiltinAssetRefresh?: boolean;
  stateReadOptions?: ServiceStateReadOptions;
  commandStateReadOptions?: ServiceStateReadOptions;
  verificationOptions?: ServiceVerificationOptions;
};

function getPreparedStartupStartOptions(): StartServiceOptions {
  const stateReadOptions = getStartupServiceStateReadOptions();
  const responsiveReadOptions = getStartupResponsiveServiceStateReadOptions();
  return {
    skipPreStartRequirements: true,
    skipBuiltinAssetRefresh: true,
    stateReadOptions,
    commandStateReadOptions: responsiveReadOptions,
    verificationOptions: {
      stateReadOptions: responsiveReadOptions,
      skipManagedPortProbe: true
    }
  };
}

function yieldStartupScheduler() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const NODE_BIN_START_ENV_SERVICE_IDS = new Set<ServiceId>([
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID
]);

function resolveNodeBinStartEnv() {
  const nodeBin = resolveNodeBin();
  const env: Record<string, string> = { NODE_BIN: nodeBin };
  if (nodeBin === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function getStartCommandEnvOverrides(_app: App, service: ServiceDefinition) {
  if (!NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)) {
    return undefined;
  }

  return resolveNodeBinStartEnv();
}

function getDesktopStartCommandOptions(app: App, service: ServiceDefinition): RunServiceCommandOptions {
  return {
    refreshBuiltinAsset: false,
    env: getStartCommandEnvOverrides(app, service)
  };
}

function buildDesktopServiceCommandEnv(
  app: App,
  layout: ServiceLayout,
  overrides: NodeJS.ProcessEnv | undefined
) {
  return {
    ...buildServiceLayoutEnv(layout),
    ...(overrides ?? {}),
    DESKTOP_DEVICE_ID: getDesktopDeviceId(app)
  };
}

function isDaemonStartArg(value: string) {
  return value.trim().toLowerCase() === "--daemon" || value.trim().toLowerCase() === "-daemon";
}

function getDesktopStartCommand(service: Pick<ServiceDefinition, "id" | "kind" | "startCommand">) {
  if (
    service.kind !== "builtin" ||
    !CORE_SERVICE_IDS.has(service.id) ||
    service.startCommand.some(isDaemonStartArg)
  ) {
    return service.startCommand;
  }

  return [...service.startCommand, "--daemon"];
}

async function runServiceCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  successMessage: string,
  options: RunServiceCommandOptions = {}
) {
  const timing = beginStartupTiming("runServiceCommand", {
    serviceId: service.id,
    command: command[0] ? path.basename(command[0]) : "none",
    args: command.slice(1).join(",") || "none"
  });
  const installDir = getInstallDir(app, service);
  try {
    const shouldRefreshBuiltinAsset = options.refreshBuiltinAsset !== false;
    if (service.kind === "builtin" && shouldRefreshBuiltinAsset) {
      const assetPath = getOptionalBundleAssetPath(app, service);
      if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
        if (!assetPath) {
          throw new Error(`${service.name} 未安装或安装已损坏。`);
        }
        await installBuiltinService(app, service.id, { source: "runServiceCommand:missing-install" });
      } else if (assetPath && isAssetNewerThanInstall(assetPath, getServiceLayout(app, service), app, service)) {
        await installBuiltinService(app, service.id, { source: "runServiceCommand:asset-newer" });
      }
    } else if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      throw new Error(`${service.name} 未安装或安装已损坏。`);
    }

    if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      if (service.kind !== "builtin") {
        throw new Error(`${service.name} 未安装或安装已损坏。`);
      }
      if (!shouldRefreshBuiltinAsset) {
        throw new Error(`${service.name} 未安装或安装已损坏。`);
      }
      ensureBundleAssetHealthy(app, service);
      await installBuiltinService(app, service.id, { source: "runServiceCommand:repair-install" });
    }
    if (command.length === 0) {
      throw new Error(`${service.name} 缺少可执行脚本定义。`);
    }
    const layout = getServiceLayout(app, service);
    prepareServiceExecutionLayout(service, layout);
    await runExecFile(command[0], command.slice(1), installDir, {
      timeoutMs: options.timeoutMs,
      env: buildDesktopServiceCommandEnv(app, layout, options.env)
    });
    return {
      ok: true,
      message: successMessage,
      service: await getServiceState(app, service.id, options.stateReadOptions)
    } satisfies ServiceCommandResult;
  } finally {
    timing.end();
  }
}

async function startServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: StartServiceOptions = {}
): Promise<ServiceCommandResult> {
  const current = await getServiceState(app, serviceId, options.stateReadOptions);
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const shouldRefreshFromBundledAsset =
    service.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    needsBundledAssetRefresh(app, service);

  if (shouldRefreshFromBundledAsset) {
    if (current.status === "running") {
      await stopService(app, serviceId);
    }
    await installBuiltinService(app, serviceId, { source: "startServiceInternal:bundled-asset-refresh" });
  }

  const refreshedState = shouldRefreshFromBundledAsset
    ? await getServiceState(app, serviceId, options.stateReadOptions)
    : current;
  const initializationState = refreshedState.installed ? readInitializationState(getServiceLayout(app, service)) : null;
  let preparedState = refreshedState;

  if (shouldReinitializeMissingCoreServiceConfig(service, preparedState)) {
    const initialization = await initializeServiceInternal(app, serviceId, { skipInstallRefresh: true });
    if (!initialization.ok) {
      return initialization;
    }
    preparedState = initialization.service;
  }

  if (preparedState.status === "initialization-required") {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (initializationState?.status === "failed" && initializationState.version === service.version) {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (
    preparedState.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    (!preparedState.installed || (preparedState.status === "error" && !isInstallHealthy(service, installDir)))
  ) {
    await installBuiltinService(app, serviceId, { source: "startServiceInternal:asset-refresh" });
  }
  const nextState = await getServiceState(app, serviceId, options.stateReadOptions);
  if (
    nextState.status === "config-required" ||
    nextState.status === "dependency-missing" ||
    nextState.status === "error"
  ) {
    return {
      ok: false,
      message: nextState.message,
      service: nextState
    };
  }
  let result: ServiceCommandResult;
  if (nextState.status === "running") {
    result = {
      ok: true,
      message: `${nextState.name} 已在运行。`,
      service: nextState
    };
  } else {
    if (!options.skipPreStartRequirements) {
      await ensurePreStartRequirements(app, service);
    }
    const preStartState = await getServiceState(app, serviceId, options.stateReadOptions);
    if (
      preStartState.status === "config-required" ||
      preStartState.status === "dependency-missing" ||
      preStartState.status === "error"
    ) {
      return {
        ok: false,
        message: preStartState.message,
        service: preStartState
      };
    }
    if (preStartState.status === "running") {
      result = {
        ok: true,
        message: `${preStartState.name} 已在运行。`,
        service: preStartState
      };
    } else {
      if (isHostManagedService(service)) {
        const layout = getServiceLayout(app, service);
        const env = readEnvFile(layout.envPath);
        const port = parsePort(service, env);
        await startAgentWebclientHost({
          service,
          layout,
          env,
          port,
          issueAccessToken: (reason) => issueAgentAccessToken(app, reason)
        });
        result = {
          ok: true,
          message: `${service.name} 已启动。`,
          service: await getServiceState(app, service.id, options.commandStateReadOptions ?? options.stateReadOptions)
        };
      } else {
        result = await runServiceCommand(
          app,
          service,
          getDesktopStartCommand(service),
          `${service.name} 已启动。`,
          {
            ...getDesktopStartCommandOptions(app, service),
            stateReadOptions: options.commandStateReadOptions ?? options.stateReadOptions
          }
        );
      }
      startedThisSession.add(serviceId);
    }
  }

  const verifiedResult = await attachServiceVerification(
    app,
    serviceId,
    result,
    "running",
    `${service.name} 启动命令已执行`,
    options.verificationOptions
  );
  return verifiedResult;
}

export async function startService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return startServiceInternal(app, serviceId);
}

export async function stopService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId);
  if (!current.installed) {
    return {
      ok: true,
      message: `${service.name} 尚未安装。`,
      service: current
    };
  }
  if (current.status !== "running") {
    return {
      ok: true,
      message: `${service.name} 当前未运行。`,
      service: current
    };
  }

  if (isHostManagedService(service)) {
    await stopAgentWebclientHost(service.id);
    startedThisSession.delete(serviceId);
    const result = {
      ok: true,
      message: `${service.name} 已停止。`,
      service: await getServiceState(app, serviceId)
    } satisfies ServiceCommandResult;
    return attachServiceVerification(app, serviceId, result, "stopped", `${service.name} 停止命令已执行`);
  }

  const result = await runServiceCommand(app, service, service.stopCommand, `${service.name} 已停止。`, {
    refreshBuiltinAsset: false
  });
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const envPath = layout.envPath;
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  const stopVerification = ensureManagedServiceStoppedForPlatform(service, layout, env);
  if (!stopVerification.ok) {
    throw new Error(stopVerification.message);
  }
  startedThisSession.delete(serviceId);

  return attachServiceVerification(app, serviceId, result, "stopped", `${service.name} 停止命令已执行`);
}

async function runServiceRestart(
  stopOperation: () => Promise<ServiceCommandResult>,
  startOperation: () => Promise<ServiceCommandResult>
) {
  await stopOperation();
  return startOperation();
}

export async function restartService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return runServiceRestart(
    () => stopService(app, serviceId),
    () => startService(app, serviceId)
  );
}

export async function readServiceConfig(app: App, serviceId: ServiceId, key: string): Promise<ServiceConfigReadResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const filePath = resolveConfigPath(layout, configFile.relativePath);
  if (!fs.existsSync(installDir)) {
    return {
      ok: true,
      path: filePath,
      content: "",
      exists: false,
      source: "missing"
    };
  }

  if (fs.existsSync(filePath)) {
    return {
      ok: true,
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
      exists: true,
      source: "file"
    };
  }

  if (configFile.templateRelativePath) {
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      return {
        ok: true,
        path: filePath,
        content: fs.readFileSync(templatePath, "utf8"),
        exists: false,
        source: "template"
      };
    }
  }

  return {
    ok: true,
    path: filePath,
    content: "",
    exists: false,
    source: "missing"
  };
}

export async function writeServiceConfig(
  app: App,
  serviceId: ServiceId,
  key: string,
  content: string
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }
  const installDir = await ensureMutableInstallDir(app, service);
  const layout = getServiceLayout(app, service);

  const filePath = resolveConfigPath(layout, configFile.relativePath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  prepareServiceExecutionLayout(service, layout);

  const message =
    key === "env" && CORE_SERVICE_IDS.has(service.id)
      ? `${service.name} 配置已保存。端口修改需重启服务后生效。`
      : `${service.name} 配置已保存。`;

  return {
    ok: true,
    message,
    service: await getServiceState(app, serviceId)
  };
}

export async function importServiceFile(
  app: App,
  serviceId: ServiceId,
  targetKey: string,
  sourcePath: string
): Promise<ServiceImportResult> {
  const service = getService(serviceId);
  const target = service.importTargets.find((item) => item.key === targetKey);
  if (!target) {
    throw new Error(`unknown import target: ${targetKey}`);
  }

  const installDir = await ensureMutableInstallDir(app, service);
  const layout = getServiceLayout(app, service);

  const targetPath = resolveConfigPath(layout, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  prepareServiceExecutionLayout(service, layout);

  return {
    ok: true,
    message: `${target.label} 已导入。`,
    targetPath,
    service: await getServiceState(app, serviceId)
  };
}

export async function getServiceLogsMeta(app: App, serviceId: ServiceId): Promise<ServiceLogsMeta> {
  const state = await getServiceState(app, serviceId);
  return {
    ok: true,
    logPath: state.healthMeta.logFilePath,
    exists: fs.existsSync(state.healthMeta.logFilePath)
  };
}

export async function readServiceLog(
  app: App,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogReadOptions = {}
): Promise<ServiceLogReadResult> {
  const state = await getServiceState(app, serviceId);
  const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;
  return readServiceLogFile(filePath, options);
}

export function watchServiceLog(
  app: App,
  subscriptionId: string,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogStreamOptions = {},
  onEvent: ServiceLogStreamCallback
) {
  let currentPath = "";
  let currentOffset = normalizeLogStreamOffset(options);
  let currentExists = false;
  let polling = false;
  let stopped = false;

  async function sendReset(message: string) {
    const result = await readServiceLog(app, serviceId, target);
    currentPath = result.path;
    currentOffset = result.endOffset;
    currentExists = result.exists;
    onEvent({
      subscriptionId,
      serviceId,
      target,
      type: "reset",
      path: result.path,
      exists: result.exists,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      hasPrevious: result.hasPrevious,
      totalBytes: result.totalBytes,
      message
    });
  }

  async function poll() {
    if (polling || stopped) {
      return;
    }

    polling = true;
    try {
      const state = await getServiceState(app, serviceId);
      const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;

      if (!filePath) {
        if (currentPath || currentExists) {
          currentPath = "";
          currentOffset = 0;
          currentExists = false;
          onEvent({
            subscriptionId,
            serviceId,
            target,
            type: "reset",
            path: "",
            exists: false,
            content: "",
            startOffset: 0,
            endOffset: 0,
            hasPrevious: false,
            totalBytes: 0,
            message: "日志路径已清空。"
          });
        }
        return;
      }

      if (currentPath && filePath !== currentPath) {
        await sendReset("日志路径已变化，已刷新到最新内容。");
        return;
      }

      currentPath = filePath;

      if (!fs.existsSync(filePath)) {
        currentExists = false;
        return;
      }

      const stat = fs.statSync(filePath);
      const totalBytes = stat.size;
      if (totalBytes < currentOffset) {
        await sendReset("日志已轮转，已刷新到最新内容。");
        return;
      }

      currentExists = true;
      if (totalBytes <= currentOffset) {
        currentOffset = totalBytes;
        return;
      }

      const deltaBytes = totalBytes - currentOffset;
      if (deltaBytes > LOG_READ_WINDOW_BYTES) {
        await sendReset("日志增长较快，已刷新到最新内容。");
        return;
      }

      const startOffset = currentOffset;
      const content = readLogRange(filePath, startOffset, totalBytes);
      currentOffset = totalBytes;
      if (content.length === 0) {
        return;
      }

      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "append",
        path: filePath,
        exists: true,
        content,
        startOffset,
        endOffset: totalBytes,
        hasPrevious: startOffset > 0,
        totalBytes
      });
    } catch (reason) {
      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "error",
        path: currentPath,
        exists: currentExists,
        content: "",
        startOffset: currentOffset,
        endOffset: currentOffset,
        hasPrevious: currentOffset > 0,
        totalBytes: currentOffset,
        message: reason instanceof Error ? reason.message : String(reason)
      });
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, normalizeLogStreamPollInterval(options));
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function stopStartedServices(app: App) {
  for (const serviceId of [...startedThisSession]) {
    try {
      await stopService(app, serviceId);
    } catch (error) {
      console.error(`failed to stop ${serviceId} during app shutdown`, error);
    }
  }
}

export async function stopRunningServices(app: App) {
  const services = await listServices(app);
  const runningServices = services.filter((service) => service.status === "running");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );
  const failures: string[] = [];

  for (const service of runningServices) {
    try {
      await stopService(app, service.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${service.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`停止运行中服务失败：${failures.join("；")}`);
  }
}

type ShutdownServiceStopResult = {
  ok: boolean;
  serviceId: ServiceId;
  serviceName: string;
  elapsedMs: number;
  message: string;
};

function getShutdownStopCommandTimeoutMs(timeoutMs: number | undefined, platform: NodeJS.Platform | string = process.platform) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : platform === "win32"
      ? WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS
      : SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function stopServiceForShutdown(
  app: App,
  serviceState: ServiceState,
  timeoutMs: number
): Promise<ShutdownServiceStopResult> {
  const service = getService(serviceState.id);
  const startedAt = Date.now();

  try {
    if (isHostManagedService(service)) {
      await stopAgentWebclientHost(service.id);
    } else {
      await runServiceCommand(app, service, service.stopCommand, `${service.name} 已停止。`, {
        refreshBuiltinAsset: false,
        timeoutMs
      });
    }
    startedThisSession.delete(service.id);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[service-manager] shutdown stop succeeded for ${service.id} in ${elapsedMs}ms`);
    return {
      ok: true,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message: ""
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = getErrorMessage(error);
    console.warn(`[service-manager] shutdown stop failed for ${service.id} after ${elapsedMs}ms: ${message}`);
    return {
      ok: false,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message
    };
  }
}

export async function stopRunningServicesForShutdown(
  app: App,
  options: { stopCommandTimeoutMs?: number } = {}
) {
  const startedAt = Date.now();
  const timeoutMs = getShutdownStopCommandTimeoutMs(options.stopCommandTimeoutMs);
  const services = await listServices(app);
  const runningServices = services.filter((service) => service.status === "running");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );

  if (runningServices.length === 0) {
    console.log("[service-manager] shutdown stop skipped: no running services");
    return {
      ok: true,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      runningServiceIds: [] as ServiceId[],
      stopped: [] as ShutdownServiceStopResult[],
      failures: [] as ShutdownServiceStopResult[]
    };
  }

  const results = await Promise.all(
    runningServices.map((service) => stopServiceForShutdown(app, service, timeoutMs))
  );
  const stopped = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[service-manager] shutdown stop summary: services=${runningServices.length} stopped=${stopped.length} failed=${failures.length} elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}`
  );

  return {
    ok: failures.length === 0,
    timeoutMs,
    elapsedMs,
    runningServiceIds: runningServices.map((service) => service.id),
    stopped,
    failures
  };
}

export async function restoreRunningServices(
  app: App,
  options: {
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: "succeeded" | "failed" | "skipped", message: string) => void;
  } = {}
) {
  const serviceIds = getServiceIdsToRestore(app);
  const restored: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of serviceIds) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId);
      if (
        (current.kind === "plugin" && current.status === "not-installed") ||
        current.status === "initialization-required"
      ) {
        options.onProgress?.(serviceId, "skipped", current.message);
        continue;
      }

      options.onStarting?.(serviceId);
      const startedAt = Date.now();
      const result = await startService(app, serviceId);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        console.info(`[service-manager] restored ${serviceId} in ${elapsedMs}ms`);
        restored.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
      } else {
        console.warn(`[service-manager] failed to restore ${serviceId} after ${elapsedMs}ms: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        if (isNonBlockingRestoreFailure(serviceId)) {
          continue;
        }
        failures.push(`${serviceId}: ${result.message}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${message}`);
      break;
    }
  }

  return {
    restored,
    failures
  };
}

type StartupPipelineOptions = {
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
};

type StartupServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  running: boolean;
};

type StartupPreparationServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  changed: boolean;
  service?: ServiceState;
};

async function restoreOptionalStartupServices(
  app: App,
  options: StartupPipelineOptions = {}
) {
  const started: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of getOptionalServiceIdsToRestore(app)) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId);
      if (
        (current.kind === "plugin" && current.status === "not-installed") ||
        current.status === "initialization-required"
      ) {
        options.onProgress?.(serviceId, "skipped", current.message);
        continue;
      }

      options.onStarting?.(serviceId);
      options.onProgress?.(serviceId, "starting", `${current.name} 启动中...`);
      const startedAt = Date.now();
      const result = await startService(app, serviceId);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok && result.service.status === "running") {
        console.info(`[service-manager] restored optional startup service ${serviceId} in ${elapsedMs}ms`);
        started.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
        continue;
      }

      const failureMessage = result.ok
        ? `${result.service.name} 启动后未进入运行中状态。`
        : result.message;
      console.warn(`[service-manager] failed to restore optional startup service ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
      options.onProgress?.(serviceId, "failed", failureMessage);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${failureMessage}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${message}`);
      break;
    }
  }

  return {
    started,
    failures
  };
}

function isStartupPreparationBlockingStatus(status: ServiceState["status"]) {
  return (
    status === "not-installed" ||
    status === "initialization-required" ||
    status === "config-required" ||
    status === "dependency-missing" ||
    status === "error"
  );
}

async function resolveStartupPreparationMode(app: App): Promise<StartupRestoreMode> {
  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const service = getService(serviceId);
    const current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions());
    if (
      current.status === "not-installed" ||
      current.status === "initialization-required" ||
      shouldReinitializeMissingCoreServiceConfig(service, current)
    ) {
      return "bootstrap";
    }

    if (service.kind === "builtin" && needsBundledAssetRefresh(app, service)) {
      return "bootstrap";
    }

    if (current.status === "error" && installedBuiltinNeedsStartupRepair(app, service, current)) {
      return "bootstrap";
    }
  }

  return "restore";
}

async function prepareStartupService(
  app: App,
  serviceId: ServiceId,
  options: StartupPipelineOptions = {}
): Promise<StartupPreparationServiceResult> {
  let changed = false;
  try {
    const service = getService(serviceId);
    let current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions());
    const bundledAssetNeedsRefresh = service.kind === "builtin" && needsBundledAssetRefresh(app, service);
    const installNeedsRepair =
      current.status === "error" && installedBuiltinNeedsStartupRepair(app, service, current);

    if (
      current.status === "not-installed" ||
      bundledAssetNeedsRefresh ||
      installNeedsRepair
    ) {
      options.onProgress?.(serviceId, "installing", `${current.name} 安装中...`);
      if (bundledAssetNeedsRefresh && current.status === "running") {
        await stopService(app, serviceId);
      }
      await installBuiltinService(app, serviceId, { source: "prepareStartupService" });
      changed = true;
      current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions());
    }

    if (current.status === "initialization-required" || shouldReinitializeMissingCoreServiceConfig(service, current)) {
      options.onProgress?.(serviceId, "initializing", `${current.name} 初始化中...`);
      changed = true;
      const initialization = await initializeService(app, serviceId);
      if (!initialization.ok) {
        return {
          serviceId,
          ok: false,
          changed,
          message: initialization.message,
          service: initialization.service
        };
      }
      current = initialization.service;
    }

    await ensurePreStartRequirements(app, service);
    current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions());
    if (isStartupPreparationBlockingStatus(current.status)) {
      options.onProgress?.(serviceId, "failed", current.message);
      return {
        serviceId,
        ok: false,
        changed,
        message: current.message,
        service: current
      };
    }

    return {
      serviceId,
      ok: true,
      changed,
      message: `${current.name} 已准备就绪。`,
      service: current
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.(serviceId, "failed", message);
    return {
      serviceId,
      ok: false,
      changed,
      message
    };
  }
}

async function startPreparedStartupService(
  app: App,
  serviceId: ServiceId,
  options: StartupPipelineOptions = {}
): Promise<StartupServiceResult> {
  try {
    const current = await getServiceState(app, serviceId, getStartupResponsiveServiceStateReadOptions());
    options.onStarting?.(serviceId);

    if (current.status === "running") {
      const message = `${current.name} 已在运行。`;
      console.info(`[service-manager] reused running startup service ${serviceId}`);
      options.onProgress?.(serviceId, "succeeded", message);
      return {
        serviceId,
        ok: true,
        message,
        running: true
      };
    }

    options.onProgress?.(serviceId, "starting", `${current.name} 启动中...`);
    await yieldStartupScheduler();
    const startedAt = Date.now();
    const result = await startServiceInternal(app, serviceId, getPreparedStartupStartOptions());
    const elapsedMs = Date.now() - startedAt;
    if (result.ok && result.service.status === "running") {
      console.info(`[service-manager] started ${serviceId} in ${elapsedMs}ms`);
      options.onProgress?.(serviceId, "succeeded", result.message);
      return {
        serviceId,
        ok: true,
        message: result.message,
        running: true
      };
    }

    const failureMessage = result.ok
      ? `${result.service.name} did not enter running state after start`
      : result.message;
    console.warn(`[service-manager] failed to start ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
    options.onProgress?.(serviceId, "failed", failureMessage);
    return {
      serviceId,
      ok: false,
      message: failureMessage,
      running: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.(serviceId, "failed", message);
    return {
      serviceId,
      ok: false,
      message,
      running: false
    };
  }
}

async function prepareInstallOnlyStartupServices(
  app: App,
  options: Pick<StartupPreparationOptions, "onProgress"> = {}
) {
  for (const serviceId of INSTALL_ONLY_STARTUP_SERVICE_IDS) {
    try {
      const result = await prepareStartupService(app, serviceId, {
        onProgress: options.onProgress
      });
      if (!result.ok) {
        console.warn(`[service-manager] optional startup service ${serviceId} is unavailable: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        continue;
      }
      options.onProgress?.(serviceId, "succeeded", result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[service-manager] optional startup service ${serviceId} failed preparation: ${message}`);
      options.onProgress?.(serviceId, "failed", message);
    }
  }
}

async function startOptionalAutoStartupServices(
  app: App,
  options: Pick<StartupPreparationOptions, "onStarting" | "onProgress"> = {}
) {
  for (const serviceId of OPTIONAL_AUTO_STARTUP_SERVICE_IDS) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const prepared = await prepareStartupService(app, serviceId, {
        onProgress: options.onProgress
      });
      if (!prepared.ok) {
        console.warn(`[service-manager] optional auto-start service ${serviceId} is unavailable: ${prepared.message}`);
        continue;
      }

      const started = await startPreparedStartupService(app, serviceId, {
        onStarting: options.onStarting,
        onProgress: options.onProgress
      });
      if (!started.ok || !started.running) {
        console.warn(`[service-manager] optional auto-start service ${serviceId} failed start: ${started.message}`);
      }
    } catch (error) {
      console.warn(
        `[service-manager] optional auto-start service ${serviceId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

function startOptionalAutoStartupServicesInBackground(
  app: App,
  options: Pick<StartupPreparationOptions, "onStarting" | "onProgress"> = {}
) {
  trackBackgroundStartupPreparation(
    startOptionalAutoStartupServices(app, options).catch((error) => {
      console.warn(
        `[service-manager] optional auto-start background task failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    })
  );
}


function trackBackgroundStartupPreparation(task: Promise<void>) {
  const trackedTask = task.finally(() => {
    backgroundStartupPreparationTasks.delete(trackedTask);
  });
  backgroundStartupPreparationTasks.add(trackedTask);
}

function prepareInstallOnlyStartupServicesInBackground(
  app: App,
  options: Pick<StartupPreparationOptions, "onProgress"> = {}
) {
  trackBackgroundStartupPreparation(
    prepareInstallOnlyStartupServices(app, options).catch((error) => {
      console.warn(
        `[service-manager] optional startup service background preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    })
  );
}

async function waitForBackgroundStartupPreparations() {
  await Promise.allSettled([...backgroundStartupPreparationTasks]);
}

export async function runStartupPreparation(
  app: App,
  options: StartupPreparationOptions = {}
): Promise<StartupPreparationResult> {
  try {
    await ensureDesktopRegisterApiKey(app);

    const initialMode = await resolveStartupPreparationMode(app);
    options.onModeResolved?.(initialMode);
    const started: ServiceId[] = [];
    const failures: string[] = [];

    const preparedDefaultServices = new Map<ServiceId, ServiceState>();
    const preparationResults = await Promise.all(
      DEFAULT_STARTUP_SERVICE_IDS.map((serviceId) =>
        prepareStartupService(app, serviceId, {
          onProgress: options.onProgress
        })
      )
    );
    const preparedChanged = preparationResults.some((result) => result.changed);

    for (const result of preparationResults) {
      if (!result.ok || !result.service) {
        failures.push(`${result.serviceId}: ${result.message}`);
        continue;
      }

      preparedDefaultServices.set(result.serviceId, result.service);
    }

    const startOptions = {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    };
    const startResults = await Promise.all(
      DEFAULT_STARTUP_SERVICE_IDS
        .filter((serviceId) => preparedDefaultServices.has(serviceId))
        .map((serviceId) =>
          startPreparedStartupService(
            app,
            serviceId,
            startOptions
          )
        )
    );
    const startResultById = new Map(startResults.map((result) => [result.serviceId, result]));
    for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
      const result = startResultById.get(serviceId);
      if (!result) {
        continue;
      }
      if (result.ok && result.running) {
        started.push(serviceId);
      } else {
        failures.push(`${serviceId}: ${result.message}`);
      }
    }

    const optionalRestoreResult = await restoreOptionalStartupServices(app, {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    started.push(...optionalRestoreResult.started);
    failures.push(...optionalRestoreResult.failures);
    prepareInstallOnlyStartupServicesInBackground(app, {
      onProgress: options.onProgress
    });
    startOptionalAutoStartupServicesInBackground(app, {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });

    return {
      mode: initialMode === "bootstrap" || preparedChanged ? "bootstrap" : "restore",
      started,
      failures,
      preparedChanged
    };
  } finally {
    flushStartupTimingSummary();
  }
}

export const __testInternals = {
  LOG_READ_WINDOW_BYTES,
  parseEnvFileContent,
  parsePort,
  getWebUrl,
  containerEngineAvailable,
  probeContainerEngines,
  fixShellScriptPermissions,
  patchProgramCommonForLayeredLayout,
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  upsertEnvFileContent,
  ensurePreStartRequirements,
  agentPlatformInstallNeedsRefresh,
  agentWebclientInstallNeedsRefresh,
  zenmindAppServerInstallNeedsRefresh,
  resolveNodeBin,
  getStartCommandEnvOverrides,
  buildDesktopServiceCommandEnv,
  getDesktopStartCommand,
  getDesktopStartCommandOptions,
  getPreparedStartupStartOptions,
  resolveAcpCommandForDesktop,
  normalizeAgentPlatformEnvContentForRuntime,
  normalizeAgentPlatformEnvContentForSave,
  normalizeAgentPlatformBashConfigContent,
  normalizeAgentPlatformFileToolsConfigContent,
  normalizeAgentContainerHubEnvContentForDesktop,
  normalizeAgentWebclientEnvContentForDesktop,
  applyAgentPlatformWindowsHostShellDefaults,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromPowerShell: parseProcessTreeRowsFromWindowsPowerShell,
  buildProcessTreePids,
  collectManagedRootPids,
  captureManagedProcessCleanupSnapshot,
  mergeCleanupTargets,
  terminateProcessTree,
  terminateProcessList,
  collectManagedServiceStopState,
  forceStopServiceInstallDir,
  ensureManagedServiceStoppedForPlatform,
  getShutdownStopCommandTimeoutMs,
  decodePowerShellCapturePayload,
  runExecFile,
  runServiceRestart,
  waitForBackgroundStartupPreparations,
  probeHttpUrl,
  verifyServiceState,
  buildVerificationResult,
  resolveAgentPlatformReadinessFallbackTarget,
  clearContainerEngineProbeCache,
  matchProcessInstallDir,
  readManagedPidFile,
  getInitializationStatePath,
  readInitializationState,
  readBuiltinAssetSignature,
  readLogRange,
  getLastRunningServicesStatePath,
  getDefaultStartupServiceIds,
  getServiceIdsToRestore,
  getOptionalServiceIdsToRestore,
  orderServiceIdsForRestore,
  needsBundledAssetRefresh,
  resolveStartupPreparationMode,
  prepareStartupService,
  startPreparedStartupService,
  readLastRunningServices,
  watchServiceLog,
  writeLastRunningServices
};
