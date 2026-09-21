import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { type ServiceLayout, resolveConfigPath, getInstallDir, getServiceLayout } from "./layout";
import path from "node:path";
import fs from "node:fs";
import { t } from "../../../support/i18n/main-i18n";
import { probeContainerEngines } from "./container-engine";
import { ServiceStateReadOptions, integrationPorts } from "./manager-contracts";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getAllServices, getService } from "../service-registry";
import { type ServiceId, type ServiceState } from "../../../../shared/contracts";
import { resolveRuntimePath, getManagedPidFilePaths, readManagedPidFile, writeManagedPidFiles } from "./pid-files";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { isHostManagedService, getDesktopManagedCommandPort } from "./host-policy";
import { parsePort, getWebUrl } from "./service-network";
import { readBridgeManagedPid } from "./bridge-pid-reader";
import { isProcessRunning } from "./process-cleanup";
import { listMissingRuntimeFiles, ensureBundleAssetHealthy } from "./bundle-assets";
import { readInitializationState } from "./state-files";
import { getAgentWebclientHostState } from "../agent-webclient-host";
import { listListeningPids, detectManagedServicePid } from "./managed-cleanup";

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
  const bridgeRead = options.mode === "bridge";
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
    ? bridgeRead
      ? await readBridgeManagedPid(pidFilePaths, installDir)
      : readManagedPidFile(pidFilePaths, installDir, {
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
    installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !responsiveRead && !bridgeRead
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

  if (!hostManaged && running && pidFromFile && !bridgeRead) {
    writeManagedPidFiles(pidFilePaths, pidFromFile);
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && port > 0 && !responsiveRead && !bridgeRead) {
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

  if (!installed && service.kind === "builtin" && !bridgeRead) {
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
