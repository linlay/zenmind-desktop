import { app, dialog, shell } from "electron";
import {
  getRuntimeEnvResetRecovery, requestRuntimeEnvRollback, resumeRuntimeEnvReset
} from "../../infrastructure/filesystem/runtime-env-reset-transaction";
import { t } from "../../support/i18n/main-i18n";

// No business runtime/profile is opened on this path. Recovery choices remain
// available even when publishing the runtime failed before the Shell existed.
export async function showRuntimeResetRecovery(error: unknown, platform: NodeJS.Platform) {
  await app.whenReady();
  for (;;) {
    const result = await dialog.showMessageBox({ type: "error", title: t("settings.reset.failed"),
      message: error instanceof Error ? error.message : String(error),
      buttons: [t("settings.reset.resume"), t("settings.reset.rollback"), t("settings.reset.openBackup"), t("common.close")],
      defaultId: 3, cancelId: 3 });
    if (result.response === 3) { app.exit(1); return; }
    try {
      if (result.response === 2) {
        const recovery = getRuntimeEnvResetRecovery(app, platform);
        if (recovery) shell.showItemInFolder(recovery.transactionRoot);
        continue;
      }
      if (result.response === 0) resumeRuntimeEnvReset(app, platform);
      else requestRuntimeEnvRollback(app, platform);
      app.relaunch();
      app.exit(0);
      return;
    } catch (failure) { error = failure; }
  }
}
