import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PROGRAM_DATA_VERSION_FILE,
  __testInternals,
  cleanupProgramDataForVersion
} = require("../dist-electron/main/program-data-cleanup.js");
const { getProgramsRoot, __testInternals: userPathInternals } = require("../dist-electron/main/user-paths.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

function expectedWindowsDataBaseRoot(root) {
  return path.join(root, "home", APP_BRAND.paths.runtimeRootDirName);
}

function createMockApp(root) {
  return {
    getPath(name) {
      if (name === "home") {
        return path.join(root, "home");
      }
      if (name === "appData") {
        return path.join(root, "app-data");
      }
      if (name === "temp") {
        return path.join(root, "temp");
      }
      throw new Error(`unexpected app path: ${name}`);
    },
    getVersion() {
      return "0.0.0";
    }
  };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-program-data-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createMockApp(root);
  const programRoot = path.join(expectedWindowsDataBaseRoot(root), "programs");
  const pluginsRoot = path.join(programRoot, "plugins");
  const runtimeRoot = path.join(expectedWindowsDataBaseRoot(root), APP_BRAND.paths.desktopDataSubdir);
  fs.mkdirSync(pluginsRoot, { recursive: true });
  return { app, root, programRoot, pluginsRoot, runtimeRoot };
}

test("program data cleanup keeps plugins and writes root VERSION when install version changes", (t) => {
  const { app, programRoot, pluginsRoot, runtimeRoot } = createFixture(t);
  fs.mkdirSync(path.join(programRoot, "services", "agent-platform"), { recursive: true });
  fs.writeFileSync(path.join(programRoot, "services", "agent-platform", "manifest.json"), "{}", "utf8");
  fs.mkdirSync(path.join(programRoot, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(programRoot, "Cache", "data_0"), "cache", "utf8");
  fs.mkdirSync(path.join(pluginsRoot, "user-plugin", "v1"), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, "user-plugin", "v1", "manifest.json"), "plugin", "utf8");
  fs.writeFileSync(path.join(programRoot, PROGRAM_DATA_VERSION_FILE), "v0.3.4\n", "utf8");

  const result = cleanupProgramDataForVersion(app, "0.3.5", {
    listProcessesImpl: () => [],
    terminateProcessTreeImpl: () => true
  });

  assert.equal(result.cleaned, true);
  assert.equal(result.previousVersion, "v0.3.4");
  assert.equal(result.currentVersion, "v0.3.5");
  assert.equal(fs.existsSync(path.join(programRoot, "services")), false);
  assert.equal(fs.existsSync(path.join(programRoot, "Cache")), false);
  assert.equal(fs.readFileSync(path.join(programRoot, PROGRAM_DATA_VERSION_FILE), "utf8"), "v0.3.5\n");
  assert.equal(fs.readFileSync(path.join(pluginsRoot, "user-plugin", "v1", "manifest.json"), "utf8"), "plugin");
  assert.equal(fs.existsSync(runtimeRoot), false);
});

test("Windows program data root lives under the unified runtime root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-program-root-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createMockApp(root);

  assert.equal(
    getProgramsRoot(app),
    path.join(expectedWindowsDataBaseRoot(root), "programs")
  );
  assert.equal(fs.existsSync(path.join(root, "app-data", APP_BRAND.paths.programDataDirName)), false);
});

test("macOS keeps desktop data under the home runtime root and programs in Application Support", () => {
  const homePath = "/Users/tester";
  const appDataPath = "/Users/tester/Library/Application Support";

  assert.equal(
    userPathInternals.resolveDesktopRoot({ platform: "darwin", homePath, appDataPath }),
    path.posix.join(homePath, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir)
  );
  assert.equal(
    userPathInternals.resolveApplicationSupportRoot({ platform: "darwin", appDataPath, homePath }),
    path.posix.join(appDataPath, APP_BRAND.paths.programDataDirName)
  );
});

test("program data cleanup treats missing VERSION as a fresh install marker", (t) => {
  const { app, programRoot, pluginsRoot } = createFixture(t);
  fs.mkdirSync(path.join(programRoot, "services", "agent-platform"), { recursive: true });
  fs.mkdirSync(path.join(programRoot, "profile-cache"), { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, "user-plugin"), { recursive: true });

  const result = cleanupProgramDataForVersion(app, "0.3.5", {
    listProcessesImpl: () => [],
    terminateProcessTreeImpl: () => true
  });

  assert.equal(result.cleaned, true);
  assert.equal(result.previousVersion, "");
  assert.equal(fs.existsSync(path.join(programRoot, "services")), false);
  assert.equal(fs.existsSync(path.join(programRoot, "profile-cache")), false);
  assert.equal(fs.existsSync(path.join(pluginsRoot, "user-plugin")), true);
  assert.equal(fs.readFileSync(path.join(programRoot, PROGRAM_DATA_VERSION_FILE), "utf8"), "v0.3.5\n");
});

test("program data cleanup skips matching VERSION and leaves existing program data untouched", (t) => {
  const { app, programRoot, pluginsRoot } = createFixture(t);
  fs.mkdirSync(path.join(programRoot, "services", "identity-center"), { recursive: true });
  fs.writeFileSync(path.join(programRoot, "services", "identity-center", "manifest.json"), "{}", "utf8");
  fs.mkdirSync(path.join(pluginsRoot, "user-plugin", "v1"), { recursive: true });
  fs.writeFileSync(path.join(programRoot, PROGRAM_DATA_VERSION_FILE), "v0.3.5\n", "utf8");

  const result = cleanupProgramDataForVersion(app, "v0.3.5", {
    listProcessesImpl: () => {
      throw new Error("processes should not be scanned when cleanup is skipped");
    },
    terminateProcessTreeImpl: () => true
  });

  assert.equal(result.skipped, true);
  assert.equal(result.cleaned, false);
  assert.deepEqual(result.removedPaths, []);
  assert.equal(fs.existsSync(path.join(programRoot, "services", "identity-center")), true);
});

test("program data cleanup stops processes only under paths that will be removed", (t) => {
  const { app, programRoot, pluginsRoot } = createFixture(t);
  fs.mkdirSync(path.join(programRoot, "services", "agent-platform"), { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, "user-plugin", "v1"), { recursive: true });
  fs.writeFileSync(path.join(programRoot, PROGRAM_DATA_VERSION_FILE), "v0.3.4\n", "utf8");
  const stoppedPids = [];

  const result = cleanupProgramDataForVersion(app, "v0.3.5", {
    listProcessesImpl: () => [
      { pid: 101, identity: path.join(programRoot, "services", "agent-platform", "backend", "server") },
      { pid: 202, identity: path.join(pluginsRoot, "user-plugin", "v1", "backend", "server") },
      { pid: 303, identity: path.join(programRoot, "services-old", "backend", "server") }
    ],
    terminateProcessTreeImpl: (pid) => {
      stoppedPids.push(pid);
      return true;
    }
  });

  assert.equal(result.cleaned, true);
  assert.deepEqual(stoppedPids, [101]);
  assert.deepEqual(result.stoppedPids, [101]);
  assert.equal(fs.existsSync(path.join(pluginsRoot, "user-plugin", "v1")), true);
});

test("program data cleanup preserves plugins and VERSION case-insensitively on Windows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-program-data-cleanup-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "Plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, "version"), "v0.3.5\n", "utf8");
  fs.mkdirSync(path.join(root, "Services"), { recursive: true });

  const targets = __testInternals
    .listProgramDataRemovalTargets(root, "win32")
    .map((targetPath) => path.basename(targetPath))
    .sort();

  assert.deepEqual(targets, ["Services"]);
});
