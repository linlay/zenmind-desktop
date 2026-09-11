import type { App } from "electron";
import type {
  ServiceId,
  ServiceState,
  StartupRestoreMode
} from "../../../../shared/contracts";
import { parseEnvFileContent } from "../../../infrastructure/filesystem/env-file";
import {
  getInitializationStatePath
} from "./layout";
import {
  LOG_READ_WINDOW_BYTES,
  readLogRange
} from "../../../support/logging/service-logs";
import {
  flushStartupTimingSummary
} from "../../../support/logging/startup-timing";
import {
  identityCenterInstallNeedsRefresh
} from "./install-refresh";
import {
  resolveNodeBin,
  __testInternals as commandEnvTestInternals
} from "./command-env";
import {
  decodePowerShellCapturePayload,
  runExecFile
} from "./command-runner";
import {
  upsertEnvFileContent
} from "./env-content";
import {
  DEFAULT_STARTUP_SERVICE_IDS,
  getDefaultStartupServiceIds,
  getLastRunningServicesStatePath,
  getOptionalServiceIdsToRestore,
  getServiceIdsToRestore,
  orderServiceIdsForRestore,
  readInitializationState,
  readLastRunningServices,
  writeLastRunningServices
} from "./state-files";
import {
  fixShellScriptPermissions
} from "./program-layout";
import {
  ensureBundleAssetHealthy,
  isInstallHealthy,
  listMissingBundleEntries,
  listMissingRuntimeFiles,
  readBuiltinAssetSignature
} from "./bundle-assets";
import {
  buildProcessTreePids,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromWindowsPowerShell
} from "./process-tree";
import {
  terminateProcessList,
  terminateProcessTree
} from "./process-cleanup";
import {
  matchProcessInstallDir
} from "./process-identity";
import {
  resolveAcpCommandForDesktop
} from "./env-normalization";
import {
  __testInternals as containerEngineTestInternals,
  clearContainerEngineProbeCache,
  containerEngineAvailable,
  probeContainerEngines
} from "./container-engine";
import {
  probeHttpUrl
} from "./service-probes";
import {
  getWebUrl,
  parsePort
} from "./service-network";
import {
  readManagedPidFile
} from "./pid-files";
import {
  captureManagedProcessCleanupSnapshot,
  collectManagedRootPids,
  collectManagedServiceStopState,
  ensureManagedServiceStoppedForPlatform,
  forceStopServiceInstallDir,
  mergeCleanupTargets
} from "./managed-cleanup";
import {
  appendConfiguredServiceLifecycleArgs
} from "../lifecycle-args";
import {
  completeDesktopServiceConfigUpgrade,
  recordDesktopServiceConfigCoreHealthFailure
} from "./desktop-config-upgrade";
import { StartupPreparationOptions, StartupPreparationResult, appendAgentPlatformDesktopDeployArgs, appendAgentPlatformRuntimeResourceDeployArgs, appendDesktopConfigResetDeployArgs, integrationPorts, needsBundledAssetRefresh, resolveAgentWebclientHostStartOverrides } from "./index.part-1";
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

    await integrationPorts(options.integrationPorts).ensureProviderRegisterApiKey(app, true);

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
