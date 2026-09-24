import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import childProcess from "node:child_process";
import { createUpdateManifest } from "../scripts/create-update-manifest.mjs";
const require = createRequire(import.meta.url);
// The host registry must not redirect Windows fixtures into an installed user's data.
const registryRead = test.mock.method(childProcess, "execFileSync", () => Buffer.from(""));
require("../dist-electron/main/infrastructure/filesystem/runtime-root.js").readWindowsRuntimeRootFromRegistry("win32");
registryRead.mock.restore();
const { normalizeUpdateConfig, getUpdateConfigPath, readUpdateConfig } = require("../dist-electron/main/modules/updates/config.js");
const { compareUpdateVersions, parseUpdateManifest } = require("../dist-electron/main/modules/updates/manifest.js");
const { createUpdateRuntime } = require("../dist-electron/main/modules/updates/runtime.js");
const { downloadUpdateFile, fetchUpdateManifest } = require("../dist-electron/main/modules/updates/download.js");
const { applyDesktopInitBootstrap, applyDesktopInitVersionUpgrade, resolveDesktopInitPath } = require("../dist-electron/main/app/bootstrap/desktop-init.js");
const content = Buffer.from("test update bytes");
const hash = createHash("sha256").update(content).digest("hex");
const config = { enabled: true, feedUrl: "https://updates.example.com/latest.json" };
const artifact = { url: "https://updates.example.com/app.zip", size: content.length, sha256: hash };
const pair = generateKeyPairSync("ed25519");
const trust = { channel: "production", keys: [{ keyId: "fixture", productId: "cutej", channel: "production", publicKey: pair.publicKey.export({ format: "pem", type: "spki" }) }] };
const manifest = () => ({ schemaVersion: 2, keyId: "fixture", channel: "production", productId: "cutej", version: "0.5.0", publishedAt: "2026-09-12T08:00:00Z", releaseNotes: { "zh-CN": ["test"] }, artifacts: { "darwin-arm64": { ...artifact }, "win32-x64": { ...artifact, url: "https://updates.example.com/app.exe" } } });
function signed(value = manifest()) { const payload = JSON.stringify(value); return { manifest: payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString("base64") }; }
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function fixture(t, extra = {}) {
  const root = temp(t), events = [], installs = [];
  const runtime = createUpdateRuntime({ trust, now: () => Date.parse("2026-09-21T08:00:00Z"), currentVersion: "0.4.1", productId: "cutej", platform: "darwin", arch: "arm64", packaged: true, cacheRoot: root, preferencesPath: path.join(root, "preferences.json"), readConfig: () => config, emit: (s) => events.push(s), fetchManifest: async () => signed(), downloadFile: async (_artifact, file) => fs.promises.writeFile(file, content), verifyPublisher: async () => {}, prepareInstall: async () => true, install: async (...args) => { installs.push(args); }, ...extra });
  t.after(() => runtime.dispose());
  return { root, runtime, events, installs };
}

test("initialization accepts one shared feed URL on both platforms", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(normalizeUpdateConfig(config, platform), config);
    assert.deepEqual(normalizeUpdateConfig({ enabled: false }, platform), { enabled: false, feedUrl: "" });
    for (const input of [
      {}, { enabled: true }, { ...config, feedUrls: { win32: config.feedUrl } },
      ...[null, [], "", "http://example.com/feed", "https://user:secret@example.com/feed", "https://example.com/feed#fragment"].map(feedUrl => ({ enabled: true, feedUrl }))
    ]) assert.throws(() => normalizeUpdateConfig(input, platform));
  }
});

test("initialization rejects split feeds even when disabled", () => {
  const feeds = { win32: "https://updates.example.com/windows.json", darwin: "https://updates.example.com/macos.json" };
  for (const platform of ["win32", "darwin"]) {
    assert.throws(() => normalizeUpdateConfig({ enabled: true, feedUrls: feeds }, platform), /feedUrl/);
    assert.equal(normalizeUpdateConfig({ enabled: false }, platform).feedUrl, "");
    for (const input of [
      {}, { enabled: true }, { ...config, feedUrls: feeds },
      { enabled: false, feedUrls: feeds },
      ...[null, [], "invalid", { windows: feeds.win32 }, { [platform]: "http://localhost/latest.json" },
        { [platform]: "https://user:secret@example.com/latest.json" },
        { [platform]: "https://example.com/latest.json#fragment" },
        { ...feeds, linux: "invalid" }].map(feedUrls => ({ enabled: true, feedUrls }))
    ]) assert.throws(() => normalizeUpdateConfig(input, platform));
    const other = platform === "win32" ? "darwin" : "win32";
    assert.throws(() => normalizeUpdateConfig({ enabled: true, feedUrls: { [other]: feeds[other] } }, platform), /feedUrl/);
  }
});

test("transient checks retry at 5/15/30 seconds and stop after recovery", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempts = 0;
  const { runtime } = fixture(t, { fetchManifest: async () => {
    if (++attempts < 4) throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' });
    return signed();
  } });
  await runtime.check();
  for (const delay of [5000, 15000, 30000]) {
    t.mock.timers.tick(delay);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(runtime.getState().phase, 'available');
  assert.equal(attempts, 4);
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 4);
});

test("main readiness recovers a failed initial check once and joins in-flight checks", async t => {
  let attempts = 0;
  const { runtime } = fixture(t, { fetchManifest: async () => {
    if (++attempts === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return signed();
  } });
  await runtime.check();
  await Promise.all([runtime.mainReady(), runtime.mainReady(), runtime.check()]);
  assert.equal(runtime.getState().phase, 'available');
  assert.equal(attempts, 2);
  await runtime.mainReady();
  assert.equal(attempts, 2);
});

test("sidebar exposes retry even when the first failed check has no version", () => {
  const { desktopUpdateSidebarVisible, desktopUpdateAction } = require('../dist-electron/shared/desktop-updates.js');
  const state = { phase: 'error', error: 'checkFailed', currentVersion: '0.4.13', progress: 0, autoDownload: false, canInstall: true };
  assert.equal(desktopUpdateSidebarVisible(state), true);
  assert.equal(desktopUpdateAction(state), 'check');
  assert.equal(desktopUpdateSidebarVisible({ ...state, phase: 'current', error: undefined }), false);
});

test("persistent network failure exhausts retries; disposal cancels pending retry", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempts = 0;
  const { runtime } = fixture(t, { fetchManifest: async () => {
    attempts++; throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' });
  } });
  await runtime.check();
  for (const delay of [5000, 15000, 30000, 60000]) {
    t.mock.timers.tick(delay); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(attempts, 4);
  assert.equal(runtime.getState().error, 'checkFailed');
  await runtime.check();
  runtime.dispose();
  t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 5);
});

test("invalid signatures never trigger network retries or readiness recovery", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempts = 0;
  const { runtime } = fixture(t, { platform: 'win32', arch: 'x64', fetchManifest: async () => {
    attempts++; return { ...signed(), signature: 'invalid' };
  } });
  await runtime.check();
  await runtime.mainReady();
  t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(runtime.getState().error, 'signatureInvalid');
});

test("startup completion waits for core readiness before update recovery", async () => {
  const { createStartupPipeline } = require('../dist-electron/main/app/lifecycle/startup.js');
  let release, finished = false;
  const phases = [];
  const pipeline = createStartupPipeline({
    app: {}, getEnvImportFailureMessage: () => null,
    startShellRuntime() {}, loadBuiltinServices() {}, loadInstalledPlugins() {}, notifyCoreServicesChanged() {},
    startupRestoreController: { finishSession() {} }, startNonCoreRuntime() {},
    setStartupPhase: phase => phases.push(phase), runServiceMutation: task => task(),
    runStartupPreparation: () => new Promise(resolve => { release = resolve; }),
  });
  const completion = pipeline.run().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release({ mode: 'normal', failures: [] });
  await completion;
  assert.equal(phases.at(-1), 'core-ready');
});


test("one configured address is independent of the initialization platform", () => {
  const input = { enabled: true, feedUrls: { win32: "https://updates.example.com/windows/desktop-latest.json", darwin: config.feedUrl } };
  assert.deepEqual(normalizeUpdateConfig(config, "win32"), config);
  assert.deepEqual(normalizeUpdateConfig(config, "darwin"), config);
  assert.throws(() => normalizeUpdateConfig(input, "win32"), /feedUrl/);
  for (const feedUrls of [[], "invalid", { win32: "http://unsafe.example.com/feed" }, { win32: "" }, { windows: config.feedUrl }, { darwin: config.feedUrl }]) {
    assert.throws(() => normalizeUpdateConfig({ enabled: true, feedUrls }, "win32"));
  }
  assert.throws(() => normalizeUpdateConfig({ enabled: true, feedUrls: { darwin: config.feedUrl } }, "win32"), /feedUrl/);
  assert.throws(() => normalizeUpdateConfig({ ...config, feedUrls: input.feedUrls }, "win32"), /feedUrls/);
});
test("SemVer precedence rejects downgrade and numeric prerelease traps", () => {
  assert.equal(compareUpdateVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareUpdateVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareUpdateVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareUpdateVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  for (const v of ["v1.0.0", "1.01.0", "1.0", "1.0.0-beta.01"]) assert.throws(() => compareUpdateVersions(v, "1.0.0"));
});
test("manifest rejects identity, version, URL, size and hash mismatches", () => {
  assert.equal(parseUpdateManifest(manifest(), "cutej").version, "0.5.0");
  for (const patch of [{ schemaVersion: 1 }, { productId: "zenmind" }, { version: "0.5.0-beta.01" }, { publishedAt: "yesterday" }]) assert.throws(() => parseUpdateManifest({ ...manifest(), ...patch }, "cutej"));
  for (const patch of [{ url: "http://example.com/app.zip" }, { url: "https://example.com/app.exe" }, { size: -1 }, { sha256: "bad" }]) assert.throws(() => parseUpdateManifest({ ...manifest(), artifacts: { "darwin-arm64": { ...artifact, ...patch } } }, "cutej"));
});
for (const platform of ["darwin", "win32"]) test(`${platform} init consumes updates into canonical config and upgrade backs it up`, (t) => {
  const root = temp(t);
  const app = { getPath: (name) => name === "home" ? root : path.join(root, "app-data") };
  const init = resolveDesktopInitPath(app, platform);
  fs.mkdirSync(path.dirname(init), { recursive: true });
  fs.writeFileSync(init, JSON.stringify({ updates: config }));
  assert.equal(applyDesktopInitBootstrap(app, platform).ok, true);
  const target = getUpdateConfigPath(app, platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), config);
  assert.deepEqual(readUpdateConfig(app, platform), config);
  assert.equal(fs.existsSync(init), false);
  const backup = path.join(root, "backup");
  const changed = { ...config, feedUrl: "https://test.example.com/latest.json" };
  applyDesktopInitVersionUpgrade(app, { updates: changed }, backup, platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), changed);
  assert.deepEqual(readUpdateConfig(app, platform), changed);
  assert.ok(fs.readdirSync(backup).some((name) => name.endsWith("updates.json")));
  assert.equal(applyDesktopInitVersionUpgrade(app, { updates: { enabled: true, feedUrls: { [platform]: config.feedUrl } } }, path.join(root, "legacy-backup"), platform).applied, true);
  assert.equal(applyDesktopInitVersionUpgrade(app, { updates: { enabled: true, feedUrl: "file:///tmp/payload" } }, path.join(root, "bad-backup"), platform).applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), changed);
});
for (const platform of ["win32", "darwin"]) test(`${platform} bootstrap and version upgrade preserve the shared entry without platform parameters`, (t) => {
  const root = temp(t);
  const app = { getPath: (name) => name === "home" ? root : path.join(root, "app-data") };
  const input = { enabled: true, feedUrl: "https://updates.example.com/api/updates/desktop-latest.json?channel=dev" };
  const expected = input;
  const init = resolveDesktopInitPath(app, platform);
  fs.mkdirSync(path.dirname(init), { recursive: true });
  fs.writeFileSync(init, JSON.stringify({ updates: input }));
  assert.equal(applyDesktopInitBootstrap(app, platform).ok, true);
  const target = getUpdateConfigPath(app, platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), expected);
  applyDesktopInitVersionUpgrade(app, { updates: input }, path.join(root, "backup"), platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), expected);
  assert.equal(applyDesktopInitVersionUpgrade(app, { updates: { ...input, feedUrl: "http://unsafe.example.com" } }, path.join(root, "bad-backup"), platform).applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), expected);
});

test("disabled source never checks or downloads", async (t) => {
  const { runtime } = fixture(t, { readConfig: () => ({ ...config, enabled: false }), fetchManifest: () => assert.fail("must not fetch") });
  assert.equal((await runtime.check()).phase, "disabled");
});

for (const platform of ['win32', 'darwin']) test(`${platform} invalid optional updates do not block other bootstrap settings`, t => {
  const root = temp(t);
  const app = { getPath: name => name === 'home' ? root : path.join(root, 'app-data') };
  const init = resolveDesktopInitPath(app, platform);
  fs.mkdirSync(path.dirname(init), { recursive: true });
  fs.writeFileSync(init, JSON.stringify({ updates: 'invalid', assistant: { defaultChatAgentKey: 'test-agent' } }));
  const result = applyDesktopInitBootstrap(app, platform);
  assert.equal(result.ok, true);
  assert.equal(result.appliedResult.updates, 'failed');
  assert.equal(result.appliedResult.assistant, 'recorded');
  assert.ok(result.errors.updates);
  assert.equal(fs.existsSync(getUpdateConfigPath(app, platform)), false);
  assert.equal(applyDesktopInitVersionUpgrade(app, { updates: null }, path.join(root, 'upgrade'), platform).applied, true);
});
test("official checks use the configured feed URL and follow configuration changes", async (t) => {
  let currentConfig = { ...config, feedUrl: "https://releases.example.org/custom/stable.json" };
  const requested = [];
  const { runtime } = fixture(t, {
    readConfig: () => currentConfig,
    fetchManifest: async (url) => { requested.push(url); return signed(); }
  });
  await runtime.check();
  currentConfig = { ...currentConfig, feedUrl: "https://cdn.example.org/releases/desktop.json" };
  await runtime.check();
  assert.deepEqual(requested, [
    "https://releases.example.org/custom/stable.json",
    "https://cdn.example.org/releases/desktop.json"
  ]);
});
for (const platform of ["darwin", "win32"]) test(`${platform} checks, verifies and invokes install only after cleanup`, async (t) => {
  const order = [];
  const { runtime, events, installs } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64", verifyPublisher: async () => { order.push("signature"); }, prepareInstall: async () => { order.push("cleanup"); return true; } });
  runtime.setAutoDownload(true);
  assert.equal((await runtime.check()).phase, "ready");
  assert.ok(events.some((s) => s.phase === "verifying"));
  await runtime.install();
  await runtime.install();
  assert.equal(installs.length, 1);
  assert.deepEqual(order, ["signature", "signature", "cleanup"]);
  assert.equal(events.some((s) => JSON.stringify(s).includes("https://")), false);
});
test("manual download preference and cache reuse survive runtime recreation", async (t) => {
  const { runtime, root } = fixture(t);
  runtime.setAutoDownload(false);
  assert.equal((await runtime.check()).phase, "available");
  assert.equal((await runtime.download()).phase, "ready");
  const again = fixture(t, { cacheRoot: root, preferencesPath: path.join(root, "preferences.json"), downloadFile: () => assert.fail("cache should be reused") });
  assert.equal(again.runtime.getState().autoDownload, false);
  assert.equal((await again.runtime.check()).phase, "ready");
  assert.equal(again.runtime.getState().packageReady, true);
});
test("bad checksum or publisher never reaches ready", async (t) => {
  for (const patch of [{ downloadFile: async (_a, file) => fs.promises.writeFile(file, "broken") }, { verifyPublisher: async () => { throw new Error("bad signature"); } }]) {
    const { runtime, events, installs } = fixture(t, patch);
    runtime.setAutoDownload(true);
    assert.equal((await runtime.check()).phase, "error");
    await runtime.install();
    assert.equal(installs.length, 0);
    assert.equal(events.some((s) => s.phase === "ready"), false);
  }
});
test("install rechecks cache and fails closed on startup or cleanup failure", async (t) => {
  for (const error of ["updateBusy", "cleanupFailed"]) {
    const { runtime, installs } = fixture(t, { prepareInstall: async () => { throw new Error(error); } });
    runtime.setAutoDownload(true);
    await runtime.check();
    assert.equal((await runtime.install()).error, error);
    assert.equal(installs.length, 0);
  }
  const { runtime, root, installs } = fixture(t);
  runtime.setAutoDownload(true);
  await runtime.check();
  fs.writeFileSync(path.join(root, `${hash}.zip`), "tampered");
  assert.equal((await runtime.install()).phase, "error");
  assert.equal(installs.length, 0);
});
test("unsupported architectures, older versions and development mode cannot install", async (t) => {
  for (const [options, phase] of [[{ arch: "ia32" }, "unavailable"], [{ currentVersion: "0.6.0" }, "current"], [{ packaged: false }, "ready"]]) {
    const { runtime, installs } = fixture(t, options);
    runtime.setAutoDownload(true);
    assert.equal((await runtime.check()).phase, phase);
    if (phase === "current") {
      assert.equal((await runtime.download()).phase, "current", "explicit download cannot enable a downgrade");
    }
    await runtime.install(); assert.equal(installs.length, 0);
  }
});
test("parallel checks are coalesced and changed config invalidates ready cache", async (t) => {
  let calls = 0, current = config;
  const { runtime, installs } = fixture(t, { readConfig: () => current, fetchManifest: async () => { calls++; return signed(); } });
  await Promise.all([runtime.check(), runtime.check(), runtime.download()]);
  assert.equal(calls, 1);
  current = { ...config, enabled: false };
  await runtime.install();
  assert.equal(runtime.getState().phase, "disabled"); assert.equal(installs.length, 0);
});
function fakeHttps(t, replies) {
  const original = https.get;
  https.get = (url, _options, cb) => {
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = (error) => request.emit("error", error);
    process.nextTick(() => { const reply = replies.shift(); assert.ok(reply, `unexpected URL ${url}`); const res = Readable.from([reply.body ?? content]); res.statusCode = reply.status ?? 200; res.headers = reply.headers ?? {}; cb(res); });
    return request;
  };
  t.after(() => { https.get = original; });
}
test("streamed download rejects oversized/truncated bytes and removes partial file", async (t) => {
  const root = temp(t); fakeHttps(t, [{ body: Buffer.alloc(content.length + 1) }, { body: Buffer.from("x") }]);
  const target = path.join(root, "app.zip");
  for (let i = 0; i < 2; i++) {
    await assert.rejects(downloadUpdateFile(artifact, target, new AbortController().signal, () => {}));
    assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(target + ".part"), false);
  }
});
test("redirects cannot downgrade HTTPS and manifest is bounded", async (t) => {
  fakeHttps(t, [{ status: 302, headers: { location: "http://localhost/app.zip" } }, { body: Buffer.alloc(256 * 1024 + 1) }]);
  await assert.rejects(fetchUpdateManifest(config.feedUrl, new AbortController().signal), /HTTPS/);
  await assert.rejects(fetchUpdateManifest(config.feedUrl, new AbortController().signal), /size limit/);
});
test("local release helper generates exact size and hash", async (t) => {
  const root = temp(t), file = path.join(root, "app.zip"); fs.writeFileSync(file, content);
  const output = await createUpdateManifest({ ...manifest(), artifacts: { "darwin-arm64": { file, url: artifact.url } } });
  assert.deepEqual(parseUpdateManifest(output, "cutej").artifacts["darwin-arm64"], artifact);
});

test("missing manifest is normal but missing artifacts and server errors still fail", async (t) => {
  const root = temp(t);
  fakeHttps(t, [{ status: 404 }, { status: 503 }, { status: 404 }, { body: Buffer.from("null") }, { body: Buffer.from("invalid-signature") }]);
  assert.equal(await fetchUpdateManifest(config.feedUrl, new AbortController().signal), undefined);
  await assert.rejects(fetchUpdateManifest(config.feedUrl, new AbortController().signal), /503/);
  await assert.rejects(downloadUpdateFile(artifact, path.join(root, "app.zip"), new AbortController().signal, () => {}), /404/);
  const raw = await fetchUpdateManifest(config.feedUrl, new AbortController().signal);
  assert.throws(() => parseUpdateManifest(raw, "cutej"));
});
test("unconfigured manifest clears stale metadata without an error or download", async (t) => {
  let found = true;
  const { runtime, installs } = fixture(t, { fetchManifest: async () => found ? signed() : undefined, downloadFile: () => assert.fail("must not download") });
  runtime.setAutoDownload(false);
  assert.equal((await runtime.check()).phase, "available");
  found = false;
  const state = await runtime.check();
  assert.equal(state.phase, "not-configured");
  assert.equal(state.error, undefined);
  assert.equal(state.version, undefined);
  assert.equal(state.releaseNotes, undefined);
  await runtime.download(); await runtime.install(); assert.equal(installs.length, 0);
});

test("display version tags compare correctly and download errors identify their stage", async (t) => {
  const { runtime } = fixture(t, { currentVersion: "v0.4.5", downloadFile: async () => { throw new Error("HTTP 404"); } });
  runtime.setAutoDownload(false);
  const available = await runtime.check();
  assert.equal(available.phase, "available");
  assert.equal(available.currentVersion, "0.4.5");
  const failed = await runtime.download();
  assert.equal(failed.error, "downloadFailed");
});
test("feed failures identify the check stage", async (t) => {
  const { runtime } = fixture(t, { fetchManifest: async () => { throw new Error("HTTP 503"); } });
  assert.equal((await runtime.check()).error, "checkFailed");
});

test("new profiles check metadata only until download is requested", async (t) => {
  let downloads = 0;
  const { runtime } = fixture(t, { downloadFile: async () => { downloads++; throw new Error("HTTP 404"); } });
  assert.equal(runtime.getState().autoDownload, false);
  assert.equal((await runtime.check()).phase, "available");
  assert.equal(downloads, 0);
  assert.equal((await runtime.download()).error, "downloadFailed");
  assert.equal(downloads, 1);
  assert.equal(runtime.getState().version, "0.5.0");
  assert.equal((await runtime.download()).error, "downloadFailed");
  assert.equal(downloads, 2, "failed downloads can be retried from the retained update entry");
});

for (const platform of ["darwin", "win32"]) test(`${platform} test update bypasses official feed only for this session`, async (t) => {
  let reads = 0, downloads = 0;
  const { runtime, installs, root } = fixture(t, {
    platform, arch: platform === "darwin" ? "arm64" : "x64",
    readConfig: () => { reads++; return config; },
    fetchManifest: async () => { throw new Error("official feed must not be queried during test"); },
    downloadFile: async (_artifact, file) => { downloads++; fs.writeFileSync(file, content); }
  });
  runtime.setAutoDownload(true);
  const input = signed({ ...manifest(), version: "0.6.0" });
  const loaded = await runtime.loadTest(input);
  assert.equal(loaded.source, "test");
  assert.equal(loaded.phase, "available");
  assert.equal(downloads, 0);
  assert.equal(runtime.getState().source, "test");
  await runtime.check(); runtime.resume(); await runtime.check(); runtime.setAutoDownload(true);
  assert.equal(reads, 0); assert.equal(downloads, 0);
  assert.equal((await runtime.download()).phase, "ready");
  await runtime.install(); assert.equal(installs.length, 1);
  // Model a user declining install instead when testing the exit path below.
  const next = fixture(t, { preferencesPath: path.join(root, "preferences.json") });
  assert.notEqual(next.runtime.getState().source, "test", "test selection never persists");
});

test("test update validation preserves existing selection and rejects wrong identity, downgrade and platform", async (t) => {
  const { runtime } = fixture(t);
  await runtime.loadTest(signed());
  const original = runtime.getState();
  for (const value of [
    { ...manifest(), productId: "other" }, { ...manifest(), version: "0.4.1" },
    { ...manifest(), artifacts: {} },
    { ...manifest(), artifacts: { "darwin-arm64": { ...artifact, url: "http://example.com/app.zip" } } },
    { ...manifest(), artifacts: { "darwin-arm64": { ...artifact, sha256: "bad" } } },
  ]) {
    await assert.rejects(runtime.loadTest(signed(value)));
    assert.deepEqual(runtime.getState(), original);
  }
  const result = await runtime.clearTest();
  assert.equal(result.source, "official"); assert.equal(result.version, undefined);
  assert.equal(result.phase, "idle");
  assert.equal((await runtime.check()).phase, "available");
});

test("test selection cannot race downloads and development mode cannot install", async (t) => {
  let finish;
  const { runtime, installs } = fixture(t, { packaged: false, downloadFile: async (_a, file) => {
    await new Promise(resolve => { finish = resolve; }); fs.writeFileSync(file, content);
  } });
  await runtime.loadTest(signed());
  const download = runtime.download();
  await assert.rejects(runtime.clearTest(), /updateBusy/);
  await assert.rejects(runtime.loadTest(signed()), /updateBusy/);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  finish(); await download;
  assert.equal(runtime.getState().canInstall, false);
  await runtime.install(); assert.equal(installs.length, 0);
  await runtime.clearTest(); assert.equal(runtime.getState().version, undefined);
});

for (const platform of ["darwin", "win32"]) test(`${platform} URL-selected feed accepts prereleases and rejects downgrades`, async (t) => {
  for (const [currentVersion, version, phase] of [
    ["0.4.9", "0.4.10-dev.1", "available"],
    ["0.4.10-dev.1", "0.4.10-dev.2", "available"],
    ["0.4.10-dev.2", "0.4.10", "available"],
    ["0.4.10", "0.4.10-dev.3", "current"]
  ]) {
    const { runtime } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64", currentVersion,
      fetchManifest: async () => signed({ ...manifest(), version }) });
    assert.equal((await runtime.check()).phase, phase);
  }
  const { runtime } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64" });
  assert.equal((await runtime.loadTest(signed({ ...manifest(), version: "0.6.0-dev.1" }))).phase, "available");
});

for (const platform of ["darwin", "win32"]) test(`${platform} pre-cleanup refusal retains package and retries install directly`, async (t) => {
  let blocked = true, downloads = 0;
  const { runtime, installs } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64",
    prepareInstall: async () => { if (blocked) throw new Error("updateBusy"); return true; },
    downloadFile: async (_a, file) => { downloads++; await fs.promises.writeFile(file, content); }
  });
  await runtime.check(); await runtime.download();
  const failed = await runtime.install();
  assert.equal(failed.phase, "ready"); assert.equal(failed.packageReady, true);
  assert.equal(failed.error, "updateBusy");
  assert.equal((await runtime.check()).phase, "ready");
  blocked = false;
  const retried = await runtime.install();
  assert.equal(retried.error, undefined); assert.equal(installs.length, 1); assert.equal(downloads, 1);
});
test("cancelled preparation preserves ready state and does not install", async (t) => {
  const { runtime, installs } = fixture(t, { prepareInstall: async () => false });
  await runtime.check(); await runtime.download();
  assert.equal((await runtime.install()).packageReady, true);
  assert.equal(runtime.getState().phase, "ready"); assert.equal(installs.length, 0);
});
for (const platform of ["darwin", "win32"]) test(`${platform} native or cleanup failure retains package but requires service recovery`, async (t) => {
  for (const stage of ["cleanup", "native"]) {
    let attempts = 0;
    const { runtime } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64",
      prepareInstall: async () => { if (stage === "cleanup") { attempts++; throw new Error("cleanupFailed"); } return true; },
      install: async () => { attempts++; throw new Error("native failure"); }
    });
    await runtime.check(); await runtime.download();
    const failed = await runtime.install();
    assert.equal(failed.packageReady, true); assert.equal(failed.restartRequired, true);
    await runtime.check(); await runtime.download(); await runtime.install();
    assert.equal(attempts, 1); assert.equal(runtime.getState().restartRequired, true);
  }
});
test("tampered cache invalidates readiness and recovers through download", async (t) => {
  const { runtime, root, installs } = fixture(t);
  await runtime.check(); await runtime.download();
  fs.writeFileSync(path.join(root, `${hash}.zip`), "tampered");
  const failed = await runtime.install();
  assert.equal(failed.packageReady, false); assert.equal(failed.error, "verificationFailed");
  assert.equal(installs.length, 0);
  await runtime.download(); await runtime.install(); assert.equal(installs.length, 1);
});
test("sidebar and About share recovery actions", () => {
  const { desktopUpdateAction } = require("../dist-electron/shared/desktop-updates.js");
  const base = { currentVersion: "0.4.1", version: "0.5.0", progress: 100, autoDownload: false, canInstall: true };
  for (const [patch, expected] of [
    [{ phase: "ready", packageReady: true, error: "updateBusy" }, "install"],
    [{ phase: "error", packageReady: true, restartRequired: true, error: "cleanupFailed" }, "restart"],
    [{ phase: "error", packageReady: false, error: "verificationFailed" }, "download"],
    [{ phase: "error", error: "downloadFailed" }, "download"],
    [{ phase: "error", error: "checkFailed" }, "check"],
    [{ phase: "installing", packageReady: true }, undefined]
  ]) assert.equal(desktopUpdateAction({ ...base, ...patch }), expected);
});
