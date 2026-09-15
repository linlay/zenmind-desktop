import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createUpdateManifest } from "../scripts/create-update-manifest.mjs";
const require = createRequire(import.meta.url);
const { normalizeUpdateConfig, getUpdateConfigPath } = require("../dist-electron/main/modules/updates/config.js");
const { compareUpdateVersions, parseUpdateManifest } = require("../dist-electron/main/modules/updates/manifest.js");
const { createUpdateRuntime } = require("../dist-electron/main/modules/updates/runtime.js");
const { downloadUpdateFile, fetchUpdateManifest } = require("../dist-electron/main/modules/updates/download.js");
const { applyDesktopInitBootstrap, applyDesktopInitVersionUpgrade, resolveDesktopInitPath } = require("../dist-electron/main/app/bootstrap/desktop-init.js");
const content = Buffer.from("test update bytes");
const hash = createHash("sha256").update(content).digest("hex");
const config = { enabled: true, channel: "stable", feedUrl: "https://updates.example.com/latest.json" };
const artifact = { url: "https://updates.example.com/app.zip", size: content.length, sha256: hash };
const manifest = () => ({ schemaVersion: 1, productId: "cutej", channel: "stable", version: "0.5.0", publishedAt: "2026-09-12T08:00:00Z", releaseNotes: { "zh-CN": ["test"] }, artifacts: { "darwin-arm64": { ...artifact }, "win32-x64": { ...artifact, url: "https://updates.example.com/app.exe" } } });
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function fixture(t, extra = {}) {
  const root = temp(t), events = [], installs = [];
  const runtime = createUpdateRuntime({ currentVersion: "0.4.1", productId: "cutej", platform: "darwin", arch: "arm64", packaged: true, cacheRoot: root, preferencesPath: path.join(root, "preferences.json"), readConfig: () => config, emit: (s) => events.push(s), fetchManifest: async () => manifest(), downloadFile: async (_artifact, file) => fs.promises.writeFile(file, content), verifyPublisher: async () => {}, prepareInstall: async () => true, install: async (...args) => { installs.push(args); }, ...extra });
  t.after(() => runtime.dispose());
  return { root, runtime, events, installs };
}

test("configuration requires explicit enablement and HTTPS without credentials", () => {
  assert.deepEqual(normalizeUpdateConfig(config), config);
  assert.equal(normalizeUpdateConfig({ enabled: false }).feedUrl, "");
  for (const input of [{}, { enabled: true }, { ...config, feedUrl: "http://localhost/latest.json" }, { ...config, feedUrl: "https://user:secret@example.com/latest.json" }, { ...config, channel: "../stable" }]) assert.throws(() => normalizeUpdateConfig(input));
});
test("SemVer precedence rejects downgrade and numeric prerelease traps", () => {
  assert.equal(compareUpdateVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareUpdateVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareUpdateVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareUpdateVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  for (const v of ["v1.0.0", "1.01.0", "1.0", "1.0.0-beta.01"]) assert.throws(() => compareUpdateVersions(v, "1.0.0"));
});
test("manifest rejects identity, version, URL, size and hash mismatches", () => {
  assert.equal(parseUpdateManifest(manifest(), "cutej", "stable").version, "0.5.0");
  for (const patch of [{ schemaVersion: 2 }, { productId: "zenmind" }, { channel: "beta" }, { version: "0.5.0-beta" }, { publishedAt: "yesterday" }]) assert.throws(() => parseUpdateManifest({ ...manifest(), ...patch }, "cutej", "stable"));
  for (const patch of [{ url: "http://example.com/app.zip" }, { url: "https://example.com/app.exe" }, { size: -1 }, { sha256: "bad" }]) assert.throws(() => parseUpdateManifest({ ...manifest(), artifacts: { "darwin-arm64": { ...artifact, ...patch } } }, "cutej", "stable"));
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
  assert.equal(fs.existsSync(init), false);
  const backup = path.join(root, "backup");
  const changed = { ...config, channel: "beta" };
  applyDesktopInitVersionUpgrade(app, { updates: changed }, backup, platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), changed);
  assert.ok(fs.readdirSync(backup).some((name) => name.endsWith("updates.json")));
  assert.throws(() => applyDesktopInitVersionUpgrade(app, { updates: { ...config, feedUrl: "file:///tmp/payload" } }, path.join(root, "bad-backup"), platform));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), changed);
});
test("disabled source never checks or downloads", async (t) => {
  const { runtime } = fixture(t, { readConfig: () => ({ ...config, enabled: false }), fetchManifest: () => assert.fail("must not fetch") });
  assert.equal((await runtime.check()).phase, "disabled");
});
for (const platform of ["darwin", "win32"]) test(`${platform} checks, verifies and invokes install only after cleanup`, async (t) => {
  const order = [];
  const { runtime, events, installs } = fixture(t, { platform, arch: platform === "darwin" ? "arm64" : "x64", verifyPublisher: async () => { order.push("signature"); }, prepareInstall: async () => { order.push("cleanup"); return true; } });
  assert.equal((await runtime.check()).phase, "ready");
  assert.ok(events.some((s) => s.phase === "verifying"));
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
  await again.runtime.check();
  assert.equal((await again.runtime.download()).phase, "ready");
});
test("bad checksum or publisher never reaches ready", async (t) => {
  for (const patch of [{ downloadFile: async (_a, file) => fs.promises.writeFile(file, "broken") }, { verifyPublisher: async () => { throw new Error("bad signature"); } }]) {
    const { runtime, events, installs } = fixture(t, patch);
    assert.equal((await runtime.check()).phase, "error");
    await runtime.install();
    assert.equal(installs.length, 0);
    assert.equal(events.some((s) => s.phase === "ready"), false);
  }
});
test("install rechecks cache and fails closed on running tasks or cleanup failure", async (t) => {
  for (const error of ["activeRuns", "cleanupFailed"]) {
    const { runtime, installs } = fixture(t, { prepareInstall: async () => { throw new Error(error); } });
    await runtime.check();
    assert.equal((await runtime.install()).error, error);
    assert.equal(installs.length, 0);
  }
  const { runtime, root, installs } = fixture(t);
  await runtime.check();
  fs.writeFileSync(path.join(root, `${hash}.zip`), "tampered");
  assert.equal((await runtime.install()).phase, "error");
  assert.equal(installs.length, 0);
});
test("unsupported architectures, older versions and development mode cannot install", async (t) => {
  for (const [options, phase] of [[{ arch: "ia32" }, "unavailable"], [{ currentVersion: "0.6.0" }, "current"], [{ packaged: false }, "ready"]]) {
    const { runtime, installs } = fixture(t, options);
    assert.equal((await runtime.check()).phase, phase);
    if (phase === "current") {
      assert.equal((await runtime.download()).phase, "current", "explicit download cannot enable a downgrade");
    }
    await runtime.install(); assert.equal(installs.length, 0);
  }
});
test("parallel checks are coalesced and changed config invalidates ready cache", async (t) => {
  let calls = 0, current = config;
  const { runtime, installs } = fixture(t, { readConfig: () => current, fetchManifest: async () => { calls++; return manifest(); } });
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
  assert.deepEqual(parseUpdateManifest(output, "cutej", "stable").artifacts["darwin-arm64"], artifact);
});

test("missing manifest is normal but missing artifacts and server errors still fail", async (t) => {
  const root = temp(t);
  fakeHttps(t, [{ status: 404 }, { status: 503 }, { status: 404 }, { body: Buffer.from("null") }]);
  assert.equal(await fetchUpdateManifest(config.feedUrl, new AbortController().signal), undefined);
  await assert.rejects(fetchUpdateManifest(config.feedUrl, new AbortController().signal), /503/);
  await assert.rejects(downloadUpdateFile(artifact, path.join(root, "app.zip"), new AbortController().signal, () => {}), /404/);
  const raw = await fetchUpdateManifest(config.feedUrl, new AbortController().signal);
  assert.throws(() => parseUpdateManifest(raw, "cutej", "stable"));
});
test("unconfigured manifest clears stale metadata without an error or download", async (t) => {
  let found = true;
  const { runtime, installs } = fixture(t, { fetchManifest: async () => found ? manifest() : undefined, downloadFile: () => assert.fail("must not download") });
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
