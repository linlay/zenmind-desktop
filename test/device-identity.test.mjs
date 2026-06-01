import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals: identityInternals,
  getDesktopDeviceId,
  getDesktopDeviceIdentity,
  getDesktopDeviceIdentityPath
} = require("../dist-electron/main/device-identity.js");
const { __testInternals: userPathInternals } = require("../dist-electron/main/user-paths.js");

function createApp(root) {
  return {
    getPath(name) {
      switch (name) {
        case "home":
          return path.join(root, "home");
        case "appData":
          return path.join(root, "app-data");
        case "userData":
          return path.join(root, "home", ".zenmind", ".desktop", "profiles", "electron");
        default:
          assert.fail(`unexpected app.getPath(${name})`);
      }
    }
  };
}

test("getDesktopDeviceIdentity creates and persists an installation UUID", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-device-identity-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const identity = getDesktopDeviceIdentity(app);
  const identityPath = getDesktopDeviceIdentityPath(app);

  assert.equal(identityPath, path.join(root, "home", ".zenmind", ".desktop", "config", "desktop", "device-identity.json"));
  assert.equal(identity.version, 1);
  assert.equal(identityInternals.isValidUuid(identity.deviceId), true);
  assert.equal(fs.existsSync(identityPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(identityPath, "utf8")), identity);
});

test("getDesktopDeviceId reuses an existing valid UUID", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-device-identity-reuse-"));
  const app = createApp(root);
  const identityPath = getDesktopDeviceIdentityPath(app);
  const existing = {
    version: 1,
    deviceId: "9d8f4d98-14e6-4af9-b60e-6f949560dbb6",
    createdAt: "2026-06-01T00:00:00.000Z"
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

  assert.equal(getDesktopDeviceId(app), existing.deviceId);
  assert.deepEqual(JSON.parse(fs.readFileSync(identityPath, "utf8")), existing);
});

test("device identity path follows the layered desktop root on macOS and Windows", () => {
  const macRoot = userPathInternals.resolveDesktopRoot({
    platform: "darwin",
    homePath: "/Users/alice"
  });
  const windowsRoot = userPathInternals.resolveDesktopRoot({
    platform: "win32",
    homePath: String.raw`C:\Users\alice`
  });

  assert.equal(path.posix.join(macRoot, "config", "desktop", identityInternals.DEVICE_IDENTITY_FILE), "/Users/alice/.zenmind/.desktop/config/desktop/device-identity.json");
  assert.equal(path.win32.join(windowsRoot, "config", "desktop", identityInternals.DEVICE_IDENTITY_FILE), String.raw`C:\Users\alice\.zenmind\.desktop\config\desktop\device-identity.json`);
});
