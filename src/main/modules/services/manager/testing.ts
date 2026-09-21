import { LOG_READ_WINDOW_BYTES, readLogRange } from "../../../support/logging/service-logs";
import { parseEnvFileContent } from "../../../infrastructure/filesystem/env-file";
import { parsePort, getWebUrl } from "./service-network";
import {
  containerEngineAvailable,
  probeContainerEngines,
  __testInternals as containerEngineTestInternals,
  clearContainerEngineProbeCache
} from "./container-engine";
import { __testInternals as commandEnvTestInternals, resolveNodeBin } from "./command-env";
import { fixShellScriptPermissions } from "./program-layout";
import {
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  readBuiltinAssetSignature
} from "./bundle-assets";
import { upsertEnvFileContent } from "./env-content";
import { ensurePreStartRequirements, resolveAgentPlatformReadinessFallbackTarget } from "./capability-requirements";
import { getStartCommandEnvOverrides, buildDesktopServiceCommandEnvForTests, getDesktopStartCommandOptions } from "./command-environment";
import {
  getDesktopStartCommand,
  appendDesktopManagedLayoutFlags,
  appendAgentPlatformDesktopDeployArgs,
  appendAgentPlatformRuntimeResourceDeployArgs,
  appendDesktopConfigResetDeployArgs
} from "./lifecycle-command-policy";
import { appendConfiguredServiceLifecycleArgs } from "../lifecycle-args";
import { resolveAgentWebclientHostStartOverrides } from "./host-policy";
import { buildDesktopManagedDeployCommand, resolveAgentPlatformDeployPublicKeySourceFile } from "./installation";
import { getPreparedStartupStartOptions } from "./startup-options";
import { resolveAcpCommandForDesktop } from "./env-normalization";
import { parseProcessTreeRowsFromPs, parseProcessTreeRowsFromWindowsPowerShell, buildProcessTreePids } from "./process-tree";
import {
  collectManagedRootPids,
  captureManagedProcessCleanupSnapshot,
  mergeCleanupTargets,
  collectManagedServiceStopState,
  forceStopServiceInstallDir,
  ensureManagedServiceStoppedForPlatform
} from "./managed-cleanup";
import { terminateProcessTree, terminateProcessList } from "./process-cleanup";
import { getShutdownStopCommandTimeoutMs } from "./shutdown";
import { decodePowerShellCapturePayload, runExecFile } from "./command-runner";
import { runServiceRestart } from "./service-start";
import {
  waitForBackgroundStartupPreparations,
  resolveStartupPreparationMode,
  prepareStartupService,
  startPreparedStartupService
} from "./startup-services";
import { probeHttpUrl } from "./service-probes";
import { verifyServiceState } from "./verification";
import { buildVerificationResult } from "./verification-policy";
import { matchProcessInstallDir } from "./process-identity";
import { readManagedPidFile } from "./pid-files";
import { getInitializationStatePath } from "./layout";
import {
  readInitializationState,
  getLastRunningServicesStatePath,
  getDefaultStartupServiceIds,
  getServiceIdsToRestore,
  getOptionalServiceIdsToRestore,
  orderServiceIdsForRestore,
  readLastRunningServices,
  writeLastRunningServices
} from "./state-files";
import { getResourcePluginServiceIdsToRestore } from "./restore-policy";
import { needsBundledAssetRefresh } from "./execution-layout";
import { identityCenterInstallNeedsRefresh } from "./install-refresh";
import { watchServiceLog } from "./log-stream";

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
