import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EMPTY_WORK_PANEL_STATE,
  normalizeWorkPanelWebUrl,
  reduceWorkPanelCommand,
} = require("../dist-electron/shared/work-panel.js");
const { WORK_PANEL_NATIVE_SURFACE_ALLOWLIST } = require("../dist-electron/shared/work-panel-native-registry.js");

function open(state, ownerChatId, descriptor) {
  return reduceWorkPanelCommand(state, { type: "openItem", ownerChatId, descriptor });
}

test("WorkPanel derives stable identities, deduplicates items, and isolates workspaces", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat-1", {
    kind: "webclient", module: "overview", route: "/overview/chat-1", context: { agentKey: "agent-1", chatId: "chat-1" }, title: "Overview",
  });
  assert.equal(first.ok, true);
  assert.equal(first.item.stableKey, "overview:agent-1:chat-1");
  assert.equal(first.item.pinned, true);
  assert.equal(first.item.closable, false);
  const duplicate = open(first.nextState, "chat-1", {
    kind: "webclient", module: "overview", route: "/overview/chat-1", context: { agentKey: "agent-1", chatId: "chat-1" },
  });
  assert.equal(duplicate.item.itemId, first.item.itemId);
  assert.equal(duplicate.state.items.length, 1);
  const deniedOverviewClose = reduceWorkPanelCommand(duplicate.nextState, {
    type: "closeItem", ownerChatId: "chat-1", itemId: first.item.itemId,
  });
  assert.equal(deniedOverviewClose.ok, false);

  const web = open(duplicate.nextState, "chat-2", {
    kind: "web", url: "HTTPS://Example.com:443/path", title: "Web",
  });
  assert.equal(web.ok, true);
  assert.equal(web.nextState.workspaces.length, 2);
  assert.deepEqual(web.nextState.visibleOwnerChatIds, ["chat-1", "chat-2"]);
  assert.notEqual(web.workspaceId, first.workspaceId);
  assert.equal(web.item.stableKey, "web:https://example.com/path");
});

test("WorkPanel hides without destroying state, restores the active item, and isolates visibility per chat", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat-1", {
    kind: "webclient", module: "overview", route: "/overview/chat-1", context: { agentKey: "agent-1", chatId: "chat-1" },
  });
  const second = open(first.nextState, "chat-1", {
    kind: "web", url: "https://example.test/second", title: "Second",
  });
  assert.equal(second.state.items[0].itemId, first.item.itemId);
  const otherChat = open(second.nextState, "chat-2", {
    kind: "webclient", module: "overview", route: "/overview/chat-2", context: { agentKey: "agent-1", chatId: "chat-2" },
  });

  const hidden = reduceWorkPanelCommand(otherChat.nextState, {
    type: "hideWorkspace", ownerChatId: "chat-1",
  });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.nextState.workspaces.length, 2);
  assert.deepEqual(hidden.nextState.visibleOwnerChatIds, ["chat-2"]);
  assert.equal(hidden.nextState.workspaces[0].activeItemId, second.item.itemId);

  const shown = reduceWorkPanelCommand(hidden.nextState, {
    type: "showWorkspace", ownerChatId: "chat-1",
  });
  assert.equal(shown.ok, true);
  assert.deepEqual(shown.nextState.visibleOwnerChatIds, ["chat-2", "chat-1"]);
  assert.equal(shown.state.activeItemId, second.item.itemId);
});

test("opening or activating an item reveals its workspace and destructive close clears visibility", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "overview", route: "/overview/chat", context: { agentKey: "agent-1", chatId: "chat" },
  });
  const hidden = reduceWorkPanelCommand(first.nextState, {
    type: "hideWorkspace", ownerChatId: "chat",
  });
  const planning = open(hidden.nextState, "chat", {
    kind: "webclient", module: "planning", route: "/planning-viewer/planning-1?chatId=chat", context: { agentKey: "agent-1", chatId: "chat", planningId: "planning-1" },
  });
  assert.deepEqual(planning.nextState.visibleOwnerChatIds, ["chat"]);
  const hiddenAgain = reduceWorkPanelCommand(planning.nextState, {
    type: "hideWorkspace", ownerChatId: "chat",
  });
  const activated = reduceWorkPanelCommand(hiddenAgain.nextState, {
    type: "activateItem", ownerChatId: "chat", itemId: first.item.itemId,
  });
  assert.deepEqual(activated.nextState.visibleOwnerChatIds, ["chat"]);

  const closed = reduceWorkPanelCommand(activated.nextState, {
    type: "closeWorkspace", ownerChatId: "chat",
  });
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.nextState.visibleOwnerChatIds, []);
  assert.deepEqual(closed.nextState.workspaces, []);
});

test("trusted Chat removal can destroy a workspace with pinned items without exposing force through the bridge", () => {
  const pinned = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/pinned", pinned: true,
  });
  const denied = reduceWorkPanelCommand(pinned.nextState, {
    type: "closeWorkspace", ownerChatId: "chat",
  });
  assert.equal(denied.ok, false);

  const removed = reduceWorkPanelCommand(pinned.nextState, {
    type: "closeWorkspace", ownerChatId: "chat", force: true,
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.nextState.workspaces, []);
  assert.deepEqual(removed.nextState.visibleOwnerChatIds, []);
});

test("WorkPanel rejects untrusted URL/path/identity fields and an empty native registry", () => {
  assert.deepEqual(WORK_PANEL_NATIVE_SURFACE_ALLOWLIST, []);
  for (const url of ["file:///tmp/secret", "javascript:alert(1)", "https://user:pass@example.test/"]) {
    assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", { kind: "web", url }).ok, false);
  }
  assert.equal(normalizeWorkPanelWebUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file-diff", route: "/project/agent?view=diff", context: { agentKey: "agent", chatId: "chat", runId: "run", path: "/absolute.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file-diff", route: "/project/agent?view=diff", context: { agentKey: "agent", chatId: "chat", runId: "run", path: "../escape.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "project", route: "/project/agent", context: { agentKey: "agent", path: "/absolute.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "project", route: "/project/agent", context: { agentKey: "agent", path: "../escape.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test", stableKey: "caller-owned",
  }).ok, false);
  const mismatchedChat = open(EMPTY_WORK_PANEL_STATE, "chat-owner", {
    kind: "webclient",
    module: "overview",
    route: "/overview/chat-forged",
    context: { agentKey: "agent", chatId: "chat-forged" },
  });
  assert.equal(mismatchedChat.ok, false);
  assert.equal(mismatchedChat.error.code, "capability_denied");
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "summary", route: "/overview", context: { chatId: "chat" },
  }).ok, false);
  const native = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "native", surfaceKey: "not-registered", context: {},
  });
  assert.equal(native.ok, false);
  assert.equal(native.error.code, "unsupported_native_surface");
});

test("WorkPanel keeps Platform-resolvable File request paths and deduplicates normalized identities", () => {
  const cases = [
    ["src/app.ts", "src/app.ts"],
    ["../outside.txt", "../outside.txt"],
    ["/Users/demo/project/src/app.ts", "/Users/demo/project/src/app.ts"],
    ["C:\\Users\\demo\\project\\src\\app.ts", "C:/Users/demo/project/src/app.ts"],
    ["\\\\server\\share\\project\\src\\app.ts", "//server/share/project/src/app.ts"],
    [" file with spaces ", " file with spaces "],
  ];

  for (const [requestedPath, normalizedPath] of cases) {
    const descriptor = {
      kind: "webclient",
      module: "file",
      route: `/file-viewer/agent?path=${encodeURIComponent(requestedPath)}`,
      context: { agentKey: "agent", path: requestedPath },
    };
    const first = open(EMPTY_WORK_PANEL_STATE, "chat", descriptor);
    assert.equal(first.ok, true, requestedPath);
    assert.equal(first.item.descriptor.context.path, normalizedPath);
    assert.equal(first.item.stableKey, `file:agent:${normalizedPath}`);

    const duplicate = open(first.nextState, "chat", {
      ...descriptor,
      context: { agentKey: "agent", path: normalizedPath },
    });
    assert.equal(duplicate.ok, true, requestedPath);
    assert.equal(duplicate.item.itemId, first.item.itemId, requestedPath);
    assert.equal(duplicate.state.items.length, 1, requestedPath);
  }

  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file", route: "/file-viewer/agent", context: { agentKey: "agent", path: "bad\u0000path" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file", route: "/file-viewer/agent", context: { agentKey: "agent", path: "\n/etc/hosts" },
  }).ok, false);
});

test("WorkPanel derives distinct canonical identities for every independent WebClient surface", () => {
  const descriptors = [
    ["btw", "/btw/chat?btwId=btw-1", { agentKey: "agent", chatId: "chat", btwId: "btw-1" }, "btw:agent:chat:btw-1"],
    ["source", "/source-viewer/src?chatId=chat&chunkId=chunk-1", { agentKey: "agent", chatId: "chat", btwId: "btw-1", publishId: "pub", sourceId: "src" }, "source:agent:chat:btw-1:pub:src"],
    ["planning", "/planning-viewer/plan?chatId=chat", { agentKey: "agent", chatId: "chat", planningId: "plan" }, "planning:agent:chat:plan"],
    ["artifact", "/resource-viewer/agent?chatId=chat&file=artifacts%2Frun%2Freport.pdf", { agentKey: "agent", chatId: "chat", artifactId: "art" }, "artifact:agent:chat:art"],
    ["reference", "/resource-viewer/agent?chatId=chat&file=references%2Fdocument.pdf", { agentKey: "agent", chatId: "chat", referenceId: "ref" }, "reference:agent:chat:ref"],
    ["file", "/file-viewer/agent?path=src%2Fapp.ts&line=20", { agentKey: "agent", path: "src/app.ts" }, "file:agent:src/app.ts"],
    ["project", "/project/agent?chatId=chat&path=src%2Fapp.ts", { agentKey: "agent", chatId: "chat", path: "src/app.ts" }, "project:agent:chat:all:src/app.ts"],
    ["file-diff", "/project/agent?chatId=chat&runId=run&path=src%2Fapp.ts&view=diff", { agentKey: "agent", chatId: "chat", runId: "run", path: "src/app.ts" }, "file-diff:agent:chat:run:src/app.ts"],
  ];
  let state = EMPTY_WORK_PANEL_STATE;
  for (const [module, route, context, stableKey] of descriptors) {
    const result = open(state, "chat", { kind: "webclient", module, route, context });
    assert.equal(result.ok, true, module);
    assert.equal(result.item.stableKey, stableKey);
    assert.equal(result.item.descriptor.route, route);
    state = result.nextState;
  }
});

test("WorkPanel keeps pinned items and destroys the final closable workspace", () => {
  const pinned = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/pinned", pinned: true,
  });
  const denied = reduceWorkPanelCommand(pinned.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: pinned.item.itemId,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "capability_denied");

  const closable = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/closable",
  });
  const closed = reduceWorkPanelCommand(closable.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: closable.item.itemId,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.nextState.workspaces.length, 0);
  assert.deepEqual(closed.nextState.visibleOwnerChatIds, []);
});

test("WorkPanel closes active items consecutively and destroys the workspace after the last tab", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/first", title: "First",
  });
  const second = open(first.nextState, "chat", {
    kind: "web", url: "https://example.test/second", title: "Second",
  });
  assert.equal(second.state.activeItemId, second.item.itemId);

  const closeSecond = reduceWorkPanelCommand(second.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: second.item.itemId,
  });
  assert.equal(closeSecond.ok, true);
  assert.equal(closeSecond.state.items.length, 1);
  assert.equal(closeSecond.state.activeItemId, first.item.itemId);

  const closeFirst = reduceWorkPanelCommand(closeSecond.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: first.item.itemId,
  });
  assert.equal(closeFirst.ok, true);
  assert.equal(closeFirst.nextState.workspaces.length, 0);
  assert.deepEqual(closeFirst.nextState.visibleOwnerChatIds, []);
});

test("WorkPanel closes other closable tabs while retaining pinned items and activating the target", () => {
  const overview = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "overview", route: "/overview/chat", context: { agentKey: "agent", chatId: "chat" },
  });
  const artifact = open(overview.nextState, "chat", {
    kind: "webclient", module: "artifact", route: "/resource-viewer/agent?chatId=chat&file=artifact.txt", context: { agentKey: "agent", chatId: "chat", artifactId: "artifact" },
  });
  const reference = open(artifact.nextState, "chat", {
    kind: "webclient", module: "reference", route: "/resource-viewer/agent?chatId=chat&file=reference.txt", context: { agentKey: "agent", chatId: "chat", referenceId: "reference" },
  });
  const pinned = open(reference.nextState, "chat", {
    kind: "web", url: "https://example.test/pinned", pinned: true,
  });

  const result = reduceWorkPanelCommand(pinned.nextState, {
    type: "closeOtherItems", ownerChatId: "chat", itemId: artifact.item.itemId,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.items.map((item) => item.itemId), [
    overview.item.itemId,
    artifact.item.itemId,
    pinned.item.itemId,
  ]);
  assert.equal(result.state.activeItemId, artifact.item.itemId);
  assert.deepEqual(result.nextState.visibleOwnerChatIds, ["chat"]);
});
