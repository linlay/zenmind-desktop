import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  getDesktopDeviceIdentity,
  getDesktopDeviceIdentityInfo,
  getDesktopDeviceIdentityPath
} = require("../dist-electron/main/modules/identity/device-identity.js");
const {
  buildDesktopDeviceName,
  getDesktopDeviceInfo
} = require("../dist-electron/main/modules/identity/device-info.js");
const {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const { getDesktopConfigRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

const INSTALL_ID = "11111111-2222-4333-8444-555555555555";
const INSTALL_ID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MACHINE_A = "12345678-1234-1234-1234-123456789abc";
const MACHINE_B = "abcdefab-cdef-abcd-efab-cdefabcdefab";
const CREATED_AT = "2026-06-20T00:00:00.000Z";
const REBOUND_AT = "2026-06-20T00:01:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fixedNow(iso) {
  return () => new Date(iso);
}

function createTestApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "AppData", "Roaming");
      }
      if (name === "temp") {
        return os.tmpdir();
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

function withTempApp(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = createTestApp(path.join(tempRoot, "home"));
  return {
    app,
    tempRoot,
    cleanup: () => {
      __testInternals.clearDesktopDeviceIdentityCache(getDesktopDeviceIdentityPath(app));
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

function machineIdentity(machineId, source = "darwinIOPlatformUUID") {
  return { machineId, source };
}

function readStoredIdentity(app) {
  return JSON.parse(fs.readFileSync(getDesktopDeviceIdentityPath(app), "utf8"));
}

function writeDesktopConfig(app, fileName, value) {
  const configPath = path.join(getDesktopConfigRoot(app), fileName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return configPath;
}

test("device identity parses macOS and Windows machine IDs", () => {
  assert.equal(
    __testInternals.parseDarwinIOPlatformUUID('    "IOPlatformUUID" = "12345678-1234-1234-1234-123456789ABC"\n'),
    MACHINE_A
  );
  assert.equal(
    __testInternals.parseWindowsMachineGuid(
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    {ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB}\r\n"
    ),
    MACHINE_B
  );
});

test("device identity reads platform machine IDs with explicit branches", () => {
  const darwin = __testInternals.readPlatformMachineIdentity("darwin", (command, args) => {
    assert.equal(command, "/usr/sbin/ioreg");
    assert.deepEqual(args, ["-rd1", "-c", "IOPlatformExpertDevice"]);
    return '    "IOPlatformUUID" = "12345678-1234-1234-1234-123456789ABC"\n';
  });
  assert.deepEqual(darwin, machineIdentity(MACHINE_A, "darwinIOPlatformUUID"));

  const windows = __testInternals.readPlatformMachineIdentity("win32", (command, args) => {
    assert.equal(command, "reg");
    assert.deepEqual(args, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    return "    MachineGuid    REG_SZ    {ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB}\r\n";
  });
  assert.deepEqual(windows, machineIdentity(MACHINE_B, "windowsMachineGuid"));

  const unavailable = __testInternals.readPlatformMachineIdentity("win32", () => {
    throw new Error("registry unavailable");
  });
  assert.equal(unavailable.source, "unavailable");
});

test("device identity creates a v2 machine-bound identity and keeps it stable on the same machine", () => {
  const { app, cleanup } = withTempApp("zenmind-device-identity-create-");
  try {
    const identity = getDesktopDeviceIdentity(app, {
      platform: "darwin",
      now: fixedNow(CREATED_AT),
      randomUUID: () => INSTALL_ID,
      readMachineIdentity: () => machineIdentity(MACHINE_A)
    });

    assert.equal(identity.version, 2);
    assert.equal(identity.installId, INSTALL_ID);
    assert.equal(identity.deviceId, __testInternals.deriveDeviceId("darwin", MACHINE_A, INSTALL_ID));
    assert.equal(identity.machineHash, __testInternals.deriveMachineHash("darwin", MACHINE_A));
    assert.equal(identity.machineSource, "darwinIOPlatformUUID");
    assert.equal(identity.createdAt, CREATED_AT);
    assert.equal(identity.updatedAt, CREATED_AT);
    assert.match(identity.deviceId, UUID_PATTERN);
    assert.deepEqual(readStoredIdentity(app), identity);

    const again = getDesktopDeviceIdentity(app, {
      platform: "darwin",
      now: fixedNow(REBOUND_AT),
      readMachineIdentity: () => machineIdentity(MACHINE_A)
    });
    assert.deepEqual(again, identity);
  } finally {
    cleanup();
  }
});

test("device identity is cached for the process and callers receive defensive copies", () => {
  for (const scenario of [
    { prefix: "zenmind-device-identity-cache-darwin-", platform: "darwin", source: "darwinIOPlatformUUID" },
    { prefix: "zenmind-device-identity-cache-win32-", platform: "win32", source: "windowsMachineGuid" }
  ]) {
    const { app, cleanup } = withTempApp(scenario.prefix);
    try {
      let probeCount = 0;
      let currentMachineId = MACHINE_A;
      const options = {
        platform: scenario.platform,
        now: fixedNow(CREATED_AT),
        randomUUID: () => INSTALL_ID,
        readMachineIdentity: () => {
          probeCount += 1;
          return machineIdentity(currentMachineId, scenario.source);
        }
      };
      const first = getDesktopDeviceIdentity(app, options);
      currentMachineId = MACHINE_B;
      const second = getDesktopDeviceIdentity(app, options);

      assert.equal(probeCount, 1);
      assert.deepEqual(second, first);
      second.deviceId = INSTALL_ID_2;
      assert.equal(getDesktopDeviceIdentity(app, options).deviceId, first.deviceId);
    } finally {
      cleanup();
    }
  }
});

test("device identity preserves a stored machine binding when the startup probe is unavailable", () => {
  for (const scenario of [
    { prefix: "zenmind-device-identity-preserve-darwin-", platform: "darwin", source: "darwinIOPlatformUUID" },
    { prefix: "zenmind-device-identity-preserve-win32-", platform: "win32", source: "windowsMachineGuid" }
  ]) {
    const { app, cleanup } = withTempApp(scenario.prefix);
    try {
      const first = getDesktopDeviceIdentity(app, {
        platform: scenario.platform,
        now: fixedNow(CREATED_AT),
        randomUUID: () => INSTALL_ID,
        readMachineIdentity: () => machineIdentity(MACHINE_A, scenario.source)
      });
      const storedBefore = fs.readFileSync(getDesktopDeviceIdentityPath(app), "utf8");
      __testInternals.clearDesktopDeviceIdentityCache(getDesktopDeviceIdentityPath(app));

      const preserved = getDesktopDeviceIdentity(app, {
        platform: scenario.platform,
        now: fixedNow(REBOUND_AT),
        readMachineIdentity: () => ({
          machineId: __testInternals.UNAVAILABLE_MACHINE_ID,
          source: "unavailable"
        })
      });

      assert.deepEqual(preserved, first);
      assert.equal(preserved.lastMachineMismatchAt, undefined);
      assert.equal(fs.readFileSync(getDesktopDeviceIdentityPath(app), "utf8"), storedBefore);
    } finally {
      cleanup();
    }
  }
});

test("device identity info exposes the storage path and normalized identity fields", () => {
  for (const scenario of [
    {
      prefix: "zenmind-device-identity-info-darwin-",
      platform: "darwin",
      installId: INSTALL_ID,
      machineId: MACHINE_A,
      source: "darwinIOPlatformUUID"
    },
    {
      prefix: "zenmind-device-identity-info-win32-",
      platform: "win32",
      installId: INSTALL_ID_2,
      machineId: MACHINE_B,
      source: "windowsMachineGuid"
    }
  ]) {
    const { app, cleanup } = withTempApp(scenario.prefix);
    try {
      const info = getDesktopDeviceIdentityInfo(app, {
        platform: scenario.platform,
        now: fixedNow(CREATED_AT),
        randomUUID: () => scenario.installId,
        readMachineIdentity: () => machineIdentity(scenario.machineId, scenario.source)
      });

      assert.equal(info.identityPath, getDesktopDeviceIdentityPath(app));
      assert.equal(info.version, 2);
      assert.equal(info.installId, scenario.installId);
      assert.equal(info.deviceId, __testInternals.deriveDeviceId(scenario.platform, scenario.machineId, scenario.installId));
      assert.equal(info.machineHash, __testInternals.deriveMachineHash(scenario.platform, scenario.machineId));
      assert.equal(info.machineSource, scenario.source);
      assert.equal(info.createdAt, CREATED_AT);
      assert.equal(info.updatedAt, CREATED_AT);
      assert.equal(info.lastMachineMismatchAt, undefined);
    } finally {
      cleanup();
    }
  }
});

test("desktop device info uses global name, system fallback, and legacy Kanban alias fallback", () => {
  assert.equal(buildDesktopDeviceName({ configuredDeviceName: "Office Mini", hostname: "host", username: "lin" }), "Office Mini");
  assert.equal(buildDesktopDeviceName({ configuredDeviceName: "Office Mini.local", hostname: "host.local", username: "lin" }), "Office Mini.local");
  assert.equal(buildDesktopDeviceName({ hostname: "host", username: "lin", deviceId: INSTALL_ID }), "host · lin");
  assert.equal(buildDesktopDeviceName({ hostname: "host.local", username: "lin", deviceId: INSTALL_ID }), "host · lin");
  assert.equal(buildDesktopDeviceName({ deviceId: INSTALL_ID }), INSTALL_ID.slice(0, 8));

  const { app, cleanup } = withTempApp("zenmind-desktop-device-info-");
  try {
    const identityOptions = {
      platform: "darwin",
      now: fixedNow(CREATED_AT),
      randomUUID: () => INSTALL_ID,
      readMachineIdentity: () => machineIdentity(MACHINE_A)
    };

    let info = getDesktopDeviceInfo(app, {
      platform: "darwin",
      arch: "arm64",
      identityOptions,
      readHostname: () => "Lin-Mac.local",
      readUsername: () => "lin"
    });
    assert.equal(info.configuredDeviceName, "");
    assert.equal(info.hostname, "Lin-Mac.local");
    assert.equal(info.deviceName, "Lin-Mac · lin");
    assert.equal(info.platform, "darwin");
    assert.equal(info.arch, "arm64");

    updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        deviceName: "Studio"
      }
    });
    info = getDesktopDeviceInfo(app, {
      platform: "darwin",
      identityOptions,
      readHostname: () => "Lin-Mac",
      readUsername: () => "lin"
    });
    assert.equal(info.configuredDeviceName, "Studio");
    assert.equal(info.deviceName, "Studio");

    updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        deviceName: ""
      }
    });
    info = getDesktopDeviceInfo(app, {
      platform: "darwin",
      identityOptions,
      readHostname: () => "",
      readUsername: () => ""
    });
    assert.equal(info.configuredDeviceName, "");
    assert.equal(info.deviceName, info.deviceId.slice(0, 8));
  } finally {
    cleanup();
  }

  const legacy = withTempApp("zenmind-desktop-device-info-legacy-");
  try {
    writeDesktopConfig(legacy.app, "kanban.json", {
      cloud: {
        deviceAlias: "旧看板别名"
      }
    });
    assert.equal(readDesktopProfileFromRoot(getDesktopConfigRoot(legacy.app)).general.deviceName, "旧看板别名");
  } finally {
    legacy.cleanup();
  }
});

test("device identity rebinds copied identity files to the current machine", () => {
  const { app, cleanup } = withTempApp("zenmind-device-identity-rebind-");
  try {
    const first = getDesktopDeviceIdentity(app, {
      platform: "darwin",
      now: fixedNow(CREATED_AT),
      randomUUID: () => INSTALL_ID,
      readMachineIdentity: () => machineIdentity(MACHINE_A)
    });
    __testInternals.clearDesktopDeviceIdentityCache(getDesktopDeviceIdentityPath(app));
    const rebound = getDesktopDeviceIdentity(app, {
      platform: "darwin",
      now: fixedNow(REBOUND_AT),
      readMachineIdentity: () => machineIdentity(MACHINE_B)
    });

    assert.equal(rebound.installId, first.installId);
    assert.notEqual(rebound.deviceId, first.deviceId);
    assert.equal(rebound.deviceId, __testInternals.deriveDeviceId("darwin", MACHINE_B, INSTALL_ID));
    assert.equal(rebound.machineHash, __testInternals.deriveMachineHash("darwin", MACHINE_B));
    assert.equal(rebound.machineSource, "darwinIOPlatformUUID");
    assert.equal(rebound.createdAt, CREATED_AT);
    assert.equal(rebound.updatedAt, REBOUND_AT);
    assert.equal(rebound.lastMachineMismatchAt, REBOUND_AT);
    assert.deepEqual(readStoredIdentity(app), rebound);
  } finally {
    cleanup();
  }
});

test("device identity replaces legacy and corrupt files with v2 identities", () => {
  for (const [prefix, content, installId] of [
    [
      "zenmind-device-identity-legacy-",
      `${JSON.stringify({ version: 1, deviceId: "99999999-9999-4999-8999-999999999999", createdAt: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`,
      INSTALL_ID
    ],
    ["zenmind-device-identity-corrupt-", "{not-json", INSTALL_ID_2]
  ]) {
    const { app, cleanup } = withTempApp(prefix);
    try {
      const identityPath = getDesktopDeviceIdentityPath(app);
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(identityPath, content, "utf8");

      const identity = getDesktopDeviceIdentity(app, {
        platform: "darwin",
        now: fixedNow(CREATED_AT),
        randomUUID: () => installId,
        readMachineIdentity: () => machineIdentity(MACHINE_A)
      });

      assert.equal(identity.version, 2);
      assert.equal(identity.installId, installId);
      assert.equal(identity.deviceId, __testInternals.deriveDeviceId("darwin", MACHINE_A, installId));
      assert.deepEqual(readStoredIdentity(app), identity);
    } finally {
      cleanup();
    }
  }
});

test("device identity keeps an unavailable fallback stable until the next process start", () => {
  const { app, cleanup } = withTempApp("zenmind-device-identity-unavailable-");
  try {
    const identity = getDesktopDeviceIdentity(app, {
      platform: "win32",
      now: fixedNow(CREATED_AT),
      randomUUID: () => INSTALL_ID,
      readMachineIdentity: () => ({
        machineId: __testInternals.UNAVAILABLE_MACHINE_ID,
        source: "unavailable"
      })
    });

    assert.equal(identity.machineSource, "unavailable");
    assert.equal(
      identity.deviceId,
      __testInternals.deriveDeviceId("win32", __testInternals.UNAVAILABLE_MACHINE_ID, INSTALL_ID)
    );
    assert.equal(
      identity.machineHash,
      __testInternals.deriveMachineHash("win32", __testInternals.UNAVAILABLE_MACHINE_ID)
    );

    const sameProcess = getDesktopDeviceIdentity(app, {
      platform: "win32",
      now: fixedNow(REBOUND_AT),
      readMachineIdentity: () => assert.fail("cached identity must not probe the machine again")
    });
    assert.deepEqual(sameProcess, identity);

    __testInternals.clearDesktopDeviceIdentityCache(getDesktopDeviceIdentityPath(app));
    const rebound = getDesktopDeviceIdentity(app, {
      platform: "win32",
      now: fixedNow(REBOUND_AT),
      readMachineIdentity: () => machineIdentity(MACHINE_B, "windowsMachineGuid")
    });
    assert.equal(rebound.deviceId, __testInternals.deriveDeviceId("win32", MACHINE_B, INSTALL_ID));
    assert.equal(rebound.machineSource, "windowsMachineGuid");
    assert.equal(rebound.lastMachineMismatchAt, REBOUND_AT);
  } finally {
    cleanup();
  }
});
