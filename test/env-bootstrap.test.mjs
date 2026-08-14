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
  importBundledEnvZipToRuntime,
  resetBundledRuntimeEnv,
  resolveRuntimeRoot,
  resolveBundledEnvZipPath,
  shouldPromptEnvRootConflict,
  syncBundledEnvResourcesForVersion,
  runtimeEnvExists,
  runtimeEnvNeedsBundledSeedRefresh
} = require(path.join(__dirname, "..", "dist-electron", "main", "env-bootstrap.js"));
const {
  WINDOWS_RUNTIME_ROOT_REGISTRY_KEY,
  WINDOWS_RUNTIME_ROOT_REGISTRY_VALUE,
  __testInternals: runtimeRootInternals
} = require(path.join(__dirname, "..", "dist-electron", "main", "runtime-root.js"));
const { APP_BRAND } = require(path.join(__dirname, "..", "dist-electron", "shared", "brand.js"));
const { createStartupEnvironmentRuntime } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "app",
  "startup-environment.js"
));
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

test("versioned bundled resource sync adds new units, overlays registries, and preserves unrelated data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-resource-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const existingAgentScript = path.join(runtimeRoot, "agents", "existing", "keep.sh");
  const existingSkillFile = path.join(runtimeRoot, "skills-center", "existing", "SKILL.md");
  const existingToolFile = path.join(runtimeRoot, "tools", "existing", "tool.txt");
  const existingRegistryFile = path.join(runtimeRoot, "registries", "models", "bundled.yml");
  const customRegistryFile = path.join(runtimeRoot, "registries", "models", "custom.yml");
  const ownerFile = path.join(runtimeRoot, "owner", "OWNER.md");
  const chatFile = path.join(runtimeRoot, "chats", "keep.jsonl");
  for (const filePath of [
    existingAgentScript,
    existingSkillFile,
    existingToolFile,
    existingRegistryFile,
    customRegistryFile,
    ownerFile,
    chatFile
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  fs.writeFileSync(existingAgentScript, "#!/bin/sh\necho user-agent\n", "utf8");
  fs.chmodSync(existingAgentScript, 0o644);
  fs.writeFileSync(existingSkillFile, "# User skill\n", "utf8");
  fs.writeFileSync(existingToolFile, "user tool\n", "utf8");
  fs.writeFileSync(existingRegistryFile, "source: old\n", "utf8");
  fs.chmodSync(existingRegistryFile, 0o600);
  fs.writeFileSync(customRegistryFile, "source: custom\n", "utf8");
  fs.writeFileSync(ownerFile, "user owner\n", "utf8");
  fs.writeFileSync(chatFile, "user chat\n", "utf8");

  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "2.0.0\n",
    "env/agents/existing/keep.sh": "#!/bin/sh\necho bundled-agent\n",
    "env/agents/existing/new-inside-existing.txt": "must not be added\n",
    "env/agents/new-agent/agent.yml": "key: new-agent\n",
    "env/agents/new-agent/run.sh": "#!/bin/sh\necho new\n",
    "env/skills-center/existing/SKILL.md": "# Bundled skill\n",
    "env/skills-center/new-skill/SKILL.md": "# New skill\n",
    "env/tools/existing/tool.txt": "bundled tool\n",
    "env/tools/new-tool/tool.txt": "new tool\n",
    "env/registries/models/bundled.yml": "source: current\n",
    "env/registries/models/new.yml": "source: new\n",
    "env/owner/OWNER.md": "bundled owner\n",
    "env/chats/new.jsonl": "bundled chat\n",
    "env/teams/new/team.yml": "bundled team\n"
  });

  const result = await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "2.0.0"
  });
  assert.equal(result.status, "synced");
  assert.equal(result.copiedUnits, 3);
  assert.equal(result.skippedUnits, 3);
  assert.equal(result.addedRegistryFiles, 1);
  assert.equal(result.overwrittenRegistryFiles, 1);
  assert.equal(fs.readFileSync(existingAgentScript, "utf8"), "#!/bin/sh\necho user-agent\n");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "existing", "new-inside-existing.txt")), false);
  assert.equal(fs.readFileSync(existingSkillFile, "utf8"), "# User skill\n");
  assert.equal(fs.readFileSync(existingToolFile, "utf8"), "user tool\n");
  assert.equal(fs.readFileSync(existingRegistryFile, "utf8"), "source: current\n");
  assert.equal(fs.readFileSync(customRegistryFile, "utf8"), "source: custom\n");
  assert.equal(fs.readFileSync(ownerFile, "utf8"), "user owner\n");
  assert.equal(fs.readFileSync(chatFile, "utf8"), "user chat\n");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "chats", "new.jsonl")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "teams", "new", "team.yml")), false);
  assert.equal(fs.readFileSync(path.join(runtimeRoot, "agents", "new-agent", "agent.yml"), "utf8"), "key: new-agent\n");
  assert.equal(fs.readFileSync(path.join(runtimeRoot, "skills-center", "new-skill", "SKILL.md"), "utf8"), "# New skill\n");
  assert.equal(fs.readFileSync(path.join(runtimeRoot, "tools", "new-tool", "tool.txt"), "utf8"), "new tool\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(existingAgentScript).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(runtimeRoot, "agents", "new-agent", "run.sh")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(existingRegistryFile).mode & 0o777, 0o600);
  }

  const markerPath = path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.desktopVersion, "2.0.0");
  assert.deepEqual(marker.scopes, ["agents", "registries", "skills-center", "tools"]);
  assert.equal(marker.addedRegistryFiles, 1);
  assert.equal(marker.overwrittenRegistryFiles, 1);

  await writeEnvZip(zipPath, {
    "env/VERSION": "2.0.0\n",
    "env/registries/models/bundled.yml": "source: same-version-replacement\n"
  });
  const currentResult = await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "2.0.0"
  });
  assert.equal(currentResult.status, "current");
  assert.equal(fs.readFileSync(existingRegistryFile, "utf8"), "source: current\n");
});

test("resource sync reruns for a different Desktop version and for a damaged marker", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-resource-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "3.0.0\n",
    "env/registries/providers/current.yml": "version: 3\n"
  });
  await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "3.0.0"
  });

  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const markerPath = path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json");
  fs.writeFileSync(markerPath, "{not-json}\n", "utf8");
  await writeEnvZip(zipPath, {
    "env/VERSION": "3.0.0\n",
    "env/registries/providers/current.yml": "version: repaired-marker\n"
  });
  const repairedResult = await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "3.0.0"
  });
  assert.equal(repairedResult.status, "synced");
  assert.equal(repairedResult.overwrittenRegistryFiles, 1);

  await writeEnvZip(zipPath, {
    "env/VERSION": "2.0.0\n",
    "env/registries/providers/current.yml": "version: downgraded\n"
  });
  const downgradedResult = await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "2.0.0"
  });
  assert.equal(downgradedResult.status, "synced");
  assert.equal(
    fs.readFileSync(path.join(runtimeRoot, "registries", "providers", "current.yml"), "utf8"),
    "version: downgraded\n"
  );
});

test("resource sync treats an explicitly unbundled product as a no-op and rejects a missing declared package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-resource-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const resourcesRoot = path.join(root, "resources");
  const envRoot = path.join(resourcesRoot, "env");
  fs.mkdirSync(envRoot, { recursive: true });
  const manifestPath = path.join(envRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ bundled: false, fileName: null, version: "1.0.0" }), "utf8");

  const noBundleResult = await syncBundledEnvResourcesForVersion(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "1.0.0"
  });
  assert.equal(noBundleResult.status, "not-bundled");
  assert.equal(fs.existsSync(noBundleResult.targetRoot), false);

  fs.writeFileSync(manifestPath, JSON.stringify({ bundled: true, fileName: "env.zip", version: "1.0.0" }), "utf8");
  await assert.rejects(
    () => syncBundledEnvResourcesForVersion(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "1.0.0"
    }),
    /env\.zip/u
  );

  await writeEnvZip(path.join(envRoot, "env.zip"), {
    "env/VERSION": "1.0.0\n",
    "env/registries/models/demo.yml": "source: bundled\n"
  });
  fs.writeFileSync(manifestPath, JSON.stringify({
    bundled: true,
    fileName: "env.zip",
    version: "1.0.0",
    sha256: "0".repeat(64)
  }), "utf8");
  await assert.rejects(
    () => syncBundledEnvResourcesForVersion(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "1.0.0"
    }),
    /完整性|integrity/iu
  );
});

test("registry overlay type conflicts fail without committing a version marker", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-registry-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const conflictPath = path.join(runtimeRoot, "registries", "models", "conflict.yml");
  fs.mkdirSync(conflictPath, { recursive: true });
  fs.writeFileSync(path.join(conflictPath, "keep.txt"), "keep\n", "utf8");

  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/registries/models/conflict.yml": "source: bundled\n"
  });

  await assert.rejects(
    () => syncBundledEnvResourcesForVersion(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "1.0.0"
    }),
    /conflict\.yml/u
  );
  assert.equal(fs.readFileSync(path.join(conflictPath, "keep.txt"), "utf8"), "keep\n");
  assert.equal(
    fs.existsSync(path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json")),
    false
  );
});

test("startup environment preparation surfaces resource sync failure before core services", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-startup-resource-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const desktopVersion = fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": `${desktopVersion}\n`,
    "env/registries/models/conflict.yml": "source: bundled\n"
  });

  const pathApp = createPathApp(root);
  const app = {
    ...pathApp,
    isPackaged: true,
    getAppPath() {
      return path.join(resourcesRoot, "app.asar");
    },
    getVersion() {
      return desktopVersion;
    }
  };
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  fs.mkdirSync(path.join(runtimeRoot, "registries", "models", "conflict.yml"), { recursive: true });

  const startupEnvironment = createStartupEnvironmentRuntime({
    app,
    platform: "darwin",
    productName: "Test Desktop",
    envZipConflictNeedsDecision: false,
    requireEnvZipImportAtStartup: false,
    runtimeRootAtProcessStart: runtimeRoot,
    oldRootDecisionRef: { current: undefined },
    startupRestoreController: {
      beginSession() {},
      updateService() {},
      setEnvImportRequired() {}
    },
    async showMessageBox() {
      return { response: 0 };
    },
    t(key, values) {
      return values?.message ? `${key}: ${values.message}` : key;
    }
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await startupEnvironment.prepareStartupRuntimeEnvironment();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.ok, false);
  assert.match(result.message, /startup\.envImport\.resourceSyncFailed/u);
  assert.equal(
    fs.existsSync(path.join(runtimeRoot, ".desktop", "state", "desktop", "env-resource-sync.json")),
    false
  );
});

test("registry overlay rejects symlink parents without writing outside the runtime", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link creation requires platform-specific privileges on Windows");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-registry-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const runtimeRoot = resolveRuntimeRoot(app, "darwin");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(path.join(runtimeRoot, "registries"), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.symlinkSync(outsideRoot, path.join(runtimeRoot, "registries", "models"));

  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/registries/models/blocked.yml": "source: bundled\n"
  });

  await assert.rejects(
    () => syncBundledEnvResourcesForVersion(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: "1.0.0"
    }),
    /models/u
  );
  assert.equal(fs.existsSync(path.join(outsideRoot, "blocked.yml")), false);
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

test("bundled full import marks the current Desktop resource version", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bundled-resource-marker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createPathApp(root);
  const resourcesRoot = path.join(root, "resources");
  const zipPath = path.join(resourcesRoot, "env", "env.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await writeEnvZip(zipPath, {
    "env/VERSION": "1.0.0\n",
    "env/agents/bundled/agent.yml": "key: bundled\n"
  });
  const result = await importBundledEnvZipToRuntime(app, "darwin", {
    resourcesRoot,
    expectedDesktopVersion: "1.0.0"
  });
  assert.ok(result);
  const marker = JSON.parse(fs.readFileSync(path.join(
    result.targetRoot,
    ".desktop",
    "state",
    "desktop",
    "env-resource-sync.json"
  ), "utf8"));
  assert.equal(marker.desktopVersion, "1.0.0");
  assert.equal(marker.mode, "full-import");
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
  const resourceMarker = JSON.parse(fs.readFileSync(path.join(
    runtimeRoot,
    ".desktop",
    "state",
    "desktop",
    "env-resource-sync.json"
  ), "utf8"));
  assert.equal(resourceMarker.desktopVersion, "1.0.0");
  assert.equal(resourceMarker.mode, "full-import");
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
