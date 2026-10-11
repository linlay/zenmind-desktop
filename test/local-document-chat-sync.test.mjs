import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLocalDocumentChatSync } = require("../dist-electron/main/app/local-document-chat-sync.js");

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

function fixture() {
  const ack = deferred();
  const main = { id: 7, mainFrame: {}, isDestroyed: () => false };
  const input = {
    sourceId: "frame:query-first-message", surfaceId: "main-chat", registrationId: "main-generation-1",
    guestWebContentsId: 41, agentKey: "cutej", newChat: "1783680000000", chatId: "chat-from-platform",
  };
  const target = {
    registrationId: input.registrationId, surfaceId: "main-chat", surfaceRole: "main-chat", surfaceLevel: "root",
    surfaceKind: "service", surfaceType: "agent-chat", serviceId: "agent-webclient", active: true,
    ownerWebContentsId: main.id, webContentsId: input.guestWebContentsId,
    pageRoute: `/agent/cutej?newChat=${input.newChat}`,
    pageRouteIdentity: `/agent/cutej?newChat=${input.newChat}`,
    currentUrl: `http://127.0.0.1:17080/agent/cutej?newChat=${input.newChat}`,
  };
  const state = { main, target, input, ack, requests: [], begins: [], cancellations: [], promotions: [], delays: [],
    beginResult: true, promoteResult: true,
    hostRoute: `/agent/cutej?newChat=${input.newChat}` };
  main.getURL = () => `http://127.0.0.1:5173/#${state.hostRoute}`;
  state.sync = createLocalDocumentChatSync({
    getMainContents: () => state.main,
    resolveSurface: id => id === input.guestWebContentsId ? state.target : null,
    request: (id, value) => { state.requests.push({ id, input: value }); return ack.promise; },
    begin: value => { state.begins.push(value); return state.beginResult; },
    cancel: value => { state.cancellations.push(value); return true; },
    promote: value => { state.promotions.push(value); return state.promoteResult; },
    delay: async ms => { state.delays.push(ms); await state.advance?.(); },
  });
  state.commitRegistry = () => {
    state.target.ownerChatId = input.chatId;
    state.target.pageRoute = state.target.pageRouteIdentity = `/agent/cutej?chatId=${input.chatId}`;
  };
  state.commitHost = () => { state.hostRoute = `/agent/cutej?chatId=${input.chatId}`; };
  state.canonical = () => { state.commitRegistry(); state.commitHost(); };
  return state;
}

test("server canonical ACK promotes file ownership while its original guest still has the draft URL", async () => {
  const state = fixture();
  const pending = state.sync(state.main.id, state.input);
  assert.deepEqual(state.requests, [{ id: 7, input: state.input }]);
  assert.deepEqual(state.promotions, []);
  state.canonical();
  state.ack.resolve({ requestId: "canonical-ack-1", ok: true });
  assert.deepEqual(await pending, { requestId: "canonical-ack-1", ok: true });
  assert.deepEqual(state.promotions, [{ ownerWebContentsId: 7, agentKey: "cutej", newChat: state.input.newChat, chatId: state.input.chatId }]);
  assert.deepEqual(state.begins, state.promotions);
  assert.deepEqual(state.cancellations, []);
  assert.ok(state.target.currentUrl.includes(`newChat=${state.input.newChat}`), "file promotion must not wait for the guest to consume chat.start");
});

test("canonical file ownership promotion also accepts a guest that has consumed the same server chat.start", async () => {
  const state = fixture();
  const pending = state.sync(state.main.id, state.input);
  state.canonical();
  state.target.currentUrl = `http://127.0.0.1:17080/agent/cutej?chatId=${state.input.chatId}`;
  state.ack.resolve({ requestId: "canonical-ack-1", ok: true });
  assert.equal((await pending).ok, true);
  assert.equal(state.promotions.length, 1);
});

test("an existing canonical promotion guard can bridge a temporarily blank guest URL in the same generation", async () => {
  const state = fixture();
  const pending = state.sync(state.main.id, state.input);
  state.canonical();
  state.target.currentUrl = "";
  state.ack.resolve({ requestId: "canonical-ack-1", ok: true });
  assert.equal((await pending).ok, true);
  assert.equal(state.promotions.length, 1);
});

for (const first of ["host", "registry"]) {
  test(`an early guard ACK waits for the independent ${first}-first canonical commits before file promotion`, async () => {
    const state = fixture();
    state.advance = () => {
      assert.deepEqual(state.promotions, [], "installing the guard does not establish the canonical file owner");
      if (state.delays.length === 1) {
        if (first === "host") state.commitHost();
        else state.commitRegistry();
      } else if (state.delays.length === 2) {
        if (first === "host") state.commitRegistry();
        else state.commitHost();
      }
    };
    const pending = state.sync(state.main.id, state.input);
    state.ack.resolve({ requestId: "guard-only-ack", ok: true });
    assert.deepEqual(await pending, { requestId: "guard-only-ack", ok: true });
    assert.deepEqual(state.delays, [50, 50]);
    assert.equal(state.promotions.length, 1);
    assert.ok(state.target.currentUrl.includes(`newChat=${state.input.newChat}`), "canonical host commit must not wait for guest chat.start consumption");
  });
}

for (const [name, partialCommit] of [
  ["neither host nor Registry commits", () => {}],
  ["only the host commits", state => state.commitHost()],
  ["only the Registry commits", state => state.commitRegistry()],
]) {
  test(`an acknowledged file draft times out without promotion when ${name}`, async () => {
    const state = fixture();
    state.advance = () => partialCommit(state);
    const pending = state.sync(state.main.id, state.input);
    state.ack.resolve({ requestId: "guard-without-commit", ok: true });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, "surface_registration_failure");
    assert.equal(state.delays.length, 30);
    assert.equal(state.delays.reduce((total, ms) => total + ms, 0), 1500);
    assert.deepEqual(state.promotions, []);
    assert.equal(state.cancellations.length, 1);
  });
}

test("an unrelated host navigation during the post-ACK wait immediately rejects file promotion", async () => {
  const state = fixture();
  state.advance = () => { state.hostRoute = "/agent/cutej?newChat=1783680000001"; };
  const pending = state.sync(state.main.id, state.input);
  state.ack.resolve({ requestId: "guard-ack", ok: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_source");
  assert.deepEqual(state.delays, [50]);
  assert.deepEqual(state.promotions, []);
  assert.equal(state.cancellations.length, 1);
});

test("ordinary new Chat synchronization keeps its baseline when no local draft is owned", async () => {
  const state = fixture();
  state.beginResult = false;
  const pending = state.sync(state.main.id, state.input);
  state.advance = () => assert.fail("an ordinary new Chat must not wait on local file presentation commits");
  state.ack.resolve({ requestId: "normal-new-chat-guard", ok: true });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(state.delays, []);
  assert.deepEqual(state.promotions, []);
  assert.deepEqual(state.cancellations, []);
  assert.equal(state.target.ownerChatId, undefined);
});

for (const [name, change] of [
  ["missing Main renderer", state => { state.main = null; }],
  ["destroyed Main renderer", state => { state.main.isDestroyed = () => true; }],
  ["missing source guest", state => { state.target = null; }],
  ["inactive source", state => { state.target.active = false; }],
  ["another renderer owner", state => { state.target.ownerWebContentsId = 8; }],
  ["another source generation", state => { state.target.registrationId = "main-generation-2"; }],
  ["another source nonce", state => { state.target.currentUrl = "http://127.0.0.1:17080/agent/cutej?newChat=1783680000001"; }],
  ["another Agent", state => { state.target.currentUrl = `http://127.0.0.1:17080/agent/other?newChat=${state.input.newChat}`; }],
  ["non-Main role", state => { state.target.surfaceRole = "copilot"; }],
  ["another service", state => { state.target.serviceId = "other-service"; }],
]) {
  test(`file draft synchronization rejects ${name} before requesting a canonical ACK`, async () => {
    const state = fixture();
    change(state);
    const result = await state.sync(7, state.input);
    assert.equal(result.ok, false);
    assert.equal(result.code, "stale_source");
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.begins, []);
    assert.deepEqual(state.promotions, []);
    assert.deepEqual(state.cancellations, []);
  });
}

for (const [name, change] of [
  ["Main object replacement", state => { state.main = { ...state.main }; }],
  ["Main frame replacement", state => { state.main.mainFrame = {}; }],
  ["Main destruction", state => { state.main.isDestroyed = () => true; }],
  ["source closure", state => { state.target = null; }],
  ["source deactivation", state => { state.target.active = false; }],
  ["source generation replacement", state => { state.target.registrationId = "main-generation-2"; }],
  ["source guest replacement", state => { state.target.webContentsId = 42; }],
  ["renderer owner replacement", state => { state.target.ownerWebContentsId = 8; }],
  ["canonical owner replacement", state => { state.target.ownerChatId = "other-chat"; }],
  ["canonical route replacement", state => { state.target.pageRouteIdentity = "/agent/cutej?chatId=other-chat"; }],
  ["host route replacement", state => { state.hostRoute = "/agent/cutej?chatId=other-chat"; }],
  ["guest nonce replacement", state => { state.target.currentUrl = "http://127.0.0.1:17080/agent/cutej?newChat=1783680000001"; }],
  ["guest canonical route replacement", state => { state.target.currentUrl = "http://127.0.0.1:17080/agent/cutej?chatId=other-chat"; }],
  ["guest Agent replacement", state => { state.target.currentUrl = `http://127.0.0.1:17080/agent/other?newChat=${state.input.newChat}`; }],
  ["service replacement", state => { state.target.serviceId = "other-service"; }],
  ["surface role replacement", state => { state.target.surfaceRole = "copilot"; }],
  ["surface identity replacement", state => { state.target.surfaceId = "copilot-dock"; }],
  ["surface level replacement", state => { state.target.surfaceLevel = "child"; }],
]) {
  test(`file draft synchronization rejects ${name} during the canonical ACK wait`, async () => {
    const state = fixture();
    const pending = state.sync(state.main.id, state.input);
    state.canonical();
    change(state);
    state.ack.resolve({ requestId: "canonical-ack-1", ok: true });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, name === "source deactivation" ? "surface_registration_failure" : "stale_source");
    assert.deepEqual(state.promotions, []);
    assert.equal(state.cancellations.length, 1);
  });
}

test("canonical ACK failure does not promote the file draft or replace its source metadata", async () => {
  const state = fixture();
  const pending = state.sync(state.main.id, state.input);
  const before = { ...state.target };
  const failure = { requestId: "canonical-ack-1", ok: false, code: "route_mismatch", message: "Route changed" };
  state.ack.resolve(failure);
  assert.deepEqual(await pending, failure);
  assert.deepEqual(state.target, before);
  assert.deepEqual(state.promotions, []);
  assert.equal(state.cancellations.length, 1);
});

test("an owned pending draft that cannot promote fails and cancels the pending association", async () => {
  const state = fixture();
  state.promoteResult = false;
  const pending = state.sync(state.main.id, state.input);
  state.canonical();
  state.ack.resolve({ requestId: "canonical-ack-1", ok: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_source");
  assert.equal(state.promotions.length, 1);
  assert.equal(state.cancellations.length, 1);
});
