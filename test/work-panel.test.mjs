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

function open(state, ownerChatId, descriptor, legacy = false) {
  return reduceWorkPanelCommand(state, { type: "openItem", ownerChatId, descriptor, legacy });
}

test("WorkPanel derives stable identities, deduplicates items, and isolates workspaces", () => {
  const first = open(EMPTY_WORK_PANEL_STATE, "chat-1", {
    kind: "webclient", module: "summary", route: "/overview", context: {}, title: "Summary",
  });
  assert.equal(first.ok, true);
  assert.equal(first.item.stableKey, "summary:chat-1");
  const duplicate = open(first.nextState, "chat-1", {
    kind: "webclient", module: "summary", route: "/overview?new=1", context: { chatId: "chat-1" },
  });
  assert.equal(duplicate.item.itemId, first.item.itemId);
  assert.equal(duplicate.state.items.length, 1);

  const web = open(duplicate.nextState, "chat-2", {
    kind: "web", url: "HTTPS://Example.com:443/path", title: "Web",
  });
  assert.equal(web.ok, true);
  assert.equal(web.nextState.workspaces.length, 2);
  assert.notEqual(web.workspaceId, first.workspaceId);
  assert.equal(web.item.stableKey, "web:https://example.com/path");
});

test("WorkPanel rejects untrusted URL/path/identity fields and an empty native registry", () => {
  assert.deepEqual(WORK_PANEL_NATIVE_SURFACE_ALLOWLIST, []);
  for (const url of ["file:///tmp/secret", "javascript:alert(1)", "https://user:pass@example.test/"]) {
    assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", { kind: "web", url }).ok, false);
  }
  assert.equal(normalizeWorkPanelWebUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file-diff", route: "/diff", context: { runId: "run", relativePath: "/absolute.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "webclient", module: "file-diff", route: "/diff", context: { runId: "run", relativePath: "../escape.txt" },
  }).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test", stableKey: "caller-owned",
  }).ok, false);
  const native = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "native", surfaceKey: "not-registered", context: {},
  });
  assert.equal(native.ok, false);
  assert.equal(native.error.code, "unsupported_native_surface");
});

test("WorkPanel keeps pinned items, destroys the final closable workspace, and counts legacy adapters", () => {
  const pinned = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/pinned", pinned: true,
  });
  const denied = reduceWorkPanelCommand(pinned.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: pinned.item.itemId,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "capability_denied");

  const legacy = open(EMPTY_WORK_PANEL_STATE, "chat", {
    kind: "web", url: "https://example.test/legacy",
  }, true);
  assert.equal(legacy.nextState.legacyActionCount, 1);
  const closed = reduceWorkPanelCommand(legacy.nextState, {
    type: "closeItem", ownerChatId: "chat", itemId: legacy.item.itemId, legacy: true,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.nextState.workspaces.length, 0);
  assert.equal(closed.nextState.legacyActionCount, 2);
});
