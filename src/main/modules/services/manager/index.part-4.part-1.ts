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
  StartupRestoreServicePhase,
  StartupEnvImportRequest
} from "../../../../shared/contracts";

import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";

import { getAllServices, getService } from "../service-registry";

import type { ServicesIntegrationPorts } from "../integration-ports";

import { readEnvFile, parseEnvFileContent } from "../../../infrastructure/filesystem/env-file";

import { extractArchiveToDir } from "../../../support/archive/archive-utils";

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
} from "../../../support/logging/service-logs";

import {
  beginStartupTiming,
  flushStartupTimingSummary
} from "../../../support/logging/startup-timing";

import {
  identityCenterInstallNeedsRefresh,
  serviceInstallNeedsRefresh
} from "./install-refresh";

import {
  resolveNodeBin,
  __testInternals as commandEnvTestInternals
} from "./command-env";

import {
  decodePowerShellCapturePayload,
  runExecFile,
  SERVICE_COMMAND_TIMEOUT_MS
} from "./command-runner";

import { t } from "../../../support/i18n/main-i18n";

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
  __testInternals as containerEngineTestInternals,
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
  rewriteServiceLifecycleArgsForDesktopConfigUpgrade,
  type ServiceLifecycleCommandKind
} from "../lifecycle-args";

import { rewriteServicePortDefaultsForDesktopConfigUpgrade } from "../port-defaults";

import { getDataRoot, getDesktopSsoAccessTokenFilePath } from "../../../infrastructure/filesystem/user-paths";

import {
  bundledEnvZipExists,
  stageValidatedDesktopVersionUpgradeInput,
  validateBundledEnvForDesktopVersionUpgrade,
  validateEnvZipForDesktopManualImport,
  validateSelectedEnvZipForDesktopVersionUpgrade
} from "../../../infrastructure/filesystem/runtime-environment";

import { isDesktopDevelopmentRuntime } from "../../../infrastructure/electron/development-runtime";

import {
  completeDesktopServiceConfigUpgrade,
  DESKTOP_SERVICE_CONFIG_UPGRADE_IDS,
  prepareDesktopServiceConfigUpgrade,
  recordDesktopServiceConfigCoreHealthFailure,
  type DesktopServiceConfigResetContext
} from "./desktop-config-upgrade";

import { CORE_SERVICE_IDS, SHUTDOWN_SERVICE_STOP_TIMEOUT_MS, ServiceLogStreamCallback, ServiceVerificationOptions, StartupPreparationProgressPhase, WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS, appendAgentContainerHubDesktopDeployArgs, appendAgentPlatformDesktopDeployArgs, appendAgentPlatformRuntimeResourceDeployArgs, appendAgentWebclientDesktopDeployArgs, appendDesktopConfigResetDeployArgs, appendIdentityCenterDesktopDeployArgs, copyDirectoryAssetToTempRoot, ensureDir, inFlightBuiltinInstalls, integrationPorts, isAssetNewerThanInstall, isDirectoryAssetPath, isHostManagedService, prepareServiceExecutionLayout, startedThisSession } from "./index.part-1";

import { InstallBuiltinServiceOptions, appendDesktopManagedLayoutFlags, buildVerificationResult, createBuiltinInstallKey, ensureDefaultConfig, getDependencyRunningVerificationTimeoutMs, getServiceState, hasVerifyRunningRequirements, listServices } from "./index.part-2";

import { RunServiceCommandOptions, applyEnvBindings, buildDesktopServiceCommandEnv, getServicePortForEnvSync, shouldReinitializeMissingCoreServiceConfig } from "./index.part-3";import { ensureMutableInstallDir } from "./index.part-4.part-2";

import { attachServiceVerification, runServiceCommand } from "./index.part-4.part-3";



export async function stopService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId, { integrationPorts: ports });
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
    await integrationPorts(ports).stopPluginResources(app, service);
    const result = {
      ok: true,
      message: t("service.stopped", { name: service.name }),
      service: await getServiceState(app, serviceId, { integrationPorts: ports })
    } satisfies ServiceCommandResult;
    if (service.kind === "plugin") {
      integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: result.service });
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
      service: await getServiceState(app, serviceId, { integrationPorts: ports })
    } satisfies ServiceCommandResult;
    const verified = await attachServiceVerification(
      app,
      serviceId,
      result,
      "stopped",
      t("service.stopCommandExecuted", { name: service.name }),
      { integrationPorts: ports }
    );
    if (service.kind === "plugin" && verified.ok) {
      integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
    }
    return verified;
  }

  const result = await runServiceCommand(app, service, service.stopCommand, t("service.stopped", { name: service.name }), {
    refreshBuiltinAsset: false,
    commandKind: "stop",
    integrationPorts: ports
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

  const verified = await attachServiceVerification(
    app,
    serviceId,
    result,
    "stopped",
    t("service.stopCommandExecuted", { name: service.name }),
    { integrationPorts: ports }
  );
  if (service.kind === "plugin" && verified.ok) {
    integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
  }
  return verified;
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
  content: string,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }
  const installDir = await ensureMutableInstallDir(app, service, ports);
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
    service: await getServiceState(app, serviceId, { integrationPorts: ports })
  };
  if (service.kind === "plugin") {
    integrationPorts(ports).emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key, service: result.service });
  }
  return result;
}

export async function importServiceFile(
  app: App,
  serviceId: ServiceId,
  targetKey: string,
  sourcePath: string,
  ports?: ServicesIntegrationPorts
): Promise<ServiceImportResult> {
  const service = getService(serviceId);
  const target = service.importTargets.find((item) => item.key === targetKey);
  if (!target) {
    throw new Error(`unknown import target: ${targetKey}`);
  }

  const installDir = await ensureMutableInstallDir(app, service, ports);
  const layout = getServiceLayout(app, service);

  const targetPath = resolveConfigPath(layout, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  prepareServiceExecutionLayout(service, layout);

  const result = {
    ok: true,
    message: t("service.imported", { label: target.label }),
    targetPath,
    service: await getServiceState(app, serviceId, { integrationPorts: ports })
  };
  if (service.kind === "plugin") {
    integrationPorts(ports).emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key: targetKey, service: result.service });
  }
  return result;
}

export async function getServiceLogsMeta(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceLogsMeta> {
  const state = await getServiceState(app, serviceId, { integrationPorts: ports });
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
  options: ServiceLogReadOptions = {},
  ports?: ServicesIntegrationPorts
): Promise<ServiceLogReadResult> {
  const state = await getServiceState(app, serviceId, { integrationPorts: ports });
  const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;
  return readServiceLogFile(filePath, options);
}

export function watchServiceLog(
  app: App,
  subscriptionId: string,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogStreamOptions = {},
  onEvent: ServiceLogStreamCallback,
  ports?: ServicesIntegrationPorts
) {
  let currentPath = "";
  let currentOffset = normalizeLogStreamOffset(options);
  let currentExists = false;
  let polling = false;
  let stopped = false;

  async function sendReset(message: string) {
    const result = await readServiceLog(app, serviceId, target, {}, ports);
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
      const state = await getServiceState(app, serviceId, { integrationPorts: ports });
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

export async function stopStartedServices(app: App, ports?: ServicesIntegrationPorts) {
  for (const serviceId of [...startedThisSession]) {
    try {
      await stopService(app, serviceId, ports);
    } catch (error) {
      console.error(`failed to stop ${serviceId} during app shutdown`, error);
    }
  }
}

export async function stopRunningServices(app: App, ports?: ServicesIntegrationPorts) {
  const services = await listServices(app, ports);
  const runningServices = services.filter((service) => service.status === "running");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );
  const failures: string[] = [];

  for (const service of runningServices) {
    try {
      await stopService(app, service.id, ports);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${service.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(t("service.stopRunningFailed", { message: failures.join(t("common.listSeparator")) }));
  }
}

export type ShutdownServiceStopResult = {
  ok: boolean;
  serviceId: ServiceId;
  serviceName: string;
  elapsedMs: number;
  message: string;
};

export function getShutdownStopCommandTimeoutMs(timeoutMs: number | undefined, platform: NodeJS.Platform | string = process.platform) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : platform === "win32"
      ? WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS
      : SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function stopServiceForShutdown(
  app: App,
  serviceState: ServiceState,
  timeoutMs: number,
  ports?: ServicesIntegrationPorts
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
        timeoutMs,
        integrationPorts: ports
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
  options: { stopCommandTimeoutMs?: number; integrationPorts?: ServicesIntegrationPorts } = {}
) {
  const startedAt = Date.now();
  const timeoutMs = getShutdownStopCommandTimeoutMs(options.stopCommandTimeoutMs);
  const services = await listServices(app, options.integrationPorts);
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
      runningServicePorts: runningServices.flatMap((service) =>
        service.healthMeta.port
          ? [{ serviceId: service.id, port: service.healthMeta.port }]
          : []
      ),
      stopped: [] as ShutdownServiceStopResult[],
      failures: [] as ShutdownServiceStopResult[]
    };
  }

  const results = await Promise.all(
    servicesToStop.map((service) => stopServiceForShutdown(
      app,
      service,
      timeoutMs,
      options.integrationPorts
    ))
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
    runningServicePorts: runningServices.flatMap((service) =>
      service.healthMeta.port
        ? [{ serviceId: service.id, port: service.healthMeta.port }]
        : []
    ),
    stopped,
    failures
  };
}

export function getResourcePluginServiceIdsToRestore(app: App, ports?: ServicesIntegrationPorts) {
  return getAllServices()
    .filter((service) =>
      service.kind === "plugin" &&
      service.serviceMode === "resource" &&
      integrationPorts(ports).readPluginResourceDesiredStatus(app, service) === "running"
    )
    .map((service) => service.id);
}

export function isResourcePluginServiceId(serviceId: ServiceId) {
  try {
    const service = getService(serviceId);
    return service.kind === "plugin" && service.serviceMode === "resource";
  } catch {
    return false;
  }
}

export type StartupPipelineOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
};

export type StartupServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  running: boolean;
};

export type StartupPreparationServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  changed: boolean;
  service?: ServiceState;
};

export function installedBuiltinNeedsStartupRepair(app: App, service: ServiceDefinition, current: ServiceState) {
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
