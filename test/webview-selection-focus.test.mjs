import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const listeners = new Map();
const handlers = new Map();
const originalLoad = Module._load;
let createWebviewContextMenuController;
try {
  Module._load = function (id, ...args) {
    if (id === "electron") return {
      ipcMain: {
        on: (channel, listener) => listeners.set(channel, listener),
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
    };
    return originalLoad.call(this, id, ...args);
  };
  ({ createWebviewContextMenuController } = require("../dist-electron/main/modules/web-surfaces/context-menu-controller.js"));
} finally {
  Module._load = originalLoad;
}
const toolbar = require("../dist-electron/shared/webview-selection-toolbar.js");
const menu = require("../dist-electron/shared/webview-context-menu.js");
const bridge = require("../dist-electron/shared/contracts/agent-webclient-bridge.js");

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: focus the original guest before opening its annotation, reject stale selections`, async () => {
    const operations = [];
    let shown;
    const target = {
      webContentsId: 2, ownerWebContentsId: 1, registrationId: "registration",
      surfaceId: "surface", tabId: "tab", serviceId: "agent-webclient", surfaceType: "agent-chat",
    };
    let live = target;
    const guest = {
      id: 2, isDestroyed: () => false, getType: () => "webview", getURL: () => "http://localhost/chat",
      focus: () => operations.push("focus"),
      send: (_channel, payload) => {
        if (payload.action === menu.WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION) {
          listeners.get(menu.WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL)({ sender: guest }, {
            version: menu.WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION, requestId: payload.requestId,
            target: { version: menu.WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION, targetId: "message:1", kind: "message", capabilities: ["content.copy"] },
          });
        } else if (payload.action === bridge.AGENT_WEBCLIENT_SELECTION_ACTION) {
          operations.push(payload.operation);
          listeners.get(toolbar.WEBVIEW_SELECTION_TOOLBAR_RESULT_CHANNEL)({ sender: guest }, {
            version: bridge.AGENT_WEBCLIENT_SELECTION_ACTION_VERSION, requestId: payload.requestId, ok: true,
          });
        }
      },
    };
    createWebviewContextMenuController({
      platform,
      browserSurfaces: { resolveWebviewSurfaceTarget: () => live },
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { id: 1, send: (_channel, state) => { if (state.visible) shown = state; } } }),
      isTrustedAgentWebclient: () => true,
      report: () => {},
    });
    const show = async () => {
      shown = undefined;
      listeners.get(toolbar.WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL)({ sender: guest }, {
        version: toolbar.WEBVIEW_SELECTION_TOOLBAR_VERSION, visible: true, rect: { x: 10, y: 20, width: 100, height: 20 },
        start: { x: 10, y: 20 }, end: { x: 100, y: 20 },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(shown);
    };
    const execute = (action, owner = 1) => handlers.get(toolbar.WEBVIEW_SELECTION_TOOLBAR_EXECUTE_CHANNEL)(
      { sender: { id: owner } }, { version: toolbar.WEBVIEW_SELECTION_TOOLBAR_VERSION, selectionId: shown.selectionId, action },
    );
    await show();
    assert.deepEqual(await execute("add-to-chat", 9), { ok: false, code: "stale_selection" });
    assert.deepEqual(operations, []);
    assert.deepEqual(await execute("add-to-chat"), { ok: true });
    assert.deepEqual(operations, ["focus", "add-to-chat"]);
    operations.length = 0;
    await show();
    assert.deepEqual(await execute("ask-in-side-chat"), { ok: true });
    assert.deepEqual(operations, ["ask-in-side-chat"]);
    operations.length = 0;
    await show();
    live = { ...target, registrationId: "replacement" };
    assert.deepEqual(await execute("add-to-chat"), { ok: false, code: "stale_selection" });
    assert.deepEqual(operations, []);
  });
}
