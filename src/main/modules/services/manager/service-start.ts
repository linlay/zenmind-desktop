import { type App } from "electron";
import { type ServiceId, type ServiceCommandResult } from "../../../../shared/contracts";
import { StartServiceOptions, integrationPorts } from "./manager-contracts";
import { clearContainerEngineProbeCache } from "./container-engine";
import { getServiceState } from "./service-state";
import { getService } from "../service-registry";
import { getInstallDir, getServiceLayout } from "./layout";
import { t } from "../../../support/i18n/main-i18n";
import { needsBundledAssetRefresh } from "./execution-layout";
import { stopService } from "./service-stop";
import { installBuiltinService, initializeServiceInternal } from "./installation";
import { readInitializationState } from "./state-files";
import { shouldReinitializeMissingCoreServiceConfig } from "./repair-policy";
import { isInstallHealthy } from "./bundle-assets";
import { ensurePreStartRequirements } from "./capability-requirements";
import { ensureEmbeddedNodeRuntime } from "./embedded-node-runtime";
import { isHostManagedService, resolveAgentWebclientHostStartOverrides, getDesktopManagedCommandPort } from "./host-policy";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { parsePort } from "./service-network";
import { startAgentWebclientHost } from "../agent-webclient-host";
import { runServiceCommand } from "./service-command";
import { getDesktopStartCommand } from "./lifecycle-command-policy";
import { getDesktopStartCommandOptions } from "./command-environment";
import { startedThisSession } from "./session-state";
import { attachServiceVerification } from "./verification";
import { type ServicesIntegrationPorts } from "../integration-ports";

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
  if (service.id === "agent-platform") {
    await ensurePreStartRequirements(app, service, options.integrationPorts);
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
    if (!options.skipPreStartRequirements && service.id !== "agent-platform") {
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
      if (service.id === "agent-platform") await ensureEmbeddedNodeRuntime(app);
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
