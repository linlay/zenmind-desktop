import type { App } from "electron";
import type {
  ServiceCommandResult,
  ServiceId
} from "../../../../shared/contracts";
import { getService } from "../service-registry";
import type { ServicesIntegrationPorts } from "../integration-ports";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import {
  getInstallDir,
  getServiceLayout
} from "./layout";
import { t } from "../../../support/i18n/main-i18n";
import {
  getServiceIdsToRestore,
  isNonBlockingRestoreFailure,
  orderServiceIdsForRestore,
  readInitializationState
} from "./state-files";
import {
  isInstallHealthy
} from "./bundle-assets";
import {
  clearContainerEngineProbeCache
} from "./container-engine";
import {
  parsePort
} from "./service-network";
import {
  startAgentWebclientHost
} from "../agent-webclient-host";
import { getDesktopManagedCommandPort, integrationPorts, isHostManagedService, needsBundledAssetRefresh, resolveAgentWebclientHostStartOverrides, startedThisSession } from "./index.part-1";
import { getServiceState } from "./index.part-2";
import { StartServiceOptions, getDesktopStartCommand, getDesktopStartCommandOptions, shouldReinitializeMissingCoreServiceConfig } from "./index.part-3";
import { attachServiceVerification, ensurePreStartRequirements, getResourcePluginServiceIdsToRestore, initializeServiceInternal, installBuiltinService, isResourcePluginServiceId, runServiceCommand, stopService } from "./index.part-4";

export async function startServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: StartServiceOptions = {}
): Promise<ServiceCommandResult> {
  if (serviceId === "agent-container-hub") {
    // A manual start is an explicit retry after Docker/Podman may have been
    // installed or started, so it must not reuse a recent negative probe.
    clearContainerEngineProbeCache();
  }
  const current = await getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
  const service = getService(serviceId);
  if (service.serviceMode === "resource") {
    if (
      !current.installed ||
      current.status === "initialization-required" ||
      current.status === "config-required" ||
      current.status === "dependency-missing" ||
      current.status === "error"
    ) {
      return {
        ok: false,
        message: current.message,
        service: current
      };
    }
    const installDir = getInstallDir(app, service);
    await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
    const nextState = await getServiceState(app, serviceId, {
      ...options.stateReadOptions,
      integrationPorts: options.integrationPorts
    });
    const result = {
      ok: true,
      message: t("service.loaded", { name: service.name }),
      service: nextState
    } satisfies ServiceCommandResult;
    if (service.kind === "plugin") {
      integrationPorts(options.integrationPorts).emitPluginBridgeHook("plugin.started", { pluginId: service.id, service: result.service });
    }
    return result;
  }
  const installDir = getInstallDir(app, service);
  const shouldRefreshFromBundledAsset =
    service.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    needsBundledAssetRefresh(app, service);

  if (shouldRefreshFromBundledAsset) {
    if (current.status === "running") {
      await stopService(app, serviceId, options.integrationPorts);
    }
    await installBuiltinService(app, serviceId, {
      source: "startServiceInternal:bundled-asset-refresh",
      integrationPorts: options.integrationPorts
    });
  }

  const refreshedState = shouldRefreshFromBundledAsset
    ? await getServiceState(app, serviceId, {
      ...options.stateReadOptions,
      integrationPorts: options.integrationPorts
    })
    : current;
  const initializationState = refreshedState.installed ? readInitializationState(getServiceLayout(app, service)) : null;
  let preparedState = refreshedState;

  if (shouldReinitializeMissingCoreServiceConfig(service, preparedState)) {
    const initialization = await initializeServiceInternal(app, serviceId, {
      skipInstallRefresh: true,
      integrationPorts: options.integrationPorts
    });
    if (!initialization.ok) {
      return initialization;
    }
    preparedState = initialization.service;
  }

  if (preparedState.status === "initialization-required") {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (initializationState?.status === "failed" && initializationState.version === service.version) {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (
    preparedState.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    (!preparedState.installed || (preparedState.status === "error" && !isInstallHealthy(service, installDir)))
  ) {
    await installBuiltinService(app, serviceId, {
      source: "startServiceInternal:asset-refresh",
      integrationPorts: options.integrationPorts
    });
  }
  let nextState = await getServiceState(app, serviceId, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  });
  if (
    nextState.status === "config-required" ||
    nextState.status === "dependency-missing" ||
    nextState.status === "error"
  ) {
    return {
      ok: false,
      message: nextState.message,
      service: nextState
    };
  }
  let result: ServiceCommandResult;
  if (nextState.status === "running") {
    result = {
      ok: true,
      message: t("service.alreadyRunning", { name: nextState.name }),
      service: nextState
    };
  } else {
    if (!options.skipPreStartRequirements) {
      await ensurePreStartRequirements(app, service, options.integrationPorts);
    }
    const preStartState = await getServiceState(app, serviceId, {
      ...options.stateReadOptions,
      integrationPorts: options.integrationPorts
    });
    if (
      preStartState.status === "config-required" ||
      preStartState.status === "dependency-missing" ||
      preStartState.status === "error"
    ) {
      return {
        ok: false,
        message: preStartState.message,
        service: preStartState
      };
    }
    if (preStartState.status === "running") {
      result = {
        ok: true,
        message: t("service.alreadyRunning", { name: preStartState.name }),
        service: preStartState
      };
    } else {
      if (isHostManagedService(service)) {
        const layout = getServiceLayout(app, service);
        const fileEnv = readEnvFile(layout.envPath);
        const envOverrides = service.id === "agent-webclient"
          ? resolveAgentWebclientHostStartOverrides(app, options.integrationPorts)
          : new Map<string, string>();
        const env = new Map([...fileEnv, ...envOverrides]);
        const port = service.id === "agent-webclient" ? getDesktopManagedCommandPort(service) : parsePort(service, env);
        await startAgentWebclientHost({
          service,
          layout,
          env,
          envOverrides,
          port,
          issueAccessToken: (reason) => integrationPorts(options.integrationPorts).issueAgentAccessToken(app, reason)
        });
        result = {
          ok: true,
          message: t("service.started", { name: service.name }),
          service: await getServiceState(app, service.id, {
            ...(options.commandStateReadOptions ?? options.stateReadOptions),
            integrationPorts: options.integrationPorts
          })
        };
      } else {
        result = await runServiceCommand(
          app,
          service,
          getDesktopStartCommand(service),
          t("service.started", { name: service.name }),
          {
            ...getDesktopStartCommandOptions(app, service),
            commandKind: "start",
            stateReadOptions: options.commandStateReadOptions ?? options.stateReadOptions,
            integrationPorts: options.integrationPorts
          }
        );
      }
      startedThisSession.add(serviceId);
    }
  }

  const verifiedResult = await attachServiceVerification(
    app,
    serviceId,
    result,
    "running",
    t("service.startCommandExecuted", { name: service.name }),
    {
      ...options.verificationOptions,
      integrationPorts: options.integrationPorts
    }
  );
  if (service.kind === "plugin" && verifiedResult.ok) {
    integrationPorts(options.integrationPorts).emitPluginBridgeHook("plugin.started", { pluginId: service.id, service: verifiedResult.service });
  }
  return verifiedResult;
}

export async function startService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  return startServiceInternal(app, serviceId, { integrationPorts: ports });
}

export async function runServiceRestart(
  stopOperation: () => Promise<ServiceCommandResult>,
  startOperation: () => Promise<ServiceCommandResult>
) {
  await stopOperation();
  return startOperation();
}

export async function restartService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  return runServiceRestart(
    () => stopService(app, serviceId, ports),
    () => startService(app, serviceId, ports)
  );
}

export async function restoreRunningServices(
  app: App,
  options: {
    integrationPorts?: ServicesIntegrationPorts;
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: "succeeded" | "failed" | "skipped", message: string) => void;
  } = {}
) {
  const serviceIds = orderServiceIdsForRestore([
    ...getServiceIdsToRestore(app),
    ...getResourcePluginServiceIdsToRestore(app, options.integrationPorts)
  ]);
  const restored: ServiceId[] = [];
  const failures: string[] = [];

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
      const startedAt = Date.now();
      const result = await startService(app, serviceId, options.integrationPorts);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        console.info(`[service-manager] restored ${serviceId} in ${elapsedMs}ms`);
        restored.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
      } else {
        console.warn(`[service-manager] failed to restore ${serviceId} after ${elapsedMs}ms: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        if (isNonBlockingRestoreFailure(serviceId) || isResourcePluginServiceId(serviceId)) {
          continue;
        }
        failures.push(`${serviceId}: ${result.message}`);
        break;
      }
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
    restored,
    failures
  };
}
