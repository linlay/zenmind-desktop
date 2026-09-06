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

import { RunServiceCommandOptions, applyEnvBindings, buildDesktopServiceCommandEnv, getServicePortForEnvSync, shouldReinitializeMissingCoreServiceConfig } from "./index.part-3";import { installBuiltinService, serviceVerificationFailureMessage, verifyServiceState } from "./index.part-4.part-2";



export async function runServiceCommand(
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
        await installBuiltinService(app, service.id, {
          source: "runServiceCommand:missing-install",
          integrationPorts: options.integrationPorts
        });
      } else if (assetPath && isAssetNewerThanInstall(assetPath, getServiceLayout(app, service), app, service)) {
        await installBuiltinService(app, service.id, {
          source: "runServiceCommand:asset-newer",
          integrationPorts: options.integrationPorts
        });
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
      await installBuiltinService(app, service.id, {
        source: "runServiceCommand:repair-install",
        integrationPorts: options.integrationPorts
      });
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
      app,
      service,
      commandWithConfiguredArgs,
      layout,
      options.commandKind ?? "start"
    );
    await runExecFile(commandForExec[0], commandForExec.slice(1), installDir, {
      timeoutMs: options.timeoutMs,
      env: buildDesktopServiceCommandEnv(app, service, layout, options.env, options.integrationPorts)
    });
    return {
      ok: true,
      message: successMessage,
      service: await getServiceState(app, service.id, {
        ...options.stateReadOptions,
        integrationPorts: options.integrationPorts
      })
    } satisfies ServiceCommandResult;
  } finally {
    timing.end();
  }
}

export async function attachServiceVerification(
  app: App,
  serviceId: ServiceId,
  result: ServiceCommandResult,
  desired: ServiceDesiredStatus,
  actionMessage: string,
  options: ServiceVerificationOptions = {}
): Promise<ServiceCommandResult> {
  const verification = await verifyServiceState(app, serviceId, desired, options);
  const service = await getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
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
