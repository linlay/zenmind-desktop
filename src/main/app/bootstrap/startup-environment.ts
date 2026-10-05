import type { App } from "electron";
import {
  generateBackupDirName,
  importBundledEnvZipToRuntime,
  backupRuntimeRoot,
  type EnvRootConflictDecision
} from "../../infrastructure/filesystem/runtime-environment";

export type StartupEnvironmentRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  productName: string;
  envZipConflictNeedsDecision: boolean;
  requireEnvZipImportAtStartup: boolean;
  runtimeRootAtProcessStart: string;
  runtimeRootConflictDecisionRef: { current: EnvRootConflictDecision | undefined };
  startupRestoreController: {
    beginSession(mode: string): void;
    updateService(serviceId: string, phase: string, message: string): void;
    setEnvImportRequired(message: string): void;
  };
  showMessageBox: (options: any) => Promise<{ response: number }>;
  t: (key: any, values?: any) => string;
};

export function createStartupEnvironmentRuntime(options: StartupEnvironmentRuntimeOptions) {
  function getDefaultEnvImportRequiredMessage() {
    return options.t("startup.envImport.requiredTitle");
  }

  async function handleStartupEnvRootConflict() {
    if (!options.envZipConflictNeedsDecision) {
      return true;
    }

    const backupPath = generateBackupDirName(options.runtimeRootAtProcessStart, options.platform);
    const choice = await options.showMessageBox({
      type: "warning",
      title: options.t("startup.envConflict.title"),
      message: options.t("startup.envConflict.message", { path: options.runtimeRootAtProcessStart }),
      detail: options.t("startup.envConflict.detail", { backupPath }),
      buttons: [
        options.t("startup.envConflict.backup"),
        options.t("startup.envConflict.keep"),
        options.t("menu.quit", { appName: options.productName })
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (choice.response === 1) {
      options.runtimeRootConflictDecisionRef.current = "keep";
      return true;
    }
    if (choice.response !== 0) {
      options.runtimeRootConflictDecisionRef.current = "cancel";
      return false;
    }

    try {
      backupRuntimeRoot(options.platform, options.runtimeRootAtProcessStart, backupPath);
      options.runtimeRootConflictDecisionRef.current = "backup";
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryChoice = await options.showMessageBox({
        type: "error",
        title: options.t("startup.envConflict.backupFailedTitle"),
        message,
        detail: options.t("startup.envConflict.backupFailedDetail", {
          path: options.runtimeRootAtProcessStart,
          backupPath
        }),
        buttons: [options.t("menu.quit", { appName: options.productName }), options.t("startup.envConflict.keep")],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (retryChoice.response === 1) {
        options.runtimeRootConflictDecisionRef.current = "keep";
        return true;
      }
      options.runtimeRootConflictDecisionRef.current = "cancel";
      return false;
    }
  }

  async function prepareStartupRuntimeEnvironment(): Promise<{ ok: true } | { ok: false; message: string }> {
    const shouldImportBundledEnvZip =
      options.runtimeRootConflictDecisionRef.current === "backup" ||
      (options.requireEnvZipImportAtStartup && options.runtimeRootConflictDecisionRef.current !== "keep");
    if (shouldImportBundledEnvZip) {
      return tryImportBundledEnvZipAtStartup();
    }
    if (options.runtimeRootConflictDecisionRef.current === "keep") {
      return { ok: true };
    }
    return { ok: true };
  }

  async function tryImportBundledEnvZipAtStartup(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const importResult = await importBundledEnvZipToRuntime(options.app, options.platform);
      if (!importResult) {
        return {
          ok: false,
          message: getDefaultEnvImportRequiredMessage()
        };
      }

      options.startupRestoreController.beginSession("bootstrap");
      options.startupRestoreController.updateService(
        "identity-center",
        "installing",
        options.t("startup.envImport.importingBundled")
      );
      console.info(
        `[main] imported bundled env.zip from ${importResult.sourceZipPath} into ${importResult.targetRoot}: copied=${importResult.copiedFiles}, skipped=${importResult.skippedFiles}`
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("failed to import bundled env.zip", error);
      return {
        ok: false,
        message: options.t("startup.envImport.bundledFailed", { message })
      };
    }
  }

  return {
    getDefaultEnvImportRequiredMessage,
    handleStartupEnvRootConflict,
    prepareStartupRuntimeEnvironment
  };
}

export type StartupEnvironmentRuntime = ReturnType<typeof createStartupEnvironmentRuntime>;
