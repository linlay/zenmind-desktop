import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  bundledEnvZipExists,
  importEnvZipToRuntime,
  importBundledEnvZipToRuntime,
  resetBundledRuntimeEnv,
  resolveRuntimeRoot,
  resolveBundledEnvZipPath,
  shouldPromptEnvRootConflict,
  stageValidatedDesktopVersionUpgradeInput,
  validateBundledEnvForDesktopVersionUpgrade,
  validateEnvZipForDesktopManualImport,
  validateSelectedEnvZipForDesktopVersionUpgrade,
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

function writeBundledEnvManifest(zipPath, version, overrides = {}) {
  const buffer = fs.readFileSync(zipPath);
  fs.writeFileSync(path.join(path.dirname(zipPath), "manifest.json"), `${JSON.stringify({
    bundled: true,
    fileName: "env.zip",
    version,
    size: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ...overrides
  })}\n`, "utf8");
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

test("Desktop version upgrade preflight validates manifest and reads desktop-init without writing runtime resources", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-upgrade-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createPathApp(root);
  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "v2.0.0\n",
    "env/desktop-init.json": JSON.stringify({
      services: {
        "agent-platform": {
          lifecycleArgs: {
            deploy: ["--ai-image-generate-model-key", "th-gpt-image-2"]
          }
        }
      }
    }),
    "env/agents/new/agent.yml": "key: new\n",
    "env/teams/new/team.yml": "name: New\n"
  });
  writeBundledEnvManifest(zipPath, "v2.0.0");

  const validated = await validateBundledEnvForDesktopVersionUpgrade(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "2.0.0"
  });
  assert.equal(validated.sourceZipPath, zipPath);
  assert.equal(validated.desktopVersion, "2.0.0");
  assert.equal(validated.desktopInit.services["agent-platform"].lifecycleArgs.deploy[1], "th-gpt-image-2");
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "new")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json")), false);
});

test("Desktop env upgrade preflight rejects SHA mismatch and missing desktop-init before runtime mutation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-upgrade-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createPathApp(root);
  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "v2.0.0\n",
    "env/desktop-init.json": "{}"
  });
  writeBundledEnvManifest(zipPath, "v2.0.0", { sha256: "0".repeat(64) });
  await assert.rejects(
    () => validateBundledEnvForDesktopVersionUpgrade(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "2.0.0"
    }),
    /完整性|integrity/iu
  );

  await writeEnvZip(zipPath, { "env/VERSION": "v2.0.0\n" });
  writeBundledEnvManifest(zipPath, "v2.0.0");
  await assert.rejects(
    () => validateBundledEnvForDesktopVersionUpgrade(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "2.0.0"
    }),
    /desktop-init\.json/u
  );
  assert.equal(fs.existsSync(resolveRuntimeRoot(app, "darwin")), false);
});

test("manual existing-runtime preflight accepts the current Desktop version and exposes the historical package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-manual-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createPathApp(root);
  const initialZip = path.join(root, "initial.zip");
  await writeEnvZip(initialZip, {
    "env/VERSION": "v2.0.0\n",
    "env/desktop-init.json": "{}",
    "env/agents/initial/agent.yml": "key: initial\n"
  });
  await importEnvZipToRuntime(app, initialZip, "darwin", "2.0.0");
  const manualZip = path.join(root, "manual.zip");
  await writeEnvZip(manualZip, {
    "env/VERSION": "v2.0.0\n",
    "env/desktop-init.json": JSON.stringify({ teams: {} }),
    "env/teams/manual/team.yml": "name: Manual\n"
  });
  const validated = await validateEnvZipForDesktopManualImport(app, manualZip, "2.0.0", "darwin");
  assert.equal(validated.sourceZipPath, manualZip);
  assert.equal(
    validated.previousSourceZipPath,
    path.join(resolveRuntimeRoot(app, "darwin"), ".desktop", "data", "env-initial", "env.zip")
  );
});

test("development version-change selection rejects mismatches, unsafe entries, symlinks, and damaged ZIPs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-selected-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createPathApp(root);

  const versionMismatchPath = path.join(root, "version-mismatch.zip");
  await writeEnvZip(versionMismatchPath, {
    "env/VERSION": "1.0.0\n",
    "env/desktop-init.json": "{}"
  });
  await assert.rejects(
    () => validateSelectedEnvZipForDesktopVersionUpgrade(app, versionMismatchPath, "2.0.0", "darwin"),
    /version|版本/iu
  );

  const unsafePath = path.join(root, "unsafe.zip");
  await writeEnvZip(unsafePath, {
    "env/VERSION": "2.0.0\n",
    "env/desktop-init.json": "{}",
    "env\\outside.txt": "unsafe"
  });
  await assert.rejects(
    () => validateSelectedEnvZipForDesktopVersionUpgrade(app, unsafePath, "2.0.0", "darwin"),
    /unsafe|安全/iu
  );

  const symlinkPath = path.join(root, "symlink.zip");
  const symlinkZip = new JSZip();
  symlinkZip.file("env/VERSION", "2.0.0\n");
  symlinkZip.file("env/desktop-init.json", "{}");
  symlinkZip.file("env/link", "target", { unixPermissions: 0o120777 });
  fs.writeFileSync(symlinkPath, await symlinkZip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  await assert.rejects(
    () => validateSelectedEnvZipForDesktopVersionUpgrade(app, symlinkPath, "2.0.0", "darwin"),
    /symbolic|symlink|符号/iu
  );

  const damagedPath = path.join(root, "damaged.zip");
  fs.writeFileSync(damagedPath, "not-a-zip", "utf8");
  await assert.rejects(
    () => validateSelectedEnvZipForDesktopVersionUpgrade(app, damagedPath, "2.0.0", "darwin")
  );
});

test("manual env import does not mark bundled resource sync complete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-manual-resource-marker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const zipPath = path.join(root, "manual-env.zip");
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/agents/manual/agent.yml": "key: manual\n"
  });
  await importEnvZipToRuntime(app, zipPath, "darwin", "1.0.0");
  assert.equal(
    fs.existsSync(path.join(
      resolveRuntimeRoot(app, "darwin"),
      ".desktop",
      "state",
      "desktop",
      "env-resource-sync.json"
    )),
    false
  );
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

test("development env.zip resolves from the explicit brand resources root on every dev platform", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-dev-env-resources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, "build", "brands", "zenmind", "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, "zip", "utf8");
  const previousRoot = process.env.DESKTOP_DEV_RESOURCES_ROOT;
  process.env.DESKTOP_DEV_RESOURCES_ROOT = resourcesRoot;
  t.after(() => {
    if (previousRoot === undefined) {
      delete process.env.DESKTOP_DEV_RESOURCES_ROOT;
    } else {
      process.env.DESKTOP_DEV_RESOURCES_ROOT = previousRoot;
    }
  });

  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(
      resolveBundledEnvZipPath({ isPackaged: false, getAppPath: () => root }, platform),
      zipPath
    );
  }
  assert.equal(
    resolveBundledEnvZipPath({ isPackaged: true, getAppPath: () => root }, "linux"),
    null
  );
  assert.notEqual(
    resolveBundledEnvZipPath({ isPackaged: true, getAppPath: () => root }, "darwin"),
    zipPath
  );
});

test("development bundled-env detection honors the active brand bundled=false manifest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-dev-env-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, "build", "brands", "zenmind", "resources");
  const manifestPath = path.join(resourcesRoot, "env", "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    bundled: false,
    fileName: null,
    version: "1.0.0"
  }), "utf8");
  const staleLegacyZip = path.join(root, "build", "resources", "env", "env.zip");
  fs.mkdirSync(path.dirname(staleLegacyZip), { recursive: true });
  fs.writeFileSync(staleLegacyZip, "stale", "utf8");
  const previousRoot = process.env.DESKTOP_DEV_RESOURCES_ROOT;
  process.env.DESKTOP_DEV_RESOURCES_ROOT = resourcesRoot;
  t.after(() => {
    if (previousRoot === undefined) {
      delete process.env.DESKTOP_DEV_RESOURCES_ROOT;
    } else {
      process.env.DESKTOP_DEV_RESOURCES_ROOT = previousRoot;
    }
  });

  assert.equal(
    bundledEnvZipExists({ isPackaged: false, getAppPath: () => root }, "darwin"),
    false
  );
});

test("validated development upgrade input is staged by sha with private permissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-staged-env-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceZipPath = path.join(root, "selected.zip");
  const content = Buffer.from("validated-env-zip", "utf8");
  fs.writeFileSync(sourceZipPath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const inputDir = path.join(root, "transaction", "input");
  const validated = {
    sourceZipPath,
    desktopVersion: "1.0.0",
    sha256,
    size: content.byteLength,
    desktopInit: {}
  };

  const staged = await stageValidatedDesktopVersionUpgradeInput(validated, inputDir, "darwin");
  assert.equal(staged.sourceZipPath, path.join(inputDir, `env-${sha256}.zip`));
  assert.deepEqual(fs.readFileSync(staged.sourceZipPath), content);
  assert.equal(fs.statSync(inputDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(staged.sourceZipPath).mode & 0o777, 0o600);

  const reused = await stageValidatedDesktopVersionUpgradeInput(validated, inputDir, "darwin");
  assert.equal(reused.sourceZipPath, staged.sourceZipPath);

  fs.writeFileSync(staged.sourceZipPath, "corrupt", "utf8");
  const repaired = await stageValidatedDesktopVersionUpgradeInput(validated, inputDir, "darwin");
  assert.equal(repaired.sourceZipPath, staged.sourceZipPath);
  assert.deepEqual(fs.readFileSync(repaired.sourceZipPath), content);
});

test("runtime env does not treat empty runtime directories as initialized", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-empty-runtime-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  assert.equal(resolveRuntimeRoot(app, "win32"), path.join(root, "home", APP_BRAND.paths.runtimeRootDirName));
  const runtimeRoot = resolveRuntimeRoot(app, "win32");
  for (const dirName of ["agents", "registries", "teams", "chats", "skills-center", "tools"]) {
    fs.mkdirSync(path.join(runtimeRoot, dirName), { recursive: true });
  }

  assert.equal(runtimeEnvExists(app, "win32"), false);

  fs.writeFileSync(path.join(runtimeRoot, "agents", "webOperator.yml"), "key: webOperator\n", "utf8");
  assert.equal(runtimeEnvExists(app, "win32"), true);
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
  assert.equal(
    fs.existsSync(path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json")),
    false
  );
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
