import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { InstallBuiltinServiceOptions, integrationPorts, CORE_SERVICE_IDS } from "./manager-contracts";
import path from "node:path";
import { type ServiceLayout, getInstallDir, getServiceLayout } from "./layout";
import { type DesktopServiceConfigResetContext } from "./desktop-config-upgrade";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { appendConfiguredServiceLifecycleArgs } from "../lifecycle-args";
import {
  appendAgentPlatformDesktopDeployArgs,
  appendAgentPlatformRuntimeResourceDeployArgs,
  appendDesktopConfigResetDeployArgs,
  appendAgentContainerHubDesktopDeployArgs,
  appendIdentityCenterDesktopDeployArgs,
  appendAgentWebclientDesktopDeployArgs
} from "./lifecycle-command-policy";
import fs from "node:fs";
import { t } from "../../../support/i18n/main-i18n";
import { type ServiceId, type ServiceCommandResult } from "../../../../shared/contracts";
import { getService } from "../service-registry";
import { inFlightBuiltinInstalls } from "./session-state";
import { beginStartupTiming } from "../../../support/logging/startup-timing";
import {
  ensureArchiveHealthy,
  ensureBundleAssetHealthy,
  computeAssetSignature,
  isInstallHealthy,
  moveExtractedBuiltinRoot,
  readBuiltinAssetSignature
} from "./bundle-assets";
import { serviceInstallNeedsRefresh } from "./install-refresh";
import {
  isAssetNewerThanInstall,
  ensureDir,
  isDirectoryAssetPath,
  copyDirectoryAssetToTempRoot,
  prepareServiceExecutionLayout,
  ensureDefaultConfig
} from "./execution-layout";
import { reconcileBuiltinSiblingInstallDirs, stopBuiltinInstallDir } from "./builtin-install";
import os from "node:os";
import { extractArchiveToDir } from "../../../support/archive/archive-utils";
import { beginStartupCheckpoints } from "../../../support/logging/startup-checkpoints";
import { getServiceState } from "./service-state";
import { fixShellScriptPermissions } from "./program-layout";
import { buildDesktopServiceCommandEnv } from "./command-environment";
import { runExecFile } from "./command-runner";
import { writeInitializationState } from "./state-files";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { applyEnvBindings, getServicePortForEnvSync } from "./environment-bindings";
import { writeEnvFileUpdates } from "./env-content";
import { resolveDesktopCapability } from "./capabilities";

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
        await stopBuiltinInstallDir(service, finalInstallDir, layout);
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
  const checkpoints = beginStartupCheckpoints(serviceId, "initialize");
  const service = getService(serviceId);
  try {
    checkpoints.next("read-initial-state");
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const currentState = await getServiceState(app, serviceId, {
      integrationPorts: options.integrationPorts
    });

    if (!currentState.installed) {
      checkpoints.end("skipped");
      return {
        ok: false,
        message: service.kind === "plugin"
          ? t("service.pluginNotImported", { name: service.name })
          : t("service.notInstalled", { name: service.name }),
        service: currentState
      };
    }

    checkpoints.next("validate-install");
    if (!isInstallHealthy(service, installDir)) {
      checkpoints.end("failed");
      return {
        ok: false,
        message: currentState.message,
        service: currentState
      };
    }

    if (!options.skipInstallRefresh && service.kind === "builtin" && serviceInstallNeedsRefresh(service, installDir)) {
      try {
        checkpoints.next("refresh-install");
        await installBuiltinService(app, service.id, {
          force: true,
          source: "initializeServiceInternal:refresh",
          integrationPorts: options.integrationPorts
        });
      } catch (error) {
        checkpoints.end("failed");
        const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          service: nextState
        };
      }

      checkpoints.next("read-final-state");
      const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
      checkpoints.end();
      return {
        ok: true,
        message: t("service.reinstalledAndInitialized", { name: service.name }),
        service: nextState
      };
    }

    try {
      checkpoints.next("prepare-execution-layout");
      fixShellScriptPermissions(installDir);
      prepareServiceExecutionLayout(service, layout);
      const serviceDeployOwnsConfig = service.kind === "builtin" && CORE_SERVICE_IDS.has(service.id) && Boolean(service.deployCommand);
      if (!serviceDeployOwnsConfig) {
        ensureDefaultConfig(service, layout);
      }
      if (service.deployCommand) {
        checkpoints.next("build-deploy-command");
        const deployCommand = await buildDesktopManagedDeployCommand(
          app,
          service,
          service.deployCommand,
          layout,
          options.desktopConfigReset,
          options.integrationPorts
        );
        checkpoints.next("build-deploy-env");
        const env = buildDesktopServiceCommandEnv(app, service, layout, undefined, options.integrationPorts);
        checkpoints.next("execute-deploy");
        await runExecFile(deployCommand[0], deployCommand.slice(1), installDir, { env });
      }
      checkpoints.next("check-initialization-requirements");
      await ensureInitializationRequirements(app, service, layout, options.integrationPorts);
      checkpoints.next("sync-plugin-resources");
      if (service.kind === "plugin" && service.serviceMode === "resource") {
        const desiredStatus = integrationPorts(options.integrationPorts).initializePluginResourceState(app, service);
        if (desiredStatus === "running") {
          await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
        }
      } else {
        await integrationPorts(options.integrationPorts).syncPluginResources(app, service, installDir);
      }
      checkpoints.next("read-asset-signature");
      const assetSignature = options.assetSignatureOverride ?? readBuiltinAssetSignature(app, service);
      checkpoints.next("persist-initialization-state");
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
      checkpoints.end("failed");
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

    checkpoints.next("read-final-state");
    const nextState = await getServiceState(app, serviceId, { integrationPorts: options.integrationPorts });
    checkpoints.end();
    return {
      ok: true,
      message: t("service.initialized", { name: service.name }),
      service: nextState
    };
  } finally {
    checkpoints.end("failed");
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
