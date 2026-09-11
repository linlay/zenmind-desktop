import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { createBrowserSurfaceRegistry } = await import("../dist-electron/main/modules/web-surfaces/browser-surface-registry.js");
const { registerEmbeddedCdpIpcHandlers } = await import("../dist-electron/main/modules/web-surfaces/cdp/ipc.js");
const { createSurfaceIdentity } = await import("../dist-electron/shared/surface-identity.js");

function createHarness() {
  const guests = new Map([101, 102, 103].map((id) => [id, {
    id,
    getType: () => "webview",
    isDestroyed: () => false,
  }]));
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...guests.values()],
      fromId: (id) => guests.get(id),
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null,
  });
  const handlers = new Map();
  let mainWindowWebContentsId = 1;
  registerEmbeddedCdpIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
  }, registry, {
    isMainWindow: (senderId) => senderId === mainWindowWebContentsId,
  });
  const sender = (id) => Object.assign(new EventEmitter(), { id });
  return {
    registry,
    sender,
    setMainWindow: (id) => { mainWindowWebContentsId = id; },
    register: (owner, input) => handlers.get("embeddedCdp.registerSurface")({ sender: owner }, input),
  };
}

function registration(role, guestId, generation) {
  const isMainChat = role === "main-chat";
  const pageRoute = isMainChat
    ? "/agent/helper?newChat=new-1"
    : "/selection-explain/chat-selection?runId=run-selection";
  const url = `http://127.0.0.1:17080${pageRoute}`;
  const tabId = `tab-${guestId}`;
  return {
    ...createSurfaceIdentity(role, "", isMainChat ? {} : { ownerChatId: "chat-selection" }),
    registrationId: generation,
    surfaceKind: "service",
    surfaceType: isMainChat ? "agent-chat" : "agent-selection-explain",
    serviceId: "agent-webclient",
    pageRoute,
    pageRouteIdentity: pageRoute,
    label: role,
    url,
    active: true,
    tabs: [{
      tabId,
      currentUrl: url,
      title: role,
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }],
    activeTabId: tabId,
  };
}

test("an auxiliary window cannot claim Main Chat before the main guest registers or after it is destroyed", () => {
  const runtime = createHarness();
  const main = runtime.sender(1);
  const auxiliary = runtime.sender(3);
  const auxiliaryMain = registration("main-chat", 102, "auxiliary-main");
  const mainChat = registration("main-chat", 101, "main-generation-1");

  assert.deepEqual(runtime.register(auxiliary, auxiliaryMain), { ok: false, reason: "ownership_conflict" });
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(102), null);
  assert.deepEqual(runtime.register(main, mainChat), { ok: true });
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(101).ownerWebContentsId, 1);

  main.emit("destroyed");
  runtime.setMainWindow(2);
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(101), null);
  assert.deepEqual(runtime.register(auxiliary, auxiliaryMain), { ok: false, reason: "ownership_conflict" });
  assert.deepEqual(runtime.register(main, mainChat), { ok: false, reason: "ownership_conflict" });
  assert.deepEqual(runtime.register(runtime.sender(2), {
    ...mainChat,
    registrationId: "main-generation-2",
  }), { ok: true });
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(101).ownerWebContentsId, 2);
});

test("an auxiliary explanation keeps its own surface while Main Chat stays owned by the main window", () => {
  const runtime = createHarness();
  const auxiliary = runtime.sender(3);
  const explanation = registration("selection-explain", 103, "explanation-generation-1");
  assert.deepEqual(runtime.register(auxiliary, explanation), { ok: true });
  assert.deepEqual(runtime.register(runtime.sender(1), registration("main-chat", 101, "main-generation-1")), { ok: true });
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(103).surfaceRole, "selection-explain");
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(103).ownerWebContentsId, 3);
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(101).ownerWebContentsId, 1);

  auxiliary.emit("destroyed");
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(103), null);
  assert.equal(runtime.registry.resolveWebviewSurfaceTarget(101).ownerWebContentsId, 1);
});
