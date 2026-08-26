import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

const {
  buildSidebarContextMenuPolicy,
  normalizeSidebarContextMenuRequest
} = await import("../dist-electron/main/sidebar-context-menu-policy.js");
const {
  registerSidebarContextMenuIpcHandlers,
  resolveSidebarContextMenuLabelKey
} = await import("../dist-electron/main/ipc/sidebar-context-menu-handlers.js");

function ids(target) {
  return buildSidebarContextMenuPolicy(target).map((item) => item.id);
}

function actionIds(target) {
  return buildSidebarContextMenuPolicy(target).flatMap((item) =>
    "submenu" in item ? item.submenu.map((action) => action.id) : [item.id]
  );
}

test("sidebar group context menus expose creation actions without project sorting", () => {
  const assistants = buildSidebarContextMenuPolicy({
    kind: "group",
    groupId: "assistants",
    canCreateProject: false,
    canCreateChat: false,
    chatSortMode: "recent",
    chatOrderingSupported: true
  });
  assert.deepEqual(assistants.map((item) => item.id), ["group.new-project"]);
  assert.equal(assistants[0].enabled, false);

  assert.deepEqual(ids({
    kind: "group",
    groupId: "chats",
    canCreateProject: true,
    canCreateChat: true,
    chatSortMode: "manual",
    chatOrderingSupported: true
  }), ["group.chat-sort-recent", "group.chat-sort-manual", "group.new-chat"]);
  assert.deepEqual(ids({
    kind: "group",
    groupId: "chats",
    canCreateProject: true,
    canCreateChat: true,
    chatSortMode: "manual",
    chatOrderingSupported: true,
    menuScope: "sort"
  }), ["group.chat-sort-recent", "group.chat-sort-manual"]);
  assert.deepEqual(ids({
    kind: "group",
    groupId: "webs",
    canCreateProject: true,
    canCreateChat: true,
    chatSortMode: "recent",
    chatOrderingSupported: false
  }), ["group.add-website", "group.import-webapp"]);
});

test("sidebar entity context menus expose only their fixed action sets", () => {
  const agentItems = buildSidebarContextMenuPolicy({
    kind: "agent",
    canRevealWorkspace: true,
    canOpenProjectEditor: true
  });
  assert.deepEqual(agentItems.map((item) => item.id), [
    "agent.reveal-workspace",
    "agent.open-project-editor",
    "agent.edit"
  ]);
  const disabledAgentItems = buildSidebarContextMenuPolicy({
    kind: "agent",
    canRevealWorkspace: false,
    canOpenProjectEditor: false
  });
  assert.equal(disabledAgentItems[0].enabled, false);
  assert.equal(disabledAgentItems[1].enabled, false);
  assert.equal(disabledAgentItems[2].enabled, true);
  const chatItems = buildSidebarContextMenuPolicy({
    kind: "chat",
    workPanelOpen: false
  });
  assert.deepEqual(chatItems.map((item) => item.id), [
    "chat.workPanel.open",
    "chat.exportMenu",
    "chat.share",
    "chat.rename",
    "chat.archive",
    "chat.delete",
    "chat.info"
  ]);
  const exportMenu = chatItems.find((item) => item.id === "chat.exportMenu");
  assert.ok(exportMenu && "submenu" in exportMenu);
  assert.deepEqual(exportMenu.submenu.map((item) => item.id), [
    "chat.export",
    "chat.exportHtml"
  ]);
  assert.equal(ids({ kind: "chat", workPanelOpen: true })[0], "chat.workPanel.close");
  assert.deepEqual(ids({
    kind: "web",
    webKind: "website",
    openMode: "window",
    canClose: true,
    canOpenAlternative: false,
    canExport: false,
    canRemove: false,
    showRemove: false
  }), ["web.close"]);
  assert.deepEqual(ids({
    kind: "web",
    webKind: "webapp",
    openMode: "dialog",
    canClose: true,
    canOpenAlternative: true,
    canExport: true,
    canRemove: true,
    showRemove: true
  }), [
    "web.close",
    "web.open-in-workspace",
    "web.export",
    "web.remove"
  ]);
});

test("sidebar renderer accepts every chat action exposed by the native menu", () => {
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  const chatActionGate = sidebarSource.match(
    /if \(target\.kind === "chat"\) \{([\s\S]*?)\n    \}/u
  )?.[1] ?? "";
  for (const actionId of actionIds({ kind: "chat" })) {
    assert.match(chatActionGate, new RegExp(`"${actionId.replace(".", "\\.")}"`, "u"));
  }
});

test("sidebar chat sharing remains available from the menu without a header button", () => {
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8"
  );
  assert.doesNotMatch(sidebarSource, /sidebar-chats-share-button/u);
  assert.match(sidebarSource, /actionId === "chat\.share"/u);
  assert.match(sidebarSource, /conversationShareDialog\.open\(chat\.chatId, chat\.chatName\)/u);
});

test("sidebar native context request validation rejects injected and malformed fields", () => {
  const valid = normalizeSidebarContextMenuRequest({
    x: 10.4,
    y: 20.6,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(valid, {
    x: 10,
    y: 21,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.equal(normalizeSidebarContextMenuRequest({
    x: 1,
    y: 2,
    target: { kind: "chat", workPanelOpen: false, label: "Injected" }
  }), null);
  assert.deepEqual(normalizeSidebarContextMenuRequest({
    x: 4,
    y: 8,
    target: {
      kind: "agent",
      canRevealWorkspace: false,
      canOpenProjectEditor: true
    }
  }), {
    x: 4,
    y: 8,
    target: {
      kind: "agent",
      canRevealWorkspace: false,
      canOpenProjectEditor: true
    }
  });
  assert.equal(normalizeSidebarContextMenuRequest({
    x: 4,
    y: 8,
    target: { kind: "agent", canRevealWorkspace: true }
  }), null);
  assert.equal(normalizeSidebarContextMenuRequest({
    x: Number.POSITIVE_INFINITY,
    y: 2,
    target: { kind: "chat", workPanelOpen: false }
  }), null);
  assert.equal(normalizeSidebarContextMenuRequest({
    x: 1,
    y: 2,
    target: { kind: "command", command: "arbitrary" }
  }), null);
  assert.equal(normalizeSidebarContextMenuRequest({
    x: 1,
    y: 2,
    target: {
      kind: "group",
      groupId: "webs",
      canCreateProject: false,
      canCreateChat: false,
      chatSortMode: "recent",
      chatOrderingSupported: false,
      sortMode: "byTime"
    }
  }), null);
  assert.equal(normalizeSidebarContextMenuRequest({
    x: 1,
    y: 2,
    target: {
      kind: "group",
      groupId: "chats",
      canCreateProject: false,
      canCreateChat: true,
      chatSortMode: "recent",
      chatOrderingSupported: true,
      menuScope: "create"
    }
  }), null);
});

test("workspace reveal menu uses native platform terminology", () => {
  assert.equal(
    resolveSidebarContextMenuLabelKey("agent.reveal-workspace", "darwin"),
    "sidebar.agent.revealWorkspaceFinder"
  );
  assert.equal(
    resolveSidebarContextMenuLabelKey("agent.reveal-workspace", "win32"),
    "sidebar.agent.revealWorkspaceExplorer"
  );
  assert.equal(
    resolveSidebarContextMenuLabelKey("agent.reveal-workspace", "linux"),
    "sidebar.agent.revealWorkspaceFileManager"
  );
  assert.equal(
    resolveSidebarContextMenuLabelKey("chat.info", "darwin"),
    "sidebar.chat.info"
  );
  assert.equal(
    resolveSidebarContextMenuLabelKey("chat.exportMenu", "darwin"),
    "sidebar.chat.exportMenu"
  );
});

test("sidebar native menu is owned by the main window and returns only the clicked action", async () => {
  let invokeHandler;
  let popupOptions;
  let builtTemplate;
  let actionToClick = "chat.rename";
  const sender = {};
  const ownerWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 200, width: 300, height: 400 })
  };
  registerSidebarContextMenuIpcHandlers({
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
            const item = template
              .flatMap((entry) => [
                entry,
                ...(Array.isArray(entry.submenu) ? entry.submenu : [])
              ])
              .find((entry) => entry.id === actionToClick);
            assert.ok(item);
            item.click();
            options.callback();
          }
        };
      }
    }
  });

  const result = await invokeHandler({ sender }, {
    x: 999,
    y: -10,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(result, { actionId: "chat.rename" });
  assert.equal(popupOptions.window, ownerWindow);
  assert.equal(popupOptions.x, 299);
  assert.equal(popupOptions.y, 0);
  assert.deepEqual(
    builtTemplate.filter((item) => item.type !== "separator").map((item) => item.id),
    ["chat.workPanel.open", "chat.exportMenu", "chat.share", "chat.rename", "chat.archive", "chat.delete", "chat.info"]
  );
  assert.equal(builtTemplate.filter((item) => item.type === "separator").length, 3);
  const exportMenu = builtTemplate.find((item) => item.id === "chat.exportMenu");
  assert.ok(exportMenu);
  assert.equal(exportMenu.click, undefined);
  assert.ok(Array.isArray(exportMenu.submenu));
  assert.deepEqual(exportMenu.submenu.map((item) => item.id), [
    "chat.export",
    "chat.exportHtml"
  ]);
  assert.equal(exportMenu.submenu.every((item) => typeof item.click === "function"), true);

  actionToClick = "chat.export";
  const markdownResult = await invokeHandler({ sender }, {
    x: 10,
    y: 20,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(markdownResult, { actionId: "chat.export" });

  actionToClick = "chat.exportHtml";
  const htmlResult = await invokeHandler({ sender }, {
    x: 10,
    y: 20,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(htmlResult, { actionId: "chat.exportHtml" });

  const rejected = await invokeHandler({ sender: {} }, {
    x: 1,
    y: 2,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(rejected, { actionId: null });
});
