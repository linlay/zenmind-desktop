import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { getDesktopUsageProfile } = require("../dist-electron/main/modules/settings/usage-profile.js");
const { writeTransitHubSettings, readTransitHubSettings, normalizeTransitHubSettings, getTransitHubSettingsPath } = require("../dist-electron/main/modules/settings/transit-hub-settings.js");
const { resolveRuntimeRoot } = require("../dist-electron/main/infrastructure/filesystem/runtime-environment.js");
const { formatMicrocredits, usageLimitProgress } = require("../dist-electron/shared/usage-credits.js");
const { applyDesktopInitBootstrap, applyDesktopInitVersionUpgrade, resolveDesktopInitPath, desktopInitUpgradeCanonicalPaths, prepareDesktopInitUpgradeBackup, restoreDesktopInitUpgradeBackup } = require("../dist-electron/main/app/bootstrap/desktop-init.js");
const origin = "https://metering.invalid";
const windowUsage = { window: "5h", state: "active", starts_at: "2026-10-21T00:00:00Z", resets_at: "2026-10-21T05:00:00Z", charged_microcredits: "3000000", quota_microcredits: "2000000", remaining_microcredits: "-1000000", tokens: 1, token_quota: 100, token_remaining: 99, request_remaining: 8, requests: 2, request_quota: 10 };
const balance = { unit: "CREDITS", microcredits_per_credit: 1000000, quota_microcredits: "90071992547409930", used_microcredits: "90071992548409930", remaining_microcredits: "-1000000", credits_unlimited: false, unlimited: false, items: [windowUsage], degraded_components: ["telemetry"] };
function fixture(t, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const config = (auth = { mode: "apikey", providerKey: "grant-hub" }, baseUrl = origin) => writeTransitHubSettings(app, { enabled: true, baseUrl, auth }, platform);
  function provider(key = "grant-hub", options = {}) {
    const file = path.join(resolveRuntimeRoot(app, platform), "registries", "providers", `${key}.yml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `key: ${key}\nbaseUrl: ${options.origin ?? origin}\napiKey: ${options.key ?? "dk_grant_fixture"}\nuseAccessToken: ${options.accessToken ?? false}\n`);
    return file;
  }
  let token = "employee-fixture";
  const calls = [];
  const overrides = new Map();
  const payloads = {
    "/api/me": { id: "metering-record", name: "Fixture", source: "jwt", status: "active", allowed_models: ["chat", "speech", "image"] },
    "/api/me/limits": { lifetime: {}, rate_limit_usage: [windowUsage] },
    "/api/me/balance": balance,
    "/api/me/usage": { summary: { total_tokens: 42, charged_microcredits: "1234567" }, items: [{ bucket: "2026-10-21", charged_microcredits: "1234567", total_tokens: 42 }] },
    "/api/me/logs": { items: [{ id: 1, charged_microcredits: "1234567", billing_status: "estimated", usage_source: "missing", characters: 20 }], total: 1 },
    "/api/me/sessions": { items: [], total: 0 },
    "/api/me/prices": { items: [
      { public_model: "chat", unit: "CREDITS", input_microcredits_per_1m_tokens: "90071992547409930", output_microcredits_per_1m_tokens: "2", billing: { mode: "tokens" } },
      { public_model: "speech", unit: "CREDITS", input_microcredits_per_1m_tokens: "0", output_microcredits_per_1m_tokens: "0", billing: { mode: "characters", microcredits_per_10k_characters: "10" } },
      { public_model: "image", unit: "CREDITS", input_microcredits_per_1m_tokens: "0", output_microcredits_per_1m_tokens: "0", billing: { mode: "image", image_prices: [{ size: "1024x1024", charged_microcredits: "7" }] } }
    ] }
  };
  const options = {
    platform, now: new Date("2026-10-21T01:00:00Z"), peekAccessToken: () => token,
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const pathname = new URL(url).pathname;
      assert.equal(new URL(url).origin, origin);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      if (overrides.has(pathname)) return overrides.get(pathname)(url, init);
      return Response.json(payloads[pathname]);
    }
  };
  return { app, config, provider, calls, overrides, options, payloads, setToken: (v) => token = v, run: () => getDesktopUsageProfile(app, options) };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: explicit API key source preserves Credits and never reads login token`, async (t) => {
    const f = fixture(t, platform); f.config(); f.provider();
    f.provider("openai", { origin: "https://unrelated.invalid", key: "dk_unrelated" });
    f.options.getAccessToken = async () => { throw new Error("must not read SSO"); };
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.provider.providerKey, "grant-hub");
    assert.equal(result.provider.authMode, "apikey");
    assert.deepEqual(result.balance, balance);
    assert.equal(result.limits.rate_limit_usage[0].state, "active");
    assert.equal(result.usage.summary.total_tokens, 42);
    assert.equal(result.logs.items[0].billing_status, "estimated");
    assert.equal(result.logs.items[0].estimated, true);
    assert.equal(result.prices.items[0].input_microcredits_per_1m_tokens, "90071992547409930");
    assert.equal(result.prices.items[1].billing.microcredits_per_10k_characters, "10");
    assert.equal(result.prices.items[2].billing.image_prices[0].charged_microcredits, "7");
    assert.deepEqual(result.unavailableSections, []);
    assert.equal(f.calls.length, 7);
    assert.ok(f.calls.every((c) => c.init.headers.Authorization === "Bearer dk_grant_fixture"));
    assert.ok(!JSON.stringify(result).includes("dk_grant_fixture"));
  });
  test(`${platform}: initialization, canonical reread, upgrade, backup and rollback`, (t) => {
    const f = fixture(t, platform);
    const initPath = resolveDesktopInitPath(f.app, platform);
    fs.mkdirSync(path.dirname(initPath), { recursive: true });
    fs.writeFileSync(initPath, JSON.stringify({ transitHub: { enabled: true, baseUrl: origin, auth: { mode: "access-token" } } }));
    assert.equal(applyDesktopInitBootstrap(f.app, platform).appliedResult.transitHub, "applied");
    assert.equal(readTransitHubSettings(f.app, platform).auth.mode, "access-token");
    assert.ok(!fs.existsSync(initPath));
    const backup = path.join(path.dirname(initPath), "test-backup");
    const paths = desktopInitUpgradeCanonicalPaths(f.app, platform);
    assert.ok(paths.includes(getTransitHubSettingsPath(f.app, platform)));
    const manifest = prepareDesktopInitUpgradeBackup(paths, backup, platform);
    applyDesktopInitVersionUpgrade(f.app, { transitHub: { enabled: true, baseUrl: origin, auth: { mode: "apikey", providerKey: "grant-hub" } } }, backup, platform);
    assert.equal(readTransitHubSettings(f.app, platform).auth.mode, "apikey");
    restoreDesktopInitUpgradeBackup(manifest, backup);
    assert.equal(readTransitHubSettings(f.app, platform).auth.mode, "access-token");
    assert.throws(() => applyDesktopInitVersionUpgrade(f.app, { transitHub: { enabled: true, baseUrl: "http://remote.invalid", auth: { mode: "access-token" } } }, backup + "-bad", platform));
    assert.equal(readTransitHubSettings(f.app, platform).auth.mode, "access-token");
  });
}

test("missing or disabled explicit source never discovers a provider", async (t) => {
  const f = fixture(t); f.provider();
  assert.equal((await f.run()).reason, "not-configured");
  writeTransitHubSettings(f.app, { enabled: false });
  assert.equal((await f.run()).reason, "not-configured");
  assert.equal(f.calls.length, 0);
});

test("origin mismatch, missing provider and access-token provider reject without sending credentials", async (t) => {
  const f = fixture(t); f.config();
  assert.equal((await f.run()).ok, false);
  f.provider("grant-hub", { origin: "https://other.invalid" });
  assert.equal((await f.run()).ok, false);
  f.provider("grant-hub", { accessToken: true });
  assert.equal((await f.run()).ok, false);
  assert.equal(f.calls.length, 0);
});

test("employee mode works without any provider or static API key", async (t) => {
  const f = fixture(t); f.config({ mode: "access-token" });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.provider.authMode, "access-token");
  assert.ok(f.calls.every((c) => c.init.headers.Authorization === "Bearer employee-fixture"));
  assert.ok(!JSON.stringify(result).includes("employee-fixture"));
});

test("signed out employee mode never falls back to a grant key", async (t) => {
  const f = fixture(t); f.config({ mode: "access-token" }); f.provider(); f.setToken("");
  assert.equal((await f.run()).reason, "unauthorized");
  assert.equal(f.calls.length, 0);
});

test("employee 401 refreshes once and queries with renewed credentials", async (t) => {
  const f = fixture(t); f.config({ mode: "access-token" });
  const forces = [];
  f.options.getAccessToken = async (force) => { forces.push(force); if (force) f.setToken("renewed"); return forces.includes(true) ? "renewed" : "employee-fixture"; };
  f.overrides.set("/api/me", (_url, init) => init.headers.Authorization === "Bearer renewed" ? Response.json(f.payloads["/api/me"]) : Response.json({ error: "no" }, { status: 401 }));
  assert.equal((await f.run()).ok, true);
  assert.deepEqual(forces, [false, true, false]);
  assert.equal(f.calls.length, 8);
});

test("expired grant key does not refresh SSO, probe other keys or echo remote errors", async (t) => {
  const f = fixture(t); f.config(); f.provider();
  f.options.getAccessToken = async () => { throw new Error("must not refresh"); };
  f.overrides.set("/api/me", () => Response.json({ error: "dk_secret_should_not_escape" }, { status: 401 }));
  const result = await f.run();
  assert.equal(result.reason, "unauthorized");
  assert.ok(!JSON.stringify(result).includes("dk_secret"));
  assert.equal(f.calls.length, 1);
});

for (const section of ["usage", "logs", "sessions", "prices", "limits", "balance"]) {
  test(`${section} failure does not hide other available sections`, async (t) => {
    const f = fixture(t); f.config(); f.provider();
    f.overrides.set(`/api/me/${section}`, () => Response.json({ error: "unavailable" }, { status: 503 }));
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result[section], null);
    assert.deepEqual(result.unavailableSections, [section]);
    if (section !== "balance") assert.deepEqual(result.balance, balance);
    assert.equal(f.calls.length, 7);
  });
}

test("old balance or malformed string money is unavailable rather than zero or unlimited", async (t) => {
  const f = fixture(t); f.config(); f.provider();
  for (const value of [{ currency: "USD", cost_micro: 0, unlimited: true }, { ...balance, used_microcredits: 123 }, { ...balance, used_microcredits: "1.5" }]) {
    f.payloads["/api/me/balance"] = value;
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.balance, null);
    assert.ok(result.unavailableSections.includes("balance"));
  }
});

for (const replacement of ["", "another-account"]) {
  test(`late employee results are discarded after identity changes to ${replacement || "signed-out"}`, async (t) => {
    const f = fixture(t); f.config({ mode: "access-token" });
    f.overrides.set("/api/me/logs", () => { f.setToken(replacement); return Response.json({ items: [] }); });
    assert.equal((await f.run()).reason, "unauthorized");
  });
}

test("configuration replacement discards in-flight usage data", async (t) => {
  const f = fixture(t); f.config(); f.provider();
  f.overrides.set("/api/me/logs", () => { writeTransitHubSettings(f.app, { enabled: false }); return Response.json({ items: [] }); });
  assert.equal((await f.run()).ok, false);
});

test("configuration validates transport, explicit mode and safe provider keys", () => {
  for (const patch of [{ baseUrl: "http://remote.invalid" }, { baseUrl: "https://user:pass@remote.invalid" }, { baseUrl: origin + "/v1" }, { baseUrl: origin + "?token=secret" }, { auth: { mode: "auto" } }, { auth: { mode: "apikey", providerKey: "../key" } }, { enabled: "true" }]) {
    assert.throws(() => normalizeTransitHubSettings({ enabled: true, baseUrl: origin, auth: { mode: "access-token" }, ...patch }));
  }
  assert.equal(normalizeTransitHubSettings({ enabled: true, baseUrl: "http://[::1]:8080", auth: { mode: "access-token" } }).baseUrl, "http://[::1]:8080");
});

test("Credits formatting preserves six decimals, negative balance and unsafe integers", () => {
  assert.equal(formatMicrocredits("90071992547409930", "en-US"), "90,071,992,547.40993 Credits");
  assert.equal(formatMicrocredits("-1", "en-US"), "-0.000001 Credits");
  assert.equal(formatMicrocredits("1000000", "zh-CN"), "1 Credits");
  assert.equal(usageLimitProgress(windowUsage, Date.parse("2026-10-21T01:00:00Z")).remainingPercent, 0);
  assert.equal(usageLimitProgress({ ...windowUsage, state: "idle" }).pending, true);
  assert.equal(usageLimitProgress({ ...windowUsage, state: "expired" }).usedPercent, 0);
  assert.equal(usageLimitProgress(windowUsage, Date.parse("2026-10-21T06:00:00Z")).pending, true);
  assert.equal(usageLimitProgress({ ...windowUsage, quota_microcredits: "0", tokens: 90 }, Date.parse("2026-10-21T01:00:00Z")).usedPercent, 90);
});

test("employee metadata 401 refreshes the entire snapshot once", async (t) => {
  const f = fixture(t); f.config({ mode: "access-token" });
  let refreshes = 0;
  let token = "employee-fixture";
  f.options.getAccessToken = async (force) => {
    if (force) { ++refreshes; token = "renewed"; f.setToken(token); }
    return token;
  };
  f.overrides.set("/api/me/balance", (_url, init) => init.headers.Authorization === "Bearer renewed" ? Response.json(balance) : Response.json({}, { status: 401 }));
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.balance.remaining_microcredits, "-1000000");
  assert.equal(refreshes, 1);
  assert.equal(f.calls.filter((c) => new URL(c.url).pathname === "/api/me").length, 2);
});

test("repeated employee 401 has a single refresh attempt", async (t) => {
  const f = fixture(t); f.config({ mode: "access-token" });
  let refreshes = 0;
  f.options.getAccessToken = async (force) => { if (force) ++refreshes; return "employee-fixture"; };
  f.overrides.set("/api/me", () => Response.json({}, { status: 401 }));
  assert.equal((await f.run()).reason, "unauthorized");
  assert.equal(refreshes, 1);
  assert.equal(f.calls.length, 2);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: encrypted Grant key resolves from service configuration`, async (t) => {
    const crypto = await import("node:crypto");
    const { APP_BRAND } = require("../dist-electron/shared/brand.js");
    const { getServiceConfigRoot } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
    const f = fixture(t, platform); f.config();
    const part = "fixture-key-part";
    const savedPart = process.env.PROVIDER_APIKEY_KEY_PART;
    delete process.env.PROVIDER_APIKEY_KEY_PART;
    t.after(() => { if (savedPart === undefined) delete process.env.PROVIDER_APIKEY_KEY_PART; else process.env.PROVIDER_APIKEY_KEY_PART = savedPart; });
    const key = crypto.createHash("sha256").update(`${APP_BRAND.storageNamespace}:provider:${part}`).digest();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update("dk_grant_fixture", "utf8"), cipher.final()]);
    f.provider("grant-hub", { key: `AES(${Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64url")})` });
    const configRoot = getServiceConfigRoot(f.app, "agent-platform", "builtin", platform);
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, ".env"), `PROVIDER_APIKEY_KEY_PART=${part}\n`);
    assert.equal((await f.run()).ok, true);
    assert.ok(f.calls.every((c) => c.init.headers.Authorization === "Bearer dk_grant_fixture"));
  });
}
