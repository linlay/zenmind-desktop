import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
