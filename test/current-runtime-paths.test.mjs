import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { resolveRuntimeRootPath } = require("../dist-electron/main/infrastructure/filesystem/runtime-root.js");
const { getManagedPidFilePaths } = require("../dist-electron/main/modules/services/manager/pid-files.js");
const { getSkillsCenterDir } = require("../dist-electron/main/modules/marketplace/skill-installer.js");

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} resolves the current brand root without filesystem discovery`, (t) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const home = platform === "win32" ? "C:\\Users\\tester" : "/users/tester";
    for (const method of ["existsSync", "statSync", "readdirSync"]) {
      t.mock.method(fs, method, () => assert.fail("root resolution must not discover directories"));
    }
    assert.equal(resolveRuntimeRootPath({ platform, homePath: home, registryDataRootPath: "" }),
      paths.join(home, APP_BRAND.paths.runtimeRootDirName));
  });
}

test("Windows accepts only current-brand registered paths, without probing invalid input", (t) => {
  t.mock.method(fs, "existsSync", () => assert.fail("registered paths are validated as strings"));
  const homePath = "C:\\Users\\tester";
  const selected = `D:\\中文数据\\${APP_BRAND.paths.runtimeRootDirName}`;
  assert.equal(resolveRuntimeRootPath({ platform: "win32", homePath, registryDataRootPath: selected }), selected);
  assert.equal(resolveRuntimeRootPath({ platform: "win32", homePath, registryDataRootPath: "D:\\arbitrary-data" }),
    path.win32.join(homePath, APP_BRAND.paths.runtimeRootDirName));
});

test("PID paths are derived only from the current service state layout", () => {
  const layout = { programDir: "/program", stateDir: "/state" };
  assert.deepEqual(getManagedPidFilePaths({ runtime: { pidRelativePath: "run/service.pid" } }, layout),
    [path.join(layout.stateDir, "service.pid")]);
  assert.deepEqual(getManagedPidFilePaths({ runtime: { pidRelativePath: "" } }, layout), []);
});

test("skill storage uses the shared root without inspecting directory contents", (t) => {
  const homePath = process.platform === "win32" ? "C:\\Users\\tester" : "/users/tester";
  const expected = path.join(resolveRuntimeRootPath({ homePath }), "skills-center");
  for (const method of ["existsSync", "statSync", "readdirSync"]) {
    t.mock.method(fs, method, () => assert.fail("skill storage must not discover directories"));
  }
  assert.equal(getSkillsCenterDir({ getPath: name => {
    assert.equal(name, "home");
    return homePath;
  } }), expected);
});
