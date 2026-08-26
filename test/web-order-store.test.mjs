import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getWebOrderPath,
  writeWebOrderKeys
} = require("../dist-electron/main/webs/order-store.js");
const {
  getDesktopConfigRoot
} = require("../dist-electron/main/user-paths.js");
const {
  getDesktopProfilePath
} = require("../dist-electron/main/desktop-profile-store.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(homePath, "app-data");
      if (name === "temp") return path.join(homePath, "tmp");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

test("writing an unchanged web order does not rewrite order or profile files", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-web-order-"));
  const app = createApp(homePath);
  const platform = "linux";
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));

  writeWebOrderKeys(app, ["website:docs", "webapp:local"], platform);
  const orderPath = getWebOrderPath(app, platform);
  const profilePath = getDesktopProfilePath(getDesktopConfigRoot(app, platform));
  const firstOrderModifiedAt = fs.statSync(orderPath).mtimeMs;
  const firstProfileModifiedAt = fs.statSync(profilePath).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 30));
  writeWebOrderKeys(app, ["website:docs", "webapp:local"], platform);

  assert.equal(fs.statSync(orderPath).mtimeMs, firstOrderModifiedAt);
  assert.equal(fs.statSync(profilePath).mtimeMs, firstProfileModifiedAt);
});
