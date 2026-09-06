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

import { RunServiceCommandOptions, applyEnvBindings, buildDesktopServiceCommandEnv, getServicePortForEnvSync, shouldReinitializeMissingCoreServiceConfig } from "./index.part-3";

export async function buildDesktopManagedDeployCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  layout: ServiceLayout,
  desktopConfigReset?: DesktopServiceConfigResetContext,
  ports?: ServicesIntegrationPorts
) {
  const commandWithConfiguredArgs = appendConfiguredServiceLifecycleArgs(app, service, command, "deploy");
  if (service.id === "agent-platform") {
    const [containerHubBaseUrl, publicKeySourceFile] = await Promise.all([
      getDesktopManagedAgentPlatformContainerHubBaseUrl(app),
      resolveAgentPlatformDeployPublicKeySourceFile(app, ports)
    ]);
    const desktopCommand = appendAgentPlatformDesktopDeployArgs(
      commandWithConfiguredArgs,
      app,
      layout,
      containerHubBaseUrl,
      publicKeySourceFile
    );
    return appendAgentPlatformRuntimeResourceDeployArgs(
      appendDesktopConfigResetDeployArgs(desktopCommand, desktopConfigReset),
      service,
      desktopConfigReset,
      integrationPorts(ports).getDesktopDeviceId(app)
    );
  }
  if (service.id === "agent-container-hub") {
    return appendDesktopConfigResetDeployArgs(
      appendAgentContainerHubDesktopDeployArgs(commandWithConfiguredArgs, layout),
      desktopConfigReset
    );
  }
  if (service.id === "identity-center") {
    return appendDesktopConfigResetDeployArgs(
      appendIdentityCenterDesktopDeployArgs(commandWithConfiguredArgs, layout),
      desktopConfigReset
    );
  }
  if (service.id === "agent-webclient") {
    return appendDesktopConfigResetDeployArgs(
      appendAgentWebclientDesktopDeployArgs(
        commandWithConfiguredArgs,
        layout
      ),
      desktopConfigReset
    );
  }
  return commandWithConfiguredArgs;
}

export async function ensureMutableInstallDir(
  app: App,
  service: ServiceDefinition,
  ports?: ServicesIntegrationPorts
) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id, {
      source: "ensureMutableInstallDir",
      integrationPorts: ports
    });
    return getInstallDir(app, service);
  }

  throw new Error(t("service.pluginNotImported", { name: service.name }));
}

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

export async function installBuiltinServiceInternal(
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
      if (options.skipInitialize) {
        return finalInstallDir;
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature,
        integrationPorts: options.integrationPorts
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
      if (options.skipInitialize) {
        return finalInstallDir;
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature,
        integrationPorts: options.integrationPorts
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

export async function initializeServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: {
    skipInstallRefresh?: boolean;
    assetSignatureOverride?: string;
    desktopConfigReset?: DesktopServiceConfigResetContext;
    integrationPorts?: ServicesIntegrationPorts;
  } = {}
): Promise<ServiceCommandResult> {
  const timing = beginStartupTiming("initializeServiceInternal", {
    serviceId,
    skipInstallRefresh: Boolean(options.skipInstallRefresh)
  });
  const service = getService(serviceId);
  try {
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const currentState = await getServiceState(app, serviceId, {
      integrationPorts: options.integrationPorts
    });

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
        await installBuiltinService(app, service.id, {
          force: true,
          source: "initializeServiceInternal:refresh",
          integrationPorts: options.integrationPorts
        });
      } catch (error) {
        const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          service: nextState
        };
      }

      const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
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
        const deployCommand = await buildDesktopManagedDeployCommand(
          app,
          service,
          service.deployCommand,
          layout,
          options.desktopConfigReset,
          options.integrationPorts
        );
        await runExecFile(deployCommand[0], deployCommand.slice(1), installDir, {
          env: buildDesktopServiceCommandEnv(app, service, layout, undefined, options.integrationPorts)
        });
      }
      await ensureInitializationRequirements(app, service, layout, options.integrationPorts);
      if (service.kind === "plugin" && service.serviceMode === "resource") {
        const desiredStatus = integrationPorts(options.integrationPorts).initializePluginResourceState(app, service);
        if (desiredStatus === "running") {
          await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
        }
      } else {
        await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
      }
      const assetSignature = options.assetSignatureOverride ?? readBuiltinAssetSignature(app, service);
      writeInitializationState(layout, {
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        ...(assetSignature ? { assetSignature } : {})
      });
      if (service.kind === "plugin") {
        integrationPorts(options.integrationPorts).emitPluginBridgeHook("plugin.initialized", { pluginId: service.id });
      }
    } catch (error) {
      writeInitializationState(layout, {
        version: service.version,
        status: "failed",
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
      const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
      return {
        ok: false,
        message: nextState.message,
        service: nextState
      };
    }

    const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
    return {
      ok: true,
      message: t("service.initialized", { name: service.name }),
      service: nextState
    };
  } finally {
    timing.end();
  }
}

export async function ensureInitializationRequirements(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  ports?: ServicesIntegrationPorts
) {
  if (CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates, ports);
  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

export async function initializeService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  return initializeServiceInternal(app, serviceId, { integrationPorts: ports });
}

export async function collectServiceVerification(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus,
  options: ServiceVerificationOptions = {}
): Promise<{ state: ServiceState; verification: ServiceVerification }> {
  const service = getService(serviceId);
  const state = await getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
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

export function serviceVerificationFailureMessage(actionMessage: string, verification: ServiceVerification) {
  const issues = verification.issues.length > 0
    ? verification.issues.join(t("common.listSeparator"))
    : t("service.verify.actualStatus", { status: verification.actualStatus });
  return t("service.verify.failed", { actionMessage, issues });
}

export function shouldRetryServiceVerification(
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

export function getCapabilityRequirementAction(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.action) {
    return requirement.action;
  }
  return requirement.capability ? "preload" : "waitHttp";
}

export function describeCapabilityRequirement(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.capability) {
    return `capability ${requirement.capability}`;
  }
  return `service ${requirement.service ?? "(unknown)"}`;
}

export function getDefaultRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string) {
  if (requiredService.id === "agent-platform" || requiredService.id === "agent-container-hub") {
    return normalizeProbeUrl(webUrl, "/api/runtime-info");
  }
  return webUrl;
}

export function resolveRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string, target: string | undefined) {
  const trimmed = target?.trim() ?? "";
  if (!trimmed) {
    return getDefaultRequirementHttpTarget(requiredService, webUrl);
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return trimmed;
  }
  return normalizeProbeUrl(webUrl, trimmed);
}

export function resolveAgentPlatformReadinessFallbackTarget(
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

export async function ensureRequiredServiceHttpReachable(
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

  const state = await getServiceState(app, requiredService.id, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
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
      ports: integrationPorts(options.integrationPorts),
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService, options.integrationPorts);
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

export async function applyDesktopCapabilityRequirement(
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
      ports: integrationPorts(options.integrationPorts),
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService, options.integrationPorts);
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

export async function applyDesktopCapabilityRequirements(
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

export async function collectDesktopCapabilityRequirementIssues(
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

export async function ensurePreStartRequirements(
  app: App,
  service: ServiceDefinition,
  ports?: ServicesIntegrationPorts
) {
  const layout = getServiceLayout(app, service);
  prepareServiceExecutionLayout(service, layout);

  if (service.id === "agent-platform") {
    await integrationPorts(ports).ensureProviderRegisterApiKey(app);
  }

  if (service.id !== "agent-platform") {
    await applyDesktopCapabilityRequirements(app, service, layout, "preStart", {
      integrationPorts: ports
    });
  }
}

export async function resolveAgentPlatformDeployPublicKeySourceFile(
  app: App,
  ports?: ServicesIntegrationPorts
) {
  const capability = await resolveDesktopCapability(app, "auth.publicKey", {
    ports: integrationPorts(ports),
    ensureProviderInstall: async (providerService) => {
      await ensureMutableInstallDir(app, providerService, ports);
    }
  });
  if (capability.filePath && fs.existsSync(capability.filePath) && fs.statSync(capability.filePath).isFile()) {
    return capability.filePath;
  }

  throw new Error("auth.publicKey capability did not produce a usable local public key file.");
}

export async function getDesktopManagedAgentPlatformContainerHubBaseUrl(app: App) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  return `http://127.0.0.1:${hubPort || getService("agent-container-hub").web.defaultPort}`;
}
