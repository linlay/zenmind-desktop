import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { createUpdateRuntime } = require("../dist-electron/main/modules/updates/runtime.js");
const { fetchUpdateManifest } = require("../dist-electron/main/modules/updates/download.js");
const pair = generateKeyPairSync("ed25519");
const trust = { keys: [{ productId: "cutej", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }] };
const bytes = Buffer.from("unsigned executable fixture");
const now = Date.parse("2026-09-21T08:00:00Z");
const manifest = (patch = {}) => ({ schemaVersion: 2, productId: "cutej", version: "0.5.0", publishedAt: new Date(now).toISOString(), releaseNotes: {}, artifacts: { "win32-x64": { url: "https://example.com/app.exe", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }, ...patch });
const signed = (value = manifest()) => { const payload = JSON.stringify(value); return { manifest: payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString("base64") }; };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installs = [];
  const options = { currentVersion: "0.4.11", productId: "cutej", platform: "win32", arch: "x64", packaged: true, cacheRoot: root, preferencesPath: path.join(root, "preferences.json"), trust, now: () => now,
    readConfig: () => ({ enabled: true, feedUrl: "https://example.com/latest.json" }), emit() {}, fetchManifest: async () => signed(), downloadFile: async (_a, file) => fs.promises.writeFile(file, bytes), verifyPublisher: async () => {}, prepareInstall: async () => true, install: async (...args) => installs.push(args), ...overrides };
  const runtime = createUpdateRuntime(options);
  t.after(() => runtime.dispose());
  return { runtime, installs, options };
}
test("unsigned update metadata cannot enter the installable update path", async t => {
  const { runtime, installs } = fixture(t, { fetchManifest: async () => ({ ...manifest(), schemaVersion: 1 }) });
  assert.equal((await runtime.check()).phase, "error");
  await runtime.download(); await runtime.install();
  assert.equal(installs.length, 0);
});
test("a genuinely signed release can install a Windows executable without Authenticode", async t => {


  const { runtime, installs } = fixture(t);
  assert.equal((await runtime.check()).phase, "available");
  assert.equal((await runtime.download()).phase, "ready");
  await runtime.install();
  assert.equal(installs.length, 1);
});
test("a signed Windows release without a publication sequence is available", async t => {
  const { runtime } = fixture(t, { fetchManifest: async () => signed(manifest()) });
  assert.equal((await runtime.check()).phase, "available");
});

test("a ready package does not hide a newer signed release", async t => {
  let release = manifest();
  const { runtime } = fixture(t, { fetchManifest: async () => signed(release) });
  await runtime.check();
  await runtime.download();
  release = manifest({ version: "0.6.0" });
  const next = await runtime.check();
  assert.equal(next.version, "0.6.0");
  assert.equal(next.phase, "ready"); // The new release references the same verified installer bytes.
});
test("obsolete expiry metadata is rejected by the Windows protocol", async t => {
  const { runtime } = fixture(t, { fetchManifest: async () => signed(manifest({ expiresAt: new Date(now + 86400000).toISOString() })) });
  assert.equal((await runtime.check()).phase, "error");
});
test("obsolete publication sequence metadata is rejected by the Windows protocol", async t => {
  const { runtime } = fixture(t, { fetchManifest: async () => signed(manifest({ releaseSequence: 1 })) });
  assert.equal((await runtime.check()).phase, "error");
});
test("a signed release remains installable after a long idle period", async t => {
  let clock = now;
  const { runtime, installs } = fixture(t, { now: () => clock });
  await runtime.check(); await runtime.download();
  clock += 90 * 86400000;
  await runtime.install();
  assert.equal(installs.length, 1);
});

test("elapsed time during cleanup does not invalidate a signed release", async t => {
  let clock = now;
  const { runtime, installs } = fixture(t, { now: () => clock,
    prepareInstall: async () => { clock += 90 * 86400000; return true; } });
  await runtime.check(); await runtime.download();
  await runtime.install();
  assert.equal(installs.length, 1);
});

test("package tampering during cleanup invalidates readiness and requires restart", async t => {
  let cachedFile;
  const { runtime, installs } = fixture(t, {
    downloadFile: async (_a, file) => { cachedFile = file; await fs.promises.writeFile(file, bytes); },
    prepareInstall: async () => { fs.writeFileSync(cachedFile, "tampered"); return true; } });
  await runtime.check(); await runtime.download();
  const failed = await runtime.install();
  assert.equal(failed.error, "verificationFailed");
  assert.equal(failed.packageReady, false);
  assert.equal(failed.restartRequired, true);
  assert.equal(installs.length, 0);
});
test("manual reinstall can repeat an upgrade after the target version is re-signed", async t => {
  const firstRelease = manifest({ version: "0.4.14" });
  const { runtime, options } = fixture(t, { currentVersion: "0.4.13", fetchManifest: async () => signed(firstRelease) });
  assert.equal((await runtime.check()).phase, "available");
  runtime.dispose();
  const securityRoot = path.join(path.dirname(options.preferencesPath), "update-security");
  fs.mkdirSync(securityRoot);
  fs.writeFileSync(path.join(securityRoot, "old-state.json"), "obsolete sequence state");
  const reissued = { ...firstRelease, releaseNotes: { "zh-CN": ["test reissue"] } };
  const reinstalled = createUpdateRuntime({ ...options, fetchManifest: async () => signed(reissued) });
  assert.equal((await reinstalled.check()).phase, "available");
  reinstalled.dispose();
});
test("Debug rejects naked metadata but accepts the same signed release as the official path", async t => {
  const { runtime } = fixture(t);
  await assert.rejects(runtime.loadTest({ manifest: manifest() }), /signatureInvalid/);
  assert.equal((await runtime.loadTest(signed())).phase, "available");
  assert.equal((await runtime.download()).phase, "ready");
});
test("network retrieval preserves signed bytes and resolves signature next to the final manifest URL", async t => {
  const envelope = signed();
  const requested = [];
  const replies = [{ status: 302, headers: { location: "/releases/1/latest.json?source=prod" } }, { body: envelope.manifest }, { body: envelope.signature }];
  const original = https.get;
  t.after(() => { https.get = original; });
  https.get = (url, _options, cb) => {
    requested.push(url);
    const request = new EventEmitter(); request.setTimeout = () => {};
    process.nextTick(() => { const reply = replies.shift(); const res = Readable.from([reply.body ?? ""]); res.statusCode = reply.status ?? 200; res.headers = reply.headers ?? {}; cb(res); });
    return request;
  };
  assert.deepEqual(await fetchUpdateManifest("https://example.com/latest.json", new AbortController().signal), envelope);
  assert.equal(requested[2], "https://example.com/releases/1/latest.json.sig?source=prod");
});
test("tampering, substituted keys, wrong scope and future publication cannot enable installation", async t => {
  const original = signed();
  const otherPair = generateKeyPairSync("ed25519");
  for (const envelope of [
    { ...original, manifest: original.manifest + "\n" },
    { ...original, manifest: original.manifest.replace("0.5.0", "0.6.0") },
    { ...original, signature: sign(null, Buffer.from(original.manifest), otherPair.privateKey).toString("base64") },

    signed(manifest({ productId: "other" })),
    signed(manifest({ publishedAt: new Date(now + 600000).toISOString() })),
    { ...original, signature: "not-base64" },
  ]) {
    const { runtime, installs } = fixture(t, { fetchManifest: async () => envelope });
    assert.equal((await runtime.check()).phase, "error");
    await runtime.download(); await runtime.install();
    assert.equal(installs.length, 0);
  }
});
test("failed checks cannot leave a previously valid update available for download", async t => {
  let response = signed();
  const { runtime, installs } = fixture(t, { fetchManifest: async () => response });
  await runtime.check();
  response = { ...response, signature: "" };
  assert.equal((await runtime.check()).error, "signatureInvalid");
  await runtime.download(); await runtime.install();
  assert.equal(installs.length, 0);
});
test("a signed manifest for the installed version does not reinstall", async t => {
  const { runtime, installs } = fixture(t, { currentVersion: "0.5.0", fetchManifest: async () => signed(manifest()) });
  assert.equal((await runtime.check()).phase, "current");
  await runtime.download(); await runtime.install(); assert.equal(installs.length, 0);
});
test("a new signing key works only when explicitly included in client trust", async t => {
  const next = generateKeyPairSync("ed25519");
  const value = manifest();
  const payload = JSON.stringify(value);
  const envelope = { manifest: payload, signature: sign(null, Buffer.from(payload), next.privateKey).toString("base64") };
  const old = fixture(t, { fetchManifest: async () => envelope });
  assert.equal((await old.runtime.check()).error, "signatureInvalid");
  const upgraded = fixture(t, { trust: { ...trust, keys: [...trust.keys, { ...trust.keys[0], publicKey: next.publicKey.export({ type: "spki", format: "pem" }) }] }, fetchManifest: async () => envelope });
  assert.equal((await upgraded.runtime.check()).phase, "available");
});
