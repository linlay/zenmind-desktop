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
} from "./desktop-config-upgrade";import { CORE_SERVICE_IDS, ServiceCommandKind, ServiceStateReadOptions, ServiceVerificationOptions, integrationPorts } from "./index.part-1";

import { getEnvBindingTemplateValues, getServiceState, getStartupResponsiveServiceStateReadOptions, getStartupServiceStateReadOptions, renderEnvBindingTemplate } from "./index.part-2";





export function getEnvBindingDefaultValues(
  app: App,
  service: ServiceDefinition,
  binding: ServiceDefinition["desktop"]["envBindings"][number]
) {
  const values = getEnvBindingTemplateValues(app, service);
  return (binding.defaults ?? [""]).map((item) => renderEnvBindingTemplate(item, values));
}

export function resolveEnvBindingLiteralValue(app: App, service: ServiceDefinition, value: string) {
  return renderEnvBindingTemplate(value, getEnvBindingTemplateValues(app, service));
}

export async function applyEnvBindings(
  app: App,
  service: ServiceDefinition,
  env: Map<string, string>,
  updates: Map<string, string>,
  ports?: ServicesIntegrationPorts
) {
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
        const depState = await getServiceState(app, binding.fromService, { integrationPorts: ports });
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

export async function getServicePortForEnvSync(app: App, serviceId: ServiceId) {
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

export function shouldReinitializeMissingCoreServiceConfig(service: ServiceDefinition, state: ServiceState) {
  return (
    service.kind === "builtin" &&
    CORE_SERVICE_IDS.has(service.id) &&
    state.status === "config-required" &&
    state.configFiles.some((configFile) => configFile.required && !configFile.exists)
  );
}

export type RunServiceCommandOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  commandKind?: ServiceCommandKind;
  stateReadOptions?: ServiceStateReadOptions;
};

export type StartServiceOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  skipPreStartRequirements?: boolean;
  skipBuiltinAssetRefresh?: boolean;
  stateReadOptions?: ServiceStateReadOptions;
  commandStateReadOptions?: ServiceStateReadOptions;
  verificationOptions?: ServiceVerificationOptions;
};

export function getPreparedStartupStartOptions(): StartServiceOptions {
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

export function yieldStartupScheduler() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export const NODE_BIN_START_ENV_SERVICE_IDS = new Set<ServiceId>([
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID
]);

export function resolveNodeBinStartEnv() {
  const nodeBin = resolveNodeBin();
  const env: Record<string, string> = { NODE_BIN: nodeBin };
  if (nodeBin === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function getStartCommandEnvOverrides(_app: App, service: ServiceDefinition) {
  if (!NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)) {
    return undefined;
  }

  return resolveNodeBinStartEnv();
}

export function getDesktopStartCommandOptions(app: App, service: ServiceDefinition): RunServiceCommandOptions {
  return {
    refreshBuiltinAsset: false,
    env: getStartCommandEnvOverrides(app, service)
  };
}

export function buildDesktopServiceCommandEnv(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  overrides: NodeJS.ProcessEnv | undefined,
  ports?: ServicesIntegrationPorts
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
    ...integrationPorts(ports).getPluginBridgeEnv(app, service),
    ...integrationPorts(ports).getPluginSettingsEnv(app, service),
    ...(overrides ?? {})
  };
  if (service.id === "identity-center") {
    env.DESKTOP_DEVICE_ID = integrationPorts(ports).getDesktopDeviceId(app);
  }
  return env;
}

export function buildDesktopServiceCommandEnvForTests(
  app: App,
  serviceOrLayout: ServiceDefinition | ServiceLayout,
  layoutOrOverrides: ServiceLayout | NodeJS.ProcessEnv | undefined,
  overrides?: NodeJS.ProcessEnv,
  ports?: ServicesIntegrationPorts
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
    overrides,
    ports
  );
}

export function isDaemonStartArg(value: string) {
  return value.trim().toLowerCase() === "--daemon" || value.trim().toLowerCase() === "-daemon";
}

export function getDesktopStartCommand(service: Pick<ServiceDefinition, "id" | "kind" | "startCommand">) {
  if (service.kind !== "builtin" || !CORE_SERVICE_IDS.has(service.id)) {
    return service.startCommand;
  }

  let command = [...service.startCommand];
  if (service.id === "agent-platform") {
    const withoutRuntimeMode: string[] = [];
    for (let index = 0; index < command.length; index += 1) {
      const arg = command[index];
      if (arg === "--runtime-mode") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--runtime-mode=")) continue;
      withoutRuntimeMode.push(arg);
    }
    command = withoutRuntimeMode;
    const daemonIndex = command.findIndex(isDaemonStartArg);
    if (daemonIndex >= 0) command.splice(daemonIndex, 0, "--runtime-mode=desktop");
    else command.push("--runtime-mode=desktop");
  }
  if (!command.some(isDaemonStartArg)) {
    command.push("--daemon");
  }
  return command;
}
