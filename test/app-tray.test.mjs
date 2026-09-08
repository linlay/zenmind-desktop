import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { BRAND_ID } = await import("../dist-electron/shared/brand.js");
const { createTranslator } = await import("../dist-electron/shared/i18n/index.js");
const { getAppTrayRecentChats, createAppTrayNewChatRoute } = await import("../dist-electron/main/modules/shell/tray-chats.js");
const trayInstances = [];

class FakeTray extends EventEmitter {
  tooltip = "";
  contextMenu = null;
  destroyed = false;
  popupCount = 0;

  constructor(icon) {
    super();
    this.icon = icon;
    trayInstances.push(this);
  }

  setToolTip(value) {
    this.tooltip = value;
  }

  setContextMenu(menu) {
    this.contextMenu = menu;
  }

  popUpContextMenu(menu) {
    this.popupCount += 1;
    this.contextMenu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

const fakeElectron = {
  Menu: {
    buildFromTemplate(template) {
      return { template };
    }
  },
  Tray: FakeTray,
  nativeImage: {
    createFromPath() {
      return {
        isEmpty: () => false,
        resize: () => ({ setTemplateImage() {} })
      };
    },
    createEmpty() {
      return {
        resize: () => ({ setTemplateImage() {} })
      };
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return fakeElectron;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let AppTrayController;
let getAppTrayIconCandidatePaths;
let getWindowsDevelopmentAppIconPath;
try {
  ({
    AppTrayController,
    getAppTrayIconCandidatePaths,
    getWindowsDevelopmentAppIconPath
  } = require("../dist-electron/main/modules/shell/tray.js"));
} finally {
  Module._load = originalLoad;
}

test("Windows development uses the generated app ICO for its main window and transparent art for its tray", () => {
  const options = {
    platform: "win32",
    isPackaged: false,
    mainDir: "C:\\app\\dist-electron",
    resourcesPath: "C:\\app\\resources"
  };

  assert.equal(
    getWindowsDevelopmentAppIconPath(options),
    `C:\\app\\build\\brands\\${BRAND_ID}\\icons\\icon.ico`
  );
  assert.deepEqual(getAppTrayIconCandidatePaths(options).slice(0, 2), [
    `C:\\app\\build\\brands\\${BRAND_ID}\\brand-assets\\tray-icon.png`,
    `C:\\app\\build\\brands\\${BRAND_ID}\\icons\\icon.ico`
  ]);
  assert.equal(getWindowsDevelopmentAppIconPath({ ...options, isPackaged: true }), undefined);
  assert.equal(getWindowsDevelopmentAppIconPath({ ...options, platform: "darwin" }), undefined);
});

test("Windows tray exposes app activation and an explicit quit action", () => {
  const calls = [];
  const controller = new AppTrayController({
    platform: "win32",
    isPackaged: false,
    appName: "ZenMind",
    t: (key) => key,
    mainDir: "C:\\app\\dist-electron\\main",
    resourcesPath: "C:\\app\\resources",
    getDesktopPetEnabled: () => false,
    isDesktopPetSupported: () => false,
    getRecentChats: () => [],
    openRecentChat: () => calls.push("recent-chat"),
    openNewChat: () => calls.push("new-chat"),
    showMainWindow: () => calls.push("show"),
    openSettings: () => calls.push("settings"),
    showDesktopPet: () => calls.push("show-pet"),
    hideDesktopPet: () => calls.push("hide-pet"),
    quitWithoutConfirmation: () => calls.push("quit")
  });

  const tray = controller.create();
  assert.equal(trayInstances.length, 1);
  assert.equal(tray.tooltip, "ZenMind");
  assert.equal(tray.contextMenu.template.at(-1).label, "tray.quit");

  tray.emit("click");
  tray.contextMenu.template.at(-1).click();

  assert.deepEqual(calls, ["show", "quit"]);
  controller.destroy();
  assert.equal(tray.destroyed, true);
});

function createChat(chatId, updatedAt, agentKey = "chat-agent", chatName = chatId) {
  return { agentKey, chatId, chatName, updatedAt };
}

function createSnapshot(chatItems = [], items = [], activityItems = []) {
  return { ok: true, chatItems, items, activityItems };
}

test("recent tray chats merge all navigation histories before sorting and limiting to eight", () => {
  const manuallyOrdered = Array.from({ length: 24 }, (_, index) => createChat(`old-${index}`, index));
  const agentHistory = Array.from({ length: 12 }, (_, index) => createChat(`recent-${index}`, 100 + index));
  const snapshot = createSnapshot(manuallyOrdered, [
    { agentKey: "chat-agent", displayName: "Assistant", recentChats: agentHistory },
    { agentKey: "project-agent", displayName: "Project", recentChats: [createChat("project-chat", 200, "project-agent")] }
  ], [
    { agentKey: "chat-agent", displayName: "Assistant", recentChats: [
      createChat("recent-11", 211, "chat-agent", "Renamed conversation"),
      createChat("", 999),
      createChat("ownerless", 999, "")
    ] }
  ]);
  const original = structuredClone(snapshot);

  const result = getAppTrayRecentChats(snapshot);
  assert.deepEqual(result.map((chat) => chat.chatId), [
    "recent-11", "project-chat", "recent-10", "recent-9", "recent-8", "recent-7", "recent-6", "recent-5"
  ]);
  assert.equal(result[0].chatName, "Renamed conversation");
  assert.equal(result[1].agentDisplayName, "Project");
  assert.deepEqual(snapshot, original);
});

test("recent tray chats handle unavailable, empty and short histories without fake rows", () => {
  assert.deepEqual(getAppTrayRecentChats(undefined), []);
  assert.deepEqual(getAppTrayRecentChats({ ok: false }), []);
  assert.deepEqual(getAppTrayRecentChats(createSnapshot()), []);
  assert.deepEqual(
    getAppTrayRecentChats(createSnapshot([createChat("only-chat", 100)])).map((chat) => chat.chatId),
    ["only-chat"]
  );
});

test("tray new chat routes use the configured agent and a fresh identity on every click", () => {
  const first = new URL(createAppTrayNewChatRoute("my agent"), "https://desktop.test");
  const second = new URL(createAppTrayNewChatRoute("my agent"), "https://desktop.test");
  assert.equal(first.pathname, "/agent/my%20agent");
  assert.ok(first.searchParams.get("newChat"));
  assert.notEqual(first.searchParams.get("newChat"), second.searchParams.get("newChat"));
  assert.equal(first.searchParams.has("chatId"), false);
});

for (const platform of ["darwin", "win32"]) {
  for (const [locale, appName, labels] of [
    ["zh-CN", "ZenMind", ["最近对话", "新对话", "打开 ZenMind", "退出 ZenMind", "暂无最近对话"]],
    ["en-US", "CuteJ", ["Recent conversations", "New conversation", "Open CuteJ", "Quit CuteJ", "No recent conversations"]]
  ]) {
    test(`${platform} tray displays recent chats and branded actions in ${locale}`, () => {
      const calls = [];
      let chats = Array.from({ length: 8 }, (_, index) => ({
        ...createChat(`chat-${index}`, 100 - index, "agent-key", `Conversation ${index}`),
        agentDisplayName: "Project"
      }));
      const controller = new AppTrayController({
        platform,
        isPackaged: false,
        appName,
        t: createTranslator(locale),
        mainDir: "/app/dist-electron/main",
        resourcesPath: "/app/resources",
        getDesktopPetEnabled: () => false,
        isDesktopPetSupported: () => false,
        getRecentChats: () => chats,
        openRecentChat: (chat) => calls.push(["recent-chat", chat.agentKey, chat.chatId]),
        openNewChat: () => calls.push("new-chat"),
        showMainWindow: () => calls.push("show"),
        openSettings: () => calls.push("settings"),
        showDesktopPet: () => {},
        hideDesktopPet: () => {},
        quitWithoutConfirmation: () => calls.push("quit")
      });
      const tray = controller.create();
      assert.equal(controller.create(), tray);
      tray.emit("click");
      if (platform === "darwin") {
        assert.equal(tray.popupCount, 1);
        assert.deepEqual(calls, []);
      } else {
        assert.equal(tray.popupCount, 0);
        assert.deepEqual(calls, ["show"]);
        calls.length = 0;
      }
      tray.emit("right-click");
      const menu = tray.contextMenu.template;
      assert.equal(menu[0].label, labels[0]);
      assert.equal(menu[0].enabled, false);
      assert.deepEqual(menu.slice(1, 9).map((item) => item.label), chats.map((chat) => chat.chatName));
      assert.equal(menu[1].sublabel, platform === "darwin" ? "Project" : undefined);
      assert.equal(menu[9].type, "separator");
      assert.equal(menu[10].label, labels[1]);
      assert.equal(menu[11].label, labels[2]);
      assert.equal(menu.at(-2).type, "separator");
      assert.equal(menu.at(-1).label, labels[3]);
      menu[1].click();
      menu[10].click();
      menu[11].click();
      menu.at(-1).click();
      assert.deepEqual(calls, [["recent-chat", "agent-key", "chat-0"], "new-chat", "show", "quit"]);

      chats = [{ ...chats[0], chatName: "Renamed conversation" }];
      controller.refreshContextMenu();
      if (platform === "darwin") tray.emit("click");
      assert.equal(tray.contextMenu.template[1].label, "Renamed conversation");
      assert.equal(tray.contextMenu.template[2].type, "separator");

      chats = [];
      controller.refreshContextMenu();
      if (platform === "darwin") tray.emit("click");
      assert.equal(tray.contextMenu.template[1].label, labels[4]);
      assert.equal(tray.contextMenu.template[1].enabled, false);
      assert.equal(tray.contextMenu.template.at(-1).label, labels[3]);
      controller.destroy();
      controller.refreshContextMenu();
      assert.equal(tray.destroyed, true);
    });
  }
}
