import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createDesktopRuntimeDiagnostics,
  summarizeDesktopSsoAccessToken
} = require("../dist-electron/main/desktop-runtime-info.js");

function jwt(payload, signature = "signature-abcd") {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    signature
  ].join(".");
}

test("Desktop SSO diagnostics summarize missing, opaque, JWT, and expired credentials", () => {
  const now = 1_900_000_000_000;

  assert.deepEqual(summarizeDesktopSsoAccessToken("", now), {
    present: false,
    expiresAt: null,
    expired: null,
    preview: ""
  });
  assert.deepEqual(summarizeDesktopSsoAccessToken("opaque-token-0123456789", now), {
    present: true,
    expiresAt: null,
    expired: null,
    preview: "****6789"
  });
  assert.deepEqual(summarizeDesktopSsoAccessToken(jwt({ exp: 2_000_000_000 }), now), {
    present: true,
    expiresAt: 2_000_000_000_000,
    expired: false,
    preview: "****abcd"
  });
  assert.deepEqual(summarizeDesktopSsoAccessToken(jwt({ exp: 1_800_000_000 }), now), {
    present: true,
    expiresAt: 1_800_000_000_000,
    expired: true,
    preview: "****abcd"
  });
  assert.equal(summarizeDesktopSsoAccessToken(jwt({ exp: "2000000000" }), now).expiresAt, null);
  assert.equal(summarizeDesktopSsoAccessToken("tiny", now).preview, "****");
});

test("runtime diagnostics aggregate exact safe fields across platform and package modes", async () => {
  const appInfo = {
    productName: "ZenMind Test",
    version: "v3.4.5",
    buildTime: "2026-08-20T01:02:03.000Z"
  };
  const rawToken = jwt({ exp: 2_000_000_000 }, "do-not-return-abcd");
  const service = {
    id: "agent-platform",
    name: "Agent Platform",
    kind: "builtin",
    serviceMode: "service",
    version: "1.2.3",
    description: "internal",
    installDir: "/managed/services/agent-platform",
    paths: {
      programDir: "/managed/services/agent-platform",
      configDir: "/managed/config/agent-platform",
      dataDir: "/managed/data/agent-platform",
      stateDir: "/managed/state/agent-platform",
      logDir: "/managed/logs/agent-platform"
    },
    installed: true,
    status: "running",
    statusLabel: "Running",
    message: "healthy",
    frontendMode: "embedded",
    pluginActions: [],
    configFiles: [],
    healthMeta: {
      pid: 4123,
      pidFilePath: "/managed/state/agent-platform/service.pid",
      logFilePath: "/managed/logs/agent-platform/main.log",
      errorLogFilePath: "/managed/logs/agent-platform/error.log",
      webUrl: "http://127.0.0.1:11789",
      port: 11789,
      prerequisites: []
    }
  };

  for (const scenario of [
    { platform: "darwin", arch: "arm64", isPackaged: true, homeDir: "/Users/tester" },
    { platform: "win32", arch: "x64", isPackaged: false, homeDir: "C:\\Users\\tester" }
  ]) {
    const calls = { device: 0, dataRoot: 0, token: 0, services: 0 };
    const app = {
      isPackaged: scenario.isPackaged,
      getPath(name) {
        assert.equal(name, "home");
        return scenario.homeDir;
      },
      getAppPath() {
        return scenario.platform === "win32" ? "C:\\Program Files\\ZenMind\\resources\\app.asar" : "/Applications/ZenMind.app/Contents/Resources/app.asar";
      }
    };
    const result = await createDesktopRuntimeDiagnostics(app, appInfo, {
      platform: scenario.platform,
      arch: scenario.arch,
      execPath: scenario.platform === "win32" ? "C:\\Program Files\\ZenMind\\ZenMind.exe" : "/Applications/ZenMind.app/Contents/MacOS/ZenMind",
      electronVersion: "36.2.1",
      nodeVersion: "22.16.0",
      now: () => 1_900_000_000_000,
      getDeviceInfo(_app, platform, arch) {
        calls.device += 1;
        assert.equal(platform, scenario.platform);
        assert.equal(arch, scenario.arch);
        return {
          deviceId: "device-1234",
          deviceName: "Tester Device",
          configuredDeviceName: "Configured but omitted",
          hostname: "tester-host",
          username: "tester",
          platform,
          arch
        };
      },
      getDataRoot(_app, platform) {
        calls.dataRoot += 1;
        assert.equal(platform, scenario.platform);
        return scenario.platform === "win32" ? "C:\\Users\\tester\\ZenMind" : "/Users/tester/.zenmind";
      },
      readDesktopSsoAccessToken() {
        calls.token += 1;
        return rawToken;
      },
      async listServices() {
        calls.services += 1;
        return [service];
      }
    });

    assert.deepEqual(calls, { device: 1, dataRoot: 1, token: 1, services: 1 });
    assert.deepEqual(result.app, appInfo);
    assert.deepEqual(Object.keys(result.device).sort(), ["arch", "deviceId", "deviceName", "hostname", "platform", "username"]);
    assert.equal(result.device.platform, scenario.platform);
    assert.equal(result.device.arch, scenario.arch);
    assert.equal(result.paths.homeDir, scenario.homeDir);
    assert.equal(result.runtime.isPackaged, scenario.isPackaged);
    assert.deepEqual(result.credentials.desktopSso, {
      present: true,
      expiresAt: 2_000_000_000_000,
      expired: false,
      preview: "****abcd"
    });
    assert.deepEqual(result.services, [{
      id: "agent-platform",
      name: "Agent Platform",
      kind: "builtin",
      version: "1.2.3",
      installed: true,
      status: "running",
      installDir: "/managed/services/agent-platform",
      pid: 4123,
      port: 11789,
      webUrl: "http://127.0.0.1:11789"
    }]);

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(rawToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.doesNotMatch(serialized, /sso-access-token\.txt|pidFilePath|logFilePath|configuredDeviceName/u);
  }
});
