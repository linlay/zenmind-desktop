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
  assert.deepEqual(normalizeChatWorkPanelTabContextMenuRequest({
    mode: "work-panel",
    x: 10,
    y: 20,
    profile: "artifact",
    isFullscreen: false,
    reviewMode: "inactive",
    canClose: true,
    canCloseOthers: false
  }), {
    mode: "work-panel",
    x: 10,
    y: 20,
    profile: "artifact",
    isFullscreen: false,
    reviewMode: "inactive",
    canClose: true,
    canCloseOthers: false
  });
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
    "toggle-fullscreen",
    "reload",
    "separator",
    "download-resource",
    "open-resource-default-app",
    "reveal-resource",
    "copy-title",
    "separator",
    "close-tab",
    "close-other-tabs"
  ]);
  assert.equal(builtTemplate.find((item) => item.id === "close-tab").enabled, false);
  assert.equal(builtTemplate.find((item) => item.id === "close-other-tabs").enabled, true);
  assert.match(
    builtTemplate.find((item) => item.id === "toggle-fullscreen").label,
    /Exit Full Screen|退出全屏/u
  );
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
    "toggle-fullscreen",
    "reload",
    "copy-url",
    "separator",
    "close-tab",
    "close-other-tabs"
  ]);
  assert.match(
    builtTemplate.find((item) => item.id === "toggle-fullscreen").label,
    /Enter Full Screen|进入全屏/u
  );

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
  assert.match(
    builtTemplate.find((item) => item.id === "reveal-resource").label,
    /Finder|Explorer|File Manager|访达|文件/u
  );

  selectedActionId = "reveal-resource";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    profile: "reference",
    isFullscreen: false,
    canClose: true,
    canCloseOthers: true
  }), { actionId: "reveal-resource" });

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

  selectedActionId = "reload";
  assert.deepEqual(await invokeHandler({ sender }, {
    mode: "work-panel",
    x: 1,
    y: 2,
    profile: "default",
    isFullscreen: false,
    canClose: false,
    canCloseOthers: false
  }), { actionId: "reload" });
  assert.deepEqual(builtTemplate.map((item) => item.id ?? item.type), [
    "toggle-fullscreen",
    "reload",
    "separator",
    "close-tab",
    "close-other-tabs"
  ]);
  assert.equal(builtTemplate.find((item) => item.id === "close-tab").enabled, false);
  assert.equal(builtTemplate.find((item) => item.id === "close-other-tabs").enabled, false);

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

test("Work Panel tab context menu groups every profile without empty separators", async () => {
  const handlers = new Map();
  const sender = {};
  const ownerWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 300, height: 400 })
  };
  let builtTemplate;
  registerChatWorkPanelTabContextMenuIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler)
  }, {
    getMainWindow: () => ownerWindow,
    platform: "darwin",
    BrowserWindow: {
      fromWebContents: (contents) => contents === sender ? ownerWindow : null
    },
    Menu: {
      buildFromTemplate: (template) => {
        builtTemplate = template;
        return { popup: ({ callback }) => callback() };
      }
    }
  });
  const invokeHandler = handlers.get("chatWorkPanel.tabContextMenu.popup");
  const scenarios = [
    {
      profile: "default",
      expected: [
        "toggle-fullscreen", "reload", "separator", "close-tab", "close-other-tabs"
      ]
    },
    {
      profile: "web",
      expected: [
        "toggle-fullscreen", "reload", "copy-url", "separator", "close-tab", "close-other-tabs"
      ]
    },
    {
      profile: "artifact",
      expected: [
        "toggle-fullscreen", "reload", "separator", "download-resource",
        "open-resource-default-app", "reveal-resource", "copy-title",
        "separator", "close-tab", "close-other-tabs"
      ]
    },
    {
      profile: "reference",
      expected: [
        "toggle-fullscreen", "reload", "separator", "download-resource",
        "open-resource-default-app", "reveal-resource", "copy-title",
        "separator", "close-tab", "close-other-tabs"
      ]
    }
  ];

  for (const scenario of scenarios) {
    assert.deepEqual(await invokeHandler({ sender }, {
      mode: "work-panel",
      x: 1,
      y: 2,
      profile: scenario.profile,
      isFullscreen: false,
      canClose: true,
      canCloseOthers: true
    }), { actionId: null });
    assert.deepEqual(
      builtTemplate.map((item) => item.id ?? item.type),
      scenario.expected,
      scenario.profile
    );
    assert.notEqual(builtTemplate[0].type, "separator");
    assert.notEqual(builtTemplate.at(-1).type, "separator");
    assert.equal(
      builtTemplate.some((item, index) =>
        item.type === "separator" && builtTemplate[index + 1]?.type === "separator"
      ),
      false
    );
  }
});

test("Work Panel tab context menu exposes review only for an explicit trusted capability", async () => {
  const handlers = new Map();
  const sender = {};
  const ownerWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 500, height: 500 })
  };
  let builtTemplate;
  let selectedActionId = "toggle-review";
  registerChatWorkPanelTabContextMenuIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler)
  }, {
    getMainWindow: () => ownerWindow,
    BrowserWindow: { fromWebContents: (contents) => contents === sender ? ownerWindow : null },
    Menu: {
      buildFromTemplate: (template) => {
        builtTemplate = template;
        return {
          popup: ({ callback }) => {
            template.find((item) => item.id === selectedActionId)?.click();
            callback();
          }
        };
      }
    }
  });
  const invoke = handlers.get("chatWorkPanel.tabContextMenu.popup");
  const result = await invoke({ sender }, {
    mode: "work-panel",
    x: 20,
    y: 20,
    profile: "artifact",
    isFullscreen: false,
    reviewMode: "inactive",
    canClose: true,
    canCloseOthers: false
  });
  assert.deepEqual(result, { actionId: "toggle-review" });
  assert.equal(builtTemplate[0].id, "toggle-review");
  assert.match(builtTemplate[0].label, /Review|编辑/u);

  selectedActionId = "reload";
  await invoke({ sender }, {
    mode: "work-panel",
    x: 20,
    y: 20,
    profile: "artifact",
    isFullscreen: false,
    reviewMode: "active",
    canClose: true,
    canCloseOthers: false
  });
  assert.match(builtTemplate[0].label, /Exit|退出/u);
});

test("Work Panel reveal menu uses platform-native file manager labels", async () => {
  for (const scenario of [
    { platform: "darwin", label: /Finder|访达/u },
    { platform: "win32", label: /Explorer|文件资源管理器/u },
    { platform: "linux", label: /File Manager|文件管理器/u },
  ]) {
    const handlers = new Map();
    const sender = {};
    const ownerWindow = {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 300, height: 400 }),
    };
    let builtTemplate;
    registerChatWorkPanelTabContextMenuIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      getMainWindow: () => ownerWindow,
      platform: scenario.platform,
      BrowserWindow: {
        fromWebContents: (contents) => contents === sender ? ownerWindow : null,
      },
      Menu: {
        buildFromTemplate: (template) => {
          builtTemplate = template;
          return { popup: ({ callback }) => callback() };
        },
      },
    });

    await handlers.get("chatWorkPanel.tabContextMenu.popup")({ sender }, {
      mode: "work-panel",
      x: 1,
      y: 2,
      profile: "artifact",
      isFullscreen: false,
      canClose: true,
      canCloseOthers: false,
    });
    assert.match(builtTemplate.find((item) => item.id === "reveal-resource").label, scenario.label);
  }
});

test("Work Panel local resource open and reveal IPCs are main-window-owned", async () => {
  const handlers = new Map();
  const sender = {};
  const ownerWindow = { isDestroyed: () => false };
  const opened = [];
  const revealed = [];
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
    revealLocalResource: async (request) => {
      revealed.push(request);
      return { ok: true, path: "/runtime/chats/chat-1/artifacts/run/report.docx" };
    },
  });

  const handler = handlers.get("chatWorkPanel.openLocalResource");
  const request = {
    ownerChatId: "chat-1",
    relativePath: "artifacts/run/report.docx",
    profile: "artifact",
  };
  const openResult = await handler({ sender }, request);
  assert.equal(openResult.ok, true);
  assert.equal("path" in openResult, false);
  assert.deepEqual(opened, [request]);
  assert.equal((await handler({ sender: {} }, request)).code, "invalid_request");
  assert.equal((await handler({ sender }, { ...request, relativePath: "../report.docx" })).code, "invalid_request");

  const revealHandler = handlers.get("chatWorkPanel.revealLocalResource");
  const revealResult = await revealHandler({ sender }, request);
  assert.equal(revealResult.ok, true);
  assert.equal("path" in revealResult, false);
  assert.deepEqual(revealed, [request]);
  assert.equal((await revealHandler({ sender: {} }, request)).code, "invalid_request");
  assert.equal((await revealHandler({ sender }, { ...request, relativePath: "../report.docx" })).code, "invalid_request");
});
