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
} from "./desktop-config-upgrade";import { StartupPreparationOptions, StartupPreparationResult, appendAgentPlatformDesktopDeployArgs, appendAgentPlatformRuntimeResourceDeployArgs, appendDesktopConfigResetDeployArgs, integrationPorts, needsBundledAssetRefresh, resolveAgentWebclientHostStartOverrides } from "./index.part-1";

import { appendDesktopManagedLayoutFlags, buildVerificationResult } from "./index.part-2";

import { buildDesktopServiceCommandEnvForTests, getDesktopStartCommand, getDesktopStartCommandOptions, getPreparedStartupStartOptions, getStartCommandEnvOverrides } from "./index.part-3";

import { buildDesktopManagedDeployCommand, ensurePreStartRequirements, getResourcePluginServiceIdsToRestore, getShutdownStopCommandTimeoutMs, resolveAgentPlatformDeployPublicKeySourceFile, resolveAgentPlatformReadinessFallbackTarget, verifyServiceState, watchServiceLog } from "./index.part-4";

import { prepareInstallOnlyStartupServicesInBackground, prepareStartupService, resolveStartupPreparationMode, restoreOptionalStartupServices, runDesktopServiceConfigUpgradePreparation, runServiceRestart, startOptionalAutoStartupServicesInBackground, startPreparedStartupService, waitForBackgroundStartupPreparations } from "./index.part-5";





export async function runStartupPreparation(
  app: App,
  options: StartupPreparationOptions = {}
): Promise<StartupPreparationResult> {
  try {
    let modeResolved = false;
    const resolveMode = (mode: StartupRestoreMode) => {
      if (modeResolved) {
        return;
      }
      modeResolved = true;
      options.onModeResolved?.(mode);
    };
    const desktopConfigUpgrade = options.desktopVersion
      ? await runDesktopServiceConfigUpgradePreparation(
          app,
          options.desktopVersion,
          options,
          () => resolveMode("bootstrap")
        )
      : null;
    if (desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none") {
      resolveMode("bootstrap");
    }
    if (desktopConfigUpgrade?.inputRequired) {
      return {
        mode: "bootstrap",
        started: [],
        failures: [],
        preparedChanged: false,
        inputRequired: {
          request: {
            reason: "desktop-version-change",
            fromVersion: desktopConfigUpgrade.inputRequired.fromVersion,
            toVersion: desktopConfigUpgrade.inputRequired.toVersion
          },
          message: desktopConfigUpgrade.inputRequired.message
        }
      };
    }
    if (desktopConfigUpgrade && desktopConfigUpgrade.failures.length > 0) {
      return {
        mode: "bootstrap",
        started: [],
        failures: desktopConfigUpgrade.failures,
        preparedChanged: true
      };
    }

    await integrationPorts(options.integrationPorts).ensureProviderRegisterApiKey(app);

    const initialMode = desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none"
      ? "bootstrap"
      : await resolveStartupPreparationMode(app, options.integrationPorts);
    resolveMode(initialMode);
    const started: ServiceId[] = [];
    const failures: string[] = [];

    const preparedDefaultServices = new Map<ServiceId, ServiceState>();
    const preparationResults = await Promise.all(
      DEFAULT_STARTUP_SERVICE_IDS.map((serviceId) =>
        prepareStartupService(app, serviceId, {
          integrationPorts: options.integrationPorts,
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
      integrationPorts: options.integrationPorts,
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
    const coreFailures: string[] = [];
    for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
      const result = startResultById.get(serviceId);
      if (!result) {
        continue;
      }
      if (result.ok && result.running) {
        started.push(serviceId);
      } else {
        const failure = `${serviceId}: ${result.message}`;
        failures.push(failure);
        coreFailures.push(failure);
      }
    }

    for (const failure of failures) {
      if (!coreFailures.includes(failure)) {
        coreFailures.push(failure);
      }
    }

    if (desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none") {
      if (coreFailures.length > 0) {
        recordDesktopServiceConfigCoreHealthFailure(
          app,
          desktopConfigUpgrade.desktopVersion,
          coreFailures
        );
      } else {
        try {
          completeDesktopServiceConfigUpgrade(app, desktopConfigUpgrade.desktopVersion);
        } catch (error) {
          const failure = `service config version commit: ${error instanceof Error ? error.message : String(error)}`;
          failures.push(failure);
          coreFailures.push(failure);
          recordDesktopServiceConfigCoreHealthFailure(
            app,
            desktopConfigUpgrade.desktopVersion,
            [failure]
          );
        }
      }
    }

    const optionalRestoreResult = await restoreOptionalStartupServices(app, {
      integrationPorts: options.integrationPorts,
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    started.push(...optionalRestoreResult.started);
    failures.push(...optionalRestoreResult.failures);
    prepareInstallOnlyStartupServicesInBackground(app, {
      integrationPorts: options.integrationPorts,
      onProgress: options.onProgress
    });
    startOptionalAutoStartupServicesInBackground(app, {
      integrationPorts: options.integrationPorts,
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });

    return {
      mode: initialMode === "bootstrap" || preparedChanged || desktopConfigUpgrade?.mode === "version-change"
        ? "bootstrap"
        : "restore",
      started,
      failures,
      preparedChanged: preparedChanged || Boolean(desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none")
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
  containerEngine: containerEngineTestInternals,
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
  appendAgentPlatformRuntimeResourceDeployArgs,
  appendDesktopConfigResetDeployArgs,
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
