import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeChatWorkPanelTabContextMenuRequest,
  registerChatWorkPanelTabContextMenuIpcHandlers
} = await import("../dist-electron/main/ipc/chat-work-panel-tab-context-menu-handlers.js");

test("Work Panel tab context menu accepts coordinates only", () => {
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({ x: 10.4, y: 20.6 }), {
    x: 10,
    y: 21
  });
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    x: 10,
    y: 20,
    url: "https://injected.example"
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({ x: Number.POSITIVE_INFINITY, y: 20 }), null);
});

test("Work Panel tab context menu is main-window-owned and returns only copy-url", async () => {
  let invokeHandler;
  let popupOptions;
  let builtTemplate;
  const sender = {};
  const ownerWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 200, width: 300, height: 400 })
  };
  registerChatWorkPanelTabContextMenuIpcHandlers({
    handle: (_channel, handler) => {
      invokeHandler = handler;
    }
  }, {
    getMainWindow: () => ownerWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender ? ownerWindow : null
    },
    Menu: {
      buildFromTemplate: (template) => {
        builtTemplate = template;
        return {
          popup: (options) => {
            popupOptions = options;
            template[0].click();
            options.callback();
          }
        };
      }
    }
  });

  const result = await invokeHandler({ sender }, { x: 999, y: -10 });
  assert.deepEqual(result, { actionId: "copy-url" });
  assert.equal(builtTemplate.length, 1);
  assert.equal(builtTemplate[0].id, "copy-url");
  assert.equal(popupOptions.window, ownerWindow);
  assert.equal(popupOptions.x, 299);
  assert.equal(popupOptions.y, 0);

  assert.deepEqual(await invokeHandler({ sender: {} }, { x: 1, y: 2 }), {
    actionId: null
  });
});
