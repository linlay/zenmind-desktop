import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ShareHttpClient } = require("../dist-electron/main/modules/shares/http-client.js");
const { ShareHttpError } = require("../dist-electron/main/modules/shares/http-transport.js");
const { registerSharesIpc } = require("../dist-electron/main/modules/shares/ipc.js");
const origin = "https://hub.example.test";
const target = { origin, accessToken: "synthetic-management-token" };
const record = { id: "abc", kind: "market-item", title: "Frozen item", url: origin + "/share/abc", createdAt: "2026-10-28T00:00:00.000Z", lastAccessedAt: null };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const prepared = { manifest: Buffer.from('{"already":"frozen"}'), resources: [{ id: "a".repeat(24), name: "a.txt", mimeType: "text/plain", bytes: Buffer.from("frozen") }] };

test("management requests reject missing or non-string credentials before HTTP", async () => {
  const client = new ShareHttpClient(async () => assert.fail("invalid credentials reached HTTP"));
  for (const accessToken of [undefined, null, 123, {}, "", "one two"]) {
    await assert.rejects(client.list({ origin, accessToken }), error => error.kind === "invalid_request");
  }
});

test("generic publishing uses v2 multipart once and accepts non-conversation metadata", async () => {
  let count = 0;
  const client = new ShareHttpClient(async (url, init) => {
    count++; assert.equal(url, origin + "/api/desktop/v2/shares");
    assert.equal(init.headers.Authorization, "Bearer " + target.accessToken);
    assert.deepEqual(Object.keys(init.headers), ["Authorization"]);
    assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
    assert.equal(await init.body.get("manifest").text(), prepared.manifest.toString());
    assert.equal(await init.body.get("resource:" + "a".repeat(24)).text(), "frozen");
    return json(record, 201);
  });
  const result = await client.create(target, prepared);
  assert.equal(result.id, "abc"); assert.equal(result.kind, "market-item");
  assert.equal(result.createdAt, Date.parse(record.createdAt));
  assert.equal(Object.hasOwn(result, "expiresAt"), false); assert.equal(Object.hasOwn(result, "singleUse"), false);
  assert.equal(count, 1);
});

test("lost creation response does not retry; invalid metadata and duplicate IDs fail closed", async () => {
  let count = 0;
  const unavailable = new ShareHttpClient(async () => { count++; throw new Error("lost"); });
  await assert.rejects(unavailable.create(target, prepared), error => error.kind === "unavailable");
  assert.equal(count, 1);
  for (const changed of [
    { ...record, expiresAt: null }, { ...record, singleUse: false },
    { ...record, url: "https://attacker.test/other" }, { ...record, createdAt: "2026-02-30T00:00:00Z" },
    { ...record, source: { module: "chat", id: "../path" } },
    { ...record, lastAccessedAt: "2025-01-01T00:00:00Z" },
  ]) await assert.rejects(new ShareHttpClient(async () => json(changed, 201)).create(target, prepared), ShareHttpError);
  await assert.rejects(new ShareHttpClient(async () => json({ items: [record, record] })).list(target), ShareHttpError);
});

test("public resolution omits credentials, strictly validates handoff, and never follows redirects", async () => {
  const resolution = { protocolVersion: 1, id: "abc", kind: "custom", title: "Frozen", actions: ["desktop"], desktop: { receiverId: "custom.receiver", contextVersion: 7, context: { version: "frozen" } } };
  let response = json(resolution);
  const client = new ShareHttpClient(async (url, init) => {
    assert.equal(url, origin + "/share/abc?action=resolve");
    assert.equal(init.headers, undefined); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "manual");
    return response;
  });
  assert.deepEqual(await client.resolve(origin, "abc"), resolution);
  for (const changed of [{ ...resolution, protocolVersion: 2 }, { ...resolution, id: "other" }, { ...resolution, actions: ["install"] }, { ...resolution, actions: [] }, { ...resolution, desktop: { ...resolution.desktop, contextVersion: 0 } }]) {
    response = json(changed); await assert.rejects(client.resolve(origin, "abc"), ShareHttpError);
  }
  response = new Response(null, { status: 302, headers: { Location: "https://attacker.test" } });
  await assert.rejects(client.resolve(origin, "abc"), error => error.status === 302);
});

function facadeFixture(fetchImpl) {
  let status = { authenticated: true, pending: false, user: { issuer: "test", sub: "one" } };
  let ready = true;
  let refreshCount = 0;
  let identityReads = 0;
  const listeners = new Set();
  const identity = {
    getDesktopSsoStatus: () => { identityReads++; return status; },
    isDesktopSsoCredentialRuntimeReady: () => { identityReads++; return ready; },
    subscribeDesktopSsoCredentialRevocation: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const file = new URL("../dist-electron/main/modules/shares/facade.js", import.meta.url);
  const localRequire = createRequire(file);
  const module = { exports: {} };
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(name => {
    if (name === "../identity") return identity;
    if (name === "./target") return { resolveShareOrigin: () => ({ ok: true, origin }) };
    if (name.endsWith("main-i18n")) return { t: key => key };
    return localRequire(name);
  }, module, module.exports);
  const facade = module.exports.createShareFacade({ app: {}, fetchImpl, refreshToken: async () => { refreshCount++; return target.accessToken; } });
  return { facade, listeners, identityReads: () => identityReads, refreshCount: () => refreshCount, switchAccount: () => { status = { ...status, user: { issuer: "test", sub: "two" } }; }, revoke: () => { ready = false; for (const listener of listeners) listener(); } };
}

test("public facade refreshes only a proven 401, never replays a lost create, and clears listeners", async () => {
  let calls = 0;
  const fixture = facadeFixture(async () => ++calls === 1 ? json({}, 401) : json({ items: [record] }));
  assert.equal((await fixture.facade.list()).ok, true);
  assert.equal(calls, 2); assert.equal(fixture.refreshCount(), 2); assert.equal(fixture.listeners.size, 0);
  let creates = 0;
  const lost = facadeFixture(async url => {
    if (url.endsWith("/limits")) return json({ maxManifestBytes: 4096, maxResourceBytes: 1024 });
    creates++; throw new Error("lost response");
  });
  assert.equal((await lost.facade.publish(async () => prepared)).ok, false);
  assert.equal(creates, 1); assert.equal(lost.listeners.size, 0);
});

test("account switch during preparation prevents upload; late responses and revocation cannot cross accounts", async () => {
  let uploads = 0;
  const fixture = facadeFixture(async url => { if (url.endsWith("/limits")) return json({ maxManifestBytes: 4096, maxResourceBytes: 1024 }); uploads++; return json(record, 201); });
  const result = await fixture.facade.publish(async () => { fixture.switchAccount(); return prepared; });
  assert.equal(result.ok, false); assert.equal(uploads, 0);
  for (const change of ["switchAccount", "revoke"]) {
    let finish;
    const late = facadeFixture(() => new Promise(resolve => { finish = resolve; }));
    const operation = late.facade.list();
    await new Promise(resolve => setImmediate(resolve));
    late[change](); finish(json({ items: [record] }));
    assert.equal((await operation).ok, false); assert.equal(late.listeners.size, 0);
  }
});

test("share management IPC rejects guests, subframes and a replaced main frame", async () => {
  const handlers = new Map(); const frame = {}; const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  let calls = 0; let finish;
  registerSharesIpc({ handle: (name, callback) => handlers.set(name, callback) }, {
    list: async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, revoke: async () => { calls++; },
  }, () => window);
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) await assert.rejects(handlers.get("shares.list")(event), /rejected/);
  assert.equal(calls, 0);
  const operation = handlers.get("shares.list")({ sender: contents, senderFrame: frame });
  contents.mainFrame = {}; finish({ ok: true, records: [] });
  await assert.rejects(operation, /changed/);
});

test("receiver setup has no network or Identity work, and public handoff never requests credentials", async () => {
  let calls = 0;
  const resolution = { protocolVersion: 1, id: "abc", kind: "custom", title: "Frozen", actions: ["desktop"], desktop: { receiverId: "test.receiver", contextVersion: 7, context: { frozen: true } } };
  const fixture = facadeFixture(async (_url, init) => { calls++; assert.equal(init.headers, undefined); return json(resolution); });
  const unregister = fixture.facade.registerReceiver({ receiverId: "test.receiver", owner: { type: "builtin", id: "test" }, contextVersions: [7], activate: async () => ({ generation: "page-1", isCurrent: () => true, receive: async () => ({ status: "received" }) }) });
  assert.equal(calls, 0); assert.equal(fixture.identityReads(), 0);
  assert.equal((await fixture.facade.receive("abc")).status, "received");
  assert.equal(calls, 2); assert.equal(fixture.refreshCount(), 0); assert.equal(fixture.identityReads(), 0); assert.equal(fixture.listeners.size, 0);
  unregister(); fixture.facade.dispose();
});

test("a previous Hub without v2 fails explicitly before preparation or upload", async () => {
  for (const status of [404, 405, 501]) {
    let requests = 0;
    const fixture = facadeFixture(async () => { requests++; return json({}, status); });
    const result = await fixture.facade.publish(async () => assert.fail("unsupported server reached source preparation"));
    assert.equal(result.ok, false); assert.equal(result.message, "share.serverUpgradeRequired");
    assert.equal((await fixture.facade.list()).message, "share.serverUpgradeRequired");
    assert.equal(requests, 2); assert.equal(fixture.listeners.size, 0);
  }
});
