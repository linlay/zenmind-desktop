import { type App } from "electron";
import { type ServiceId } from "../../../../shared/contracts";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getService } from "../service-registry";
import { getServiceState, getStartupResponsiveServiceStateReadOptions } from "./service-state";
import { isHostManagedService } from "./host-policy";
import { stopAgentWebclientHost, getAgentWebclientHostState } from "../agent-webclient-host";
import { stopService } from "./service-stop";
import { getServiceLayout } from "./layout";
import fs from "node:fs";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { collectManagedServiceStopState } from "./managed-cleanup";
import { StartupPreparationOptions } from "./manager-contracts";
import { isDesktopDevelopmentRuntime } from "../../../infrastructure/electron/development-runtime";
import { DESKTOP_SERVICE_CONFIG_UPGRADE_IDS, prepareDesktopServiceConfigUpgrade } from "./desktop-config-upgrade";
import {
  validateSelectedEnvZipForDesktopVersionUpgrade,
  bundledEnvZipExists,
  validateBundledEnvForDesktopVersionUpgrade,
  stageValidatedDesktopVersionUpgradeInput,
  applyProviderRegisterUpgradeInput,
  validateEnvZipForDesktopManualImport
} from "../../../infrastructure/filesystem/runtime-environment";
import { t } from "../../../support/i18n/main-i18n";
import { installBuiltinService, initializeServiceInternal } from "./installation";
import path from "node:path";
import { getDataRoot } from "../../../infrastructure/filesystem/user-paths";
import { rewriteServicePortDefaultsForDesktopConfigUpgrade } from "../port-defaults";
import { rewriteServiceLifecycleArgsForDesktopConfigUpgrade } from "../lifecycle-args";

export async function stopServiceForDesktopConfigUpgrade(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
) {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId, {
    ...getStartupResponsiveServiceStateReadOptions(),
    integrationPorts: ports
  });
  if (isHostManagedService(service)) {
    await stopAgentWebclientHost(service.id);
    if (getAgentWebclientHostState(service.id)?.running) {
      throw new Error(`${serviceId} host process is still running`);
    }
    return;
  }
  if (!current.installed) {
    return;
  }
  if (current.status === "running") {
    const result = await stopService(app, serviceId, ports);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  const layout = getServiceLayout(app, service);
  const env = fs.existsSync(layout.envPath) ? readEnvFile(layout.envPath) : new Map<string, string>();
  const stopState = collectManagedServiceStopState(service, layout, env);
  const survivingPids = [
    stopState.managedMainPid,
    ...stopState.managedPortPids
  ].filter((pid): pid is number => typeof pid === "number");
  if (survivingPids.length > 0) {
    throw new Error(`${serviceId} process is still running (pid=${[...new Set(survivingPids)].join(", ")})`);
  }
}

export async function runDesktopServiceConfigUpgradePreparation(
  app: App,
  desktopVersion: string,
  options: StartupPreparationOptions,
  onBegin: () => void
) {
  const isDevelopmentApp = isDesktopDevelopmentRuntime(app);
  const currentDesktopDefaultPorts = Object.fromEntries(
    DESKTOP_SERVICE_CONFIG_UPGRADE_IDS.map((serviceId) => {
      const service = getService(serviceId);
      return [serviceId, service.web.defaultPort];
    })
  );
  return prepareDesktopServiceConfigUpgrade(app, desktopVersion, {
    currentDesktopDefaultPorts,
    isFirstDesktopInstall: options.isFirstDesktopInstall,
    onBegin,
    onProgress: (serviceId, message) => {
      options.onProgress?.(serviceId, "initializing", message);
    },
    prepareDesktopConfiguration: async (context) => {
      let validated;
      let journalInputError = "";
      if (isDevelopmentApp && context.sourceZipPath && fs.existsSync(context.sourceZipPath)) {
        try {
          validated = await validateSelectedEnvZipForDesktopVersionUpgrade(
            app,
            context.sourceZipPath,
            context.toVersion,
            process.platform
          );
        } catch (error) {
          journalInputError = error instanceof Error ? error.message : String(error);
        }
      }
      if (isDevelopmentApp && !validated && options.desktopVersionUpgradeEnvZipPath) {
        try {
          validated = await validateSelectedEnvZipForDesktopVersionUpgrade(
            app,
            options.desktopVersionUpgradeEnvZipPath,
            context.toVersion,
            process.platform
          );
        } catch (error) {
          return { inputRequired: { message: error instanceof Error ? error.message : String(error) } };
        }
      } else if (isDevelopmentApp && !validated && context.sourceZipPath) {
        return {
          inputRequired: {
            message: journalInputError || t("startup.envImport.versionChangeStagedMissing", {
              expected: context.expectedSha256 ?? ""
            })
          }
        };
      } else if (isDevelopmentApp && !validated && !bundledEnvZipExists(app, process.platform)) {
        return { inputRequired: { message: "" } };
      } else if (!validated) {
        validated = await validateBundledEnvForDesktopVersionUpgrade(app, process.platform, {
          expectedDesktopVersion: context.toVersion
        });
      }

      if (
        context.expectedSha256 &&
        context.expectedSha256.toLowerCase() !== validated.sha256.toLowerCase()
      ) {
        if (isDevelopmentApp) {
          return {
            inputRequired: {
              message: t("startup.envImport.versionChangeShaMismatch", {
                expected: context.expectedSha256.toLowerCase(),
                actual: validated.sha256.toLowerCase()
              })
            }
          };
        }
        throw new Error(
          `bundled env.zip changed during the unfinished upgrade: expected ${context.expectedSha256}, got ${validated.sha256}`
        );
      }

      if (isDevelopmentApp) {
        validated = await stageValidatedDesktopVersionUpgradeInput(
          validated,
          context.inputDir,
          process.platform
        );
      }
      if (context.apply) {
        try {
          if (!options.applyDesktopConfiguration) {
            throw new Error("Desktop configuration upgrade adapter is unavailable.");
          }
          options.applyDesktopConfiguration(
            app,
            validated.desktopInit,
            context.backupDir,
            process.platform
          );
        } catch (error) {
          if (isDevelopmentApp && options.desktopVersionUpgradeEnvZipPath) {
            fs.rmSync(validated.sourceZipPath, { force: true });
            return { inputRequired: { message: error instanceof Error ? error.message : String(error) } };
          }
          throw error;
        }
      }
      // Restore on every unfinished transaction attempt: the previous grant may
      // have been consumed before a later service failure required another deploy.
      applyProviderRegisterUpgradeInput(app, validated.providerRegister, context.backupDir);
      return {
        sourceZipPath: validated.sourceZipPath,
        ...(validated.previousSourceZipPath
          ? { previousSourceZipPath: validated.previousSourceZipPath }
          : {}),
        sha256: validated.sha256,
        size: validated.size
      };
    },
    stopService: (serviceId) => stopServiceForDesktopConfigUpgrade(
      app,
      serviceId,
      options.integrationPorts
    ),
    installCurrentService: async (serviceId) => {
      await installBuiltinService(app, serviceId, {
        source: "desktop-service-config-upgrade",
        skipInitialize: true,
        integrationPorts: options.integrationPorts
      });
    },
    resetServiceConfig: async (serviceId, context) => {
      const result = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        desktopConfigReset: context,
        integrationPorts: options.integrationPorts
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
    }
  });
}

export async function importEnvZipIntoExistingRuntime(
  app: App,
  zipPath: string,
  desktopVersion: string,
  platform: NodeJS.Platform = process.platform,
  applyDesktopConfiguration?: StartupPreparationOptions["applyDesktopConfiguration"]
) {
  const validated = await validateEnvZipForDesktopManualImport(
    app,
    zipPath,
    desktopVersion,
    platform
  );
  const backupDir = path.join(
    getDataRoot(app, platform),
    "config",
    "service-backups",
    "manual-env-import",
    String(Date.now()),
    "desktop"
  );
  if (!applyDesktopConfiguration) {
    throw new Error("Desktop configuration upgrade adapter is unavailable.");
  }
  applyDesktopConfiguration(app, validated.desktopInit, backupDir, platform);
  applyProviderRegisterUpgradeInput(app, validated.providerRegister, backupDir, platform);
  const currentDesktopDefaultPorts = Object.fromEntries(
    DESKTOP_SERVICE_CONFIG_UPGRADE_IDS.map((serviceId) => [
      serviceId,
      getService(serviceId).web.defaultPort
    ])
  );
  const ports = rewriteServicePortDefaultsForDesktopConfigUpgrade(
    app,
    currentDesktopDefaultPorts,
    platform
  );
  rewriteServiceLifecycleArgsForDesktopConfigUpgrade(
    app,
    ports.services["agent-platform"].defaultPort,
    platform
  );
  await stopServiceForDesktopConfigUpgrade(app, "agent-platform");
  await installBuiltinService(app, "agent-platform", {
    source: "manual-env-import",
    skipInitialize: true
  });
  const result = await initializeServiceInternal(app, "agent-platform", {
    skipInstallRefresh: true,
    desktopConfigReset: {
      desktopConfigReset: false,
      backupDir: "",
      fromVersion: desktopVersion,
      toVersion: desktopVersion,
      runtimeResourceSource: validated.sourceZipPath,
      ...(validated.previousSourceZipPath
        ? { runtimeResourcePreviousSource: validated.previousSourceZipPath }
        : {}),
      runtimeResourceMode: "manual-import"
    }
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return {
    copiedFiles: 0,
    skippedFiles: 0,
    platformResourcesMigrated: true,
    sourceZipPath: validated.sourceZipPath,
    sha256: validated.sha256
  };
}
