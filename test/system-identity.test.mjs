import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  configureSystemIdentity
} = await import(pathToFileURL(
  path.join(__dirname, "..", "dist-electron", "main", "app", "system-identity.js")
).href);

function createFakeApp(isPackaged) {
  const calls = {
    appUserModelIds: [],
    names: []
  };
  return {
    calls,
    app: {
      isPackaged,
      setName: (value) => calls.names.push(value),
      setAppUserModelId: (value) => calls.appUserModelIds.push(value),
      setAboutPanelOptions: () => {},
      getAppPath: () => path.join(__dirname, ".."),
      getVersion: () => "0.0.0"
    }
  };
}

function configureWindowsIdentity(app, appId, productName) {
  return configureSystemIdentity({
    app,
    platform: "win32",
    appId,
    productName,
    mainProcessDir: "C:\\app\\dist-electron",
    resourcesPath: "C:\\app\\resources",
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true })
    },
    safeConsoleError: () => {}
  });
}

test("Windows development identity uses the active brand development app ID", () => {
  const { app, calls } = createFakeApp(false);
  const runtime = configureWindowsIdentity(app, "cc.zenmind.desktop", "ZenMind");

  assert.equal(runtime.effectiveAppId, "cc.zenmind.desktop.dev");
  assert.deepEqual(calls.appUserModelIds, ["cc.zenmind.desktop.dev"]);
  assert.deepEqual(calls.names, ["ZenMind"]);
});

test("Windows packaged identity keeps each brand formal app ID", () => {
  const { app, calls } = createFakeApp(true);
  const runtime = configureWindowsIdentity(app, "cc.cutej.desktop", "CuteJ");

  assert.equal(runtime.effectiveAppId, "cc.cutej.desktop");
  assert.deepEqual(calls.appUserModelIds, ["cc.cutej.desktop"]);
  assert.deepEqual(calls.names, ["CuteJ"]);
});

test("Windows packaged startup restores the current user's document registration once", async t => {
  const require = createRequire(import.meta.url);
  const registration = require("../dist-electron/main/infrastructure/electron/windows-document-registration.js");
  const requests = [], paths = [];
  t.mock.method(registration, "refreshWindowsDocumentRegistration", async options => {
    requests.push(options);
    return { status: "unchanged", registeredTypes: [], preservedTypes: [] };
  });
  const { app } = createFakeApp(true);
  app.getPath = name => { paths.push(name); return "C:\\企业 应用\\CuteJ.exe"; };
  const runtime = configureWindowsIdentity(app, "cc.cutej.desktop", "CuteJ");
  runtime.ensureDockIdentity();
  runtime.ensureDockIdentity();
  assert.deepEqual(paths, [], "window activation returns before registry/path access");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [{
    platform: "win32", isPackaged: true, appId: "cc.cutej.desktop", productName: "CuteJ",
    executablePath: "C:\\企业 应用\\CuteJ.exe"
  }]);
  assert.deepEqual(paths, ["exe"]);
  runtime.ensureDockIdentity();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, "ordinary activations do not repeatedly access the registry");
});

test("Windows document registration policy failures do not block activation", async t => {
  const require = createRequire(import.meta.url);
  const registration = require("../dist-electron/main/infrastructure/electron/windows-document-registration.js");
  t.mock.method(registration, "refreshWindowsDocumentRegistration", () => { throw new Error("registry access denied (5)"); });
  const errors = [];
  const { app } = createFakeApp(true);
  app.getPath = () => "C:\\Apps\\CuteJ.exe";
  const runtime = configureSystemIdentity({
    app, platform: "win32", appId: "cc.cutej.desktop", productName: "CuteJ",
    mainProcessDir: "C:\\Apps\\resources\\app\\dist-electron", resourcesPath: "C:\\Apps\\resources",
    nativeImage: { createFromPath: () => { assert.fail("Windows must not load a macOS dock icon"); } },
    safeConsoleError: (...args) => errors.push(args)
  });
  assert.doesNotThrow(() => runtime.ensureDockIdentity());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [["failed to refresh Windows document registration", { error: "registry access denied (5)" }]]);
});

test("Windows development startup never registers the Electron executable", async t => {
  const require = createRequire(import.meta.url);
  const registration = require("../dist-electron/main/infrastructure/electron/windows-document-registration.js");
  t.mock.method(registration, "refreshWindowsDocumentRegistration", () => { assert.fail("development must not register file handlers"); });
  const { app } = createFakeApp(false);
  app.getPath = () => { assert.fail("development must not resolve an executable for registration"); };
  configureWindowsIdentity(app, "cc.cutej.desktop", "CuteJ").ensureDockIdentity();
  await new Promise(resolve => setImmediate(resolve));
});

test("macOS refresh is asynchronous, coalesces window activations and retries after failure", async t => {
  const require = createRequire(import.meta.url);
  const registry = require("../dist-electron/main/infrastructure/electron/mac-system-integration.js");
  const original = registry.refreshMacSystemIntegration;
  const realNow = Date.now;
  t.after(() => { registry.refreshMacSystemIntegration = original; Date.now = realNow; });
  let now = 1_000, requests = 0, rejectRefresh;
  Date.now = () => now;
  registry.refreshMacSystemIntegration = options => {
    requests++;
    assert.equal(options.bundleId, "cc.cutej.desktop");
    assert.equal(options.executablePath, "/Applications/CuteJ.app/Contents/MacOS/CuteJ");
    return new Promise((_resolve, reject) => { rejectRefresh = reject; });
  };
  const errors = [], activations = [];
  const { app } = createFakeApp(true);
  app.getPath = name => name === "exe" ? "/Applications/CuteJ.app/Contents/MacOS/CuteJ" : "/Users/test";
  app.setActivationPolicy = policy => activations.push(policy);
  const runtime = configureSystemIdentity({
    app, platform: "darwin", appId: "cc.cutej.desktop", productName: "CuteJ",
    mainProcessDir: "/Applications/CuteJ.app/Contents/Resources/app/dist-electron",
    resourcesPath: "/Applications/CuteJ.app/Contents/Resources",
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    safeConsoleError: (...args) => errors.push(args)
  });
  runtime.ensureDockIdentity();
  runtime.ensureDockIdentity();
  assert.deepEqual(activations, ["regular", "regular"], "window activation does not wait for system registration");
  assert.equal(requests, 0, "even argument/path resolution is deferred off the activation call");
  await Promise.resolve();
  assert.equal(requests, 1);
  now += 61_000;
  runtime.ensureDockIdentity();
  await Promise.resolve();
  assert.equal(requests, 1, "a pending refresh is never duplicated");
  rejectRefresh(new Error("fixture LaunchServices failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  runtime.ensureDockIdentity();
  await Promise.resolve();
  assert.equal(requests, 2, "a later activation retries the failed registration");
  rejectRefresh(new Error("fixture second failure"));
  await new Promise(resolve => setImmediate(resolve));
  runtime.ensureDockIdentity();
  await Promise.resolve();
  assert.equal(requests, 2, "completed failures still observe the activation rate limit");
});
