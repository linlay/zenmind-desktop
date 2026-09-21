import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { RunServiceCommandOptions } from "./manager-contracts";
import { beginStartupTiming } from "../../../support/logging/startup-timing";
import path from "node:path";
import { getInstallDir, getServiceLayout } from "./layout";
import { getOptionalBundleAssetPath, isInstallHealthy, ensureBundleAssetHealthy } from "./bundle-assets";
import fs from "node:fs";
import { t } from "../../../support/i18n/main-i18n";
import { installBuiltinService } from "./installation";
import { isAssetNewerThanInstall, prepareServiceExecutionLayout } from "./execution-layout";
import { appendConfiguredServiceLifecycleArgs } from "../lifecycle-args";
import { appendDesktopManagedLayoutFlags } from "./lifecycle-command-policy";
import { runExecFile } from "./command-runner";
import { buildDesktopServiceCommandEnv } from "./command-environment";
import { getServiceState } from "./service-state";
import { type ServiceCommandResult } from "../../../../shared/contracts";

export async function runServiceCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  successMessage: string,
  options: RunServiceCommandOptions = {}
) {
  const timing = beginStartupTiming("runServiceCommand", {
    serviceId: service.id,
    command: command[0] ? path.basename(command[0]) : "none",
    args: command.slice(1).join(",") || "none"
  });
  const installDir = getInstallDir(app, service);
  try {
    const shouldRefreshBuiltinAsset = options.refreshBuiltinAsset !== false;
    if (service.kind === "builtin" && shouldRefreshBuiltinAsset) {
      const assetPath = getOptionalBundleAssetPath(app, service);
      if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
        if (!assetPath) {
          throw new Error(t("service.notInstalledDamaged", { name: service.name }));
        }
        await installBuiltinService(app, service.id, {
          source: "runServiceCommand:missing-install",
          integrationPorts: options.integrationPorts
        });
      } else if (assetPath && isAssetNewerThanInstall(assetPath, getServiceLayout(app, service), app, service)) {
        await installBuiltinService(app, service.id, {
          source: "runServiceCommand:asset-newer",
          integrationPorts: options.integrationPorts
        });
      }
    } else if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      throw new Error(t("service.notInstalledDamaged", { name: service.name }));
    }

    if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      if (service.kind !== "builtin") {
        throw new Error(t("service.notInstalledDamaged", { name: service.name }));
      }
      if (!shouldRefreshBuiltinAsset) {
        throw new Error(t("service.notInstalledDamaged", { name: service.name }));
      }
      ensureBundleAssetHealthy(app, service);
      await installBuiltinService(app, service.id, {
        source: "runServiceCommand:repair-install",
        integrationPorts: options.integrationPorts
      });
    }
    if (command.length === 0) {
      throw new Error(t("service.missingExecutableScript", { name: service.name }));
    }
    const layout = getServiceLayout(app, service);
    prepareServiceExecutionLayout(service, layout);
    const commandWithConfiguredArgs = appendConfiguredServiceLifecycleArgs(
      app,
      service,
      command,
      options.commandKind ?? "start"
    );
    const commandForExec = appendDesktopManagedLayoutFlags(
      app,
      service,
      commandWithConfiguredArgs,
      layout,
      options.commandKind ?? "start"
    );
    await runExecFile(commandForExec[0], commandForExec.slice(1), installDir, {
      timeoutMs: options.timeoutMs,
      env: buildDesktopServiceCommandEnv(app, service, layout, options.env, options.integrationPorts)
    });
    return {
      ok: true,
      message: successMessage,
      service: await getServiceState(app, service.id, {
        ...options.stateReadOptions,
        integrationPorts: options.integrationPorts
      })
    } satisfies ServiceCommandResult;
  } finally {
    timing.end();
  }
}
