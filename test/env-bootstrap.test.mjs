import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  resolveRuntimeRoot,
  resolveBundledEnvZipPath,
  shouldPromptEnvRootConflict,
  runtimeEnvExists,
  runtimeEnvNeedsBundledSeedRefresh
} = require(path.join(__dirname, "..", "dist-electron", "main", "env-bootstrap.js"));
const {
  WINDOWS_RUNTIME_ROOT_REGISTRY_KEY,
  WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE,
  __testInternals: runtimeRootInternals
} = require(path.join(__dirname, "..", "dist-electron", "main", "runtime-root.js"));
const { APP_BRAND } = require(path.join(__dirname, "..", "dist-electron", "shared", "brand.js"));

function createPathApp(root) {
  return {
    getPath(name) {
      if (name === "home") {
        return path.join(root, "home");
      }
      if (name === "appData") {
        return path.join(root, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

test("bundled env.zip falls back to the packaged app resources directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-packaged-resources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "CuteJ");
  const resourcesRoot = path.join(installRoot, "resources");
  const bundledEnvRoot = path.join(resourcesRoot, "env");
  const staleResourcesRoot = path.join(root, "stale-resources");
  fs.mkdirSync(bundledEnvRoot, { recursive: true });
  fs.mkdirSync(staleResourcesRoot, { recursive: true });
  fs.writeFileSync(path.join(bundledEnvRoot, "env.zip"), "zip", "utf8");

  const app = {
    isPackaged: true,
    getAppPath() {
      return path.join(resourcesRoot, "app.asar");
    }
  };

  assert.equal(
    resolveBundledEnvZipPath(app, "win32", staleResourcesRoot),
    path.join(resourcesRoot, "env", "env.zip")
  );
});

test("runtime env does not treat empty runtime directories as initialized", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-empty-runtime-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  assert.equal(resolveRuntimeRoot(app, "win32"), path.join(root, "home", APP_BRAND.paths.runtimeRootDirName));
  const runtimeRoot = resolveRuntimeRoot(app, "win32");
  for (const dirName of ["agents", "registries", "teams", "chats", "skills-market"]) {
    fs.mkdirSync(path.join(runtimeRoot, dirName), { recursive: true });
  }

  assert.equal(runtimeEnvExists(app, "win32"), false);

  fs.writeFileSync(path.join(runtimeRoot, "agents", "webOperator.yml"), "key: webOperator\n", "utf8");
  assert.equal(runtimeEnvExists(app, "win32"), true);
});

test("Windows runtime root can come from the installer selected data directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-selected-runtime-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selectedRoot = path.join(root, "selected-data");

  assert.equal(WINDOWS_RUNTIME_ROOT_REGISTRY_KEY, `Software\\${APP_BRAND.storageNamespace}`);
  assert.equal(WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE, "DataRoot");
  assert.equal(
    runtimeRootInternals.resolveRuntimeRootPath({
      platform: "win32",
      homePath: path.join(root, "home"),
      registryDataRootPath: selectedRoot
    }),
    selectedRoot
  );
});

test("Windows first install uses an existing selected data directory without old-data migration prompt", () => {
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "win32",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    false
  );
});

test("macOS runtime env keeps the existing home runtime root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mac-runtime-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  assert.equal(resolveRuntimeRoot(app, "darwin"), path.join(root, "home", APP_BRAND.paths.runtimeRootDirName));
});

test("runtime env marker still marks the runtime as initialized", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-marker-runtime-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const markerPath = path.join(
    resolveRuntimeRoot(app, "win32"),
    ".desktop",
    "state",
    "desktop",
    "env-bootstrap.json"
  );
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, "{}\n", "utf8");

  assert.equal(runtimeEnvExists(app, "win32"), true);
  assert.equal(runtimeEnvNeedsBundledSeedRefresh(app, "win32"), false);
});

test("runtime env requests bundled seed refresh when generated data exists without agents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-seed-refresh-runtime-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "win32");
  fs.mkdirSync(path.join(runtimeRoot, "chats"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "chats", "chats.db"), "sqlite", "utf8");

  assert.equal(runtimeEnvExists(app, "win32"), true);
  assert.equal(runtimeEnvNeedsBundledSeedRefresh(app, "win32"), true);

  fs.mkdirSync(path.join(runtimeRoot, "agents", "cutej"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "agents", "cutej", "agent.yml"), "key: cutej\n", "utf8");

  assert.equal(runtimeEnvNeedsBundledSeedRefresh(app, "win32"), false);
});
