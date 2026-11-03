import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const importerUrl = new URL("../dist-electron/main/infrastructure/filesystem/runtime-env-import.js", import.meta.url);
const require = createRequire(importerUrl);
const importerSource = fs.readFileSync(importerUrl, "utf8");
const JSZip = require("jszip");

async function stagingFixture(platform, targetRoot, { source = "manual", mkdirError, stagingError } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const parent = pathApi.dirname(targetRoot);
  const stageReached = stagingError ?? new Error("staging reached");
  const mkdirCalls = [];
  const stagingCalls = [];
  const zip = new JSZip();
  zip.file("env/VERSION", "1.0.0");
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const module = { exports: {} };

  vm.runInNewContext(importerSource, {
    module,
    exports: module.exports,
    process,
    require(specifier) {
      if (specifier === "node:path") return pathApi;
      if (specifier === "node:fs") return {
        promises: { readFile: async () => zipBuffer },
        existsSync: () => false,
        mkdirSync(directory, options) {
          mkdirCalls.push({ directory, options });
          if (platform === "win32" && directory === pathApi.parse(directory).root) {
            throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${directory}'`), { code: "EPERM" });
          }
          if (mkdirError) throw mkdirError;
        },
        mkdtempSync(prefix) {
          stagingCalls.push(prefix);
          // Stop at this boundary: the regression must never write to a real drive root.
          throw stageReached;
        }
      };
      if (specifier === "./runtime-env-paths") return {
        ...require(specifier), resolveRuntimeRoot: () => targetRoot
      };
      if (specifier === "./runtime-env-publication") return {
        ...require(specifier), inspectEnvImportTarget: () => undefined
      };
      if (specifier === "./runtime-env-bundle") return {
        ...require(specifier), resolveBundledEnvPackage: () => ({ zipPath: pathApi.join(parent, "env.zip") })
      };
      return require(specifier);
    }
  }, { filename: fileURLToPath(importerUrl) });

  return {
    run: source === "bundled"
      ? () => module.exports.importBundledEnvZipToRuntime({}, platform, { targetRoot, expectedDesktopVersion: "1.0.0" })
      : () => module.exports.importEnvZipToRuntime({}, pathApi.join(parent, "env.zip"), platform, "1.0.0"),
    parent, stageReached, mkdirCalls, stagingCalls, pathApi
  };
}

for (const targetRoot of ["D:\\.cutej", "C:\\.cutej"]) {
  for (const source of ["bundled", "manual"]) {
    test(`Windows ${source} env import reaches sibling staging for ${targetRoot} without creating the drive root`, async () => {
      const fixture = await stagingFixture("win32", targetRoot, { source });
      await assert.rejects(fixture.run(), error => error === fixture.stageReached);
      assert.equal(fixture.mkdirCalls.length, 0);
      assert.deepEqual(fixture.stagingCalls, [fixture.pathApi.join(fixture.parent, ".desktop-env-import-")]);
    });
  }
}

for (const [platform, targetRoot] of [
  ["win32", "D:\\CuteJData\\.cutej"],
  ["darwin", "/Users/test/.cutej"],
  ["darwin", "/.cutej"]
]) {
  test(`${platform} env import still creates the parent directory for ${targetRoot}`, async () => {
    const fixture = await stagingFixture(platform, targetRoot);
    await assert.rejects(fixture.run(), error => error === fixture.stageReached);
    assert.equal(fixture.mkdirCalls.length, 1);
    assert.equal(fixture.mkdirCalls[0].directory, fixture.parent);
    assert.equal(fixture.mkdirCalls[0].options.recursive, true);
    assert.deepEqual(fixture.stagingCalls, [fixture.pathApi.join(fixture.parent, ".desktop-env-import-")]);
  });
}

test("Windows env import preserves parent creation errors before attempting staging", async () => {
  const denied = Object.assign(new Error("parent directory is not writable"), { code: "EACCES" });
  const fixture = await stagingFixture("win32", "D:\\CuteJData\\.cutej", { mkdirError: denied });
  await assert.rejects(fixture.run(), error => error === denied);
  assert.equal(fixture.stagingCalls.length, 0);
});

for (const code of ["EPERM", "ENOENT"]) {
  test(`Windows env import preserves ${code} from sibling staging at the drive root`, async () => {
    const failure = Object.assign(new Error(`staging failed: ${code}`), { code });
    const fixture = await stagingFixture("win32", "D:\\.cutej", { stagingError: failure });
    await assert.rejects(fixture.run(), error => error === failure);
    assert.equal(fixture.mkdirCalls.length, 0);
    assert.deepEqual(fixture.stagingCalls, ["D:\\.desktop-env-import-"]);
  });
}
