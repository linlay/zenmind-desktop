import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getHelpSettingsPath,
  normalizeHelpSettings,
  normalizeHelpUrl,
  readHelpSettings,
  writeHelpSettings
} = require("../dist-electron/main/help-settings.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

function createApp(homePath) {
  return {
    getPath(name) {
      assert.equal(name, "home");
      return homePath;
    }
  };
}

test("Help settings accept remote HTTPS and loopback HTTP only", () => {
  assert.equal(normalizeHelpUrl("https://www.zenmind.cc/help/#topic"), "https://www.zenmind.cc/help/");
  assert.equal(normalizeHelpUrl("http://127.0.0.1:5173/help/"), "http://127.0.0.1:5173/help/");
  assert.equal(normalizeHelpUrl("http://localhost:5173/help/"), "http://localhost:5173/help/");
  assert.equal(normalizeHelpUrl("http://example.com/help/"), "");
  assert.equal(normalizeHelpUrl("file:///tmp/help.html"), "");
  assert.equal(normalizeHelpUrl("https://user:secret@example.com/help/"), "");
});

test("Help settings use the canonical Desktop config file", (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-help-settings-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const app = createApp(homePath);
  const settings = normalizeHelpSettings({
    schemaVersion: 99,
    url: "https://www.zenmind.cc/help/"
  });

  assert.deepEqual(settings, {
    schemaVersion: 1,
    url: "https://www.zenmind.cc/help/"
  });
  writeHelpSettings(app, settings, "darwin");
  assert.equal(
    getHelpSettingsPath(app, "darwin"),
    path.join(
      homePath,
      APP_BRAND.paths.runtimeRootDirName,
      ".desktop",
      "config",
      "desktop",
      "help.json"
    )
  );
  assert.deepEqual(readHelpSettings(app, "darwin"), settings);
});

test("missing or invalid Help settings do not introduce an implicit website", (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-help-settings-empty-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const app = createApp(homePath);

  assert.deepEqual(readHelpSettings(app, "darwin"), {
    schemaVersion: 1,
    url: ""
  });
});
