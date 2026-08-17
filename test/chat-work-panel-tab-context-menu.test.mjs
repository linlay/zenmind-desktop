import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeChatWorkPanelTabContextMenuRequest,
  registerChatWorkPanelTabContextMenuIpcHandlers
} = await import("../dist-electron/main/ipc/chat-work-panel-tab-context-menu-handlers.js");

test("Work Panel tab context menu accepts coordinates only", () => {
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10.4,
    y: 20.6,
    canCopyUrl: true,
    isFullscreen: false
  }), {
    mode: "work-panel",
    x: 10,
    y: 21,
    canCopyUrl: true,
    isFullscreen: false
  });
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10,
    y: 20,
    canCopyUrl: true,
    isFullscreen: false,
    url: "https://injected.example"
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: Number.POSITIVE_INFINITY,
    y: 20,
    canCopyUrl: true,
    isFullscreen: false
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({ x: 10, y: 20 }), null);
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "copy-url",
    x: 4,
    y: 8
  }), { mode: "copy-url", x: 4, y: 8 });
});

test("Work Panel tab context menu is main-window-owned and exposes bounded tab actions", async () => {
  let invokeHandler;
  let popupOptions;
  let builtTemplate;
  let selectedActionId = "toggle-fullscreen";
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
            template.find((item) => item.id === selectedActionId).click();
            options.callback();
          }
        };
      }
    }
  });

  const result = await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 999,
    y: -10,
    canCopyUrl: false,
    isFullscreen: true
  });
  assert.deepEqual(result, { actionId: "toggle-fullscreen" });
  assert.deepEqual(builtTemplate.map((item) => item.id ?? item.type), [
    "reload",
    "copy-url",
    "separator",
    "toggle-fullscreen"
  ]);
  assert.equal(builtTemplate.find((item) => item.id === "copy-url").enabled, false);
  assert.equal(popupOptions.window, ownerWindow);
  assert.equal(popupOptions.x, 299);
  assert.equal(popupOptions.y, 0);

  selectedActionId = "copy-url";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    canCopyUrl: true,
    isFullscreen: false
  }), { actionId: "copy-url" });
  assert.equal(builtTemplate.find((item) => item.id === "copy-url").enabled, true);

  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "copy-url",
    x: 1,
    y: 2
  }), { actionId: "copy-url" });
  assert.deepEqual(builtTemplate.map((item) => item.id), ["copy-url"]);

  assert.deepEqual(await invokeHandler({ sender: {} }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    canCopyUrl: true,
    isFullscreen: false
  }), {
    actionId: null
  });
});
