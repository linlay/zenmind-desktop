import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  normalizeEnterpriseImSettings,
  readEnterpriseImSettings,
  setEnterpriseImEnabled,
  writeEnterpriseImSettings
} = require("../dist-electron/main/modules/enterprise-chat/settings.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

test("enterprise IM settings require enabled and a secure remote base URL", () => {
  assert.deepEqual(normalizeEnterpriseImSettings({
    enabled: true,
    baseUrl: "https://im.example.test/api/?ignored=yes#fragment"
  }), {
    schemaVersion: 1,
    enabled: true,
    baseUrl: "https://im.example.test/api"
  });
  assert.equal(normalizeEnterpriseImSettings({
    baseUrl: "https://im.example.test"
  }), null);
  assert.equal(normalizeEnterpriseImSettings({
    enabled: false,
    baseUrl: "http://im.example.test"
  }), null);
  assert.deepEqual(normalizeEnterpriseImSettings({
    enabled: false,
    baseUrl: "http://127.0.0.1:11956/"
  }), {
    schemaVersion: 1,
    enabled: false,
    baseUrl: "http://127.0.0.1:11956"
  });
});

test("enterprise IM settings ignore retired files and preserve the base URL when toggled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-enterprise-im-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const configRoot = getDesktopConfigRoot(app, "darwin");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, "im-server.json"), JSON.stringify({
    schemaVersion: 1,
    baseUrl: "https://legacy-im.example.test"
  }), "utf8");
  fs.writeFileSync(path.join(configRoot, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    general: {
      enterpriseChatEnabled: true
    }
  }), "utf8");

  assert.deepEqual(readEnterpriseImSettings(app, "darwin"), {
    schemaVersion: 1,
    enabled: false,
    baseUrl: "http://127.0.0.1:11956"
  });

  writeEnterpriseImSettings(app, {
    schemaVersion: 1,
    enabled: false,
    baseUrl: "https://im.example.test"
  }, "darwin");
  assert.deepEqual(setEnterpriseImEnabled(app, true, "darwin"), {
    schemaVersion: 1,
    enabled: true,
    baseUrl: "https://im.example.test"
  });
});
