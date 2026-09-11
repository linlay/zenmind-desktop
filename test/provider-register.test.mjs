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
let invalidateProviderRegistration;
let clearAccessTokenProviderKeys;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { net: electronNet };
    if (request === "../../infrastructure/filesystem/runtime-environment") {
      // Keep both platform cases inside the fixture, regardless of a Windows data-root registry entry.
      return { resolveRuntimeRoot: (app) => app.getPath("home") };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ ensureProviderRegisterApiKey, invalidateProviderRegistration, clearAccessTokenProviderKeys } = require("../dist-electron/main/modules/agent-platform/provider-register.js"));
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
  return { app, token, endpoint, registerPath, providerPath, run, assertPreserved };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: missing registration skips offline without changing provider configuration`, async (t) => {
    const f = fixture(t, platform);
    fs.unlinkSync(f.registerPath);
    const providerContent = fs.readFileSync(f.providerPath, "utf8");
    electronNet.fetch = () => assert.fail("missing registration must not access the network");
    assert.deepEqual(await f.run({
      getDesktopDeviceId: () => assert.fail("missing registration must not request a device identity")
    }), { status: "skipped", reason: "missing" });
    assert.equal(fs.readFileSync(f.providerPath, "utf8"), providerContent);
    assert.equal(fs.existsSync(f.registerPath), false);
  });

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

for (const platform of ["darwin", "win32"]) {
  function accessFixture(t) {
    const f = fixture(t, platform);
    const config = { mode: "access-token", endpoint: "https://registration.invalid/api/bind-apikey", providers: ["th-main"] };
    fs.writeFileSync(f.registerPath, JSON.stringify(config));
    fs.writeFileSync(f.providerPath, "key: th-main\nbaseUrl: https://registration.invalid\napiKey: dk_PreviousAccountKey\n");
    return { ...f, config };
  }

  test(`${platform}: access-token waits for login even when a provider already has a key`, async t => {
    const f = accessFixture(t);
    let requested = false;
    electronNet.fetch = () => assert.fail("signed-out registration must not send a request");
    await assert.rejects(f.run({ getAccessToken: () => null, onLoginRequired: () => { requested = true; } }), /Sign in/);
    assert.equal(requested, true);
    assert.equal(fs.existsSync(f.registerPath), true);
    assert.deepEqual(await f.run({ preparation: true }), { status: "skipped", reason: "unchanged" });
  });

  test(`${platform}: access-token binds device and replaces an old account key while retaining policy`, async t => {
    const f = accessFixture(t);
    let calls = 0;
    electronNet.fetch = async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, f.config.endpoint);
      assert.equal(init.headers.Authorization, "Bearer access-current");
      assert.deepEqual(JSON.parse(init.body), { name: "test-desktop-device", device_id: "test-desktop-device" });
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ key: "dk_CurrentAccountKey" }));
    };
    await f.run({ getAccessToken: () => "access-current" });
    await f.run({ getAccessToken: () => "access-current" });
    assert.equal(calls, 2, "existing key does not bypass identity validation");
    assert.match(fs.readFileSync(f.providerPath, "utf8"), /apiKey: dk_CurrentAccountKey/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.registerPath, "utf8")), f.config);
  });

  test(`${platform}: a late response cannot publish another account's key`, async t => {
    const f = accessFixture(t);
    let token = "account-a";
    let release;
    electronNet.fetch = () => new Promise(resolve => { release = resolve; });
    const pending = f.run({ getAccessToken: () => token });
    token = "account-b";
    release(new Response(JSON.stringify({ key: "dk_AccountAKey" })));
    await assert.rejects(pending, /identity or provider registration changed/);
    assert.doesNotMatch(fs.readFileSync(f.providerPath, "utf8"), /dk_AccountAKey/);
  });

  test(`${platform}: refreshes access token once on 401 and never falls back to a grant`, async t => {
    const f = accessFixture(t);
    let token = "expired-access";
    let refreshes = 0;
    let calls = 0;
    electronNet.fetch = async (_, init) => {
      calls++;
      if (calls === 1) return new Response("rejected", { status: 401 });
      assert.equal(init.headers.Authorization, "Bearer renewed-access");
      return new Response(JSON.stringify({ key: "dk_RenewedAccountKey" }));
    };
    await f.run({ getAccessToken: () => token, refreshAccessToken: async () => { refreshes++; token = "renewed-access"; return token; } });
    assert.equal(refreshes, 1);
    assert.equal(calls, 2);
  });

  test(`${platform}: refuses insecure or credential-bearing access token endpoints`, async t => {
    const f = accessFixture(t);
    electronNet.fetch = () => assert.fail("unsafe endpoint must not receive a token");
    for (const endpoint of ["http://registration.invalid/api/bind-apikey", "https://user:password@registration.invalid/api/bind-apikey", "https://registration.invalid/api/bind-apikey?secret=value"]) {
      fs.writeFileSync(f.registerPath, JSON.stringify({ ...f.config, endpoint }));
      await assert.rejects(f.run({ getAccessToken: () => "access" }), /HTTPS endpoint/);
    }
  });

  test(`${platform}: explicit grant mode works without enabled and deletes its one-time file`, async t => {
    const f = fixture(t, platform);
    const config = JSON.parse(fs.readFileSync(f.registerPath, "utf8"));
    delete config.enabled;
    config.mode = "grant-jwt";
    fs.writeFileSync(f.registerPath, JSON.stringify(config));
    electronNet.fetch = async () => new Response(JSON.stringify({ key: "dk_ExplicitGrantKey" }));
    await f.run();
    assert.equal(fs.existsSync(f.registerPath), false);
  });

  test(`${platform}: invalid mode fails closed`, async t => {
    const f = accessFixture(t);
    fs.writeFileSync(f.registerPath, JSON.stringify({ ...f.config, mode: "automatic" }));
    electronNet.fetch = () => assert.fail("invalid mode must not use either credential");
    await assert.rejects(f.run(), /mode must be/);
  });
}


test("logout invalidates an in-flight response even if the same token is restored", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.registerPath, JSON.stringify({ mode: "access-token", endpoint: "https://registration.invalid/api/bind-apikey", providers: ["th-main"] }));
  let release;
  electronNet.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = f.run({ getAccessToken: () => "same-token" });
  invalidateProviderRegistration(f.app, "darwin");
  release(new Response(JSON.stringify({ key: "dk_StaleGenerationKey" })));
  await assert.rejects(pending, /identity or provider registration changed/);
  assert.doesNotMatch(fs.readFileSync(f.providerPath, "utf8"), /StaleGeneration/);
});

test("clearing access-token providers preserves policy and unrelated providers", t => {
  const f = fixture(t);
  fs.writeFileSync(f.registerPath, JSON.stringify({ mode: "access-token", providers: ["th-main"] }));
  const other = path.join(path.dirname(f.providerPath), "other.yml");
  fs.writeFileSync(other, "key: other\napiKey: private-user-key\n");
  fs.writeFileSync(f.providerPath, "key: th-main\napiKey: old-account-key\n");
  clearAccessTokenProviderKeys(f.app, "darwin");
  assert.match(fs.readFileSync(f.providerPath, "utf8"), /apiKey: ""/);
  assert.match(fs.readFileSync(other, "utf8"), /private-user-key/);
  assert.equal(fs.existsSync(f.registerPath), true);
});
