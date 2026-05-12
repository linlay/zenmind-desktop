import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DESKTOP_PET_WINDOW_SIZE,
  DESKTOP_PET_WINDOW_SIZES,
  __testInternals: desktopPetInternals,
  clampDesktopPetPosition,
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  getDesktopPetContextMenuItems,
  readDesktopPetStoredState,
  sanitizeDesktopPetAppearanceId,
  sanitizeDesktopPetBoundAgentKey,
  writeDesktopPetStoredState,
  isDesktopPetSupportedPlatform
} = await import("../dist-electron/main/desktop-pet.js");

const {
  DesktopPetPreviewProjector,
  DesktopPetSseParser,
  sanitizeDesktopPetPreviewText
} = await import("../dist-electron/main/desktop-pet-preview.js");

const {
  AgentPlatformPetStreamClient
} = await import("../dist-electron/main/agent-platform-pet-stream.js");

const {
  AgentPlatformPetStatusClient,
  applyAgentPlatformCompletionReminder,
  applyAgentPlatformPetPush,
  buildAgentPlatformPetStatus: buildStatusFromPlatform,
  resolveAgentPlatformPetBoundAgentKey,
  toDesktopPetAgentOptions
} = await import("../dist-electron/main/agent-platform-pet-status.js");

function waitFor(predicate, timeoutMs = 800) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("desktop pet is only supported on macOS", () => {
  assert.equal(isDesktopPetSupportedPlatform("darwin"), true);
  assert.equal(isDesktopPetSupportedPlatform("win32"), false);
  assert.equal(isDesktopPetSupportedPlatform("linux"), false);
});

test("desktop pet clamps to the full display area", () => {
  const bounds = clampDesktopPetPosition({ x: -50, y: 9999 }, {
    x: 0,
    y: 0,
    width: 1440,
    height: 900
  });

  assert.deepEqual(bounds, {
    x: 0,
    y: 702,
    width: DESKTOP_PET_WINDOW_SIZE.width,
    height: DESKTOP_PET_WINDOW_SIZE.height
  });
});

test("desktop pet can be dragged into the top edge of the display", () => {
  const bounds = clampDesktopPetPosition({ x: 120, y: -80 }, {
    x: 0,
    y: 0,
    width: 1440,
    height: 900
  });

  assert.equal(bounds.y, 0);
});

test("desktop pet exposes anchored preview window sizes", () => {
  const display = {
    x: 0,
    y: 0,
    width: 1440,
    height: 900
  };
  const base = desktopPetInternals.getAnchoredDesktopPetBounds({ x: 1100, y: 610 }, display, "base");
  const expanded = desktopPetInternals.getAnchoredDesktopPetBounds({ x: 1100, y: 610 }, display, "preview-expanded");
  const logical = desktopPetInternals.getDesktopPetLogicalPositionFromBounds(expanded, "preview-expanded");

  assert.equal(DESKTOP_PET_WINDOW_SIZES["preview-collapsed"].width, 380);
  assert.equal(DESKTOP_PET_WINDOW_SIZES["preview-expanded"].height, 412);
  assert.deepEqual(logical, { x: base.x, y: base.y });
  assert.equal(expanded.x + expanded.width, base.x + DESKTOP_PET_WINDOW_SIZE.width);
  assert.equal(expanded.y + expanded.height, base.y + DESKTOP_PET_WINDOW_SIZE.height);
});

test("desktop pet bubble window grows upward from the sprite footprint", () => {
  const display = {
    x: 0,
    y: 0,
    width: 1440,
    height: 900
  };
  const base = desktopPetInternals.getAnchoredDesktopPetBounds({ x: 1100, y: 610 }, display, "base");
  const bubble = desktopPetInternals.getAnchoredDesktopPetBounds({ x: 1100, y: 610 }, display, "bubble");
  const logical = desktopPetInternals.getDesktopPetLogicalPositionFromBounds(bubble, "bubble");

  assert.equal(DESKTOP_PET_WINDOW_SIZE.width, 176);
  assert.equal(DESKTOP_PET_WINDOW_SIZE.height, 198);
  assert.equal(desktopPetInternals.DESKTOP_PET_WINDOW_SIZES.bubble.width, 224);
  assert.equal(desktopPetInternals.DESKTOP_PET_WINDOW_SIZES.bubble.height, 228);
  assert.deepEqual(logical, { x: base.x, y: base.y });
  assert.equal(bubble.x + desktopPetInternals.DESKTOP_PET_WINDOW_SIZES.bubble.width, base.x + DESKTOP_PET_WINDOW_SIZE.width);
  assert.equal(bubble.y + bubble.height, base.y + DESKTOP_PET_WINDOW_SIZE.height);
});

test("desktop pet stores a default bound agent key", () => {
  assert.equal(sanitizeDesktopPetBoundAgentKey(""), DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  assert.equal(sanitizeDesktopPetBoundAgentKey("  xiaozhai  "), DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  assert.equal(sanitizeDesktopPetBoundAgentKey("  custom-agent  "), "custom-agent");
});

test("desktop pet stores a safe appearance id", () => {
  assert.equal(sanitizeDesktopPetAppearanceId(""), DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  assert.equal(sanitizeDesktopPetAppearanceId("  dario  "), "dario");
  assert.equal(sanitizeDesktopPetAppearanceId("  mini-sama  "), "mini-sama");
  assert.equal(sanitizeDesktopPetAppearanceId("  sprout  "), "dario");
  assert.equal(sanitizeDesktopPetAppearanceId("  starlight  "), "mini-sama");
  assert.equal(sanitizeDesktopPetAppearanceId("missing-pet"), DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS.length, 3);
});

test("desktop pet context menu only offers dance for the classic appearance", () => {
  assert.deepEqual(
    getDesktopPetContextMenuItems(DEFAULT_DESKTOP_PET_APPEARANCE_ID).map((item) => item.label),
    ["跳舞", "关闭宠物"]
  );
  assert.deepEqual(
    getDesktopPetContextMenuItems("dario").map((item) => item.label),
    ["关闭宠物"]
  );
  assert.deepEqual(
    getDesktopPetContextMenuItems("mini-sama").map((item) => item.label),
    ["关闭宠物"]
  );
});

test("desktop pet generated resources cover all visual states", () => {
  const root = path.join(process.cwd(), "public", "desktop-pet");
  const states = ["idle", "hover", "dragging", "thinking", "message", "done", "error", "running", "awaiting"];
  const appearances = ["", "dario", "mini-sama", "sprout", "starlight"];

  for (const appearance of appearances) {
    for (const state of states) {
      assert.equal(
        fs.existsSync(path.join(root, appearance, `pet-${state}.png`)),
        true,
        `${appearance || "classic"} missing pet-${state}.png`
      );
    }
  }
});

test("desktop pet ignores state files on unsupported platforms", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-unsupported-"));
  t.after(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userData;
    }
  };

  const readState = readDesktopPetStoredState(app, "win32");
  const writtenState = writeDesktopPetStoredState(app, {
    enabled: true,
    lastVisible: true,
    unreadCount: 7,
    boundAgentKey: "custom-agent",
    appearanceId: "dario"
  }, "win32");

  assert.equal(readState.enabled, false);
  assert.equal(writtenState.enabled, false);
  assert.equal(writtenState.appearanceId, "dario");
  assert.equal(fs.existsSync(path.join(userData, desktopPetInternals.DESKTOP_PET_DIRECTORY)), false);
});

test("desktop pet recovers from a corrupt state file", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-corrupt-"));
  t.after(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userData;
    }
  };
  const petRoot = path.join(userData, desktopPetInternals.DESKTOP_PET_DIRECTORY);
  fs.mkdirSync(petRoot, { recursive: true });
  fs.writeFileSync(path.join(petRoot, desktopPetInternals.DESKTOP_PET_SETTINGS_FILE), "{not valid json", "utf8");

  const state = readDesktopPetStoredState(app, "darwin");

  assert.equal(state.enabled, true);
  assert.equal(state.boundAgentKey, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  assert.equal(state.appearanceId, DEFAULT_DESKTOP_PET_APPEARANCE_ID);
});

test("desktop pet persists selected appearance", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-appearance-"));
  t.after(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userData;
    }
  };

  const state = writeDesktopPetStoredState(app, {
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    appearanceId: "dario"
  }, "darwin");
  const restored = readDesktopPetStoredState(app, "darwin");

  assert.equal(state.appearanceId, "dario");
  assert.equal(restored.appearanceId, "dario");
});

test("desktop pet shows bound agent unread count while idle", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "available",
      unreadCount: 8,
      latestPreview: "宠物提醒：久坐伤身，请起身活动一下...",
      chatId: "chat-x",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "idle");
  assert.equal(state.hint, "");
  assert.equal(state.unreadCount, 8);
  assert.equal(state.agentDisplayName, "小宅");
  assert.equal(state.agentStatusStale, false);
  assert.equal(state.appearanceId, DEFAULT_DESKTOP_PET_APPEARANCE_ID);
  assert.equal(state.appearanceOptions.length, 3);
});

test("desktop pet state exposes selectable agent options", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentOptions: [
      { agentKey: "zenmi", displayName: "小宅", role: "平台总管", unreadCount: 8 }
    ]
  });

  assert.deepEqual(state.agentOptions, [
    { agentKey: "zenmi", displayName: "小宅", role: "平台总管", unreadCount: 8 }
  ]);
});

test("desktop pet local awaiting status displays as thinking", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: {
      status: "awaiting",
      hint: "旧等待提示",
      unreadCount: 1,
      chatId: "local-chat"
    },
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "available",
      unreadCount: 8,
      latestPreview: "平台消息",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "running");
  assert.equal(state.hint, "思考中");
  assert.equal(state.unreadCount, 8);
  assert.equal(state.chatId, "local-chat");
});

test("desktop pet done status can show a task completion reminder", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: {
      status: "done",
      hint: "任务已完成",
      unreadCount: 0,
      chatId: "quick-chat"
    }
  });

  assert.equal(state.status, "done");
  assert.equal(state.hint, "任务已完成");
  assert.equal(state.chatId, "quick-chat");
});

test("desktop pet done status can be refreshed by the agent reply preview", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: {
      status: "done",
      hint: "暂无回复预览",
      unreadCount: 0,
      chatId: "agent-chat"
    },
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "away",
      unreadCount: 0,
      latestPreview: "模型回复内容预览会直接显示在气泡里。",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "done");
  assert.equal(state.hint, "模型回复内容预览会直接显示在气泡里。");
  assert.equal(state.chatId, "agent-chat");
});

test("desktop pet done bound agent status can preview the latest reply", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "away",
      unreadCount: 0,
      latestPreview: "好的，我已经收到测试消息了。",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "done");
  assert.equal(state.hint, "好的，我已经收到测试消息了。");
  assert.equal(state.messagePreview, "");
  assert.equal(state.chatId, "agent-chat");
});

test("desktop pet local error status shows a short error reminder", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: {
      status: "error",
      hint: "",
      unreadCount: 0,
      chatId: "error-chat"
    }
  });

  assert.equal(state.status, "error");
  assert.equal(state.hint, "出错了");
  assert.equal(state.chatId, "error-chat");
  assert.equal(state.unreadCount, 0);
});

test("desktop pet running bound agent status keeps unread display", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 1,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "busy",
      unreadCount: 1,
      latestPreview: "旧未读提醒",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "running");
  assert.equal(state.hint, "思考中");
  assert.equal(state.unreadCount, 1);
});

test("desktop pet does not render read long previews inside the floating bubble", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "available",
      unreadCount: 0,
      latestPreview: "这是一段很长很长的回复内容，不应该塞进桌面宠物的气泡里展示。",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.hint, "");
  assert.equal(state.messagePreview, "");
  assert.equal(state.unreadCount, 0);
});

test("desktop pet exposes unread short previews for message reactions", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "available",
      unreadCount: 2,
      latestPreview: "最新提醒",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "idle");
  assert.equal(state.hint, "");
  assert.equal(state.messagePreview, "最新提醒");
  assert.equal(state.unreadCount, 2);
});

test("desktop pet truncates unread long previews for message reactions", () => {
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      displayName: "小宅",
      role: "平台总管",
      presence: "available",
      unreadCount: 1,
      latestPreview: "这是一段很长很长的回复内容，不应该塞进桌面宠物的气泡里展示，也不应该把宠物窗口撑开。",
      chatId: "agent-chat",
      hasPendingAwaiting: false,
      stale: false,
      updatedAt: "2026-05-07T00:00:00.000Z"
    }
  });

  assert.equal(state.status, "idle");
  assert.equal(state.messagePreview, "这是一段很长很长的回复内容，不应该塞进桌面宠物的气泡里...");
  assert.equal(state.messagePreview.length, 30);
  assert.equal(state.unreadCount, 1);
});

test("agent-platform snapshot selects only the bound agent", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [
      { key: "other", name: "别的智能体", stats: { unreadCount: 99 } },
      { key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", role: "平台总管", stats: { unreadCount: 3 } }
    ],
    chats: [
      { chatId: "other-chat", agentKey: "other", updatedAt: 3, lastRunContent: "不该展示" },
      { chatId: "chat-new", agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, updatedAt: 5, lastRunContent: "最新提醒", read: { isRead: false } },
      { chatId: "chat-old", agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, updatedAt: 1, lastRunContent: "旧提醒" }
    ],
    updatedAt: "2026-05-07T00:00:00.000Z"
  });

  assert.equal(status.agentKey, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY);
  assert.equal(status.displayName, "小宅");
  assert.equal(status.unreadCount, 1);
  assert.equal(status.latestPreview, "最新提醒");
  assert.equal(status.chatId, "chat-new");
});

test("agent-platform snapshot derives unread count from chat read states", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 0 } }],
    chats: [
      {
        chatId: "chat-unread-a",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: 3,
        read: { isRead: false }
      },
      {
        chatId: "chat-read",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: 2,
        read: { isRead: true }
      },
      {
        chatId: "chat-unread-b",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: 1,
        isRead: false
      }
    ]
  });

  assert.equal(status.unreadCount, 2);
});

test("agent-platform snapshot clears unread when chat read states are all read", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 1 } }],
    chats: [
      {
        chatId: "chat-read-a",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: 3,
        read: { isRead: true }
      },
      {
        chatId: "chat-read-b",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: 2,
        read: true
      }
    ]
  });

  assert.equal(status.unreadCount, 0);
});

test("agent-platform snapshot sorts ISO chat timestamps by freshness", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅" }],
    chats: [
      {
        chatId: "chat-old",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: "2026-05-07T09:00:00.000Z",
        lastRunContent: "旧提醒"
      },
      {
        chatId: "chat-new",
        agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
        updatedAt: "2026-05-08T09:00:00.000Z",
        lastRunContent: "新提醒"
      }
    ]
  });

  assert.equal(status.chatId, "chat-new");
  assert.equal(status.latestPreview, "新提醒");
});

test("agent-platform snapshot reports missing bound agent as offline", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: "missing",
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅" }],
    chats: [{ chatId: "chat-x", agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, lastRunContent: "不该展示" }]
  });

  assert.equal(status.agentKey, "missing");
  assert.equal(status.presence, "offline");
  assert.equal(status.latestPreview, "目标智能体未在线");
  assert.equal(status.unreadCount, 0);
});

test("agent-platform snapshot migrates legacy xiaozhai binding to zenmi", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: "xiaozhai",
    agents: [{ key: "zenmi", name: "小宅", role: "平台总管", stats: { unreadCount: 8 } }],
    chats: [{ chatId: "chat-zenmi", agentKey: "zenmi", updatedAt: 9, lastRunContent: "宠物提醒：久坐伤身" }]
  });

  assert.equal(status.agentKey, "zenmi");
  assert.equal(status.displayName, "小宅");
  assert.equal(status.latestPreview, "宠物提醒：久坐伤身");
  assert.equal(status.unreadCount, 8);
});

test("agent-platform snapshot self-heals partial zen binding to zenmi", () => {
  const status = buildStatusFromPlatform({
    boundAgentKey: "zen",
    agents: [{ key: "zenmi", name: "小宅", role: "平台总管", stats: { unreadCount: 8 } }],
    chats: [{ chatId: "chat-zenmi", agentKey: "zenmi", updatedAt: 9, lastRunContent: "宠物提醒：久坐伤身" }]
  });

  assert.equal(status.agentKey, "zenmi");
  assert.equal(status.displayName, "小宅");
  assert.equal(status.presence, "available");
  assert.equal(status.latestPreview, "宠物提醒：久坐伤身");
  assert.equal(status.unreadCount, 8);
});

test("agent-platform bound agent resolver uses exact key before prefix healing", () => {
  const resolved = resolveAgentPlatformPetBoundAgentKey("zen", [
    { key: "zen", name: "自定义 Zen" },
    { key: "zenmi", name: "小宅" }
  ]);

  assert.equal(resolved.resolvedKey, "zen");
  assert.equal(resolved.agent?.name, "自定义 Zen");
});

test("agent-platform agent options let settings show names instead of requiring keys", () => {
  const options = toDesktopPetAgentOptions([
    { key: "codeAssistant", name: "代码助手", role: "CLI 代码助手", stats: { unreadCount: 99 } },
    { key: "zenmi", name: "小宅", role: "平台总管", stats: { unreadCount: 8 } },
    { name: "缺少 key" }
  ]);

  assert.deepEqual(options.slice(0, 2), [
    { agentKey: "zenmi", displayName: "小宅", role: "平台总管", unreadCount: 8 },
    { agentKey: "codeAssistant", displayName: "代码助手", role: "CLI 代码助手", unreadCount: 99 }
  ]);
});

test("agent-platform unread push surfaces unread count to desktop pet", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 1 } }],
    chats: []
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.unread",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-2",
      agentUnreadCount: 4
    }
  });

  assert.equal(next?.unreadCount, 4);
  assert.equal(next?.chatId, "chat-2");
});

test("agent-platform push keeps resolved agent key when settings still contain stale partial key", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: "zen",
    agents: [{ key: "zenmi", name: "小宅", stats: { unreadCount: 1 } }],
    chats: []
  });
  const next = applyAgentPlatformPetPush(current, "zen", {
    frame: "push",
    type: "chat.unread",
    data: {
      agentKey: "zenmi",
      chatId: "chat-3",
      agentUnreadCount: 5
    }
  });

  assert.equal(next?.agentKey, "zenmi");
  assert.equal(next?.unreadCount, 5);
  assert.equal(next?.chatId, "chat-3");
});

test("agent-platform read all push clears desktop pet unread count", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 6 } }],
    chats: []
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.read_all",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
    }
  });

  assert.equal(current.unreadCount, 6);
  assert.equal(next?.unreadCount, 0);
});

test("agent-platform read push without count decrements desktop pet unread count", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 1 } }],
    chats: []
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.read",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-read"
    }
  });

  assert.equal(next?.unreadCount, 0);
});

test("agent-platform unread push without count increments desktop pet unread count", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 1 } }],
    chats: []
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.unread",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-unread"
    }
  });

  assert.equal(next?.unreadCount, 2);
});

test("agent-platform unread push does not downgrade a running bound agent", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 1 } }],
    chats: []
  });
  const running = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const next = applyAgentPlatformPetPush(running, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.unread",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running",
      agentUnreadCount: 2
    }
  });

  assert.equal(next?.presence, "busy");
  assert.equal(next?.unreadCount, 2);
});

test("agent-platform run finished push exposes a short done status", () => {
  const current = applyAgentPlatformPetPush(null, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.finished",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 99,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: next
  });

  assert.equal(next?.presence, "away");
  assert.equal(state.status, "done");
  assert.equal(state.hint, "暂无回复预览");
  assert.equal(state.unreadCount, 0);
});

test("agent-platform run finished push can surface the reply preview", () => {
  const current = applyAgentPlatformPetPush(null, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const next = applyAgentPlatformPetPush(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.finished",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running",
      lastRunContent: "好的，我已经收到测试消息了。"
    }
  });
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: next
  });

  assert.equal(next?.presence, "away");
  assert.equal(next?.latestPreview, "好的，我已经收到测试消息了。");
  assert.equal(state.status, "done");
  assert.equal(state.hint, "好的，我已经收到测试消息了。");
});

test("agent-platform run finished push can match current chat without agent key", () => {
  const running = applyAgentPlatformPetPush(null, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const next = applyAgentPlatformPetPush(running, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.finished",
    data: {
      chatId: "chat-running"
    }
  });

  assert.equal(next?.presence, "away");
  assert.equal(next?.chatId, "chat-running");
  assert.equal(next?.latestPreview, "暂无回复预览");
});

test("agent-platform chat updated push refreshes reply preview after generic finish", () => {
  const running = applyAgentPlatformPetPush(null, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-running"
    }
  });
  const finished = applyAgentPlatformPetPush(running, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.finished",
    data: {
      chatId: "chat-running"
    }
  });
  const next = applyAgentPlatformPetPush(finished, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.updated",
    data: {
      chat: {
        chatId: "chat-running",
        lastRunContent: "你指的重写是指：告诉我哪里不对，我再改。"
      }
    }
  });
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: {
      ...createDefaultDesktopPetLocalStatus(),
      status: "done",
      hint: "暂无回复预览",
      chatId: "chat-running"
    },
    agentStatus: next
  });

  assert.equal(finished?.latestPreview, "暂无回复预览");
  assert.equal(next?.presence, "away");
  assert.equal(next?.latestPreview, "你指的重写是指：告诉我哪里不对，我再改。");
  assert.equal(state.status, "done");
  assert.equal(state.hint, "你指的重写是指：告诉我哪里不对，我再改。");
});

test("agent-platform status client attaches only bound agent runs", () => {
  const startedRuns = [];
  const finishedRuns = [];
  const statusUpdates = [];
  const client = new AgentPlatformPetStatusClient({
    app: {},
    getBoundAgentKey: () => DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    getServiceState: async () => ({ status: "stopped", healthMeta: { webUrl: "" } }),
    issueAccessToken: async () => ({ ok: true, token: "token" }),
    onStatus: (status) => statusUpdates.push(status),
    onRunStarted: (input) => startedRuns.push(input),
    onRunFinished: (input) => finishedRuns.push(input)
  });

  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.started",
    data: {
      runId: "run_other",
      chatId: "chat_other",
      agentKey: "other-agent"
    }
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.started",
    data: {
      runId: "run_bound",
      chatId: "chat_bound",
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
    }
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.finished",
    data: {
      runId: "run_other",
      chatId: "chat_other",
      agentKey: "other-agent",
      lastRunContent: "不该收尾"
    }
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.finished",
    data: {
      runId: "run_bound",
      chatId: "chat_bound",
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      lastRunContent: "好的，已经完成。"
    }
  }));
  client.stop();

  assert.deepEqual(startedRuns, [{
    runId: "run_bound",
    chatId: "chat_bound",
    agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }]);
  assert.deepEqual(finishedRuns, [{
    runId: "run_bound",
    chatId: "chat_bound",
    agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    message: "好的，已经完成。"
  }]);
  assert.equal(statusUpdates.at(-1)?.presence, "away");
});

test("agent-platform status client accepts chat updated content for the current chat", () => {
  const statusUpdates = [];
  const client = new AgentPlatformPetStatusClient({
    app: {},
    getBoundAgentKey: () => DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    getServiceState: async () => ({ status: "stopped", healthMeta: { webUrl: "" } }),
    issueAccessToken: async () => ({ ok: true, token: "token" }),
    onStatus: (status) => statusUpdates.push(status)
  });

  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.started",
    data: {
      runId: "run_bound",
      chatId: "chat_bound",
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
    }
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "run.finished",
    data: {
      runId: "run_bound",
      chatId: "chat_bound"
    }
  }));
  client.handleWebSocketMessage(JSON.stringify({
    frame: "push",
    type: "chat.updated",
    data: {
      chatId: "chat_bound",
      lastRunContent: "真正的模型回复内容"
    }
  }));
  client.stop();

  assert.equal(statusUpdates.at(-1)?.presence, "away");
  assert.equal(statusUpdates.at(-1)?.latestPreview, "真正的模型回复内容");
});

test("desktop pet preview can be completed by agent-platform run finished fallback", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest({
    runId: "run_bound",
    chatId: "chat_bound",
    type: "run.start",
    message: "现在几点了"
  });
  projector.ingest({
    runId: "run_bound",
    chatId: "chat_bound",
    type: "run.complete",
    message: "现在是 09:24。"
  });

  const panel = projector.getPanel();
  assert.equal(panel.status, "done");
  assert.equal(panel.title, "现在是 09:24。");
  assert.equal(panel.summary, "现在是 09:24。");
  assert.equal(panel.items.some((item) => item.title === "现在是 09:24。"), true);
});

test("desktop pet preview keeps the latest body when completion is generic", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest({
    runId: "run_body",
    chatId: "chat_body",
    type: "run.start",
    message: "帮我总结一下"
  });
  projector.ingest({
    runId: "run_body",
    chatId: "chat_body",
    type: "content.delta",
    text: "正文内容会显示在折叠预览里。"
  });
  projector.ingest({
    runId: "run_body",
    chatId: "chat_body",
    type: "run.complete",
    message: "已完成"
  });

  const panel = projector.getPanel();
  assert.equal(panel.status, "done");
  assert.equal(panel.title, "正文内容会显示在折叠预览里。");
  assert.equal(panel.summary, "正文内容会显示在折叠预览里。");
});

test("desktop pet preview accumulates streamed reply chunks for completion preview", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest({
    runId: "run_chunks",
    chatId: "chat_chunks",
    type: "run.start",
    message: "帮我写一句话"
  });
  projector.ingest({
    runId: "run_chunks",
    chatId: "chat_chunks",
    type: "content.delta",
    text: "第一段"
  });
  projector.ingest({
    runId: "run_chunks",
    chatId: "chat_chunks",
    type: "content.delta",
    text: "第二段"
  });
  projector.ingest({
    runId: "run_chunks",
    chatId: "chat_chunks",
    type: "run.complete",
    message: "生成完成。"
  });

  const panel = projector.getPanel();
  assert.equal(panel.status, "done");
  assert.equal(panel.title, "第一段第二段");
  assert.equal(panel.summary, "第一段第二段");
});

test("desktop pet preview truncates model reply content to thirty characters", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest({
    runId: "run_long_reply",
    chatId: "chat_long_reply",
    type: "run.start",
    message: "帮我写一段话"
  });
  projector.ingest({
    runId: "run_long_reply",
    chatId: "chat_long_reply",
    type: "run.complete",
    message: "这是一段超过三十个字的模型回复内容，用来验证气泡只展示预览内容。"
  });

  const panel = projector.getPanel();
  assert.equal(panel.status, "done");
  assert.equal(panel.title, "这是一段超过三十个字的模型回复内容，用来验证气泡只展示...");
  assert.equal(panel.summary, "这是一段超过三十个字的模型回复内容，用来验证气泡只展示...");
});

test("desktop pet preview does not reuse the user request as a generic completion preview", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest({
    runId: "run_no_body",
    chatId: "chat_no_body",
    type: "run.start",
    message: "帮我写一份总结"
  });
  projector.ingest({
    runId: "run_no_body",
    chatId: "chat_no_body",
    type: "run.complete",
    message: "生成完成。"
  });

  const panel = projector.getPanel();
  assert.equal(panel.status, "done");
  assert.equal(panel.title, "暂无回复预览");
  assert.equal(panel.summary, "暂无回复预览");
});

test("desktop pet preview projects tool, artifact, and terminal events", () => {
  const projector = new DesktopPetPreviewProjector();

  projector.ingest({
    id: "evt_1",
    seq: 1,
    runId: "run_preview",
    chatId: "chat_preview",
    type: "run.start",
    createdAt: "2026-05-08T00:00:00.000Z",
    message: "已开始生成。"
  });
  projector.ingest({
    id: "evt_2",
    seq: 2,
    runId: "run_preview",
    chatId: "chat_preview",
    type: "tool.start",
    toolCallId: "tool_1",
    toolName: "bash",
    message: "正在运行命令",
    createdAt: "2026-05-08T00:00:01.000Z"
  });
  projector.ingest({
    id: "evt_3",
    seq: 3,
    runId: "run_preview",
    chatId: "chat_preview",
    type: "artifact.publish",
    artifactCount: 1,
    artifacts: [{ name: "report.md", sizeBytes: 20 }],
    createdAt: "2026-05-08T00:00:02.000Z"
  });
  const terminal = projector.ingest({
    id: "evt_4",
    seq: 4,
    runId: "run_preview",
    chatId: "chat_preview",
    type: "run.complete",
    message: "生成完成。",
    createdAt: "2026-05-08T00:00:03.000Z"
  });
  const panel = projector.getPanel();

  assert.equal(panel.status, "done");
  assert.equal(panel.title, "report.md");
  assert.equal(panel.chatId, "chat_preview");
  assert.equal(panel.artifactCount, 1);
  assert.equal(terminal.holdMs, 12000);
  assert.equal(panel.items.some((item) => item.kind === "tool"), true);
  assert.equal(panel.items.some((item) => item.kind === "artifact"), true);
});

test("desktop pet preview exposes readonly detail text for expanded items", () => {
  const projector = new DesktopPetPreviewProjector();

  projector.ingest({
    seq: 1,
    runId: "run_detail",
    chatId: "chat_detail",
    type: "run.start",
    message: "帮我检查项目里的桌面宠物展开状态是否能看清运行细节。",
    createdAt: "2026-05-08T00:00:00.000Z"
  });
  projector.ingest({
    seq: 2,
    runId: "run_detail",
    chatId: "chat_detail",
    type: "content.delta",
    text: "我正在读取 DesktopPetPreviewProjector 和 DesktopPet 组件，确认展开态只读展示具体内容。",
    createdAt: "2026-05-08T00:00:01.000Z"
  });
  projector.ingest({
    seq: 3,
    runId: "run_detail",
    chatId: "chat_detail",
    type: "tool.start",
    toolCallId: "tool_rg",
    toolName: "bash",
    data: {
      command: "rg desktop-pet src"
    },
    createdAt: "2026-05-08T00:00:02.000Z"
  });
  projector.ingest({
    seq: 4,
    runId: "run_detail",
    chatId: "chat_detail",
    type: "run.error",
    error: "模型调用失败：provider invalid_request_error",
    createdAt: "2026-05-08T00:00:03.000Z"
  });
  const panel = projector.getPanel();
  const contentItem = panel.items.find((item) => item.kind === "content");
  const toolItem = panel.items.find((item) => item.kind === "tool");
  const terminalItem = panel.items.find((item) => item.id === "run:terminal");

  assert.match(contentItem.detailText, /DesktopPetPreviewProjector/);
  assert.equal(toolItem.text, "正在执行");
  assert.match(toolItem.detailText, /rg desktop-pet src/);
  assert.match(terminalItem.detailText, /invalid_request_error/);
  assert.equal(toolItem.title, "正在使用 bash");
  assert.equal(toolItem.status, "running");
});

test("desktop pet preview keeps HITL readonly and redacts answers", () => {
  const projector = new DesktopPetPreviewProjector();

  projector.ingest({
    seq: 1,
    runId: "run_hitl",
    chatId: "chat_hitl",
    type: "awaiting.ask",
    awaitingId: "await_1",
    mode: "approval",
    approvals: [{
      id: "tool_bash",
      command: "chmod 777 ~/secret.sh",
      description: "放开脚本权限"
    }],
    createdAt: "2026-05-08T00:00:00.000Z"
  });
  projector.ingest({
    seq: 2,
    runId: "run_hitl",
    chatId: "chat_hitl",
    type: "awaiting.answer",
    awaitingId: "await_1",
    status: "answered",
    data: {
      params: [{ password: "should-not-render", decision: "approve" }]
    },
    createdAt: "2026-05-08T00:00:01.000Z"
  });
  const panel = projector.getPanel();

  assert.equal(panel.title, "思考中...");
  assert.equal(panel.awaiting, undefined);
  assert.equal(panel.items.some((item) => item.title === "已收到确认"), true);
  assert.match(panel.items.find((item) => item.kind === "awaiting").detailText, /chmod 777/);
  assert.doesNotMatch(JSON.stringify(panel), /should-not-render/);
});

test("desktop pet preview parses SSE frames and ignores done frames", () => {
  const parser = new DesktopPetSseParser();
  const first = parser.push([
    "event: message",
    "data: {\"type\":\"content.delta\",\"runId\":\"run_sse\",\"chatId\":\"chat_sse\",\"seq\":1,\"text\":\"hi\"}",
    "",
    ": heartbeat",
    "",
    "event: run.complete",
    "data: {\"runId\":\"run_sse\",\"chatId\":\"chat_sse\",\"seq\":2}",
    "",
    "event: message",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));

  assert.equal(first.done, true);
  assert.equal(first.errors.length, 0);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].type, "content.delta");
  assert.equal(first.events[1].type, "run.complete");
});

test("agent-platform pet stream attaches directly to backend SSE", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          "event: message",
          "data: {\"type\":\"content.delta\",\"runId\":\"run_stream\",\"chatId\":\"chat_stream\",\"seq\":4,\"text\":\"正在处理\"}",
          "",
          "event: run.complete",
          "data: {\"runId\":\"run_stream\",\"chatId\":\"chat_stream\",\"seq\":5}",
          "",
          "event: message",
          "data: [DONE]",
          "",
          ""
        ].join("\n")));
        controller.close();
      }
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const client = new AgentPlatformPetStreamClient({
    app: {},
    getServiceState: async () => ({
      status: "running",
      healthMeta: { webUrl: "http://127.0.0.1:11949" }
    }),
    issueAccessToken: async () => ({ ok: true, token: "token-direct" }),
    onEvent: (event) => events.push(event)
  });

  client.attach("run_stream", "chat_stream");
  await waitFor(() => events.length === 2);
  client.stop();

  const attachUrl = new URL(calls[0].url);
  assert.equal(attachUrl.pathname, "/api/attach");
  assert.equal(attachUrl.searchParams.get("runId"), "run_stream");
  assert.equal(attachUrl.searchParams.get("lastSeq"), "0");
  assert.equal(calls[0].init.headers.Authorization, "Bearer token-direct");
  assert.equal(events[0].type, "content.delta");
  assert.equal(events[1].type, "run.complete");
});

test("agent-platform pet stream degrades on expired attach sequence", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const debugMessages = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      code: "SEQ_EXPIRED",
      message: "sequence expired"
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new AgentPlatformPetStreamClient({
    app: {},
    getServiceState: async () => ({
      status: "running",
      healthMeta: { webUrl: "http://127.0.0.1:11949" }
    }),
    issueAccessToken: async () => ({ ok: true, token: "token-direct" }),
    onEvent: () => {},
    onDebug: (message) => debugMessages.push(message)
  });

  client.attach("run_expired", "chat_expired");
  await waitFor(() => debugMessages.some((message) => message.includes("SEQ_EXPIRED")));
  await new Promise((resolve) => setTimeout(resolve, 900));
  client.stop();

  assert.equal(calls.length, 1);
  assert.match(debugMessages.join("\n"), /SEQ_EXPIRED/);
});

test("desktop pet preview dedupes streamed events and ignores stale runs", () => {
  const projector = new DesktopPetPreviewProjector();

  projector.ingest({ id: "evt_same", seq: 1, runId: "run_1", chatId: "chat_1", type: "run.start" });
  projector.ingest({ id: "evt_same", seq: 1, runId: "run_1", chatId: "chat_1", type: "tool.start", toolName: "ignored" });
  projector.ingest({ seq: 2, runId: "run_other", chatId: "chat_2", type: "tool.start", toolName: "other" });

  const panel = projector.getPanel();
  assert.equal(panel.runId, "run_1");
  assert.equal(panel.items.some((item) => item.text.includes("ignored")), false);
  assert.equal(panel.items.some((item) => item.text.includes("other")), false);
});

test("desktop pet preview sanitizer hides obvious sensitive values", () => {
  assert.equal(
    sanitizeDesktopPetPreviewText("token=abc123 password: secret", 80).includes("abc123"),
    false
  );
  assert.equal(
    sanitizeDesktopPetPreviewText({ data: { command: "curl -H authorization=Bearer-abc123 https://example.test" } }, 80).includes("Bearer-abc123"),
    false
  );
  assert.equal(sanitizeDesktopPetPreviewText("data:image/png;base64,abc", 80), "[已隐藏数据]");
});

test("agent-platform read push does not clear a finished bound agent reminder", () => {
  const running = applyAgentPlatformPetPush(null, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.started",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-finished"
    }
  });
  const finished = applyAgentPlatformPetPush(running, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "run.finished",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-finished"
    }
  });
  const read = applyAgentPlatformPetPush(finished, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.read",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-finished"
    }
  });
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: read
  });

  assert.equal(read?.presence, "away");
  assert.equal(state.status, "done");
  assert.equal(state.hint, "暂无回复预览");
});

test("agent-platform read push replays a recent completion after snapshot refresh", () => {
  const refreshed = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 0 } }],
    chats: [{ chatId: "chat-finished", agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, updatedAt: 9, lastRunContent: "小宅回复内容" }]
  });
  const reminded = applyAgentPlatformCompletionReminder(refreshed, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.read",
    data: {
      agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
      chatId: "chat-finished"
    }
  }, new Map([["chat-finished", Date.parse("2026-05-08T00:00:00.000Z")]]), Date.parse("2026-05-08T00:01:00.000Z"));
  const state = createDesktopPetState({
    enabled: true,
    lastVisible: true,
    unreadCount: 0,
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY
  }, {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: reminded
  });

  assert.equal(refreshed.presence, "available");
  assert.equal(reminded?.presence, "away");
  assert.equal(reminded?.latestPreview, "小宅回复内容");
  assert.equal(state.status, "done");
  assert.equal(state.hint, "小宅回复内容");
});

test("agent-platform completion reminder ignores pushes from other agents", () => {
  const current = buildStatusFromPlatform({
    boundAgentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
    agents: [{ key: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, name: "小宅", stats: { unreadCount: 0 } }],
    chats: [{ chatId: "chat-finished", agentKey: DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, updatedAt: 9 }]
  });
  const reminded = applyAgentPlatformCompletionReminder(current, DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, {
    frame: "push",
    type: "chat.read",
    data: {
      agentKey: "other-agent",
      chatId: "chat-finished"
    }
  }, new Map([["chat-finished", Date.now()]]));

  assert.equal(reminded, current);
  assert.equal(reminded?.presence, "available");
});
