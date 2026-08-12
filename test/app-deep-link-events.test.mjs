import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { registerMainAppEvents } = await import("../dist-electron/main/app/app-events.js");
const { DESKTOP_OPEN_DEEP_LINK } = await import("../dist-electron/main/app/deep-link.js");

function createOptions(platform, initialCommandLine = ["desktop"]) {
  const app = new EventEmitter();
  app.whenReady = async () => undefined;
  app.quit = () => undefined;
  const shown = [];
  return {
    shown,
    options: {
      app,
      platform,
      state: { shutdownCleanupComplete: false, isHandlingQuit: false },
      gotSingleInstanceLock: true,
      installerShutdownArgs: new Set(["--installer-shutdown"]),
      globalShortcut: { unregister() {} },
      focusedWebviewDevToolsShortcut: "CommandOrControl+Shift+I",
      initialCommandLine,
      async onReady() {},
      showMainWindow(targetPath) { shown.push(targetPath); },
      beginAppQuitWithoutConfirmation() {},
      beginInstallerShutdown() {},
      isNativeDialogOpen: () => false,
      emitPluginBeforeQuit() {},
      prepareQuitUi() {},
      async runShutdownCleanup() { return { mode: "system", survivors: [] }; },
      writeInstallerShutdownAcks() {},
      releaseAssistantRunWakeLock() {},
      clearDesktopPetIdleResetTimer() {},
      stopAssistantBridgeRuntime() {},
      stopTunnelHubRuntime() {},
      stopAgentPlatformPetStatusClient() {},
      unregisterPluginGlobalShortcuts() {},
      stopResourceDirectoryWatcher() {},
      stopPluginBridgeRuntime() {},
      stopEnterpriseChatRuntime() {}
    }
  };
}

async function flushReadyHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("macOS open-url queues the exact open action until the shell is ready", async () => {
  const fixture = createOptions("darwin");
  registerMainAppEvents(fixture.options);
  let prevented = false;
  fixture.options.app.emit("open-url", { preventDefault() { prevented = true; } }, DESKTOP_OPEN_DEEP_LINK);
  assert.equal(prevented, true);
  assert.deepEqual(fixture.shown, []);
  await flushReadyHandlers();
  assert.deepEqual(fixture.shown, ["/"]);
});

test("Windows initial and second-instance deep links open only the Desktop home route", async () => {
  const fixture = createOptions("win32", ["desktop", DESKTOP_OPEN_DEEP_LINK]);
  registerMainAppEvents(fixture.options);
  await flushReadyHandlers();
  assert.deepEqual(fixture.shown, ["/"]);
  fixture.options.app.emit("second-instance", {}, ["desktop", DESKTOP_OPEN_DEEP_LINK]);
  assert.deepEqual(fixture.shown, ["/", "/"]);
  fixture.options.app.emit("second-instance", {}, ["desktop", "zenmind://settings"]);
  assert.deepEqual(fixture.shown, ["/", "/", undefined]);
});
