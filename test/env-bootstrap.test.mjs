import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  importEnvZipToRuntime,
  resetBundledRuntimeEnv,
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
const { __testInternals: userPathInternals } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "user-paths.js"
));

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

async function writeEnvZip(zipPath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("env.zip import restores POSIX shell script permissions, including skipped files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-script-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const skippedShellPath = path.join(runtimeRoot, "agents", "existing", "repair.sh");
  fs.mkdirSync(path.dirname(skippedShellPath), { recursive: true });
  fs.writeFileSync(skippedShellPath, "#!/usr/bin/env bash\necho old\n", "utf8");
  fs.chmodSync(skippedShellPath, 0o644);

  const zipPath = path.join(root, "env.zip");
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/agents/bootstrap/bootstrap.sh": "#!/usr/bin/env bash\necho bootstrap\n",
    "env/agents/bootstrap/bootstrap.ps1": "Write-Output 'bootstrap'\n",
    "env/agents/existing/repair.sh": "#!/usr/bin/env bash\necho replacement\n"
  });

  const result = await importEnvZipToRuntime(app, zipPath, "darwin", "1.0.0");
  assert.equal(result.copiedFiles, 3);
  assert.equal(result.skippedFiles, 1);
  assert.equal(fs.readFileSync(skippedShellPath, "utf8"), "#!/usr/bin/env bash\necho old\n");

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(runtimeRoot, "agents", "bootstrap", "bootstrap.sh")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(skippedShellPath).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(runtimeRoot, "agents", "bootstrap", "bootstrap.ps1")).mode & 0o777, 0o644);
  }
});

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
  for (const dirName of ["agents", "registries", "teams", "chats", "skills-center"]) {
    fs.mkdirSync(path.join(runtimeRoot, dirName), { recursive: true });
  }

  assert.equal(runtimeEnvExists(app, "win32"), false);

  fs.writeFileSync(path.join(runtimeRoot, "agents", "webOperator.yml"), "key: webOperator\n", "utf8");
  assert.equal(runtimeEnvExists(app, "win32"), true);
});

test("macOS and Windows remove only empty legacy skills-market runtime directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-empty-removed-skill-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const platform of ["darwin", "win32"]) {
    const app = createPathApp(path.join(root, platform));
    const runtimeRoot = resolveRuntimeRoot(app, platform);
    const removedRoot = path.join(runtimeRoot, "skills-market");
    fs.mkdirSync(path.join(removedRoot, "nested", "empty"), { recursive: true });
    fs.writeFileSync(path.join(removedRoot, ".DS_Store"), "metadata\n", "utf8");

    assert.equal(runtimeEnvExists(app, platform), false);
    assert.equal(fs.existsSync(removedRoot), false);
  }
});

test("legacy skills-market runtime directories fail before Desktop writes skills-center", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-removed-skill-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const removedRoot = path.join(runtimeRoot, "skills-market");
  fs.mkdirSync(removedRoot, { recursive: true });
  fs.writeFileSync(path.join(removedRoot, "keep.txt"), "keep\n", "utf8");

  assert.throws(() => runtimeEnvExists(app, "darwin"), /skills-market/u);

  const zipPath = path.join(root, "env.zip");
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/skills-center/demo/SKILL.md": "# Demo\n"
  });
  await assert.rejects(
    () => importEnvZipToRuntime(app, zipPath, "darwin", "1.0.0"),
    /skills-market/u
  );
  assert.equal(fs.readFileSync(path.join(removedRoot, "keep.txt"), "utf8"), "keep\n");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills-center")), false);
});

test("legacy skills-market env.zip is rejected before creating the runtime root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-removed-skill-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const zipPath = path.join(root, "env.zip");
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/skills-market/demo/SKILL.md": "# Demo\n"
  });

  await assert.rejects(
    () => importEnvZipToRuntime(app, zipPath, "darwin", "1.0.0"),
    /skills-market/u
  );
  assert.equal(fs.existsSync(runtimeRoot), false);
});

test("legacy and new skill directories together still fail without modifying either", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mixed-skill-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "win32");
  const removedFile = path.join(runtimeRoot, "skills-market", "removed.txt");
  const centerFile = path.join(runtimeRoot, "skills-center", "center.txt");
  fs.mkdirSync(path.dirname(removedFile), { recursive: true });
  fs.mkdirSync(path.dirname(centerFile), { recursive: true });
  fs.writeFileSync(removedFile, "removed\n", "utf8");
  fs.writeFileSync(centerFile, "center\n", "utf8");

  assert.throws(() => runtimeEnvExists(app, "win32"), /skills-market/u);
  assert.equal(fs.readFileSync(removedFile, "utf8"), "removed\n");
  assert.equal(fs.readFileSync(centerFile, "utf8"), "center\n");
});

test("explicit bundled reset backs up a legacy runtime and restores skills-center", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-center-reset-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  fs.mkdirSync(path.join(runtimeRoot, "skills-market"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "skills-market", "keep.txt"), "legacy\n", "utf8");

  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/skills-center/demo/SKILL.md": "# Demo\n"
  });

  const result = await resetBundledRuntimeEnv(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "1.0.0",
    nowSeconds: 123
  });
  assert.equal(result.backupPath, `${runtimeRoot}-123`);
  assert.equal(fs.readFileSync(path.join(result.backupPath, "skills-market", "keep.txt"), "utf8"), "legacy\n");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills-center", "demo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills-market")), false);
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

test("Windows registry runtime root preserves non-ASCII values from encoded PowerShell output", () => {
  const selectedRoot = "D:\\OneDrive\\中文目录\\.cutej";
  const encodedRoot = Buffer.from(selectedRoot, "utf8").toString("base64");
  let capturedArgs;

  const actual = runtimeRootInternals.readWindowsRuntimeRootFromRegistryUncached({
    platform: "win32",
    execFileSyncImpl(command, args) {
      assert.match(command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
      capturedArgs = args;
      return Buffer.from(encodedRoot, "ascii");
    }
  });

  assert.equal(actual, selectedRoot);
  assert.deepEqual(capturedArgs?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const registryScript = Buffer.from(capturedArgs[3], "base64").toString("utf16le");
  assert.match(registryScript, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.OpenSubKey/u);
  assert.match(registryScript, new RegExp(WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE, "u"));
});

test("Windows program root stays under roaming app data when data root is selected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-selected-program-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selectedRoot = path.join(root, "selected-data");

  assert.equal(
    userPathInternals.resolveApplicationSupportRoot({
      platform: "win32",
      appDataPath: path.join(root, "AppData", "Roaming"),
      homePath: path.join(root, "home"),
      registryDataRootPath: selectedRoot
    }),
    path.join(root, "AppData", "Roaming", APP_BRAND.paths.programDataDirName)
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
