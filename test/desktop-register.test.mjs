import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ensureDesktopRegisterApiKey,
  __testInternals
} = require("../dist-electron/main/desktop-register.js");

function createApp(root) {
  const homeRoot = path.join(root, "home");
  return {
    getPath(name) {
      if (name === "home") return homeRoot;
      if (name === "userData") return path.join(root, "user-data");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "desktop") return path.join(homeRoot, "Desktop");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function writeProvider(homeRoot, providerKey, content) {
  const providerPath = path.join(homeRoot, ".zenmind", "registries", "providers", `${providerKey}.yml`);
  fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  fs.writeFileSync(providerPath, content, "utf8");
  return providerPath;
}

function writeRegister(homeRoot, content) {
  const registerPath = path.join(homeRoot, ".zenmind", "desktop-register.json");
  fs.mkdirSync(path.dirname(registerPath), { recursive: true });
  fs.writeFileSync(registerPath, content, "utf8");
  return registerPath;
}

test("resolveDesktopRegisterPath uses the user .zenmind root on macOS and Windows", () => {
  const macApp = { getPath: () => "/Users/alice" };
  const windowsApp = { getPath: () => String.raw`C:\Users\alice` };

  assert.equal(
    __testInternals.resolveDesktopRegisterPath(macApp, "darwin"),
    "/Users/alice/.zenmind/desktop-register.json"
  );
  assert.equal(
    __testInternals.resolveDesktopRegisterPath(windowsApp, "win32"),
    String.raw`C:\Users\alice\.zenmind\desktop-register.json`
  );
});

test("ensureDesktopRegisterApiKey skips when desktop-register.json is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-register-missing-"));
  const app = createApp(root);
  let called = false;
  try {
    const result = await ensureDesktopRegisterApiKey(app, {
      fetchImpl: async () => {
        called = true;
        throw new Error("unexpected fetch");
      }
    });

    assert.deepEqual(result, { status: "skipped", reason: "missing" });
    assert.equal(called, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDesktopRegisterApiKey writes provider keys and removes the register file on success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-register-success-"));
  const app = createApp(root);
  const homeRoot = path.join(root, "home");
  const deepseekPath = writeProvider(
    homeRoot,
    "th-deepseek",
    [
      "key: th-deepseek",
      "baseUrl: https://transit-hub.zenmind.cc",
      "defaultModel: th-deepseek-v4-flash"
    ].join("\n") + "\n"
  );
  const minimaxPath = writeProvider(
    homeRoot,
    "th-minimax",
    [
      "key: th-minimax",
      "baseUrl: https://transit-hub.zenmind.cc",
      "apiKey: existing-real-key",
      "defaultModel: th-minimax-m3"
    ].join("\n") + "\n"
  );
  const registerPath = writeRegister(
    homeRoot,
    JSON.stringify({
      enabled: true,
      endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
      grant: {
        type: "jwt",
        token: "jwt-token"
      },
      providers: ["th-deepseek", "th-minimax"]
    }, null, 2) + "\n"
  );
  const issuedKey = "dk_TestDesktopKey123-abc";
  let requestBody = null;
  let requestAuth = "";

  try {
    const result = await ensureDesktopRegisterApiKey(app, {
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        requestAuth = init.headers.Authorization;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ key: issuedKey })
        };
      }
    });

    const identityPath = path.join(
      homeRoot,
      ".zenmind",
      ".desktop",
      "config",
      "desktop",
      "device-identity.json"
    );
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    assert.deepEqual(requestBody, { name: identity.deviceId });
    assert.equal(requestAuth, "Bearer jwt-token");
    assert.deepEqual(result, {
      status: "applied",
      providers: ["th-deepseek", "th-minimax"],
      updatedProviders: ["th-deepseek"]
    });
    assert.match(fs.readFileSync(deepseekPath, "utf8"), /^apiKey: dk_TestDesktopKey123-abc$/m);
    assert.match(fs.readFileSync(minimaxPath, "utf8"), /^apiKey: existing-real-key$/m);

    assert.equal(fs.existsSync(registerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildResetContent produces safe cleanup content without version and with empty token", () => {
  const config = {
    version: 1,
    enabled: true,
    endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
    grant: { type: "jwt", token: "secret-jwt" },
    providers: ["th-deepseek"]
  };
  const result = __testInternals.buildResetContent(config);
  const parsed = JSON.parse(result);
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.grant.token, "");
  assert.equal(parsed.grant.type, "jwt");
  assert.equal("version" in parsed, false);
});

test("ensureDesktopRegisterApiKey reports cleanup error when register deletion fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-register-cleanup-fail-"));
  const app = createApp(root);
  const homeRoot = path.join(root, "home");
  const deepseekPath = writeProvider(
    homeRoot,
    "th-deepseek",
    "key: th-deepseek\nbaseUrl: https://transit-hub.zenmind.cc\n"
  );
  const registerPath = writeRegister(
    homeRoot,
    JSON.stringify({
      enabled: true,
      endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
      grant: { type: "jwt", token: "jwt-token" },
      providers: ["th-deepseek"]
    }, null, 2) + "\n"
  );
  const originalRmSync = fs.rmSync;

  try {
    fs.rmSync = (targetPath, opts) => {
      if (targetPath === registerPath) {
        throw new Error("permission denied");
      }
      return originalRmSync(targetPath, opts);
    };

    await assert.rejects(
      ensureDesktopRegisterApiKey(app, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ key: "dk_CleanupFailKey" })
        })
      }),
      /desktop-register 清理失败/u
    );

    assert.match(fs.readFileSync(deepseekPath, "utf8"), /^apiKey: dk_CleanupFailKey$/m);
    assert.equal(fs.existsSync(registerPath), true);
    const register = JSON.parse(fs.readFileSync(registerPath, "utf8"));
    assert.equal(register.enabled, false);
    assert.equal(register.grant.token, "");
    assert.equal("version" in register, false);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDesktopRegisterApiKey keeps enabled true when the response has no key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-register-no-key-"));
  const app = createApp(root);
  const homeRoot = path.join(root, "home");
  const providerPath = writeProvider(
    homeRoot,
    "th-deepseek",
    "key: th-deepseek\nbaseUrl: https://transit-hub.zenmind.cc\n"
  );
  const registerPath = writeRegister(
    homeRoot,
    JSON.stringify({
      version: 1,
      enabled: true,
      grant: { type: "jwt", token: "jwt-token" },
      providers: ["th-deepseek"]
    }, null, 2) + "\n"
  );

  try {
    await assert.rejects(
      ensureDesktopRegisterApiKey(app, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "key_without_secret" })
        })
      }),
      /响应缺少 key/u
    );

    assert.equal(JSON.parse(fs.readFileSync(registerPath, "utf8")).enabled, true);
    assert.doesNotMatch(fs.readFileSync(providerPath, "utf8"), /^apiKey:/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDesktopRegisterApiKey reapplies disabled registration when providers still need keys", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-register-disabled-placeholder-"));
  const app = createApp(root);
  const homeRoot = path.join(root, "home");
  const providerPath = writeProvider(
    homeRoot,
    "th-minimax",
    [
      "key: th-minimax",
      "baseUrl: https://transit-hub.zenmind.cc",
      "apiKey: YOUR_API_KEY",
      "defaultModel: th-minimax-m3"
    ].join("\n") + "\n"
  );
  const registerPath = writeRegister(
    homeRoot,
    JSON.stringify({
      version: 1,
      enabled: false,
      endpoint: "https://transit-hub.zenmind.cc/api/apply-apikey",
      grant: { type: "jwt", token: "jwt-token" },
      providers: ["th-minimax"]
    }, null, 2) + "\n"
  );

  try {
    const result = await ensureDesktopRegisterApiKey(app, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ key: "dk_RecoveredKey123" })
      })
    });

    assert.deepEqual(result, {
      status: "applied",
      providers: ["th-minimax"],
      updatedProviders: ["th-minimax"]
    });
    assert.match(fs.readFileSync(providerPath, "utf8"), /^apiKey: dk_RecoveredKey123$/m);
    assert.equal(JSON.parse(fs.readFileSync(registerPath, "utf8")).enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
