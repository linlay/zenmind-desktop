import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const compiledRoot = process.env.LOCAL_DOCUMENT_TEST_BUILD_ROOT ?? fileURLToPath(new URL("../dist-electron", import.meta.url));
const { createLocalDocumentEditingChat } = await import(pathToFileURL(path.join(compiledRoot, "main/app/assembly/local-documents.js")).href);
const nonce = "1700000000001";
const surface = (overrides = {}) => ({
  surfaceId: "main-chat", serviceId: "agent-webclient", surfaceRole: "main-chat",
  surfaceLevel: "root", active: true, ownerChatId: "owned-chat",
  url: "http://127.0.0.1:17080/agent/cutej?chatId=owned-chat", ...overrides,
});

function fixture(overrides = {}) {
  const requests = [];
  let current;
  let route = "http://127.0.0.1:5173/#/settings/control";
  const controller = createLocalDocumentEditingChat({
    getAgentKey: () => "cutej", getMainChatSurface: () => current,
    getDesktopRoute: () => route, delay: async () => {},
    prepareChat: async request => { requests.push(request); throw new Error("network must not be used for a preview"); },
    ...overrides,
  });
  return { controller, requests, setSurface(next) { current = next; }, setRoute(next) { route = next; } };
}

test("first and concurrent file targets are local ownerless drafts without any Platform request", async () => {
  const f = fixture();
  f.setSurface(surface());
  const results = await Promise.all([f.controller.getEditingChat(), f.controller.getEditingChat()]);
  assert.ok(results.every(target => target.agentKey === "cutej" && target.chatId === "" && /^[1-9]\d{12}$/u.test(target.newChat)));
  assert.notEqual(results[0].newChat, results[1].newChat);
  assert.equal(f.requests.length, 0);
});

test("an existing ordinary canonical Chat is never returned as the first file preview target", async () => {
  const f = fixture();
  f.setSurface(surface());
  f.setRoute("http://127.0.0.1:5173/#/agent/cutej?chatId=owned-chat");
  const target = await f.controller.getEditingChat();
  assert.equal(target.chatId, "");
  assert.match(target.newChat, /^[1-9]\d{12}$/u);
  assert.equal(f.requests.length, 0);
});

test("an actual ownerless host route supplies the same draft target before the guest is ready", async () => {
  const f = fixture();
  f.setRoute(`file:///app/index.html#/agent/cutej?newChat=${nonce}`);
  assert.deepEqual(await f.controller.getEditingChat(), { agentKey: "cutej", chatId: "", newChat: nonce });
  assert.equal(f.controller.isEditingChatRequested("", "cutej", nonce), true);
  assert.equal(f.controller.isEditingChatActive("", "cutej", nonce), false);
  assert.equal(f.requests.length, 0);
});

test("draft binding identity requires the exact ownerless Main guest and host nonce", async () => {
  const f = fixture();
  f.setRoute(`http://127.0.0.1:5173/#/agent/cutej?newChat=${nonce}`);
  f.setSurface(surface({ ownerChatId: undefined, url: `http://127.0.0.1:17080/agent/cutej?newChat=${nonce}` }));
  assert.equal(f.controller.isEditingChatActive("", "cutej", nonce), true);
  assert.equal(f.controller.isEditingChatActive("", "cutej", "1700000000002"), false);
  assert.equal(f.controller.isEditingChatActive("ordinary-chat", "cutej", nonce), false);
  assert.equal(f.controller.isEditingChatActive("", "other", nonce), false);
  f.setSurface(surface({ ownerChatId: "already-owned", url: `http://127.0.0.1:17080/agent/cutej?newChat=${nonce}` }));
  assert.equal(f.controller.isEditingChatActive("", "cutej", nonce), false);
});

test("child, background, foreign service and mismatched routes cannot establish an active draft", async () => {
  for (const changed of [
    { surfaceLevel: "child" }, { active: false }, { serviceId: "website" },
    { surfaceRole: "workpanel-web" }, { surfaceId: "other" },
    { currentUrl: "http://127.0.0.1:17080/agent/other?newChat=1700000000001" },
  ]) {
    const f = fixture();
    f.setRoute(`http://127.0.0.1:5173/#/agent/cutej?newChat=${nonce}`);
    f.setSurface(surface({ ownerChatId: undefined, url: `http://127.0.0.1:17080/agent/cutej?newChat=${nonce}`, ...changed }));
    assert.equal(f.controller.isEditingChatActive("", "cutej", nonce), false);
    assert.equal((await f.controller.getEditingChat()).chatId, "");
    assert.equal(f.requests.length, 0);
  }
});

test("malformed, mixed, duplicated and foreign-agent draft routes are never reused", async () => {
  for (const suffix of [
    "newChat=123", "newChat=1700000000001&newChat=1700000000001",
    "newChat=1700000000001&chatId=owned-chat", "newChat=0000000000000", "newChat=17000000000012",
  ]) {
    const f = fixture();
    f.setRoute(`http://127.0.0.1:5173/#/agent/cutej?${suffix}`);
    assert.equal(f.controller.isEditingChatRequested("", "cutej", nonce), false);
    const target = await f.controller.getEditingChat();
    assert.equal(target.chatId, "");
    assert.notEqual(target.newChat, nonce);
  }
  const f = fixture();
  f.setRoute(`http://127.0.0.1:5173/#/agent/other?newChat=${nonce}`);
  assert.notEqual((await f.controller.getEditingChat()).newChat, nonce);
});

test("nonce generation stays unique when multiple opens occur in the same millisecond", async () => {
  const f = fixture();
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    const targets = await Promise.all(Array.from({ length: 4 }, () => f.controller.getEditingChat()));
    assert.deepEqual(targets.map(target => target.newChat), ["1700000000000", "1700000000001", "1700000000002", "1700000000003"]);
    assert.ok(targets.every(target => target.chatId === ""));
  } finally { Date.now = originalNow; }
});

test("canonical active ownership remains strict after the normal query creates the real Chat", () => {
  const f = fixture();
  f.setSurface(surface());
  f.setRoute("http://127.0.0.1:5173/#/agent/cutej?chatId=owned-chat");
  assert.equal(f.controller.isEditingChatActive("owned-chat", "cutej"), true);
  assert.equal(f.controller.isEditingChatActive("owned-chat", "cutej", nonce), false);
  f.setRoute("http://127.0.0.1:5173/#/agent/cutej?chatId=ordinary-chat");
  assert.equal(f.controller.isEditingChatActive("owned-chat", "cutej"), false);
});

test("queued previews wait only for the host draft route, without network requests", async () => {
  let route = "http://127.0.0.1:5173/#/settings/control", delays = 0;
  const f = fixture({ getDesktopRoute: () => route, delay: async ms => {
    assert.equal(ms, 50);
    if (++delays === 3) route = `file:///app/index.html#/agent/cutej?newChat=${nonce}`;
  } });
  assert.equal(await f.controller.waitForEditingChatRequested("", "cutej", nonce), true);
  assert.equal(delays, 3);
  assert.equal(f.requests.length, 0);
});

test("the host route wait is bounded and never borrows a stale committed draft", async () => {
  let delays = 0;
  const f = fixture({ delay: async () => { delays++; } });
  f.setSurface(surface({ ownerChatId: undefined, url: `http://127.0.0.1:17080/agent/cutej?newChat=${nonce}` }));
  assert.equal(await f.controller.waitForEditingChatRequested("", "cutej", nonce), false);
  assert.equal(delays, 30);
  assert.equal(f.requests.length, 0);
});

test("missing default assistant rejects only the local target without accessing Platform", async () => {
  const f = fixture({ getAgentKey: () => "  " });
  await assert.rejects(f.controller.getEditingChat(), /editing assistant is unavailable/u);
  assert.equal(f.requests.length, 0);
});
