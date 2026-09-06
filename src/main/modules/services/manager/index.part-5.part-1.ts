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

import { StartupPreparationOptions, backgroundStartupPreparationTasks, getDesktopManagedCommandPort, integrationPorts, isHostManagedService, needsBundledAssetRefresh, resolveAgentWebclientHostStartOverrides, startedThisSession } from "./index.part-1";

import { getServiceState, getStartupResponsiveServiceStateReadOptions, getStartupServiceStateReadOptions } from "./index.part-2";

import { StartServiceOptions, getDesktopStartCommand, getDesktopStartCommandOptions, getPreparedStartupStartOptions, shouldReinitializeMissingCoreServiceConfig, yieldStartupScheduler } from "./index.part-3";

import { StartupPipelineOptions, StartupPreparationServiceResult, StartupServiceResult, attachServiceVerification, ensurePreStartRequirements, getResourcePluginServiceIdsToRestore, initializeService, initializeServiceInternal, installBuiltinService, installedBuiltinNeedsStartupRepair, isResourcePluginServiceId, runServiceCommand, stopService } from "./index.part-4";

import { startService, startServiceInternal } from "./index.part-5.part-2";

export async function restoreOptionalStartupServices(
  app: App,
  options: StartupPipelineOptions = {}
) {
  const started: ServiceId[] = [];
  const failures: string[] = [];
  const serviceIds = orderServiceIdsForRestore([
    ...getOptionalServiceIdsToRestore(app),
    ...getResourcePluginServiceIdsToRestore(app, options.integrationPorts)
  ]);

  for (const serviceId of serviceIds) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId, {
        integrationPorts: options.integrationPorts
      });
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
      const result = await startService(app, serviceId, options.integrationPorts);
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

export function isStartupPreparationBlockingStatus(status: ServiceState["status"]) {
  return (
    status === "not-installed" ||
    status === "initialization-required" ||
    status === "config-required" ||
    status === "dependency-missing" ||
    status === "error"
  );
}

export async function resolveStartupPreparationMode(
  app: App,
  ports?: ServicesIntegrationPorts
): Promise<StartupRestoreMode> {
  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const service = getService(serviceId);
    const current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions({
      integrationPorts: ports
    }));
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

export async function prepareStartupService(
  app: App,
  serviceId: ServiceId,
  options: StartupPipelineOptions = {}
): Promise<StartupPreparationServiceResult> {
  let changed = false;
  try {
    const service = getService(serviceId);
    let current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions({
      integrationPorts: options.integrationPorts
    }));
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
        await stopService(app, serviceId, options.integrationPorts);
      }
      await installBuiltinService(app, serviceId, {
        source: "prepareStartupService",
        integrationPorts: options.integrationPorts
      });
      changed = true;
      current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions({
        integrationPorts: options.integrationPorts
      }));
    }

    if (current.status === "initialization-required" || shouldReinitializeMissingCoreServiceConfig(service, current)) {
      options.onProgress?.(serviceId, "initializing", t("service.initializing", { name: current.name }));
      changed = true;
      const initialization = await initializeService(app, serviceId, options.integrationPorts);
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

    await ensurePreStartRequirements(app, service, options.integrationPorts);
    current = await getServiceState(app, serviceId, getStartupServiceStateReadOptions({
      integrationPorts: options.integrationPorts
    }));
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

export async function startPreparedStartupService(
  app: App,
  serviceId: ServiceId,
  options: StartupPipelineOptions = {}
): Promise<StartupServiceResult> {
  try {
    const current = await getServiceState(app, serviceId, {
      ...getStartupResponsiveServiceStateReadOptions(),
      integrationPorts: options.integrationPorts
    });
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
    const result = await startServiceInternal(app, serviceId, {
      ...getPreparedStartupStartOptions(),
      integrationPorts: options.integrationPorts
    });
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

export async function prepareInstallOnlyStartupServices(
  app: App,
  options: Pick<StartupPreparationOptions, "integrationPorts" | "onProgress"> = {}
) {
  for (const serviceId of INSTALL_ONLY_STARTUP_SERVICE_IDS) {
    try {
      const result = await prepareStartupService(app, serviceId, {
        integrationPorts: options.integrationPorts,
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

export async function startOptionalAutoStartupServices(
  app: App,
  options: Pick<StartupPreparationOptions, "integrationPorts" | "onStarting" | "onProgress"> = {}
) {
  for (const serviceId of OPTIONAL_AUTO_STARTUP_SERVICE_IDS) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }
    try {
      const prepared = await prepareStartupService(app, serviceId, {
        integrationPorts: options.integrationPorts,
        onProgress: options.onProgress
      });
      if (!prepared.ok) {
        console.warn(`[service-manager] optional auto-start service ${serviceId} is unavailable: ${prepared.message}`);
        continue;
      }

      const started = await startPreparedStartupService(app, serviceId, {
        integrationPorts: options.integrationPorts,
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

export function startOptionalAutoStartupServicesInBackground(
  app: App,
  options: Pick<StartupPreparationOptions, "integrationPorts" | "onStarting" | "onProgress"> = {}
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

export function trackBackgroundStartupPreparation(task: Promise<void>) {
  const trackedTask = task.finally(() => {
    backgroundStartupPreparationTasks.delete(trackedTask);
  });
  backgroundStartupPreparationTasks.add(trackedTask);
}

export function prepareInstallOnlyStartupServicesInBackground(
  app: App,
  options: Pick<StartupPreparationOptions, "integrationPorts" | "onProgress"> = {}
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

export async function waitForBackgroundStartupPreparations() {
  await Promise.allSettled([...backgroundStartupPreparationTasks]);
}

export async function stopServiceForDesktopConfigUpgrade(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
) {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId, {
    ...getStartupResponsiveServiceStateReadOptions(),
    integrationPorts: ports
  });
  if (isHostManagedService(service)) {
    await stopAgentWebclientHost(service.id);
    if (getAgentWebclientHostState(service.id)?.running) {
      throw new Error(`${serviceId} host process is still running`);
    }
    return;
  }
  if (!current.installed) {
    return;
  }
  if (current.status === "running") {
    const result = await stopService(app, serviceId, ports);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  const layout = getServiceLayout(app, service);
  const env = fs.existsSync(layout.envPath) ? readEnvFile(layout.envPath) : new Map<string, string>();
  const stopState = collectManagedServiceStopState(service, layout, env);
  const survivingPids = [
    stopState.managedMainPid,
    ...stopState.managedPortPids
  ].filter((pid): pid is number => typeof pid === "number");
  if (survivingPids.length > 0) {
    throw new Error(`${serviceId} process is still running (pid=${[...new Set(survivingPids)].join(", ")})`);
  }
}

export async function runDesktopServiceConfigUpgradePreparation(
  app: App,
  desktopVersion: string,
  options: StartupPreparationOptions,
  onBegin: () => void
) {
  const isDevelopmentApp = isDesktopDevelopmentRuntime(app);
  const currentDesktopDefaultPorts = Object.fromEntries(
    DESKTOP_SERVICE_CONFIG_UPGRADE_IDS.map((serviceId) => {
      const service = getService(serviceId);
      return [serviceId, service.web.defaultPort];
    })
  );
  return prepareDesktopServiceConfigUpgrade(app, desktopVersion, {
    currentDesktopDefaultPorts,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    onBegin,
    onProgress: (serviceId, message) => {
      options.onProgress?.(serviceId, "initializing", message);
    },
    prepareDesktopConfiguration: async (context) => {
      let validated;
      let journalInputError = "";
      if (isDevelopmentApp && context.sourceZipPath && fs.existsSync(context.sourceZipPath)) {
        try {
          validated = await validateSelectedEnvZipForDesktopVersionUpgrade(
            app,
            context.sourceZipPath,
            context.toVersion,
            process.platform
          );
        } catch (error) {
          journalInputError = error instanceof Error ? error.message : String(error);
        }
      }
      if (isDevelopmentApp && !validated && options.desktopVersionUpgradeEnvZipPath) {
        try {
          validated = await validateSelectedEnvZipForDesktopVersionUpgrade(
            app,
            options.desktopVersionUpgradeEnvZipPath,
            context.toVersion,
            process.platform
          );
        } catch (error) {
          return { inputRequired: { message: error instanceof Error ? error.message : String(error) } };
        }
      } else if (isDevelopmentApp && !validated && context.sourceZipPath) {
        return {
          inputRequired: {
            message: journalInputError || t("startup.envImport.versionChangeStagedMissing", {
              expected: context.expectedSha256 ?? ""
            })
          }
        };
      } else if (isDevelopmentApp && !validated && !bundledEnvZipExists(app, process.platform)) {
        return { inputRequired: { message: "" } };
      } else if (!validated) {
        validated = await validateBundledEnvForDesktopVersionUpgrade(app, process.platform, {
          expectedDesktopVersion: context.toVersion
        });
      }

      if (
        context.expectedSha256 &&
        context.expectedSha256.toLowerCase() !== validated.sha256.toLowerCase()
      ) {
        if (isDevelopmentApp) {
          return {
            inputRequired: {
              message: t("startup.envImport.versionChangeShaMismatch", {
                expected: context.expectedSha256.toLowerCase(),
                actual: validated.sha256.toLowerCase()
              })
            }
          };
        }
        throw new Error(
          `bundled env.zip changed during the unfinished upgrade: expected ${context.expectedSha256}, got ${validated.sha256}`
        );
      }

      if (isDevelopmentApp) {
        validated = await stageValidatedDesktopVersionUpgradeInput(
          validated,
          context.inputDir,
          process.platform
        );
      }
      if (context.apply) {
        try {
          if (!options.applyDesktopConfiguration) {
            throw new Error("Desktop configuration upgrade adapter is unavailable.");
          }
          options.applyDesktopConfiguration(
            app,
            validated.desktopInit,
            context.backupDir,
            process.platform
          );
        } catch (error) {
          if (isDevelopmentApp && options.desktopVersionUpgradeEnvZipPath) {
            fs.rmSync(validated.sourceZipPath, { force: true });
            return { inputRequired: { message: error instanceof Error ? error.message : String(error) } };
          }
          throw error;
        }
      }
      return {
        sourceZipPath: validated.sourceZipPath,
        ...(validated.previousSourceZipPath
          ? { previousSourceZipPath: validated.previousSourceZipPath }
          : {}),
        sha256: validated.sha256,
        size: validated.size
      };
    },
    stopService: (serviceId) => stopServiceForDesktopConfigUpgrade(
      app,
      serviceId,
      options.integrationPorts
    ),
    installCurrentService: async (serviceId) => {
      await installBuiltinService(app, serviceId, {
        source: "desktop-service-config-upgrade",
        skipInitialize: true,
        integrationPorts: options.integrationPorts
      });
    },
    resetServiceConfig: async (serviceId, context) => {
      const result = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        desktopConfigReset: context,
        integrationPorts: options.integrationPorts
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
    }
  });
}

export async function importEnvZipIntoExistingRuntime(
  app: App,
  zipPath: string,
  desktopVersion: string,
  platform: NodeJS.Platform = process.platform,
  applyDesktopConfiguration?: StartupPreparationOptions["applyDesktopConfiguration"]
) {
  const validated = await validateEnvZipForDesktopManualImport(
    app,
    zipPath,
    desktopVersion,
    platform
  );
  const backupDir = path.join(
    getDataRoot(app, platform),
    "config",
    "service-backups",
    "manual-env-import",
    String(Date.now()),
    "desktop"
  );
  if (!applyDesktopConfiguration) {
    throw new Error("Desktop configuration upgrade adapter is unavailable.");
  }
  applyDesktopConfiguration(app, validated.desktopInit, backupDir, platform);
  const currentDesktopDefaultPorts = Object.fromEntries(
    DESKTOP_SERVICE_CONFIG_UPGRADE_IDS.map((serviceId) => [
      serviceId,
      getService(serviceId).web.defaultPort
    ])
  );
  const ports = rewriteServicePortDefaultsForDesktopConfigUpgrade(
    app,
    currentDesktopDefaultPorts,
    platform
  );
  rewriteServiceLifecycleArgsForDesktopConfigUpgrade(
    app,
    ports.services["agent-platform"].defaultPort,
    platform
  );
  await stopServiceForDesktopConfigUpgrade(app, "agent-platform");
  await installBuiltinService(app, "agent-platform", {
    source: "manual-env-import",
    skipInitialize: true
  });
  const result = await initializeServiceInternal(app, "agent-platform", {
    skipInstallRefresh: true,
    desktopConfigReset: {
      desktopConfigReset: false,
      backupDir: "",
      fromVersion: desktopVersion,
      toVersion: desktopVersion,
      runtimeResourceSource: validated.sourceZipPath,
      ...(validated.previousSourceZipPath
        ? { runtimeResourcePreviousSource: validated.previousSourceZipPath }
        : {}),
      runtimeResourceMode: "manual-import"
    }
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return {
    copiedFiles: 0,
    skippedFiles: 0,
    platformResourcesMigrated: true,
    sourceZipPath: validated.sourceZipPath,
    sha256: validated.sha256
  };
}
