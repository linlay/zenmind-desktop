import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerWorkPanelWebDialogIpc, workPanelWebDialogOptions, WORK_PANEL_DIALOG_RESTORE_URL } from "../dist-electron/main/modules/work-panel/web-dialog.js";
import { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from "../dist-electron/shared/work-panel.js";

function setup({ failLoad = false } = {}) {
  const created = [], registered = [], sent = [];
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  owner.isMinimized = () => false;
  owner.show = () => { owner.visible = true; };
  owner.focus = () => { owner.focused = true; };
  owner.webContents = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, send: (...args) => sent.push(args) });
  const guest = (id) => Object.assign(new EventEmitter(), {
    id, hostWebContents: owner.webContents, destroyed: false,
    isDestroyed() { return this.destroyed; }, getType: () => "webview",
    close() { this.destroyed = true; this.emit("destroyed"); },
    getURL: () => "https://example.test/current?q=1", getTitle: () => "Current page",
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }, isLoading: () => false,
    setWindowOpenHandler() {}, reload() { this.reloaded = true; },
  });
  const source = guest(2);
  const snapshot = {
    surfaceId: "wp-1", registrationId: "original-registration", surfaceKind: "chat-work-panel", surfaceRole: "workpanel-web",
    surfaceLevel: "child", interaction: "interactive", parentSurfaceId: "main-chat", ownerChatId: "chat-1", ownerWebContentsId: 1,
    url: "https://example.test", label: "Website", active: false, activeTabId: "tab-1",
    tabs: [{ tabId: "tab-1", webContentsId: 2, title: "Website", currentUrl: "https://example.test" }],
  };
  class Window extends EventEmitter {
    constructor(options) {
      super(); assert.equal(source.isDestroyed(), true, "old guest must be released before a new window is created");
      this.options = options; this.webContents = guest(3); this.content = guest(4); created.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.content.close(); this.emit("closed"); }
    close() { this.emit("close", { preventDefault() {} }); }
    setMenuBarVisibility() {}
    async loadURL(url) {
      this.url = url;
      this.webContents.emit("did-attach-webview", {}, this.content);
      if (failLoad) this.content.emit("did-fail-load", {}, -2, "failed", "", true);
      else this.content.emit("did-finish-load");
    }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    isMinimized() { return false; }
  }
  let handler;
  registerWorkPanelWebDialogIpc({ handle: (_channel, next) => { handler = next; } }, () => owner, {
    resolveWebviewSurfaceTarget: () => snapshot,
    getRegisteredSurfaceSnapshot: () => ({ registered: snapshot, tabs: snapshot.tabs }),
    registerSurface: (next, ownerId) => { registered.push({ ...next, ownerWebContentsId: ownerId }); return true; },
    unregisterSurface: () => true,
    retainWorkPanelDialogSurface: () => true,
    releaseWorkPanelDialogSurface: () => {},
  }, Window, { fromId: id => id === 2 ? source : null });
  return { owner, source, snapshot, created, registered, sent, handler, event: { sender: owner.webContents, senderFrame: owner.webContents.mainFrame } };
}

test("dialog transfer rejects foreign senders, non-WorkPanel guests and duplicate preparations", async () => {
  const { handler, event, source, owner, created } = setup();
  const request = { action: "prepare", sourceGuestId: 2 };
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) assert.deepEqual(await handler(bad, request), { ok: false });
  source.hostWebContents = {};
  assert.deepEqual(await handler(event, request), { ok: false });
  source.hostWebContents = owner.webContents;
  source.getURL = () => "file:///tmp/page.html";
  assert.deepEqual(await handler(event, request), { ok: false });
  source.getURL = () => "https://example.test/current";
  const prepared = await handler(event, request);
  assert.equal(prepared.ok, true);
  assert.deepEqual(await handler(event, request), { ok: false });
  assert.equal(created.length, 0);
  await handler(event, { action: "close", transferId: prepared.transferId });
});

test("dialog preserves surface/Chat/parent identity with one guest and normal window stacking", async () => {
  const { handler, event, created, registered, snapshot, sent, owner } = setup();
  const prepared = await handler(event, { action: "prepare", sourceGuestId: 2 });
  assert.equal(prepared.surfaceId, snapshot.surfaceId);
  assert.deepEqual(await handler(event, { action: "open", transferId: prepared.transferId }), { ok: true });
  const dialog = created[0], next = registered.at(-1);
  for (const key of ["surfaceId", "ownerChatId", "parentSurfaceId", "surfaceKind", "surfaceRole", "ownerWebContentsId"]) assert.equal(next[key], snapshot[key], key);
  assert.notEqual(next.registrationId, snapshot.registrationId, "stale embedded cleanup must not remove the dialog registration");
  assert.equal(next.tabs[0].webContentsId, dialog.content.id);
  assert.equal(dialog.options.parent, undefined);
  assert.equal(dialog.options.alwaysOnTop, undefined);
  assert.equal(dialog.options.modal, undefined);
  assert.equal(dialog.options.webPreferences.preload, undefined);
  assert.equal(dialog.visible && dialog.focused, true);
  dialog.close();
  assert.equal(dialog.isDestroyed(), false, "close goes through renderer draft protection");
  assert.equal(sent[0][1], prepared.transferId);
  assert.deepEqual(await handler(event, { action: "reload", transferId: prepared.transferId }), { ok: true });
  assert.equal(dialog.content.reloaded, true);
  await handler(event, { action: "close", transferId: prepared.transferId });
  assert.equal(dialog.isDestroyed(), true);
  assert.equal(owner.listenerCount("closed"), 0);
});

test("load failure releases destination and owner listeners", async () => {
  const { handler, event, created, owner } = setup({ failLoad: true });
  const prepared = await handler(event, { action: "prepare", sourceGuestId: 2 });
  assert.deepEqual(await handler(event, { action: "open", transferId: prepared.transferId }), { ok: false });
  assert.equal(created[0].isDestroyed(), true);
  assert.equal(owner.listenerCount("closed"), 0);
});

test("dialog platform chrome remains native without parent or topmost flags", () => {
  assert.equal(workPanelWebDialogOptions("Website", "darwin").titleBarStyle, "default");
  assert.equal(workPanelWebDialogOptions("Website", "win32").autoHideMenuBar, true);
});

test("presentation retains logical item, avoids duplicate reopen, survives navigation and cleans up on close", () => {
  const first = reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, { type: "openItem", ownerChatId: "chat-1", descriptor: { kind: "web", url: "https://one.test" } });
  const second = reduceWorkPanelCommand(first.nextState, { type: "openItem", ownerChatId: "chat-1", descriptor: { kind: "web", url: "https://two.test" } });
  const dialog = { ownerChatId: "chat-1", itemId: second.item.itemId, surfaceId: "wp-1", transferId: "transfer-1" };
  const moved = reduceWorkPanelCommand(second.nextState, { type: "setDialogPresentation", ownerChatId: "chat-1", itemId: second.item.itemId, dialog });
  assert.equal(moved.nextState.workspaces[0].items.length, 2);
  assert.equal(moved.nextState.workspaces[0].activeItemId, first.item.itemId);
  const reopened = reduceWorkPanelCommand(moved.nextState, { type: "openItem", ownerChatId: "chat-1", descriptor: second.item.descriptor });
  assert.equal(reopened.item.itemId, second.item.itemId);
  assert.equal(reopened.nextState.workspaces[0].items.length, 2);
  assert.deepEqual(reopened.nextState.dialogItems, [dialog]);
  const hidden = reduceWorkPanelCommand(reopened.nextState, { type: "hideWorkspace", ownerChatId: "chat-1" });
  assert.deepEqual(hidden.nextState.dialogItems, [dialog]);
  const restored = reduceWorkPanelCommand(hidden.nextState, { type: "setDialogPresentation", ownerChatId: "chat-1", itemId: second.item.itemId, dialog: null });
  assert.equal(restored.nextState.workspaces[0].activeItemId, second.item.itemId);
  assert.deepEqual(restored.nextState.dialogItems, []);
  const closed = reduceWorkPanelCommand(hidden.nextState, { type: "closeItem", ownerChatId: "chat-1", itemId: second.item.itemId });
  assert.deepEqual(closed.nextState.dialogItems, []);
  assert.equal(closed.nextState.workspaces[0].items.length, 1);
});

test("Main-only dialog reservation survives parent remount without changing Chat ownership", async () => {
  const { createBrowserSurfaceRegistry } = await import("../dist-electron/main/modules/web-surfaces/browser-surface-registry.js");
  const { createSurfaceIdentity, createChatChildSurfaceIdentity } = await import("../dist-electron/shared/surface-identity.js");
  const guests = new Map([1, 2, 3].map(id => [id, { id, getType: () => "webview", isDestroyed: () => false }]));
  const registry = createBrowserSurfaceRegistry({ webContents: { fromId: id => guests.get(id), getAllWebContents: () => [...guests.values()] }, listWebEntries: () => ({ items: [] }), getCurrentPageSnapshot: () => null });
  const tab = (id, url) => ({ tabId: `tab-${id}`, webContentsId: id, currentUrl: url, title: "Page", canGoBack: false, canGoForward: false, isLoading: false });
  const root = { ...createSurfaceIdentity("main-chat", "", { ownerChatId: "chat-1" }), registrationId: "root-1", surfaceKind: "service", surfaceType: "agent-chat", serviceId: "agent-webclient", pageRoute: "/agent/agent-1", pageRouteIdentity: "/agent/agent-1?chatId=chat-1", label: "Chat", url: "http://127.0.0.1:7788/agent/agent-1?chatId=chat-1", active: true, tabs: [tab(1, "http://127.0.0.1:7788/agent/agent-1?chatId=chat-1")], activeTabId: "tab-1" };
  assert.equal(registry.registerSurface(root, 7), true);
  const key = "web:https://example.test/";
  const child = { ...createChatChildSurfaceIdentity("workpanel-web", key, "chat-1"), surfaceIdentityKey: key, registrationId: "embedded-1", surfaceKind: "chat-work-panel", surfaceType: "chat-work-panel", label: "Website", url: "https://example.test/", active: false, tabs: [tab(2, "https://example.test/")], activeTabId: "tab-2" };
  assert.equal(registry.registerSurface(child, 7), true);
  assert.equal(registry.retainWorkPanelDialogSurface(child.surfaceId, child.registrationId, 99, "dialog-1"), false);
  assert.equal(registry.retainWorkPanelDialogSurface(child.surfaceId, child.registrationId, 7, "dialog-1"), true);
  assert.equal(registry.registerSurface(child, 7), false, "late source registration cannot take back a reserved surface");
  registry.unregisterSurface({ surfaceId: child.surfaceId, registrationId: child.registrationId }, 7);
  guests.delete(2);
  const detached = { ...child, registrationId: "dialog-1", tabs: [tab(3, "https://example.test/current")], activeTabId: "tab-3" };
  assert.equal(registry.registerSurface(detached, 7), true);
  registry.unregisterSurface({ surfaceId: root.surfaceId, registrationId: root.registrationId }, 7);
  assert.equal(registry.listChatWorkPanelSurfaces()[0].ownerChatId, "chat-1");
  assert.equal(registry.resolveWebviewSurfaceTarget(3).surfaceId, child.surfaceId);
  assert.equal(registry.registerSurface(detached, 7), true, "navigation updates work while Main Chat is absent");
  assert.equal(registry.registerSurface({ ...detached, registrationId: "forged" }, 7), false);
  const otherRoot = { ...root, ownerChatId: "chat-2", registrationId: "root-2", pageRouteIdentity: "/agent/agent-1?chatId=chat-2", tabs: [tab(1, "http://127.0.0.1:7788/agent/agent-1?chatId=chat-2")] };
  assert.equal(registry.registerSurface(otherRoot, 7), true);
  assert.equal(registry.registerSurface(detached, 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(3).ownerChatId, "chat-1");
  registry.releaseWorkPanelDialogSurface(child.surfaceId, detached.registrationId);
  registry.unregisterSurface({ surfaceId: child.surfaceId, registrationId: detached.registrationId }, 7);
  assert.equal(registry.resolveWebviewSurfaceTarget(3), null);
});


test("trusted shell restore control returns current URL only after releasing the dialog guest", async () => {
  const { handler, event, created, sent, owner } = setup();
  const prepared = await handler(event, { action: "prepare", sourceGuestId: 2 });
  await handler(event, { action: "open", transferId: prepared.transferId });
  const dialog = created[0];
  assert.match(decodeURIComponent(dialog.url), /Restore to WorkPanel|还原到 WorkPanel/u);
  let prevented = false;
  dialog.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, WORK_PANEL_DIALOG_RESTORE_URL);
  assert.equal(prevented, true);
  assert.deepEqual(sent.at(-1), ["chatWorkPanel.webDialogRestoreRequested", prepared.transferId]);
  const count = sent.length;
  dialog.content.emit("will-navigate", { preventDefault() {} }, WORK_PANEL_DIALOG_RESTORE_URL);
  assert.equal(sent.length, count, "remote page navigation cannot invoke the shell control");
  dialog.content.getURL = () => "https://example.test/new-page?q=latest#section";
  const restored = await handler(event, { action: "restore", transferId: prepared.transferId });
  assert.deepEqual(restored, { ok: true, url: "https://example.test/new-page?q=latest#section", surfaceId: "wp-1", ownerChatId: "chat-1" });
  assert.equal(dialog.content.isDestroyed(), true);
  assert.equal(owner.visible && owner.focused, true);
  assert.deepEqual(await handler(event, { action: "restore", transferId: prepared.transferId }), { ok: false });
});

test("restoration changes the displayed URL without changing WorkPanel item identity or losing it on subsequent commands", () => {
  const opened = reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, { type: "openItem", ownerChatId: "chat-1", descriptor: { kind: "web", url: "https://example.test/original" } });
  const dialog = { ownerChatId: "chat-1", itemId: opened.item.itemId, surfaceId: "wp-1", transferId: "transfer-1" };
  const detached = reduceWorkPanelCommand(opened.nextState, { type: "setDialogPresentation", ownerChatId: "chat-1", itemId: opened.item.itemId, dialog });
  const restored = reduceWorkPanelCommand(detached.nextState, { type: "setDialogPresentation", ownerChatId: "chat-1", itemId: opened.item.itemId, dialog: null, restoreUrl: "https://example.test/latest" });
  const key = `chat-1\u0000${opened.item.itemId}`;
  assert.equal(restored.item.itemId, opened.item.itemId);
  assert.equal(restored.item.stableKey, opened.item.stableKey);
  assert.equal(restored.nextState.webItemUrls[key], "https://example.test/latest");
  assert.equal(restored.nextState.workspaces[0].activeItemId, opened.item.itemId);
  assert.deepEqual(restored.nextState.visibleOwnerChatIds, ["chat-1"]);
  const shown = reduceWorkPanelCommand(restored.nextState, { type: "showWorkspace", ownerChatId: "chat-1" });
  assert.equal(shown.nextState.webItemUrls[key], "https://example.test/latest");
  const reopened = reduceWorkPanelCommand(shown.nextState, { type: "openItem", ownerChatId: "chat-1", descriptor: opened.item.descriptor });
  assert.equal(reopened.nextState.workspaces[0].items.length, 1);
  const closed = reduceWorkPanelCommand(reopened.nextState, { type: "closeItem", ownerChatId: "chat-1", itemId: opened.item.itemId });
  assert.deepEqual(closed.nextState.webItemUrls, {});
});
