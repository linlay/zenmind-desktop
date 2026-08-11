import test from "node:test";
import assert from "node:assert/strict";

const {
  buildSidebarContextMenuPolicy,
  normalizeSidebarContextMenuRequest
} = await import("../dist-electron/main/sidebar-context-menu-policy.js");
const {
  registerSidebarContextMenuIpcHandlers
} = await import("../dist-electron/main/ipc/sidebar-context-menu-handlers.js");

function ids(target) {
  return buildSidebarContextMenuPolicy(target).map((item) => item.id);
}

test("sidebar group context menus preserve sorting and creation actions", () => {
  const assistants = buildSidebarContextMenuPolicy({
    kind: "group",
    groupId: "assistants",
    menuScope: "all",
    sortMode: "byTime",
    canCreateProject: false,
    canCreateChat: false
  });
  assert.deepEqual(assistants.map((item) => item.id), [
    "group.sort-by-time",
    "group.sort-by-name",
    "group.new-project"
  ]);
  assert.equal(assistants[0].checked, true);
  assert.equal(assistants[1].checked, false);
  assert.equal(assistants[2].enabled, false);
  assert.deepEqual(ids({
    kind: "group",
    groupId: "assistants",
    menuScope: "sort",
    sortMode: "byName",
    canCreateProject: true,
    canCreateChat: false
  }), ["group.sort-by-time", "group.sort-by-name"]);

  assert.deepEqual(ids({
    kind: "group",
    groupId: "chats",
    menuScope: "all",
    sortMode: "byName",
    canCreateProject: true,
    canCreateChat: true
  }), ["group.new-chat"]);
  assert.deepEqual(ids({
    kind: "group",
    groupId: "webs",
    menuScope: "all",
    sortMode: "byName",
    canCreateProject: true,
    canCreateChat: true
  }), ["group.add-website", "group.import-webapp"]);
});

test("sidebar entity context menus expose only their fixed action sets", () => {
  assert.deepEqual(ids({ kind: "agent", canOpenWorkspace: true }), [
    "agent.open-workspace",
    "agent.edit"
  ]);
  assert.deepEqual(ids({ kind: "chat", workPanelOpen: false }), [
    "chat.workPanel.open",
    "chat.export",
    "chat.rename",
    "chat.archive",
    "chat.delete"
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
      menuScope: "sort",
      sortMode: "byTime",
      canCreateProject: false,
      canCreateChat: false
    }
  }), null);
});

test("sidebar native menu is owned by the main window and returns only the clicked action", async () => {
  let invokeHandler;
  let popupOptions;
  let builtTemplate;
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
            template.find((item) => item.id === "chat.rename").click();
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
    ["chat.workPanel.open", "chat.export", "chat.rename", "chat.archive", "chat.delete"]
  );

  const rejected = await invokeHandler({ sender: {} }, {
    x: 1,
    y: 2,
    target: { kind: "chat", workPanelOpen: false }
  });
  assert.deepEqual(rejected, { actionId: null });
});
