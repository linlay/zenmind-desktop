import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import ts from "typescript";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const runtimePath = path.resolve(import.meta.dirname, "../src/main/modules/browser-use/runtime.ts");
const runtimeModule = new Module(runtimePath);
runtimeModule.filename = runtimePath;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimePath));
// Follow the production dependency graph, including the shared AWCP protocol.
const runtimeBundle = require("esbuild").buildSync({
  entryPoints: [runtimePath], bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
});
runtimeModule._compile(runtimeBundle.outputFiles[0].text, runtimePath);
const { BrowserUseRuntime } = runtimeModule.exports;
const source = fs.readFileSync(new URL("../src/main/modules/browser-use/settings-store.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const TOKEN = "synthetic-browser-authorization_0123456789ABCDEF";
const TOKEN_TWO = "replacement-browser-authorization_0123456789ABCDEF";
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-settings-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "brand-desktop");
  fs.mkdirSync(dataRoot);
  const configRoot = path.join(dataRoot, "config", "desktop");
  const secretsRoot = path.join(dataRoot, "secrets");
  const settingsFile = path.join(configRoot, "browser-use.json");
  const credentialRoot = path.join(secretsRoot, "browser-use");
  const state = { available: true, failEncrypt: false, failDecrypt: false, failSettingsWrite: false, probeCalls: 0, encryptCalls: 0, decryptCalls: 0, acl: [] };
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable() { throw new Error("Synchronous Keychain probing is forbidden"); },
    encryptString() { throw new Error("Synchronous Keychain encryption is forbidden"); },
    decryptString() { throw new Error("Synchronous Keychain decryption is forbidden"); },
    async isAsyncEncryptionAvailable() { state.probeCalls++; await state.probeGate?.promise; return state.available; },
    async encryptStringAsync(value) {
      state.encryptCalls++;
      await state.encryptGate?.promise;
      if (state.failEncrypt) throw new Error(`keychain failed with secret ${TOKEN} at ${root}`);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const body = Buffer.concat([(await cipher.update(value, "utf8")), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(value) {
      state.decryptCalls++;
      await state.decryptGate?.promise;
      if (state.failDecrypt) throw new Error(`keychain rejected ${TOKEN} at ${root}`);
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([(await decipher.update(value.subarray(28))), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
    },
  };
  const mockFs = Object.create(fs);
  mockFs.renameSync = (from, to) => {
    if (state.failSettingsWrite && to === settingsFile) throw new Error(`write failed ${TOKEN} ${root}`);
    return fs.renameSync(from, to);
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, process, require: name => {
    if (name === "electron") return { safeStorage };
    if (name === "node:fs") return mockFs;
    if (name === "node:child_process") return { execFileSync: (...args) => state.acl.push(args) };
    if (name === "../../infrastructure/filesystem/user-paths") return {
      getDesktopConfigRoot: () => configRoot, getSecretsRoot: () => secretsRoot,
    };
    return require(name);
  } });
  const reopen = () => module.exports.createBrowserUseSettingsStore({}, platform);
  return { store: reopen(), reopen, root, dataRoot, configRoot, secretsRoot, settingsFile, credentialRoot, state,
    files: () => fs.existsSync(credentialRoot) ? fs.readdirSync(credentialRoot).sort() : [],
    saved() { return JSON.parse(fs.readFileSync(settingsFile, "utf8")); } };
}

async function rejectsSafely(operation, expected, fixture) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, expected);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes(fixture.root), false);
    assert.equal("cause" in error, false);
    return true;
  });
}

test("new settings use conservative defaults and reading creates no config or secret files", async t => {
  const f = fixture(t);
  assert.deepEqual(plain((await f.store.read())), { defaultBackend: "workpanel", rememberChromeConnection: false,
    hasSavedAuthorization: false, secureStorageAvailable: true });
  assert.equal((await f.store.authorization()), undefined);
  assert.equal(fs.existsSync(f.configRoot), false);
  assert.equal(fs.existsSync(f.secretsRoot), false);
});

test("new Chat state, Run preparation and status broadcasts never initialize OS cryptography", async t => {
  for (const platform of ["darwin", "win32"]) {
    const f = fixture(t, platform), changes = [];
    await f.store.update({ defaultBackend: "chrome" });
    const runtime = new BrowserUseRuntime({
      preferences: { read: f.store.readSnapshot, authorization: f.store.authorization },
      onSettingsChanged: value => changes.push(value),
      createClient: () => { throw new Error("metadata must not start Chrome"); },
    });
    t.after(() => runtime.dispose());
    assert.equal(runtime.state("new-chat").backend, "chrome");
    runtime.prepareRun({ chatId: "new-chat", runId: "run-1", agentKey: "cutej" });
    runtime.registerRun({ chatId: "new-chat", runId: "run-1", agentKey: "cutej" });
    runtime.releaseRun("run-1");
    assert.ok(changes.length >= 2);
    assert.equal(runtime.settingsState().secureStorageAvailable, false, "an unprobed background snapshot is conservative");
    assert.equal(f.state.probeCalls, 0);
    assert.equal(f.state.encryptCalls, 0);
    assert.equal(f.state.decryptCalls, 0);

    assert.equal((await f.store.read()).secureStorageAvailable, true, "an explicit settings query probes actual availability");
    assert.equal(f.state.probeCalls, 1);
    runtime.prepareRun({ chatId: "second-chat", runId: "run-2", agentKey: "cutej" });
    assert.equal(changes.at(-1).secureStorageAvailable, true, "notifications reuse the last completed probe");
    assert.equal(f.state.probeCalls, 1);

    f.state.available = false;
    assert.equal(f.store.readSnapshot().secureStorageAvailable, true, "metadata reads do not secretly refresh OS state");
    assert.equal(f.state.probeCalls, 1);
    assert.equal((await f.store.read()).secureStorageAvailable, false);
    runtime.releaseRun("run-2");
    assert.equal(changes.at(-1).secureStorageAvailable, false);
    assert.equal(f.state.probeCalls, 2);
    assert.equal(f.state.encryptCalls + f.state.decryptCalls, 0);
  }
});

test("saved authorization remains encrypted and is freshly checked when actually used, while snapshots stay metadata-only", async t => {
  for (const platform of ["darwin", "win32"]) {
    const f = fixture(t, platform);
    await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
    const fresh = f.reopen();
    const before = f.state.probeCalls;
    assert.equal(fresh.readSnapshot().rememberChromeConnection, true);
    assert.equal(fresh.readSnapshot().hasSavedAuthorization, true);
    assert.equal(fresh.readSnapshot().secureStorageAvailable, false, "a new store has not probed the OS yet");
    assert.equal(f.state.probeCalls, before);
    assert.equal(f.state.decryptCalls, 0);
    assert.equal((await fresh.authorization()), TOKEN);
    assert.equal(f.state.probeCalls, before + 1);
    assert.equal(f.state.decryptCalls, 1);
    f.state.available = false;
    await rejectsSafely(() => fresh.authorization(), "secure_storage_unavailable", f);
    assert.equal(f.state.probeCalls, before + 2);
    assert.equal(f.state.decryptCalls, 1, "unavailable crypto cannot reach decryptString");
    assert.equal(fresh.readSnapshot().secureStorageAvailable, false);
  }
});

test("authorization survives reopening as OS ciphertext and never appears in public settings or metadata", async t => {
  const f = fixture(t);
  const result = (await f.store.update({ defaultBackend: "chrome", rememberChromeConnection: true,
    extensionToken: `PLAYWRIGHT_MCP_EXTENSION_TOKEN='${TOKEN}'` }));
  assert.deepEqual(plain(result), { defaultBackend: "chrome", rememberChromeConnection: true,
    hasSavedAuthorization: true, secureStorageAvailable: true });
  assert.equal(f.state.decryptCalls, 0);
  assert.equal((await f.reopen().authorization()), TOKEN);
  await f.store.read();
  assert.equal(f.state.decryptCalls, 1, "public reads never decrypt the authorization");
  const metadata = fs.readFileSync(f.settingsFile, "utf8");
  const bytes = f.files().map(file => fs.readFileSync(path.join(f.credentialRoot, file)));
  for (const value of [metadata, JSON.stringify(result), ...bytes.map(value => value.toString("utf8"))]) {
    assert.equal(value.includes(TOKEN), false);
    assert.equal(value.includes("PLAYWRIGHT_MCP_EXTENSION_TOKEN"), false);
  }
  assert.equal(f.files().length, 1);
  assert.equal(fs.statSync(f.settingsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.credentialRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.credentialRoot, f.files()[0])).mode & 0o777, 0o600);
});

test("token normalization accepts only bounded URL-safe values and known quoted assignment syntax", async t => {
  const f = fixture(t);
  for (const input of [TOKEN, `'${TOKEN}'`, `"${TOKEN}"`, `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`,
    `"PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}"`, `PLAYWRIGHT_MCP_EXTENSION_TOKEN="${TOKEN}"`, "a".repeat(16), "a".repeat(256)]) {
    await f.store.update({ rememberChromeConnection: true, extensionToken: input });
    assert.match((await f.store.authorization()), /^[A-Za-z0-9_-]{16,256}$/u);
    assert.equal(f.files().length, 1, "replacing authorization removes obsolete ciphertext");
  }
  const before = fs.readFileSync(f.settingsFile);
  for (const input of ["", "a".repeat(15), "a".repeat(257), "a".repeat(1025), `${TOKEN}\n`, `${TOKEN}\r`, `${TOKEN} x`,
    `https://example.test/${TOKEN}`, `export PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, `$(echo ${TOKEN})`, `\"${TOKEN}'`, 42, null]) {
    await rejectsSafely(() => f.store.update({ rememberChromeConnection: true, extensionToken: input }), "invalid_browser_authorization", f);
    assert.deepEqual(fs.readFileSync(f.settingsFile), before);
  }
});

test("enabling remembered authorization requires a token, omitted tokens reuse the saved authorization", async t => {
  const f = fixture(t);
  await rejectsSafely(() => f.store.update({ rememberChromeConnection: true }), "invalid_browser_authorization", f);
  assert.equal(fs.existsSync(f.settingsFile), false);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  const id = f.saved().authorizationId;
  await f.store.update({ defaultBackend: "chrome" });
  assert.equal(f.saved().authorizationId, id);
  assert.equal((await f.store.authorization()), TOKEN);
  assert.equal(f.files().length, 1);
});

test("disabling or forgetting removes ciphertext while preserving the default backend", async t => {
  const f = fixture(t);
  await f.store.update({ defaultBackend: "chrome", rememberChromeConnection: true, extensionToken: TOKEN });
  await f.store.update({ rememberChromeConnection: false });
  assert.equal((await f.store.authorization()), undefined);
  assert.deepEqual(f.files(), []);
  assert.equal("authorizationId" in f.saved(), false);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  f.state.available = false;
  const probesBeforeForget = f.state.probeCalls;
  const result = (await f.store.forget());
  assert.equal(f.state.probeCalls, probesBeforeForget, "the Store recovery itself never initializes system storage");
  assert.equal(result.defaultBackend, "chrome");
  assert.equal(result.rememberChromeConnection, false);
  assert.equal(result.hasSavedAuthorization, false);
  assert.equal((await f.store.authorization()), undefined);
  assert.deepEqual(f.files(), []);
});

test("unavailable Keychain/DPAPI blocks persistence without weakening protection or replacing prior settings", async t => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const f = fixture(t, platform);
    await f.store.update({ defaultBackend: "chrome" });
    const before = fs.readFileSync(f.settingsFile);
    f.state.available = false;
    assert.equal((await f.store.read()).secureStorageAvailable, false);
    await rejectsSafely(() => f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN }), "secure_storage_unavailable", f);
    assert.deepEqual(fs.readFileSync(f.settingsFile), before);
    assert.equal(fs.existsSync(f.credentialRoot), false);
    if (platform === "linux") {
      f.state.available = true;
      assert.equal((await f.store.read()).secureStorageAvailable, false, "basic_text is never used on unsupported platforms");
    }
  }
});

test("Windows uses explicit owner ACLs for config and secret directories", async t => {
  const f = fixture(t, "win32");
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  assert.equal((await f.store.authorization()), TOKEN);
  for (const directory of [f.configRoot, f.secretsRoot, f.credentialRoot]) {
    const call = f.state.acl.find(entry => entry[1][0] === directory);
    assert.equal(call[0], "icacls");
    assert.deepEqual(plain(call[1].slice(1, 3)), ["/inheritance:r", "/grant:r"]);
    assert.match(call[1][3], /:\(OI\)\(CI\)F$/u);
    assert.equal(call[2].stdio, "ignore");
  }
});

test("failed encryption or metadata publication preserves the prior settings and usable authorization", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  const metadata = fs.readFileSync(f.settingsFile);
  const files = f.files();
  const original = fs.readFileSync(path.join(f.credentialRoot, files[0]));
  f.state.failEncrypt = true;
  await rejectsSafely(() => f.store.update({ defaultBackend: "chrome", extensionToken: TOKEN_TWO }), "browser_authorization_unavailable", f);
  f.state.failEncrypt = false;
  f.state.failSettingsWrite = true;
  await rejectsSafely(() => f.store.update({ defaultBackend: "chrome", extensionToken: TOKEN_TWO }), "browser_settings_unavailable", f);
  f.state.failSettingsWrite = false;
  assert.deepEqual(fs.readFileSync(f.settingsFile), metadata);
  assert.deepEqual(f.files(), files);
  assert.deepEqual(fs.readFileSync(path.join(f.credentialRoot, files[0])), original);
  assert.equal((await f.store.authorization()), TOKEN);
  assert.equal(fs.readdirSync(f.configRoot).some(file => file.endsWith(".tmp")), false);
});

test("keychain rejection and damaged authorization use fixed errors and explicit forget can recover", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  const original = fs.readFileSync(f.settingsFile);
  f.state.failDecrypt = true;
  await rejectsSafely(() => f.store.authorization(), "browser_authorization_unavailable", f);
  await f.store.update({ defaultBackend: "chrome" });
  assert.equal(f.saved().defaultBackend, "chrome", "a preference change does not need to decrypt an unchanged credential");
  assert.equal(f.saved().authorizationId, JSON.parse(original).authorizationId);
  f.state.failDecrypt = false;
  fs.writeFileSync(path.join(f.credentialRoot, f.files()[0]), "{broken}");
  await rejectsSafely(() => f.store.read(), "browser_authorization_unavailable", f);
  await rejectsSafely(() => f.store.authorization(), "browser_authorization_unavailable", f);
  assert.equal((await f.store.forget()).hasSavedAuthorization, false);
  assert.deepEqual(f.files(), []);
});

test("stored settings shape and input shape are validated without silently overwriting a corrupt file", async t => {
  const f = fixture(t);
  for (const input of [null, [], { defaultBackend: "unknown" }, { rememberChromeConnection: "yes" }, { data: TOKEN }]) {
    await rejectsSafely(() => f.store.update(input), "invalid_browser_settings", f);
  }
  await f.store.update({ defaultBackend: "chrome" });
  for (const stored of ["{broken", JSON.stringify({ version: 2, defaultBackend: "chrome", rememberChromeConnection: false }),
    JSON.stringify({ version: 1, defaultBackend: "chrome", rememberChromeConnection: true, authorizationId: "../../outside" }),
    JSON.stringify({ version: 1, defaultBackend: "chrome", rememberChromeConnection: false, token: TOKEN }), "x".repeat(4097)]) {
    fs.writeFileSync(f.settingsFile, stored);
    await rejectsSafely(() => f.store.read(), "browser_settings_unavailable", f);
    await rejectsSafely(() => f.store.update({ defaultBackend: "workpanel" }), "browser_settings_unavailable", f);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), stored);
  }
  assert.equal((await f.store.forget()).rememberChromeConnection, false);
});

test("symlinked metadata, credential files and managed parents cannot escape the current brand data root", async t => {
  const f = fixture(t);
  const external = path.join(f.root, "outside");
  fs.mkdirSync(external);
  const target = path.join(external, "original.json");
  fs.writeFileSync(target, "untouched");
  fs.mkdirSync(f.configRoot, { recursive: true });
  fs.symlinkSync(target, f.settingsFile);
  await rejectsSafely(() => f.store.update({ defaultBackend: "chrome" }), "browser_settings_unavailable", f);
  await rejectsSafely(() => f.store.forget(), "browser_settings_unavailable", f);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  fs.unlinkSync(f.settingsFile);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  const sealed = path.join(f.credentialRoot, f.files()[0]);
  fs.unlinkSync(sealed);
  fs.symlinkSync(target, sealed);
  await rejectsSafely(() => f.store.authorization(), "browser_authorization_unavailable", f);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  fs.unlinkSync(sealed);
  fs.rmdirSync(f.credentialRoot);
  fs.symlinkSync(external, f.credentialRoot, "dir");
  await rejectsSafely(() => f.store.update({ extensionToken: TOKEN_TWO }), "browser_settings_unavailable", f);
  assert.deepEqual(fs.readdirSync(external), ["original.json"]);
});

test("delayed async Keychain work leaves timers and metadata reads responsive without using sync crypto", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  f.state.decryptGate = deferred();
  const pending = f.store.authorization();
  await flush();
  assert.equal(f.state.decryptCalls, 1);
  const probes = f.state.probeCalls;
  let ticks = 0;
  await new Promise(resolve => setTimeout(() => { ticks++; resolve(); }, 5));
  assert.equal(ticks, 1);
  assert.equal(f.store.readSnapshot().hasSavedAuthorization, true);
  assert.equal(f.state.probeCalls, probes);
  assert.equal(f.state.decryptCalls, 1);
  f.state.decryptGate.resolve();
  assert.equal(await pending, TOKEN);
});

test("changing only the default browser does not revoke or repeat a pending decrypt of the same authorization", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  const id = f.saved().authorizationId;
  f.state.decryptGate = deferred();
  const pending = f.store.authorization();
  await flush();
  const probes = f.state.probeCalls;
  await f.store.update({ defaultBackend: "chrome" });
  assert.equal(f.state.probeCalls, probes);
  assert.equal(f.state.decryptCalls, 1);
  assert.equal(f.saved().authorizationId, id);
  f.state.decryptGate.resolve();
  assert.equal(await pending, TOKEN);
});

test("forget finishes while decrypt is pending and a late plaintext result cannot revive authorization", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  f.state.decryptGate = deferred();
  const rejected = rejectsSafely(() => f.store.authorization(), "browser_authorization_unavailable", f);
  await flush();
  const probes = f.state.probeCalls;
  assert.equal((await f.store.forget()).hasSavedAuthorization, false);
  assert.equal(f.state.probeCalls, probes);
  assert.deepEqual(f.files(), []);
  f.state.decryptGate.resolve();
  await rejected;
  assert.equal(await f.store.authorization(), undefined);
  assert.equal(f.store.readSnapshot().rememberChromeConnection, false);
});

test("forget supersedes a slow encryption and every older queued save without publishing late ciphertext", async t => {
  const f = fixture(t);
  await f.store.update({ rememberChromeConnection: true, extensionToken: TOKEN });
  f.state.encryptGate = deferred();
  const first = rejectsSafely(() => f.store.update({ extensionToken: TOKEN_TWO }), "browser_settings_unavailable", f);
  await flush();
  const second = rejectsSafely(() => f.store.update({ extensionToken: TOKEN_TWO }), "browser_settings_unavailable", f);
  await f.store.forget();
  f.state.encryptGate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.store.readSnapshot().hasSavedAuthorization, false);
  assert.deepEqual(f.files(), []);
});

test("concurrent saves serialize while preserving the newest default and the encrypted credential", async t => {
  const f = fixture(t);
  f.state.encryptGate = deferred();
  const first = f.store.update({ defaultBackend: "chrome", rememberChromeConnection: true, extensionToken: TOKEN });
  await flush();
  const second = f.store.update({ defaultBackend: "workpanel" });
  f.state.encryptGate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.store.readSnapshot().defaultBackend, "workpanel");
  assert.equal(f.store.readSnapshot().hasSavedAuthorization, true);
  assert.equal(await f.store.authorization(), TOKEN);
  assert.equal(f.files().length, 1);
});
