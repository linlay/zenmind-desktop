import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { t } from "../../i18n/main-i18n";
import { getDesktopWebappsDataRoot } from "../../user-paths";
import {
  activateWebappInstall,
  commitWebappInstall,
  rollbackWebappInstall,
  type WebappInstallTransaction
} from "./install-transaction";
import { webappRuntime } from "./runtime";
import { readWebappItemFromDir } from "./store";
import { webappWindowManager } from "./window-manager";

export type WebappRuntimeValidationMode = "never" | "updates" | "always";

export type PreparedWebappInstallOptions = {
  expectedId?: string;
  runtimeValidation?: WebappRuntimeValidationMode;
};

export function normalizeWebappDirectoryName(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().replace(/^user:/u, "") : "";
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

export async function installPreparedWebappDirectory(
  app: App,
  preparedPath: string,
  options: PreparedWebappInstallOptions = {}
) {
  const expectedId = normalizeWebappDirectoryName(options.expectedId);
  const webapp = readWebappItemFromDir(preparedPath, expectedId);
  if (!webapp) {
    throw new Error(t("market.websiteApp.invalidPackage"));
  }
  const safeWebappDirName = normalizeWebappDirectoryName(expectedId || webapp.id);
  if (!safeWebappDirName) {
    throw new Error(t("market.websiteApp.invalidId"));
  }
  if (webapp.id !== safeWebappDirName) {
    throw new Error(t("market.websiteApp.idMismatch", {
      expected: safeWebappDirName,
      actual: webapp.id
    }));
  }

  const targetRoot = getDesktopWebappsDataRoot(app);
  const installPath = path.join(targetRoot, safeWebappDirName);
  const replacingExisting = fs.existsSync(installPath);
  const previousState = replacingExisting
    ? webappRuntime.getStatus(app, safeWebappDirName)
    : null;
  const previousWasRunning = previousState?.status === "running";
  const validationMode = options.runtimeValidation ?? "updates";
  const shouldValidateRuntime = validationMode === "always" || (
    validationMode === "updates" && replacingExisting
  );
  let transaction: WebappInstallTransaction | null = null;
  let releaseWebappDisposal: (() => void) | null = null;
  let previousRuntimeStopped = false;

  try {
    if (shouldValidateRuntime || replacingExisting) {
      const prerequisites = webappRuntime.checkItemPrerequisites(app, webapp, preparedPath);
      if (!prerequisites.ok) {
        throw new Error(prerequisites.message);
      }
    }
    if (replacingExisting) {
      releaseWebappDisposal = webappWindowManager.beginDisposal(safeWebappDirName);
      const stopped = await webappRuntime.stop(
        app,
        safeWebappDirName,
        t("market.websiteApp.replaced")
      );
      if (!stopped.ok) {
        throw new Error(`Unable to replace WebApp while its runtime is active: ${stopped.message}`);
      }
      previousRuntimeStopped = true;
    }

    fs.mkdirSync(targetRoot, { recursive: true });
    transaction = activateWebappInstall({
      app,
      id: safeWebappDirName,
      installPath,
      stagingPath: preparedPath
    });

    if (shouldValidateRuntime) {
      const started = await webappRuntime.start(app, safeWebappDirName);
      if (!started.ok) {
        throw new Error(`WebApp failed startup validation: ${started.message}`);
      }
      if (!previousWasRunning) {
        const stopped = await webappRuntime.stop(app, safeWebappDirName);
        if (!stopped.ok) {
          throw new Error(`WebApp could not be stopped after startup validation: ${stopped.message}`);
        }
      }
    }

    commitWebappInstall(app, transaction);
    transaction = null;
    return { item: webapp, installPath };
  } catch (error) {
    if (transaction) {
      await webappRuntime.stop(app, safeWebappDirName).catch(() => undefined);
      rollbackWebappInstall(app, transaction);
      transaction = null;
    }
    if (previousWasRunning && previousRuntimeStopped) {
      const restored = await webappRuntime.start(app, safeWebappDirName).catch((restoreError) => ({
        ok: false,
        message: restoreError instanceof Error ? restoreError.message : String(restoreError)
      }));
      if (!restored.ok) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} Previous runtime restoration also failed: ${restored.message}`);
      }
    }
    throw error;
  } finally {
    releaseWebappDisposal?.();
    if (transaction) {
      rollbackWebappInstall(app, transaction);
    }
  }
}
