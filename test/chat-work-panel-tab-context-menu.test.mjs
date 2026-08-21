import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeChatWorkPanelTabContextMenuRequest,
  registerChatWorkPanelTabContextMenuIpcHandlers
} = await import("../dist-electron/main/ipc/chat-work-panel-tab-context-menu-handlers.js");

test("Work Panel tab context menu accepts only bounded profile capabilities", () => {
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10.4,
    y: 20.6,
    profile: "artifact",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false
  }), {
    mode: "work-panel",
    x: 10,
    y: 21,
    profile: "artifact",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false
  });
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10,
    y: 20,
    profile: "artifact",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false,
    url: "https://injected.example"
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: Number.POSITIVE_INFINITY,
    y: 20,
    profile: "web",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10,
    y: 20,
    profile: "injected-profile",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false
  }), null);
  assert.equal(normalizeChatWorkPanelTabContextMenuRequest({ x: 10, y: 20 }), null);
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "copy-url",
    x: 4,
    y: 8
  }), { mode: "copy-url", x: 4, y: 8 });
});

test("Work Panel tab context menu is main-window-owned and exposes bounded tab actions", async () => {
  const invokeHandlers = new Map();
  let popupOptions;
  let builtTemplate;
  let selectedActionId = "toggle-fullscreen";
  const sender = {};
  const ownerWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 200, width: 300, height: 400 })
  };
  registerChatWorkPanelTabContextMenuIpcHandlers({
    handle: (channel, handler) => {
      invokeHandlers.set(channel, handler);
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
  const invokeHandler = invokeHandlers.get("chatWorkPanel.tabContextMenu.popup");

  const result = await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 999,
    y: -10,
    profile: "artifact",
    isFullscreen: true,
    canClose: false,
    canCloseOthers: true
  });
  assert.deepEqual(result, { actionId: "toggle-fullscreen" });
  assert.deepEqual(builtTemplate.map((item) => item.id ?? item.type), [
    "download-resource",
    "open-resource-default-app",
    "copy-title",
    "separator",
    "reload",
    "separator",
    "toggle-fullscreen",
    "separator",
    "close-tab",
    "close-other-tabs"
  ]);
  assert.equal(builtTemplate.find((item) => item.id === "close-tab").enabled, false);
  assert.equal(builtTemplate.find((item) => item.id === "close-other-tabs").enabled, true);
  assert.equal(popupOptions.window, ownerWindow);
  assert.equal(popupOptions.x, 299);
  assert.equal(popupOptions.y, 0);

  selectedActionId = "copy-url";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    profile: "web",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: false
  }), { actionId: "copy-url" });
  assert.deepEqual(builtTemplate.map((item) => item.id ?? item.type), [
    "reload",
    "copy-url",
    "separator",
    "toggle-fullscreen",
    "separator",
    "close-tab",
    "close-other-tabs"
  ]);

  selectedActionId = "download-resource";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    profile: "reference",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: true
  }), { actionId: "download-resource" });
  assert.match(
    builtTemplate.find((item) => item.id === "download-resource").label,
    /Resource|资源/u
  );
  assert.match(
    builtTemplate.find((item) => item.id === "open-resource-default-app").label,
    /Default App|默认应用/u
  );

  selectedActionId = "open-resource-default-app";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    profile: "artifact",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: true
  }), { actionId: "open-resource-default-app" });

  selectedActionId = "copy-url";
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
    profile: "default",
    isFullscreen: false,
    canClose: false,
    canCloseOthers: false
  }), {
    actionId: null
  });
});

test("Work Panel local resource open IPC is main-window-owned", async () => {
  const handlers = new Map();
  const sender = {};
  const ownerWindow = { isDestroyed: () => false };
  const opened = [];
  registerChatWorkPanelTabContextMenuIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
  }, {
    getMainWindow: () => ownerWindow,
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender ? ownerWindow : null,
    },
    openLocalResource: async (request) => {
      opened.push(request);
      return { ok: true, path: "/runtime/chats/chat-1/artifacts/run/report.docx" };
    },
  });

  const handler = handlers.get("chatWorkPanel.openLocalResource");
  const request = {
    ownerChatId: "chat-1",
    relativePath: "artifacts/run/report.docx",
    profile: "artifact",
  };
  assert.equal((await handler({ sender }, request)).ok, true);
  assert.deepEqual(opened, [request]);
  assert.equal((await handler({ sender: {} }, request)).code, "invalid_request");
  assert.equal((await handler({ sender }, { ...request, relativePath: "../report.docx" })).code, "invalid_request");
});
