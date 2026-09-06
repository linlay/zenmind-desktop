import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { createStartupPipeline } = await import("../dist-electron/main/app/lifecycle/startup.js");

const startupGateSource = fs.readFileSync(
  path.join(process.cwd(), "src", "renderer", "app-shell", "startup", "StartupGate.tsx"),
  "utf8"
);

test("startup failure page leaves application exit to the system tray", () => {
  assert.doesNotMatch(startupGateSource, /startup-loading-quit|onQuit/u);
});

test("startup pipeline starts the shell tray before a degraded startup can return", async () => {
  const events = [];
  let phase = "";
  const pipeline = createStartupPipeline({
    app: {},
    desktopVersion: "0.3.29",
    isFirstDesktopInstall: false,
    getEnvImportFailureMessage: () => "env import required",
    startupRestoreController: {
      setEnvImportRequired: () => events.push("env-import-required")
    },
    loadBuiltinServices: () => events.push("load-builtin-services"),
    loadInstalledPlugins: () => events.push("load-installed-plugins"),
    notifyCoreServicesChanged: () => events.push("notify-services"),
    startShellRuntime: () => events.push("create-tray"),
    startNonCoreRuntime: () => events.push("start-non-core"),
    setStartupPhase: (nextPhase) => {
      phase = nextPhase;
    },
    runServiceMutation: async () => ({ mode: "normal", failures: [] }),
    runStartupPreparation: async () => ({ mode: "normal", failures: [] }),
    t: (key) => key,
    onError: () => undefined
  });

  await pipeline.run();

  assert.deepEqual(events, ["create-tray", "env-import-required"]);
  assert.equal(phase, "degraded");
});

test("core startup failures keep the shell tray available without starting non-core runtime", async () => {
  const events = [];
  let phase = "";
  const pipeline = createStartupPipeline({
    app: {},
    desktopVersion: "0.3.29",
    isFirstDesktopInstall: false,
    getEnvImportFailureMessage: () => null,
    startupRestoreController: {
      beginSession: () => undefined,
      finishSession: () => events.push("finish-startup"),
      updateService: () => undefined,
      setEnvImportRequired: () => undefined,
      failCurrentSession: () => undefined
    },
    loadBuiltinServices: () => events.push("load-builtin-services"),
    loadInstalledPlugins: () => events.push("load-installed-plugins"),
    notifyCoreServicesChanged: () => undefined,
    startShellRuntime: () => events.push("create-tray"),
    startNonCoreRuntime: () => events.push("start-non-core"),
    setStartupPhase: (nextPhase) => {
      phase = nextPhase;
    },
    runServiceMutation: async (task) => task(),
    runStartupPreparation: async () => ({
      mode: "normal",
      failures: [{ serviceId: "identity-center", message: "port unavailable" }]
    }),
    t: (key) => key,
    onError: () => undefined
  });

  await pipeline.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.includes("create-tray"), true);
  assert.equal(events.includes("start-non-core"), false);
  assert.equal(phase, "degraded");
});

test("development version upgrade input request returns to the env selector", async () => {
  const events = [];
  let phase = "";
  const request = {
    reason: "desktop-version-change",
    fromVersion: "v0.3.35",
    toVersion: "v0.3.40"
  };
  const pipeline = createStartupPipeline({
    app: {},
    desktopVersion: "0.3.40",
    isFirstDesktopInstall: false,
    getEnvImportFailureMessage: () => null,
    startupRestoreController: {
      beginSession: () => undefined,
      finishSession: () => events.push("finish-startup"),
      updateService: () => undefined,
      setEnvImportRequired: (message, receivedRequest) => events.push(["env-input", message, receivedRequest]),
      failCurrentSession: () => undefined
    },
    loadBuiltinServices: () => undefined,
    loadInstalledPlugins: () => undefined,
    notifyCoreServicesChanged: () => events.push("notify-services"),
    startShellRuntime: () => events.push("create-tray"),
    startNonCoreRuntime: () => events.push("start-non-core"),
    setStartupPhase: (nextPhase) => {
      phase = nextPhase;
    },
    runServiceMutation: async (task) => task(),
    runStartupPreparation: async () => ({
      mode: "bootstrap",
      failures: [],
      inputRequired: { request, message: "" }
    }),
    t: (key) => key,
    onError: () => undefined
  });

  await pipeline.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    "create-tray",
    "notify-services",
    ["env-input", "", request],
    "notify-services"
  ]);
  assert.equal(phase, "degraded");
});
