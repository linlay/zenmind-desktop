import { type App } from "electron";
import {
  StartupPipelineOptions,
  StartupPreparationServiceResult,
  StartupServiceResult,
  StartupPreparationOptions
} from "./manager-contracts";
import { type ServiceId, type ServiceState, type StartupRestoreMode } from "../../../../shared/contracts";
import {
  orderServiceIdsForRestore,
  getOptionalServiceIdsToRestore,
  isNonBlockingRestoreFailure,
  DEFAULT_STARTUP_SERVICE_IDS,
  readInitializationState,
  INSTALL_ONLY_STARTUP_SERVICE_IDS,
  OPTIONAL_AUTO_STARTUP_SERVICE_IDS
} from "./state-files";
import { getResourcePluginServiceIdsToRestore, isResourcePluginServiceId } from "./restore-policy";
import { getService } from "../service-registry";
import { getServiceState, getStartupServiceStateReadOptions, getStartupResponsiveServiceStateReadOptions } from "./service-state";
import { t } from "../../../support/i18n/main-i18n";
import { startService, startServiceInternal } from "./service-start";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { shouldReinitializeMissingCoreServiceConfig, installedBuiltinNeedsStartupRepair } from "./repair-policy";
import { needsBundledAssetRefresh } from "./execution-layout";
import { getServiceLayout, getInitializationStatePath } from "./layout";
import { getBuiltinAssetsRoot } from "../builtin-loader";
import { readBuiltinAssetSignature } from "./bundle-assets";
import { stopService } from "./service-stop";
import { installBuiltinService, initializeService } from "./installation";
import { ensurePreStartRequirements } from "./capability-requirements";
import { yieldStartupScheduler, getPreparedStartupStartOptions } from "./startup-options";
import { backgroundStartupPreparationTasks } from "./session-state";

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
      // Capture the previous receipt before installation overwrites it, so a
      // later restart can be traced to an asset change or an install repair.
      const layout = getServiceLayout(app, service);
      const installedState = readInitializationState(layout);
      console.info("[service-manager] startup install decision", {
        serviceId,
        installed: current.installed,
        status: current.status,
        version: service.version,
        installDir: layout.programDir,
        initializationStatePath: getInitializationStatePath(layout),
        installedVersion: installedState?.version ?? null,
        initializationStatus: installedState?.status ?? null,
        initializedAt: installedState?.updatedAt ?? null,
        bundledAssetNeedsRefresh,
        installNeedsRepair,
        builtinAssetsRoot: getBuiltinAssetsRoot(app),
        assetFileName: service.desktop.assetFileName,
        installedAssetSignature: installedState?.assetSignature ?? null,
        bundledAssetSignature: readBuiltinAssetSignature(app, service) ?? null
      });
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

    if (current.status === "running" && service.serviceMode !== "resource" && service.id !== "agent-platform") {
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
