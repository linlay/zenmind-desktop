import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerAssistantIpcHandlers } = require(
  "../dist-electron/main/ipc/assistant-handlers.js",
);
const { readDesktopProfileFromRoot } = require(
  "../dist-electron/main/desktop-profile-store.js",
);
const { getDesktopConfigRoot } = require(
  "../dist-electron/main/user-paths.js",
);
const projectRoot = path.resolve(import.meta.dirname, "..");

function registerChatOrderHandler(t, callAgentPlatform) {
  const homePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "zenmind-chat-order-desktop-"),
  );
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const app = {
    getPath(name) {
      if (name === "home") return homePath;
      throw new Error(`unexpected app path ${name}`);
    },
    once() {},
  };
  const handlers = new Map();
  const calls = [];
  let refreshCount = 0;
  registerAssistantIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    assistantBridge: {},
    assistantNavigationStatusClient: {
      async refreshNow() {
        refreshCount += 1;
        return {};
      },
    },
    desktopActionRendererRequests: new Map(),
    desktopActionConfirmationRequests: new Map(),
    desktopActionOptions: {},
    app,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: async (_app, endpoint, options) => {
      calls.push({ endpoint, options });
      return callAgentPlatform(endpoint, options);
    },
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "darwin",
  });
  return {
    app,
    calls,
    handler: handlers.get("assistant.updateChatOrder"),
    getRefreshCount: () => refreshCount,
  };
}

test("Desktop persists the Platform chat mode and refreshes the canonical navigation snapshot", async (t) => {
  const fixture = registerChatOrderHandler(t, async () => ({
    sortMode: "manual",
    updatedAt: 1_787_414_400_000,
  }));
  const result = await fixture.handler({}, {
    operation: "move",
    chatId: "chat-old",
    beforeChatId: "chat-new",
  });
  assert.equal(result.ok, true);
  assert.equal(result.sortMode, "manual");
  assert.equal(result.updatedAt, 1_787_414_400_000);
  assert.ok(result.message);
  assert.deepEqual(fixture.calls, [{
    endpoint: "/api/chats/order",
    options: {
      method: "PUT",
      body: {
        operation: "move",
        chatId: "chat-old",
        beforeChatId: "chat-new",
      },
    },
  }]);
  assert.equal(fixture.getRefreshCount(), 1);
  assert.equal(
    readDesktopProfileFromRoot(
      getDesktopConfigRoot(fixture.app, "darwin"),
    ).navigation.chatSortMode,
    "manual",
  );
});

test("Desktop rejects invalid moves before Platform and preserves the cached mode on failure", async (t) => {
  t.mock.method(console, "warn", () => {});
  const fixture = registerChatOrderHandler(t, async () => {
    throw new Error("platform write failed");
  });
  const invalid = await fixture.handler({}, {
    operation: "move",
    chatId: "chat-a",
    beforeChatId: "chat-a",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.sortMode, "recent");
  assert.equal(fixture.calls.length, 0);

  const failed = await fixture.handler({}, {
    operation: "set_mode",
    sortMode: "manual",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.sortMode, "recent");
  assert.match(failed.message, /platform write failed/u);
  assert.equal(fixture.getRefreshCount(), 0);
  assert.equal(
    readDesktopProfileFromRoot(
      getDesktopConfigRoot(fixture.app, "darwin"),
    ).navigation.chatSortMode,
    "recent",
  );
});

test("expanded Chats drag with a portaled name preview and insertion line", () => {
  const sidebar = fs.readFileSync(
    path.join(projectRoot, "src/renderer/app-shell/navigation/AppSidebar.tsx"),
    "utf8",
  );
  const navigationStyles = fs.readFileSync(
    path.join(projectRoot, "src/renderer/styles/navigation.css"),
    "utf8",
  );
  const appShell = fs.readFileSync(
    path.join(projectRoot, "src/renderer/app-shell/AppShell.tsx"),
    "utf8",
  );
  assert.doesNotMatch(sidebar, /sidebar-chat-drag-handle/u);
  assert.match(sidebar, /<DragOverlay[\s\S]*?sidebar-chat-drag-overlay[\s\S]*?document\.body/u);
  assert.match(sidebar, /getAssistantChatDisplayText\(activeChatDragItem, t\)/u);
  assert.match(sidebar, /setActiveChatDragId\(String\(event\.active\.id\)\)/u);
  assert.match(sidebar, /setActiveChatDragId\(""\)/u);
  assert.match(sidebar, /renderItem\(\{[\s\S]*?attributes: sortable\.attributes,[\s\S]*?listeners: sortable\.listeners/u);
  assert.match(sidebar, /const sortable = roving && assistantChatOrderingSupported/u);
  assert.match(sidebar, /onDragOver=\{handleChatDragOver\}/u);
  assert.match(sidebar, /dropIndicator\.position === "before"[\s\S]*?beforeChatId[\s\S]*?afterChatId/u);
  assert.match(navigationStyles, /has-drop-indicator-before::before[\s\S]*?has-drop-indicator-after::after/u);
  assert.doesNotMatch(navigationStyles, /sidebar-chat-drag-handle/u);
  assert.match(navigationStyles, /\.sidebar-navigation-drag-overlay\s*\{[\s\S]*?opacity:\s*0\.78;[\s\S]*?pointer-events:\s*none;/u);
  assert.match(sidebar, /setChatOrderMutationPending\(true\)[\s\S]*?onUpdateAssistantChatOrder\(request\)[\s\S]*?setChatOrderMutationPending\(false\)/u);
  assert.match(appShell, /setAssistantNavChatItems\(reordered\)[\s\S]*?setAssistantChatSortMode\("manual"\)/u);
  assert.match(appShell, /if \(!result\.ok\)[\s\S]*?setAssistantNavChatItems\(previousItems\)[\s\S]*?setAssistantChatSortMode\(previousMode\)/u);
});
