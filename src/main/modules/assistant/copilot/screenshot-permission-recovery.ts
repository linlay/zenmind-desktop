import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app, dialog, shell, systemPreferences, type BrowserWindow, type MessageBoxOptions } from "electron";
import { APP_ID as PRODUCT_APP_ID, PRODUCT_NAME } from "../../../../shared/brand";
import { t } from "../../../support/i18n/main-i18n";

const execFileAsync = promisify(execFile);
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

type RecoveryRequest = {
  platform: NodeJS.Platform;
  userSelectedRegion: boolean;
  getMainWindow: () => BrowserWindow | null;
};

export type ScreenshotPermissionRecoveryResult = {
  granted: boolean;
  message?: string;
};

type RecoveryDependencies = {
  getStatus: () => string;
  getExecutablePath: () => string;
  readBundleId: (plistPath: string) => Promise<string>;
  resetScreenCapture: (bundleId: string) => Promise<void>;
  requestScreenCapture: () => boolean;
  openSettings: () => Promise<void>;
  showMessageBox: (options: MessageBoxOptions, owner: BrowserWindow | null) => Promise<{ response: number }>;
};

export function screenshotBundlePlistPath(executablePath: string) {
  const executableDirectory = path.dirname(executablePath);
  const contentsDirectory = path.dirname(executableDirectory);
  const bundleDirectory = path.dirname(contentsDirectory);
  if (!path.isAbsolute(executablePath) || path.basename(executableDirectory) !== "MacOS" ||
      path.basename(contentsDirectory) !== "Contents" || !bundleDirectory.endsWith(".app")) {
    throw new Error("Screen Recording recovery requires the current macOS application bundle");
  }
  return path.join(contentsDirectory, "Info.plist");
}

function assertCurrentBrandBundleId(bundleId: string) {
  if (bundleId !== PRODUCT_APP_ID && bundleId !== `${PRODUCT_APP_ID}.dev`) {
    throw new Error("Screen Recording recovery cannot reset a different application's permission");
  }
  return bundleId;
}

function requestNativeScreenCaptureAccess() {
  // Load only after a user confirms recovery, never during startup or on Windows.
  const koffi = require("koffi") as typeof import("koffi");
  const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  return Boolean(coreGraphics.func("bool CGRequestScreenCaptureAccess(void)")());
}

export function createScreenshotPermissionRecovery(dependencies: RecoveryDependencies) {
  let pending: Promise<ScreenshotPermissionRecoveryResult | null> | null = null;
  const recover = async (request: RecoveryRequest): Promise<ScreenshotPermissionRecoveryResult | null> => {
    try {
      const plistPath = screenshotBundlePlistPath(dependencies.getExecutablePath());
      const bundleId = assertCurrentBrandBundleId((await dependencies.readBundleId(plistPath)).trim());
      const target = request.getMainWindow();
      const owner = target && !target.isDestroyed() ? target : null;
      const choice = await dependencies.showMessageBox({
        type: "warning",
        title: t("screenshot.recoveryTitleMac", { appName: PRODUCT_NAME }),
        message: t("screenshot.recoveryQuestionMac", { appName: PRODUCT_NAME }),
        detail: t("screenshot.recoveryDetailMac", { appName: PRODUCT_NAME }),
        buttons: [t("screenshot.reauthorizeMac"), t("common.cancel")],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }, owner);
      if (choice.response !== 0) return { granted: false };

      // A permission change while the dialog was open must not revoke a new grant
      // or reset access that has become restricted by device management.
      const currentStatus = dependencies.getStatus();
      if (currentStatus === "granted") return { granted: true };
      if (currentStatus !== "denied") return { granted: false };
      await dependencies.resetScreenCapture(bundleId);
      try {
        dependencies.requestScreenCapture();
      } finally {
        // Previously denied processes may still need System Settings and a restart.
        // CGRequestScreenCaptureAccess never grants access on the user's behalf.
        await dependencies.openSettings();
      }
      if (dependencies.getStatus() === "granted") return { granted: true };
      return {
        granted: false,
        message: t("screenshot.recoveryPendingMac", { appName: PRODUCT_NAME })
      };
    } catch (error) {
      console.warn("[screenshot] Screen Recording permission recovery failed", error);
      return {
        granted: false,
        message: t("screenshot.recoveryFailedMac", { appName: PRODUCT_NAME })
      };
    }
  };
  return (request: RecoveryRequest): Promise<ScreenshotPermissionRecoveryResult | null> => {
    if (request.platform !== "darwin" || !request.userSelectedRegion || dependencies.getStatus() !== "denied") {
      return Promise.resolve(null);
    }
    if (pending) return pending;
    pending = recover(request).finally(() => { pending = null; });
    return pending;
  };
}

export const recoverScreenshotPermission = createScreenshotPermissionRecovery({
  getStatus: () => systemPreferences.getMediaAccessStatus("screen"),
  getExecutablePath: () => app.getPath("exe"),
  readBundleId: async (plistPath) => {
    const result = await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath], {
      timeout: 10_000
    });
    return result.stdout;
  },
  resetScreenCapture: async (bundleId) => {
    await execFileAsync("/usr/bin/tccutil", ["reset", "ScreenCapture", assertCurrentBrandBundleId(bundleId)], {
      timeout: 15_000
    });
  },
  requestScreenCapture: requestNativeScreenCaptureAccess,
  openSettings: () => shell.openExternal(SCREEN_RECORDING_SETTINGS),
  showMessageBox: (options, owner) => owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
});
