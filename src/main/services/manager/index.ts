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
import { emitPluginBridgeHook, getPluginBridgeEnv } from "../../plugin-bridge";
import { getPluginSettingsEnv } from "../../plugin-settings";
import {
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  stopPluginResources,
  syncPluginResources
} from "../../plugin-resources";
import { readEnvFile, parseEnvFileContent } from "../../env-file";
import { extractArchiveToDir } from "../../archive-utils";
import {
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
  identityCenterInstallNeedsRefresh,
  serviceInstallNeedsRefresh
} from "./install-refresh";
import {
  resolveNodeBin,
  __testInternals as commandEnvTestInternals
} from "./command-env";
import { ensureProviderRegisterApiKey } from "../../provider-register";
import { getDesktopDeviceId } from "../../device-identity";
import {
  decodePowerShellCapturePayload,
  runExecFile,
  SERVICE_COMMAND_TIMEOUT_MS
} from "./command-runner";
import { t } from "../../i18n/main-i18n";
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
  fixShellScriptPermissions
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
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID,
  PROCESS_EXEC_PATH_PLACEHOLDER,
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
  getWebUrl,
  parsePort
} from "./service-network";
import {
  resolvePreferredAgentPlatformRuntimeRoot
} from "./runtime-paths";
import {
  getManagedPidFilePaths,
  readManagedPidFile,
  resolveRuntimePath,
  writeManagedPidFiles
} from "./pid-files";
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
import {
  appendConfiguredServiceLifecycleArgs,
  getConfiguredServiceLifecycleArgs,
  type ServiceLifecycleCommandKind
} from "../../service-lifecycle-args";

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

function isDirectoryAssetPath(assetPath: string) {
  return fs.existsSync(assetPath) && fs.statSync(assetPath).isDirectory();
}

function copyDirectoryAssetToTempRoot(assetPath: string, tempRoot: string) {
  const targetRoot = path.join(tempRoot, path.basename(assetPath));
  fs.cpSync(assetPath, targetRoot, { recursive: true, force: true });
  return targetRoot;
}

function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
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
  "identity-center"
]);

type ServiceCommandKind = ServiceLifecycleCommandKind;

function isHostManagedService(service: ServiceDefinition) {
  return isHostManagedAgentWebclientService(service);
}

function getDesktopManagedCommandPort(service: ServiceDefinition) {
  return service.web.defaultPort;
}

function getDesktopManagedContainerHubBindAddr(service: ServiceDefinition) {
  return `127.0.0.1:${getDesktopManagedCommandPort(service)}`;
}

async function getDesktopManagedAgentPlatformContainerHubBaseUrl(app: App) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  return `http://127.0.0.1:${hubPort || getService("agent-container-hub").web.defaultPort}`;
}

function normalizeHttpUrlArgument(value: string) {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
      return parsed.toString().replace(/\/$/u, "");
    }
  } catch {
    // Return null below so callers get a lifecycle-specific error message.
  }
  return null;
}

function resolveAgentWebclientHostBaseUrl(app: App) {
  const args = getConfiguredServiceLifecycleArgs(app, "agent-webclient", "start");
  let baseUrl = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base-url": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("agent-webclient host start argument --base-url requires a value.");
        }
        const normalized = normalizeHttpUrlArgument(value);
        if (!normalized) {
          throw new Error(`agent-webclient host start argument --base-url must be an http(s) URL: ${value}`);
        }
        baseUrl = normalized;
        index += 1;
        break;
      }
      default:
        throw new Error(`unsupported agent-webclient host start argument: ${arg}`);
    }
  }

  if (!baseUrl) {
    throw new Error("agent-webclient host start requires lifecycleArgs.start --base-url.");
  }

  return baseUrl;
}

function resolveAgentWebclientHostStartOverrides(app: App) {
  const baseUrl = resolveAgentWebclientHostBaseUrl(app);
  return new Map<string, string>([
    ["BASE_URL", baseUrl],
    ["DESKTOP_APP", "true"]
  ]);
}

async function resolveAgentPlatformDeployPublicKeySourceFile(app: App) {
  const capability = await resolveDesktopCapability(app, "auth.publicKey", {
    ensureProviderInstall: async (providerService) => {
      await ensureMutableInstallDir(app, providerService);
    }
  });
  if (capability.filePath && fs.existsSync(capability.filePath) && fs.statSync(capability.filePath).isFile()) {
    return capability.filePath;
  }

  throw new Error("auth.publicKey capability did not produce a usable local public key file.");
}

function appendAgentPlatformDesktopDeployArgs(
  command: string[],
  app: App,
  layout: ServiceLayout,
  containerHubBaseUrl: string,
  publicKeySourceFile: string
) {
  return [
    ...command,
    "--output-dir", layout.configDir,
    "--ap-runtime-dir", resolvePreferredAgentPlatformRuntimeRoot(app),
    "--container-hub-base-url", containerHubBaseUrl,
    "--public-key-source-file", publicKeySourceFile
  ];
}

function appendAgentContainerHubDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

function appendIdentityCenterDesktopDeployArgs(command: string[], layout: ServiceLayout) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

function appendAgentWebclientDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

async function buildDesktopManagedDeployCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  layout: ServiceLayout
) {
  const commandWithConfiguredArgs = appendConfiguredServiceLifecycleArgs(app, service, command, "deploy");
  if (service.id === "agent-platform") {
    const [containerHubBaseUrl, publicKeySourceFile] = await Promise.all([
      getDesktopManagedAgentPlatformContainerHubBaseUrl(app),
      resolveAgentPlatformDeployPublicKeySourceFile(app)
    ]);
    return appendAgentPlatformDesktopDeployArgs(
      commandWithConfiguredArgs,
      app,
      layout,
      containerHubBaseUrl,
      publicKeySourceFile
    );
  }
  if (service.id === "agent-container-hub") {
    return appendAgentContainerHubDesktopDeployArgs(commandWithConfiguredArgs, layout);
  }
  if (service.id === "identity-center") {
    return appendIdentityCenterDesktopDeployArgs(commandWithConfiguredArgs, layout);
  }
  if (service.id === "agent-webclient") {
    return appendAgentWebclientDesktopDeployArgs(
      commandWithConfiguredArgs,
      layout
    );
  }
  return commandWithConfiguredArgs;
}

function appendDesktopManagedLayoutFlags(
  service: ServiceDefinition,
  command: string[],
  layout: ServiceLayout,
  kind: ServiceCommandKind
) {
  if (service.id === "agent-platform") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--port", String(getDesktopManagedCommandPort(service))
    ];
  }

  if (service.id === "agent-container-hub") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--data-dir", layout.dataDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--bind-addr", getDesktopManagedContainerHubBindAddr(service)
    ];
  }

  if (service.id === "identity-center") {
    if (kind === "deploy") {
      return command;
    }
    if (kind === "stop") {
      return [...command, "--state-dir", layout.stateDir];
    }
    return [
      ...command,
      "--config-dir", layout.configDir,
      "--data-dir", layout.dataDir,
      "--state-dir", layout.stateDir,
      "--log-dir", layout.logDir,
      "--port", String(getDesktopManagedCommandPort(service))
    ];
  }

  if (service.id === "agent-webclient" && kind === "deploy") {
    return command;
  }

  return command;
}

function collectPrerequisites(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  options: { cacheContainerEngineProbe?: boolean } = {}
) {
  const prerequisites: string[] = [];
  const envPath = layout.envPath;
  const requiresEnvFile = service.configFiles.some((configFile) =>
    configFile.required && path.normalize(configFile.relativePath) === ".env"
  );
  if (requiresEnvFile && !fs.existsSync(envPath)) {
    prerequisites.push(t("service.missingEnvFile"));
  }

  for (const target of service.importTargets) {
    const targetPath = resolveConfigPath(layout, target.relativePath);
    if (target.required && !fs.existsSync(targetPath)) {
      prerequisites.push(t("service.missingImportTarget", { label: target.label }));
    }
  }

  if (service.id === "agent-container-hub") {
    const engineProbe = probeContainerEngines({ cache: options.cacheContainerEngineProbe });
    if (!engineProbe.engine) {
      const installed = engineProbe.probes.filter((probe) => probe.installed);
      if (installed.length > 0) {
        const names = installed.map((probe) => probe.engine).join(" / ");
        prerequisites.push(t("service.containerEngineInstalledNotConnected", { names }));
      } else {
        prerequisites.push(t("service.containerEngineMissing"));
      }
    }
  }

  if (false && service.id === "agent-container-hub" && !containerEngineAvailable()) {
    prerequisites.push(t("service.containerEngineMissing"));
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

async function ensureInitializationRequirements(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  if (CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates);
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

  throw new Error(t("service.pluginNotImported", { name: service.name }));
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
      ? ensureArchiveHealthy(service, options.archivePath, t("service.archivePackageLabel"))
      : ensureBundleAssetHealthy(app, service);
    const initializationAssetSignature = options.archivePath ? computeAssetSignature(assetPath) : undefined;

    const finalInstallDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const needsExtract =
      options.force ||
      !fs.existsSync(finalInstallDir) ||
      !isInstallHealthy(service, finalInstallDir) ||
      serviceInstallNeedsRefresh(service, finalInstallDir) ||
      isAssetNewerThanInstall(assetPath, layout, options.archivePath ? undefined : app, service);

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
      let extractedRoot: string;
      if (isDirectoryAssetPath(assetPath)) {
        extractedRoot = copyDirectoryAssetToTempRoot(assetPath, tempRoot);
      } else {
        await extractArchiveToDir(assetPath, tempRoot);
        const entries = fs.readdirSync(tempRoot);
        if (entries.length !== 1) {
          throw new Error(`unexpected archive layout for ${service.id}`);
        }
        extractedRoot = path.join(tempRoot, entries[0]);
      }
      didExtract = true;
      if (fs.existsSync(finalInstallDir)) {
        await stopBuiltinInstallDir(service, finalInstallDir);
      }
      fs.rmSync(finalInstallDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      moveExtractedBuiltinRoot(extractedRoot, finalInstallDir);
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
        message: service.kind === "plugin"
          ? t("service.pluginNotImported", { name: service.name })
          : t("service.notInstalled", { name: service.name }),
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
        message: t("service.reinstalledAndInitialized", { name: service.name }),
        service: nextState
      };
    }

    try {
      fixShellScriptPermissions(installDir);
      prepareServiceExecutionLayout(service, layout);
      const serviceDeployOwnsConfig = service.kind === "builtin" && CORE_SERVICE_IDS.has(service.id) && Boolean(service.deployCommand);
      if (!serviceDeployOwnsConfig) {
        ensureDefaultConfig(service, layout);
      }
      if (service.deployCommand) {
        const deployCommand = await buildDesktopManagedDeployCommand(app, service, service.deployCommand, layout);
        await runExecFile(deployCommand[0], deployCommand.slice(1), installDir, {
          env: buildDesktopServiceCommandEnv(app, service, layout, undefined)
        });
      }
      await ensureInitializationRequirements(app, service, layout);
      if (service.kind === "plugin" && service.serviceMode === "resource") {
        const desiredStatus = initializePluginResourceState(app, service);
        if (desiredStatus === "running") {
          await syncPluginResources(app, service, installDir);
        }
      } else {
        await syncPluginResources(app, service, installDir);
      }
      const assetSignature = options.assetSignatureOverride ?? readBuiltinAssetSignature(app, service);
      writeInitializationState(layout, {
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        ...(assetSignature ? { assetSignature } : {})
      });
      if (service.kind === "plugin") {
        emitPluginBridgeHook("plugin.initialized", { pluginId: service.id });
      }
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
      message: t("service.initialized", { name: service.name }),
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
  const hostManaged = isHostManagedService(service);
  const port = hostManaged ? getDesktopManagedCommandPort(service) : parsePort(service, env);
  const webUrl = installed && !hostManaged ? getWebUrl(service, env) : getWebUrl(service, new Map<string, string>());
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
      ? collectPrerequisites(app, service, layout, {
        cacheContainerEngineProbe: options.cacheContainerEngineProbe
      })
      : [];
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
  let statusLabel = t("service.status.notInstalled");
  let message = t("service.notInstalledLocal");

  if (installed) {
    status = "stopped";
    statusLabel = t("service.status.stopped");
    message = t("service.installedCanStart");
  }

  if (installed && missingRuntimeFiles.length > 0) {
    status = "error";
    statusLabel = t("service.status.corrupted");
    message = t("service.missingRuntimeFiles", { files: missingRuntimeFiles.join(", ") });
  }

  if (installed && missingRuntimeFiles.length === 0 && !initializationSucceeded) {
    if (initializationState?.status === "failed" && initializationState.version === service.version) {
      status = "error";
      statusLabel = t("service.status.initializationFailed");
      message = initializationState.lastError
        ? t("service.initializationFailedWithMessage", { message: initializationState.lastError })
        : t("service.initializationFailedRetry");
    } else {
      status = "initialization-required";
      statusLabel = t("service.status.initializationRequired");
      message = service.kind === "plugin" ? t("service.pluginImportedNeedsInit") : t("service.serviceInstalledNeedsInit");
    }
  }

  if (!installed && service.kind === "builtin") {
    try {
      ensureBundleAssetHealthy(app, service);
    } catch (error) {
      status = "error";
      statusLabel = t("service.status.assetDamaged");
      message = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && prerequisites.length > 0) {
    const hasDependencyError = prerequisites.some((item) => item.includes("Docker") || item.includes("Podman"));
    status = hasDependencyError ? "dependency-missing" : "config-required";
    statusLabel = hasDependencyError ? t("service.status.dependencyMissing") : t("service.status.configRequired");
    message = prerequisites.join(t("common.listSeparator"));
  }

  if (
    service.kind === "plugin" &&
    service.serviceMode === "resource" &&
    installed &&
    missingRuntimeFiles.length === 0 &&
    initializationSucceeded &&
    prerequisites.length === 0
  ) {
    if (readPluginResourceDesiredStatus(app, service) === "running") {
      status = "running";
      statusLabel = t("service.status.loaded");
      message = t("service.pluginResourceLoaded");
    } else {
      status = "stopped";
      statusLabel = t("service.status.stopped");
      message = t("service.pluginResourceNotLoaded");
    }
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && conflictingPortPid) {
    status = "error";
    statusLabel = t("service.status.portConflict");
    message = t("service.portOccupied", { port, pid: conflictingPortPid });
  }

  if (running && initializationSucceeded) {
    status = "running";
    statusLabel = t("service.status.running");
    message = t("service.processRunning", {
      entry: webUrl ? t("service.processEntry", { url: webUrl }) : ""
    }).trim();
  }

  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    serviceMode: service.serviceMode,
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
    pluginActions: service.desktop.actions.map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.icon ? { icon: action.icon } : {}),
      placement: action.placement ?? "controlCenter",
      requiresRunning: action.requiresRunning === true,
      ...(action.globalShortcut ? { globalShortcut: { settingKey: action.globalShortcut.settingKey } } : {})
    })),
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
      issues.push(t("service.verify.statusStill", { status: state.status }));
    }
    if (pid && !isProcessRunning(pid)) {
      issues.push(t("service.verify.pidMissing", { pid }));
    }
    if (!pid) {
      issues.push(t("service.verify.noValidPid"));
    }
    if (service.id === "agent-container-hub") {
      if (port > 0 && !managedPortPid) {
        issues.push(t("service.verify.portNoManagedProcess", { port }));
      }
      if (httpProbe && !httpProbe.ok) {
        issues.push(t("service.verify.probeFailed", {
          target: httpProbe.target,
          message: httpProbe.message || t("service.probeHttpUnavailable")
        }));
      }
      if (runtimeInfoProbe) {
        const looksJson = /application\/json/iu.test(runtimeInfoProbe.contentType || "")
          || /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "");
        if (!runtimeInfoProbe.ok || !looksJson) {
          issues.push(runtimeInfoProbe.ok
            ? t("service.verify.runtimeInfoNotJson", { statusCode: runtimeInfoProbe.statusCode })
            : t("service.verify.probeFailed", {
                target: "/api/runtime-info",
                message: runtimeInfoProbe.message || t("service.probeHttpUnavailable")
              }));
        }
      } else {
        issues.push(t("service.verify.runtimeInfoMissing"));
      }
    }
  } else {
    if (state.status === "running") {
      issues.push(t("service.verify.stillRunning"));
    }
    if (pid && isProcessRunning(pid)) {
      issues.push(t("service.verify.pidStillRunning", { pid }));
    }
    if (port > 0 && managedPortPid) {
      issues.push(t("service.verify.portStillManaged", { port, pid: managedPortPid }));
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
  const issues = verification.issues.length > 0
    ? verification.issues.join(t("common.listSeparator"))
    : t("service.verify.actualStatus", { status: verification.actualStatus });
  return t("service.verify.failed", { actionMessage, issues });
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

function shouldReinitializeMissingCoreServiceConfig(service: ServiceDefinition, state: ServiceState) {
  return (
    service.kind === "builtin" &&
    CORE_SERVICE_IDS.has(service.id) &&
    state.status === "config-required" &&
    state.configFiles.some((configFile) => configFile.required && !configFile.exists)
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
        [
          t("service.verify.probeFailed", { target, message: probe.message || t("service.probeHttpUnavailable") }),
          t("service.verify.probeFailed", { target: fallbackTarget, message: fallbackProbe.message || t("service.probeHttpUnavailable") })
        ].join(t("common.listSeparator"))
      );
    }
    throw new Error(t("service.verify.probeFailed", {
      target,
      message: probe.message || t("service.probeHttpUnavailable")
    }));
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
      issues.push(t("service.verify.requirementNotReady", {
        requirement: describeCapabilityRequirement(requirement),
        message
      }));
    }
  }
  return issues;
}

async function ensurePreStartRequirements(app: App, service: ServiceDefinition) {
  const layout = getServiceLayout(app, service);
  prepareServiceExecutionLayout(service, layout);

  if (service.id === "agent-platform") {
    await ensureProviderRegisterApiKey(app);
  }

  if (service.id !== "agent-platform") {
    await applyDesktopCapabilityRequirements(app, service, layout, "preStart");
  }
}

type RunServiceCommandOptions = {
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  commandKind?: ServiceCommandKind;
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
  service: ServiceDefinition,
  layout: ServiceLayout,
  overrides: NodeJS.ProcessEnv | undefined
) {
  const pluginFileEnv = service.kind === "plugin" && fs.existsSync(layout.envPath)
    ? Object.fromEntries(readEnvFile(layout.envPath))
    : {};
  const env: NodeJS.ProcessEnv = {
    ...pluginFileEnv,
    ...(service.kind === "plugin"
      ? {
          SERVICE_PROGRAM_DIR: layout.programDir,
          SERVICE_CONFIG_DIR: layout.configDir,
          SERVICE_DATA_DIR: layout.dataDir,
          SERVICE_STATE_DIR: layout.stateDir,
          SERVICE_LOG_DIR: layout.logDir,
          SERVICE_ENV_PATH: layout.envPath
        }
      : {}),
    ...getPluginBridgeEnv(app, service),
    ...getPluginSettingsEnv(app, service),
    ...(overrides ?? {})
  };
  if (service.id === "identity-center") {
    env.DESKTOP_DEVICE_ID = getDesktopDeviceId(app);
  }
  return env;
}

function buildDesktopServiceCommandEnvForTests(
  app: App,
  serviceOrLayout: ServiceDefinition | ServiceLayout,
  layoutOrOverrides: ServiceLayout | NodeJS.ProcessEnv | undefined,
  overrides?: NodeJS.ProcessEnv
) {
  if ("programDir" in serviceOrLayout) {
    return {
      ...((layoutOrOverrides as NodeJS.ProcessEnv | undefined) ?? {})
    };
  }
  return buildDesktopServiceCommandEnv(
    app,
    serviceOrLayout,
    layoutOrOverrides as ServiceLayout,
    overrides
  );
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
          throw new Error(t("service.notInstalledDamaged", { name: service.name }));
        }
        await installBuiltinService(app, service.id, { source: "runServiceCommand:missing-install" });
      } else if (assetPath && isAssetNewerThanInstall(assetPath, getServiceLayout(app, service), app, service)) {
        await installBuiltinService(app, service.id, { source: "runServiceCommand:asset-newer" });
      }
    } else if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      throw new Error(t("service.notInstalledDamaged", { name: service.name }));
    }

    if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      if (service.kind !== "builtin") {
        throw new Error(t("service.notInstalledDamaged", { name: service.name }));
      }
      if (!shouldRefreshBuiltinAsset) {
        throw new Error(t("service.notInstalledDamaged", { name: service.name }));
      }
      ensureBundleAssetHealthy(app, service);
      await installBuiltinService(app, service.id, { source: "runServiceCommand:repair-install" });
    }
    if (command.length === 0) {
      throw new Error(t("service.missingExecutableScript", { name: service.name }));
    }
    const layout = getServiceLayout(app, service);
    prepareServiceExecutionLayout(service, layout);
    const commandWithConfiguredArgs = appendConfiguredServiceLifecycleArgs(
      app,
      service,
      command,
      options.commandKind ?? "start"
    );
    const commandForExec = appendDesktopManagedLayoutFlags(
      service,
      commandWithConfiguredArgs,
      layout,
      options.commandKind ?? "start"
    );
    await runExecFile(commandForExec[0], commandForExec.slice(1), installDir, {
      timeoutMs: options.timeoutMs,
      env: buildDesktopServiceCommandEnv(app, service, layout, options.env)
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
  if (service.serviceMode === "resource") {
    if (
      !current.installed ||
      current.status === "initialization-required" ||
      current.status === "config-required" ||
      current.status === "dependency-missing" ||
      current.status === "error"
    ) {
      return {
        ok: false,
        message: current.message,
        service: current
      };
    }
    const installDir = getInstallDir(app, service);
    await syncPluginResources(app, service, installDir);
    const nextState = await getServiceState(app, serviceId, options.stateReadOptions);
    const result = {
      ok: true,
      message: t("service.loaded", { name: service.name }),
      service: nextState
    } satisfies ServiceCommandResult;
    if (service.kind === "plugin") {
      emitPluginBridgeHook("plugin.started", { pluginId: service.id, service: result.service });
    }
    return result;
  }
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
  let nextState = await getServiceState(app, serviceId, options.stateReadOptions);
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
      message: t("service.alreadyRunning", { name: nextState.name }),
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
        message: t("service.alreadyRunning", { name: preStartState.name }),
        service: preStartState
      };
    } else {
      if (isHostManagedService(service)) {
        const layout = getServiceLayout(app, service);
        const fileEnv = readEnvFile(layout.envPath);
        const envOverrides = service.id === "agent-webclient"
          ? resolveAgentWebclientHostStartOverrides(app)
          : new Map<string, string>();
        const env = new Map([...fileEnv, ...envOverrides]);
        const port = service.id === "agent-webclient" ? getDesktopManagedCommandPort(service) : parsePort(service, env);
        await startAgentWebclientHost({
          service,
          layout,
          env,
          envOverrides,
          port,
          issueAccessToken: (reason) => issueAgentAccessToken(app, reason)
        });
        result = {
          ok: true,
          message: t("service.started", { name: service.name }),
          service: await getServiceState(app, service.id, options.commandStateReadOptions ?? options.stateReadOptions)
        };
      } else {
        result = await runServiceCommand(
          app,
          service,
          getDesktopStartCommand(service),
          t("service.started", { name: service.name }),
          {
            ...getDesktopStartCommandOptions(app, service),
            commandKind: "start",
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
    t("service.startCommandExecuted", { name: service.name }),
    options.verificationOptions
  );
  if (service.kind === "plugin" && verifiedResult.ok) {
    emitPluginBridgeHook("plugin.started", { pluginId: service.id, service: verifiedResult.service });
  }
  return verifiedResult;
}

export async function startService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return startServiceInternal(app, serviceId);
}

export async function stopService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId);
  if (service.serviceMode === "resource") {
    if (!current.installed) {
      return {
        ok: true,
        message: t("service.notInstalled", { name: service.name }),
        service: current
      };
    }
    if (current.status === "initialization-required" || current.status === "error") {
      return {
        ok: false,
        message: current.message,
        service: current
      };
    }
    if (current.status !== "running") {
      return {
        ok: true,
        message: t("service.notLoaded", { name: service.name }),
        service: current
      };
    }
    await stopPluginResources(app, service);
    const result = {
      ok: true,
      message: t("service.stopped", { name: service.name }),
      service: await getServiceState(app, serviceId)
    } satisfies ServiceCommandResult;
    if (service.kind === "plugin") {
      emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: result.service });
    }
    return result;
  }
  if (!current.installed) {
    return {
      ok: true,
      message: t("service.notInstalled", { name: service.name }),
      service: current
    };
  }
  if (current.status !== "running") {
    return {
      ok: true,
      message: t("service.currentlyNotRunning", { name: service.name }),
      service: current
    };
  }

  if (isHostManagedService(service)) {
    await stopAgentWebclientHost(service.id);
    startedThisSession.delete(serviceId);
    const result = {
      ok: true,
      message: t("service.stopped", { name: service.name }),
      service: await getServiceState(app, serviceId)
    } satisfies ServiceCommandResult;
    const verified = await attachServiceVerification(app, serviceId, result, "stopped", t("service.stopCommandExecuted", { name: service.name }));
    if (service.kind === "plugin" && verified.ok) {
      emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
    }
    return verified;
  }

  const result = await runServiceCommand(app, service, service.stopCommand, t("service.stopped", { name: service.name }), {
    refreshBuiltinAsset: false,
    commandKind: "stop"
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

  const verified = await attachServiceVerification(app, serviceId, result, "stopped", t("service.stopCommandExecuted", { name: service.name }));
  if (service.kind === "plugin" && verified.ok) {
    emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
  }
  return verified;
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
      ? t("service.configSavedRestartRequired", { name: service.name })
      : t("service.configSaved", { name: service.name });

  const result = {
    ok: true,
    message,
    service: await getServiceState(app, serviceId)
  };
  if (service.kind === "plugin") {
    emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key, service: result.service });
  }
  return result;
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

  const result = {
    ok: true,
    message: t("service.imported", { label: target.label }),
    targetPath,
    service: await getServiceState(app, serviceId)
  };
  if (service.kind === "plugin") {
    emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key: targetKey, service: result.service });
  }
  return result;
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
            message: t("service.logPathCleared")
          });
        }
        return;
      }

      if (currentPath && filePath !== currentPath) {
        await sendReset(t("service.logPathChanged"));
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
        await sendReset(t("service.logRotated"));
        return;
      }

      currentExists = true;
      if (totalBytes <= currentOffset) {
        currentOffset = totalBytes;
        return;
      }

      const deltaBytes = totalBytes - currentOffset;
      if (deltaBytes > LOG_READ_WINDOW_BYTES) {
        await sendReset(t("service.logGrowingFast"));
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
    throw new Error(t("service.stopRunningFailed", { message: failures.join(t("common.listSeparator")) }));
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
      await runServiceCommand(app, service, service.stopCommand, t("service.stopped", { name: service.name }), {
        refreshBuiltinAsset: false,
        commandKind: "stop",
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
  const servicesToStop = runningServices.filter((service) => service.serviceMode !== "resource");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );

  if (servicesToStop.length === 0) {
    console.log("[service-manager] shutdown stop skipped: no stoppable running services");
    return {
      ok: true,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      runningServiceIds: runningServices.map((service) => service.id),
      stopped: [] as ShutdownServiceStopResult[],
      failures: [] as ShutdownServiceStopResult[]
    };
  }

  const results = await Promise.all(
    servicesToStop.map((service) => stopServiceForShutdown(app, service, timeoutMs))
  );
  const stopped = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[service-manager] shutdown stop summary: services=${servicesToStop.length} stopped=${stopped.length} failed=${failures.length} elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}`
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

function getResourcePluginServiceIdsToRestore(app: App) {
  return getAllServices()
    .filter((service) =>
      service.kind === "plugin" &&
      service.serviceMode === "resource" &&
      readPluginResourceDesiredStatus(app, service) === "running"
    )
    .map((service) => service.id);
}

function isResourcePluginServiceId(serviceId: ServiceId) {
  try {
    const service = getService(serviceId);
    return service.kind === "plugin" && service.serviceMode === "resource";
  } catch {
    return false;
  }
}

export async function restoreRunningServices(
  app: App,
  options: {
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: "succeeded" | "failed" | "skipped", message: string) => void;
  } = {}
) {
  const serviceIds = orderServiceIdsForRestore([
    ...getServiceIdsToRestore(app),
    ...getResourcePluginServiceIdsToRestore(app)
  ]);
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
        if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
          continue;
        }
        failures.push(`${serviceId}: ${result.message}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
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
  const serviceIds = orderServiceIdsForRestore([
    ...getOptionalServiceIdsToRestore(app),
    ...getResourcePluginServiceIdsToRestore(app)
  ]);

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
      options.onProgress?.(serviceId, "starting", t("service.starting", { name: current.name }));
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
        ? t("service.startedNotRunning", { name: result.service.name })
        : result.message;
      console.warn(`[service-manager] failed to restore optional startup service ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
      options.onProgress?.(serviceId, "failed", failureMessage);
      if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${failureMessage}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
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
      options.onProgress?.(serviceId, "installing", t("service.installing", { name: current.name }));
      if (bundledAssetNeedsRefresh && current.status === "running") {
        await stopService(app, serviceId);
      }
      await installBuiltinService(app, serviceId, { source: "prepareStartupService" });
      changed = true;
      current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions());
    }

    if (current.status === "initialization-required" || shouldReinitializeMissingCoreServiceConfig(service, current)) {
      options.onProgress?.(serviceId, "initializing", t("service.initializing", { name: current.name }));
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
      message: t("service.preparedReady", { name: current.name }),
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
    const service = getService(serviceId);
    options.onStarting?.(serviceId);

    if (current.status === "running" && service.serviceMode !== "resource") {
      const message = t("service.alreadyRunning", { name: current.name });
      console.info(`[service-manager] reused running startup service ${serviceId}`);
      options.onProgress?.(serviceId, "succeeded", message);
      return {
        serviceId,
        ok: true,
        message,
        running: true
      };
    }

    options.onProgress?.(serviceId, "starting", t("service.starting", { name: current.name }));
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
    await ensureProviderRegisterApiKey(app);

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
  commandEnv: commandEnvTestInternals,
  fixShellScriptPermissions,
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  upsertEnvFileContent,
  ensurePreStartRequirements,
  resolveNodeBin,
  getStartCommandEnvOverrides,
  buildDesktopServiceCommandEnv: buildDesktopServiceCommandEnvForTests,
  getDesktopStartCommand,
  appendConfiguredServiceLifecycleArgs,
  appendDesktopManagedLayoutFlags,
  appendAgentPlatformDesktopDeployArgs,
  resolveAgentWebclientHostStartOverrides,
  buildDesktopManagedDeployCommand,
  resolveAgentPlatformDeployPublicKeySourceFile,
  getDesktopStartCommandOptions,
  getPreparedStartupStartOptions,
  resolveAcpCommandForDesktop,
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
  getResourcePluginServiceIdsToRestore,
  orderServiceIdsForRestore,
  needsBundledAssetRefresh,
  identityCenterInstallNeedsRefresh,
  resolveStartupPreparationMode,
  prepareStartupService,
  startPreparedStartupService,
  readLastRunningServices,
  watchServiceLog,
  writeLastRunningServices
};
