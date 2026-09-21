import { type App } from "electron";
import { StartupPreparationOptions, StartupPreparationResult, integrationPorts } from "./manager-contracts";
import { type StartupRestoreMode, type ServiceId, type ServiceState } from "../../../../shared/contracts";
import { runDesktopServiceConfigUpgradePreparation } from "./runtime-upgrade";
import {
  resolveStartupPreparationMode,
  prepareStartupService,
  startPreparedStartupService,
  restoreOptionalStartupServices,
  prepareInstallOnlyStartupServicesInBackground,
  startOptionalAutoStartupServicesInBackground
} from "./startup-services";
import { DEFAULT_STARTUP_SERVICE_IDS } from "./state-files";
import { ensureEmbeddedNodeRuntime } from "./embedded-node-runtime";
import { recordDesktopServiceConfigCoreHealthFailure, completeDesktopServiceConfigUpgrade } from "./desktop-config-upgrade";
import { flushStartupTimingSummary } from "../../../support/logging/startup-timing";

export async function runStartupPreparation(
  app: App,
  options: StartupPreparationOptions = {}
): Promise<StartupPreparationResult> {
  try {
    let modeResolved = false;
    const resolveMode = (mode: StartupRestoreMode) => {
      if (modeResolved) {
        return;
      }
      modeResolved = true;
      options.onModeResolved?.(mode);
    };
    const desktopConfigUpgrade = options.desktopVersion
      ? await runDesktopServiceConfigUpgradePreparation(
          app,
          options.desktopVersion,
          options,
          () => resolveMode("bootstrap")
        )
      : null;
    if (desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none") {
      resolveMode("bootstrap");
    }
    if (desktopConfigUpgrade?.inputRequired) {
      return {
        mode: "bootstrap",
        started: [],
        failures: [],
        preparedChanged: false,
        inputRequired: {
          request: {
            reason: "desktop-version-change",
            fromVersion: desktopConfigUpgrade.inputRequired.fromVersion,
            toVersion: desktopConfigUpgrade.inputRequired.toVersion
          },
          message: desktopConfigUpgrade.inputRequired.message
        }
      };
    }
    if (desktopConfigUpgrade && desktopConfigUpgrade.failures.length > 0) {
      return {
        mode: "bootstrap",
        started: [],
        failures: desktopConfigUpgrade.failures,
        preparedChanged: true
      };
    }

    await integrationPorts(options.integrationPorts).ensureProviderRegisterApiKey(app, true);

    const initialMode = desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none"
      ? "bootstrap"
      : await resolveStartupPreparationMode(app, options.integrationPorts);
    resolveMode(initialMode);
    const started: ServiceId[] = [];
    const failures: string[] = [];

    const preparedDefaultServices = new Map<ServiceId, ServiceState>();
    const preparationResults = await Promise.all(
      DEFAULT_STARTUP_SERVICE_IDS.map((serviceId) =>
        prepareStartupService(app, serviceId, {
          integrationPorts: options.integrationPorts,
          onProgress: options.onProgress
        })
      )
    );
    const preparedChanged = preparationResults.some((result) => result.changed);

    for (const result of preparationResults) {
      if (!result.ok || !result.service) {
        failures.push(`${result.serviceId}: ${result.message}`);
        continue;
      }

      preparedDefaultServices.set(result.serviceId, result.service);
    }

    // Shared runtime preparation is a barrier before any core service starts.
    // A failure must leave all three start callbacks uncalled and allow retry.
    try {
      await ensureEmbeddedNodeRuntime(app);
    } catch (error) {
      return {
        mode: initialMode,
        started: [],
        failures: [...failures, `Desktop Node/npm: ${error instanceof Error ? error.message : String(error)}`],
        preparedChanged: preparedChanged || Boolean(desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none")
      };
    }

    const startOptions = {
      integrationPorts: options.integrationPorts,
      onStarting: options.onStarting,
      onProgress: options.onProgress
    };
    const startResults = await Promise.all(
      DEFAULT_STARTUP_SERVICE_IDS
        .filter((serviceId) => preparedDefaultServices.has(serviceId))
        .map((serviceId) =>
          startPreparedStartupService(
            app,
            serviceId,
            startOptions
          )
        )
    );
    const startResultById = new Map(startResults.map((result) => [result.serviceId, result]));
    const coreFailures: string[] = [];
    for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
      const result = startResultById.get(serviceId);
      if (!result) {
        continue;
      }
      if (result.ok && result.running) {
        started.push(serviceId);
      } else {
        const failure = `${serviceId}: ${result.message}`;
        failures.push(failure);
        coreFailures.push(failure);
      }
    }

    for (const failure of failures) {
      if (!coreFailures.includes(failure)) {
        coreFailures.push(failure);
      }
    }

    if (desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none") {
      if (coreFailures.length > 0) {
        recordDesktopServiceConfigCoreHealthFailure(
          app,
          desktopConfigUpgrade.desktopVersion,
          coreFailures
        );
      } else {
        try {
          completeDesktopServiceConfigUpgrade(app, desktopConfigUpgrade.desktopVersion);
        } catch (error) {
          const failure = `service config version commit: ${error instanceof Error ? error.message : String(error)}`;
          failures.push(failure);
          coreFailures.push(failure);
          recordDesktopServiceConfigCoreHealthFailure(
            app,
            desktopConfigUpgrade.desktopVersion,
            [failure]
          );
        }
      }
    }

    const optionalRestoreResult = await restoreOptionalStartupServices(app, {
      integrationPorts: options.integrationPorts,
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    started.push(...optionalRestoreResult.started);
    failures.push(...optionalRestoreResult.failures);
    prepareInstallOnlyStartupServicesInBackground(app, {
      integrationPorts: options.integrationPorts,
      onProgress: options.onProgress
    });
    startOptionalAutoStartupServicesInBackground(app, {
      integrationPorts: options.integrationPorts,
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });

    return {
      mode: initialMode === "bootstrap" || preparedChanged || desktopConfigUpgrade?.mode === "version-change"
        ? "bootstrap"
        : "restore",
      started,
      failures,
      preparedChanged: preparedChanged || Boolean(desktopConfigUpgrade && desktopConfigUpgrade.mode !== "none")
    };
  } finally {
    flushStartupTimingSummary();
  }
}
