import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EMPTY_WORK_PANEL_STATE,
  normalizeWorkPanelWebUrl,
  reduceWorkPanelCommand,
  resolveWorkPanelWebSessionKey,
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
    kind: "webclient", module: "planning", route: "/planning-viewer/planning-1?chatId=chat", context: { chatId: "chat", planningId: "planning-1" },
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
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "skill", route: "/skill-viewer/skill", context: { key: "" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "skill", route: "/skill-viewer/skill", context: { key: "skill", agentKey: "forged" },
  }).ok, false);
  const native = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "native", surfaceKey: "not-registered", context: {},
  });
  assert.equal(native.ok, false);
  assert.equal(native.error.code, "unsupported_native_surface");
});

test("trusted WorkPanel Blob popups inherit their source session without widening public URL inputs", () => {
  const source = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web",
    url: "https://example.test/attachments",
    title: "Attachments",
  });
  assert.equal(source.ok, true);
  assert.equal(open(source.nextState, "chat", {
    kind: "web",
    url: "blob:https://example.test/public-input",
  }).ok, false);
  assert.equal(normalizeWorkPanelWebUrl("blob:https://example.test/public-input"), "");

  const blobUrl = "blob:https://example.test/6940b58b-49ce-43b3-a6f7-30405f5eb6c0";
  const popup = reduceWorkPanelCommand(source.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat",
    sourceItemId: source.item.itemId,
    url: blobUrl,
  });
  assert.equal(popup.ok, true);
  assert.equal(popup.item.descriptor.url, blobUrl);
  assert.equal(popup.item.title, "example.test");
  assert.equal(
    resolveWorkPanelWebSessionKey(popup.nextState, popup.workspaceId, popup.item.itemId),
    source.item.itemId,
  );
  assert.equal(
    popup.item.stableKey,
    `blob:${source.item.itemId}:${blobUrl}`,
  );

  const duplicate = reduceWorkPanelCommand(popup.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat",
    sourceItemId: source.item.itemId,
    url: blobUrl,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.item.itemId, popup.item.itemId);
  assert.equal(duplicate.state.items.length, 2);

  const descendantUrl = "blob:https://example.test/2b2aaf61-d822-492f-87ad-16d1a40347ec";
  const descendant = reduceWorkPanelCommand(duplicate.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat",
    sourceItemId: popup.item.itemId,
    url: descendantUrl,
  });
  assert.equal(descendant.ok, true);
  assert.equal(
    resolveWorkPanelWebSessionKey(
      descendant.nextState,
      descendant.workspaceId,
      descendant.item.itemId,
    ),
    source.item.itemId,
  );

  const missingSource = reduceWorkPanelCommand(descendant.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat",
    sourceItemId: "item:missing",
    url: blobUrl,
  });
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.error.code, "target_unavailable");

  const closeSource = reduceWorkPanelCommand(descendant.nextState, {
    type: "closeItem",
    ownerChatId: "chat",
    itemId: source.item.itemId,
  });
  assert.equal(closeSource.ok, true);
  assert.equal(
    resolveWorkPanelWebSessionKey(closeSource.nextState, popup.workspaceId, popup.item.itemId),
    source.item.itemId,
  );

  const closePopup = reduceWorkPanelCommand(closeSource.nextState, {
    type: "closeItem",
    ownerChatId: "chat",
    itemId: popup.item.itemId,
  });
  const closeDescendant = reduceWorkPanelCommand(closePopup.nextState, {
    type: "closeItem",
    ownerChatId: "chat",
    itemId: descendant.item.itemId,
  });
  assert.equal(closeDescendant.ok, true);
  assert.deepEqual(closeDescendant.nextState.webSessionKeysByItemId, {});
});

test("WorkPanel Blob session affinity remains isolated when item identities match across chats", () => {
  const sourceA = open(EMPTY_WORK_PANEL_STATE, "chat-a", {
    kind: "web",
    url: "https://example.test/attachments",
  });
  const sourceB = open(sourceA.nextState, "chat-b", {
    kind: "web",
    url: "https://example.test/attachments",
  });
  assert.equal(sourceA.item.itemId, sourceB.item.itemId);
  const blobUrl = "blob:https://example.test/8581db74-cfa7-4b25-bb8c-1b96cdfc98fa";
  const popupA = reduceWorkPanelCommand(sourceB.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat-a",
    sourceItemId: sourceA.item.itemId,
    url: blobUrl,
  });
  const popupB = reduceWorkPanelCommand(popupA.nextState, {
    type: "openBlobPopup",
    ownerChatId: "chat-b",
    sourceItemId: sourceB.item.itemId,
    url: blobUrl,
  });
  assert.equal(popupA.item.itemId, popupB.item.itemId);
  assert.equal(Object.keys(popupB.nextState.webSessionKeysByItemId).length, 2);

  const closedA = reduceWorkPanelCommand(popupB.nextState, {
    type: "closeWorkspace",
    ownerChatId: "chat-a",
    force: true,
  });
  assert.equal(closedA.ok, true);
  assert.equal(Object.keys(closedA.nextState.webSessionKeysByItemId).length, 1);
  assert.equal(
    resolveWorkPanelWebSessionKey(
      closedA.nextState,
      popupB.workspaceId,
      popupB.item.itemId,
    ),
    sourceB.item.itemId,
  );
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
    ["planning", "/planning-viewer/plan?chatId=chat", { chatId: "chat", planningId: "plan" }, "planning:chat:plan"],
    ["artifact", "/resource-viewer/agent?chatId=chat&file=artifacts%2Frun%2Freport.pdf", { agentKey: "agent", chatId: "chat", artifactId: "art" }, "artifact:agent:chat:art"],
    ["reference", "/resource-viewer/agent?chatId=chat&file=references%2Fdocument.pdf", { agentKey: "agent", chatId: "chat", referenceId: "ref" }, "reference:agent:chat:ref"],
    ["file", "/file-viewer/agent?path=src%2Fapp.ts&line=20", { agentKey: "agent", path: "src/app.ts" }, "file:agent:src/app.ts"],
    ["project", "/project/agent?chatId=chat&path=src%2Fapp.ts", { agentKey: "agent", chatId: "chat", path: "src/app.ts" }, "project:agent:chat:all:src/app.ts"],
    ["file-diff", "/project/agent?chatId=chat&runId=run&path=src%2Fapp.ts&view=diff", { agentKey: "agent", chatId: "chat", runId: "run", path: "src/app.ts" }, "file-diff:agent:chat:run:src/app.ts"],
    ["skill", "/skill-viewer/pdf", { key: "pdf" }, "skill:pdf"],
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

test("Planning identity does not require an agent and canonicalizes legacy descriptors", () => {
  const current = open(EMPTY_WORK_PANEL_STATE, "team-chat", {
    kind: "webclient",
    module: "planning",
    route: "/planning-viewer/plan-1?chatId=team-chat",
    context: { chatId: "team-chat", planningId: "plan-1" },
  });
  assert.equal(current.ok, true);
  assert.equal(current.item.stableKey, "planning:team-chat:plan-1");
  assert.deepEqual(current.item.descriptor.context, {
    chatId: "team-chat",
    planningId: "plan-1",
  });

  const legacy = open(current.nextState, "team-chat", {
    kind: "webclient",
    module: "planning",
    route: "/planning-viewer/plan-1?chatId=team-chat",
    context: { agentKey: "legacy-agent", chatId: "team-chat", planningId: "plan-1" },
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.item.itemId, current.item.itemId);
  assert.equal(legacy.state.items.length, 1);
  assert.deepEqual(legacy.item.descriptor.context, {
    chatId: "team-chat",
    planningId: "plan-1",
  });

  const otherPlan = open(legacy.nextState, "team-chat", {
    kind: "webclient",
    module: "planning",
    route: "/planning-viewer/plan-2?chatId=team-chat",
    context: { chatId: "team-chat", planningId: "plan-2" },
  });
  assert.equal(otherPlan.ok, true);
  assert.notEqual(otherPlan.item.itemId, current.item.itemId);

  const mismatchedChat = open(EMPTY_WORK_PANEL_STATE, "team-chat", {
    kind: "webclient",
    module: "planning",
    route: "/planning-viewer/plan-1?chatId=other-chat",
    context: { chatId: "other-chat", planningId: "plan-1" },
  });
  assert.equal(mismatchedChat.ok, false);
  assert.equal(mismatchedChat.error.code, "capability_denied");
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

test("WorkPanel keeps host-created WebApps and local files resource-deduplicated", () => {
  const webapp = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webapp-ref", webappId: "demo-app", title: "Demo App",
  });
  assert.equal(webapp.ok, true);
  assert.equal(webapp.item.stableKey, "webapp:demo-app");
  const duplicateWebapp = open(webapp.nextState, "chat", {
    kind: "webapp-ref", webappId: "demo-app", title: "Renamed by caller",
  });
  assert.equal(duplicateWebapp.item.itemId, webapp.item.itemId);
  assert.equal(duplicateWebapp.state.items.length, 1);

  const localFile = open(duplicateWebapp.nextState, "chat", {
    kind: "local-file",
    handleId: "opaque-handle",
    fileName: "report.pdf",
    previewKind: "pdf",
  });
  assert.equal(localFile.ok, true);
  assert.equal(localFile.item.stableKey, "local-file:opaque-handle");
  assert.equal(localFile.item.title, "report.pdf");
  const duplicateFile = open(localFile.nextState, "chat", {
    kind: "local-file",
    handleId: "opaque-handle",
    fileName: "report.pdf",
    previewKind: "pdf",
  });
  assert.equal(duplicateFile.item.itemId, localFile.item.itemId);
  assert.equal(duplicateFile.state.items.length, 2);
});

test("WorkPanel creates independent BTW instances unless a canonical BTW id is known", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient",
    module: "btw",
    route: "/btw/chat",
    context: { agentKey: "agent", chatId: "chat", instanceId: "instance-a" },
  });
  const second = open(first.nextState, "chat", {
    kind: "webclient",
    module: "btw",
    route: "/btw/chat",
    context: { agentKey: "agent", chatId: "chat", instanceId: "instance-b" },
  });
  assert.notEqual(first.item.itemId, second.item.itemId);
  assert.equal(second.state.items.length, 2);

  const canonical = open(second.nextState, "chat", {
    kind: "webclient",
    module: "btw",
    route: "/btw/chat",
    context: { agentKey: "agent", chatId: "chat", btwId: "btw-1", instanceId: "ignored-a" },
  });
  const canonicalDuplicate = open(canonical.nextState, "chat", {
    kind: "webclient",
    module: "btw",
    route: "/btw/chat",
    context: { agentKey: "agent", chatId: "chat", btwId: "btw-1", instanceId: "ignored-b" },
  });
  assert.equal(canonical.item.itemId, canonicalDuplicate.item.itemId);
});

test("WorkPanel Web URL normalization adds HTTPS while still refusing credentials", () => {
  assert.equal(normalizeWorkPanelWebUrl("example.test/path"), "https://example.test/path");
  assert.equal(normalizeWorkPanelWebUrl("https://user:secret@example.test"), "");
});
