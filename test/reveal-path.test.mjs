import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { revealPathInFileManager } = require("../dist-electron/main/reveal-path.js");

function createDeps({
  platform,
  existingPaths = [],
  directoryPaths = [],
  openPathResult = ""
}) {
  const calls = [];
  const existing = new Set(existingPaths);
  const directories = new Set(directoryPaths);

  return {
    calls,
    deps: {
      platform,
      existsSync: (targetPath) => existing.has(targetPath),
      statSync: (targetPath) => ({
        isDirectory: () => directories.has(targetPath)
      }),
      showItemInFolder: (targetPath) => {
        calls.push(["showItemInFolder", targetPath]);
      },
      openPath: async (targetPath) => {
        calls.push(["openPath", targetPath]);
        return openPathResult;
      }
    }
  };
}

test("revealPathInFileManager reveals existing macOS files in Finder", async () => {
  const targetPath = "/Users/test/service/run/app.log";
  const { calls, deps } = createDeps({
    platform: "darwin",
    existingPaths: [targetPath]
  });

  const result = await revealPathInFileManager(targetPath, { targetType: "file" }, deps);

  assert.equal(result.ok, true);
  assert.match(result.message, /Finder/);
  assert.deepEqual(calls, [["showItemInFolder", targetPath]]);
});

test("revealPathInFileManager opens existing Windows directories in Explorer", async () => {
  const targetPath = "C:\\Users\\test\\AppData\\Roaming\\ZenMind\\services";
  const { calls, deps } = createDeps({
    platform: "win32",
    existingPaths: [targetPath],
    directoryPaths: [targetPath]
  });

  const result = await revealPathInFileManager(targetPath, { targetType: "directory" }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["openPath", targetPath]]);
});

test("revealPathInFileManager opens parent directory for missing files", async () => {
  const targetPath = "/Users/test/service/run/app.pid";
  const parentPath = "/Users/test/service/run";
  const { calls, deps } = createDeps({
    platform: "darwin",
    existingPaths: [parentPath],
    directoryPaths: [parentPath]
  });

  const result = await revealPathInFileManager(targetPath, { targetType: "file" }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.path, parentPath);
  assert.match(result.message, /尚未创建/);
  assert.deepEqual(calls, [["openPath", parentPath]]);
});

test("revealPathInFileManager rejects relative paths", async () => {
  const { calls, deps } = createDeps({
    platform: "darwin"
  });

  const result = await revealPathInFileManager("run/app.log", { targetType: "file" }, deps);

  assert.equal(result.ok, false);
  assert.match(result.message, /绝对路径/);
  assert.deepEqual(calls, []);
});

test("revealPathInFileManager returns shell errors from openPath", async () => {
  const targetPath = "/Users/test/service/configs";
  const { calls, deps } = createDeps({
    platform: "darwin",
    existingPaths: [targetPath],
    directoryPaths: [targetPath],
    openPathResult: "permission denied"
  });

  const result = await revealPathInFileManager(targetPath, { targetType: "directory" }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.message, "permission denied");
  assert.deepEqual(calls, [["openPath", targetPath]]);
});
