import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const electronNet = {};
const originalLoad = Module._load;
let ensureProviderRegisterApiKey;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { net: electronNet };
    if (request === "../../infrastructure/filesystem/runtime-environment") {
      // Keep both platform cases inside the fixture, regardless of a Windows data-root registry entry.
      return { resolveRuntimeRoot: (app) => app.getPath("home") };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ensureProviderRegisterApiKey } = require("../dist-electron/main/modules/agent-platform/provider-register.js"));
} finally {
  Module._load = originalLoad;
}
require("../dist-electron/main/support/i18n/main-i18n.js").setMainLocaleForCurrentProcess("en-US");

function fixture(t, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-register-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = "synthetic-registration-grant";
  const endpoint = "https://registration.invalid/api/apply-apikey";
  const registerPath = path.join(root, "provider-register.json");
  const providerPath = path.join(root, "registries", "providers", "th-main.yml");
  fs.mkdirSync(path.dirname(providerPath), { recursive: true });
  const providerContent = "key: th-main\nbaseUrl: https://registration.invalid\napiKey:\n";
  const registerContent = JSON.stringify({ enabled: true, endpoint, providers: ["th-main"], grant: { type: "jwt", token } });
  fs.writeFileSync(providerPath, providerContent);
  fs.writeFileSync(registerPath, registerContent);
  t.mock.method(globalThis, "fetch", () => assert.fail("registration must not fall back to Node fetch"));
  const app = { getPath: () => root };
  const run = (options = {}) => ensureProviderRegisterApiKey(app, {
    platform,
    getDesktopDeviceId: () => "test-desktop-device",
    ...options
  });
  const assertPreserved = () => {
    assert.equal(fs.readFileSync(providerPath, "utf8"), providerContent);
    assert.equal(fs.readFileSync(registerPath, "utf8"), registerContent);
  };
  return { token, endpoint, registerPath, providerPath, run, assertPreserved };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: registration uses Electron networking with only the grant credential`, async (t) => {
    const f = fixture(t, platform);
    let calls = 0;
    electronNet.fetch = async function (endpoint, init) {
      calls += 1;
      assert.equal(this, electronNet);
      assert.equal(endpoint, f.endpoint);
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "omit");
      assert.deepEqual(init.headers, { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(init.body), { name: "test-desktop-device" });
      return new Response(JSON.stringify({ key: "dk_SyntheticRegistrationKey" }));
    };
    assert.deepEqual(await f.run(), { status: "applied", providers: ["th-main"], updatedProviders: ["th-main"] });
    assert.equal(calls, 1);
    assert.match(fs.readFileSync(f.providerPath, "utf8"), /^apiKey: dk_SyntheticRegistrationKey$/m);
    assert.equal(fs.existsSync(f.registerPath), false);
  });
}

test("network errors retain their cause code, redact credentials, and preserve registration for retry", async (t) => {
  const f = fixture(t);
  const key = "dk_SyntheticSecretKey";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
  const cause = Object.assign(new Error(`connection failed ${f.token} ${key} ${jwt}`), { code: "UND_ERR_CONNECT_TIMEOUT" });
  let calls = 0;
  electronNet.fetch = async () => {
    calls += 1;
    throw new Error("fetch failed", { cause });
  };
  await assert.rejects(f.run(), (error) => {
    assert.match(error.message, /apikey request failed: fetch failed -> UND_ERR_CONNECT_TIMEOUT/);
    for (const secret of [f.token, key, jwt]) assert.equal(error.message.includes(secret), false);
    assert.equal(error.cause, undefined, "raw credentials must not escape in an attached cause");
    return true;
  });
  assert.equal(calls, 1, "an allocation request must not be automatically replayed");
  f.assertPreserved();
});

test("Chromium proxy errors remain actionable and preserve the grant", async (t) => {
  const f = fixture(t);
  electronNet.fetch = async () => { throw new Error("net::ERR_PROXY_CONNECTION_FAILED"); };
  await assert.rejects(f.run(), /apikey request failed: net::ERR_PROXY_CONNECTION_FAILED/);
  f.assertPreserved();
});

test("response body network failures receive the same diagnostics and leave files unchanged", async (t) => {
  const f = fixture(t);
  electronNet.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => { throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" }); }
  });
  await assert.rejects(f.run(), /apikey request failed: ECONNRESET: socket closed/);
  f.assertPreserved();
});

for (const status of [401, 429]) {
  test(`HTTP ${status} stays distinct from a network failure`, async (t) => {
    const f = fixture(t);
    electronNet.fetch = async () => new Response('{"error":"request rejected"}', { status });
    await assert.rejects(f.run(), new RegExp(`apikey request failed: HTTP ${status}.*request rejected`));
    f.assertPreserved();
  });
}

test("missing Electron networking does not silently use Node fetch", async (t) => {
  const f = fixture(t);
  delete electronNet.fetch;
  await assert.rejects(f.run(), /this runtime does not support fetch/);
  f.assertPreserved();
});

test("injected transports remain supported for service lifecycle tests", async (t) => {
  const f = fixture(t);
  electronNet.fetch = () => assert.fail("explicit transport must take precedence");
  const result = await f.run({ fetchImpl: async () => new Response('{"key":"dk_InjectedRegistrationKey"}') });
  assert.equal(result.status, "applied");
});

test("cyclic error causes cannot prevent a registration failure from returning", async (t) => {
  const f = fixture(t);
  const failure = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
  failure.cause = failure;
  electronNet.fetch = async () => { throw failure; };
  await assert.rejects(f.run(), /apikey request failed: ECONNRESET: connection closed$/);
  f.assertPreserved();
});
