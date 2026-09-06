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
} from "./desktop-config-upgrade";import { DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS, ServiceCommandKind, ServiceStateReadOptions, ServiceVerificationOptions, ensureDir, getDesktopManagedCommandPort, getDesktopManagedContainerHubBindAddr, integrationPorts, isHostManagedService } from "./index.part-1";





export function appendDesktopManagedLayoutFlags(
  app: App,
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
      "--port", String(getDesktopManagedCommandPort(service)),
      "--identity-file", getDesktopSsoAccessTokenFilePath(app)
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

export async function collectPrerequisites(
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
    const engineProbe = await probeContainerEngines({
      cache: options.cacheContainerEngineProbe !== false
    });
    if (!engineProbe.engine) {
      const unsafe = engineProbe.probes.filter((probe) => probe.failure === "unsafe-location");
      const timedOut = engineProbe.probes.filter((probe) =>
        probe.failure === "timeout" || probe.failure === "path-timeout"
      );
      const installed = engineProbe.probes.filter((probe) => probe.installed);
      if (unsafe.length > 0) {
        const names = unsafe.map((probe) => probe.engine).join(" / ");
        const locations = unsafe.map((probe) => probe.command).filter(Boolean).join(" / ");
        prerequisites.push(t("service.containerEngineUnsafeLocation", { names, locations }));
      } else if (timedOut.length > 0) {
        const names = timedOut.map((probe) => probe.engine).join(" / ");
        prerequisites.push(t("service.containerEngineProbeTimedOut", { names }));
      } else if (installed.length > 0) {
        const names = installed.map((probe) => probe.engine).join(" / ");
        prerequisites.push(t("service.containerEngineInstalledNotConnected", { names }));
      } else {
        prerequisites.push(t("service.containerEngineMissing"));
      }
    }
  }

  return prerequisites;
}

export function ensureDefaultConfig(service: ServiceDefinition, layout: ServiceLayout) {
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

export type InstallBuiltinServiceOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  force?: boolean;
  archivePath?: string;
  source?: string;
  skipInitialize?: boolean;
};

export function createBuiltinInstallKey(app: App, service: ServiceDefinition, options: InstallBuiltinServiceOptions) {
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
    options.skipInitialize ? "skip-initialize" : "initialize",
    assetScope
  ].join("\0");
}

export function shouldUseResponsiveServiceState(options: ServiceStateReadOptions = {}) {
  return process.platform === "win32" && options.mode === "responsive";
}

export function getResponsiveServiceStateReadOptions(): ServiceStateReadOptions {
  return process.platform === "win32" ? { mode: "responsive" } : {};
}

export function getStartupServiceStateReadOptions(
  options: ServiceStateReadOptions = {}
): ServiceStateReadOptions {
  return {
    ...options,
    cacheContainerEngineProbe: true
  };
}

export function getStartupResponsiveServiceStateReadOptions(): ServiceStateReadOptions {
  return getStartupServiceStateReadOptions(getResponsiveServiceStateReadOptions());
}

export async function listServices(app: App, ports?: ServicesIntegrationPorts) {
  const readOptions = {
    ...getResponsiveServiceStateReadOptions(),
    integrationPorts: ports
  };
  return Promise.all(getAllServices().map((service) => getServiceState(app, service.id, readOptions)));
}

export async function getResponsiveServiceState(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceState> {
  return getServiceState(app, serviceId, {
    ...getResponsiveServiceStateReadOptions(),
    integrationPorts: ports
  });
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
      ? await collectPrerequisites(app, service, layout, {
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
    if (integrationPorts(options.integrationPorts).readPluginResourceDesiredStatus(app, service) === "running") {
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

export function buildVerificationResult(
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

export function getInstallDirFromState(state: ServiceState) {
  return state.installDir || "";
}

export function hasVerifyRunningRequirements(service: ServiceDefinition) {
  return service.desktop.capabilities.requires.some((requirement) => requirement.phase === "verifyRunning");
}

export function getDependencyRunningVerificationTimeoutMs() {
  const raw = Number.parseInt(process.env.SERVICE_DEPENDENCY_VERIFY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS;
}

export function renderEnvBindingTemplate(value: string, values: Record<string, string>) {
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

export function getEnvBindingTemplateValues(app: App, service: ServiceDefinition) {
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
