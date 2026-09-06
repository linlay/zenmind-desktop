import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const {
  WEBVIEW_SELECTION_TOOLBAR_VERSION,
  isWebviewSelectionToolbarSurfaceAllowed,
  isWebviewSelectionToolbarTargetAllowed,
  resolveWebviewSelectionToolbarPosition,
  validateWebviewSelectionToolbarChange,
} = await import("../dist-electron/shared/webview-selection-toolbar.js");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("selection toolbar change validation accepts geometry without selected text", () => {
  const payload = {
    version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
    visible: true,
    rect: { x: 10, y: 20, width: 120, height: 32 },
    probe: { x: 22, y: 28 },
  };
  assert.deepEqual(validateWebviewSelectionToolbarChange(payload), payload);
  assert.equal(JSON.stringify(validateWebviewSelectionToolbarChange(payload)).includes("text"), false);
  assert.deepEqual(validateWebviewSelectionToolbarChange({
    version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
    visible: false,
  }), {
    version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
    visible: false,
  });
  assert.equal(validateWebviewSelectionToolbarChange({
    ...payload,
    selectedText: "secret",
  }), null);
  assert.equal(validateWebviewSelectionToolbarChange({
    ...payload,
    rect: { ...payload.rect, width: 0 },
  }), null);
  assert.equal(validateWebviewSelectionToolbarChange({
    ...payload,
    probe: { x: Number.NaN, y: 20 },
  }), null);
});

test("selection toolbar only allows trusted conversation target categories", () => {
  assert.equal(isWebviewSelectionToolbarSurfaceAllowed("agent-chat"), true);
  assert.equal(isWebviewSelectionToolbarSurfaceAllowed("agent-copilot"), true);
  assert.equal(isWebviewSelectionToolbarSurfaceAllowed("agent-management"), false);
  assert.equal(isWebviewSelectionToolbarSurfaceAllowed("project"), false);
  assert.equal(isWebviewSelectionToolbarTargetAllowed("message"), true);
  assert.equal(isWebviewSelectionToolbarTargetAllowed("code"), true);
  assert.equal(isWebviewSelectionToolbarTargetAllowed("web-link"), false);
});

test("selection toolbar positioning centers, flips and clamps to eight pixel edges", () => {
  assert.deepEqual(resolveWebviewSelectionToolbarPosition({
    anchor: { x: 100, y: 100, width: 80, height: 20 },
    containerWidth: 400,
    containerHeight: 300,
    toolbarWidth: 200,
    toolbarHeight: 40,
  }), { left: 40, top: 52, placement: "above" });
  assert.deepEqual(resolveWebviewSelectionToolbarPosition({
    anchor: { x: 100, y: 10, width: 80, height: 20 },
    containerWidth: 400,
    containerHeight: 300,
    toolbarWidth: 200,
    toolbarHeight: 40,
  }), { left: 40, top: 38, placement: "below" });
  assert.deepEqual(resolveWebviewSelectionToolbarPosition({
    anchor: { x: 290, y: 100, width: 20, height: 20 },
    containerWidth: 320,
    containerHeight: 180,
    toolbarWidth: 200,
    toolbarHeight: 40,
  }), { left: 112, top: 52, placement: "above" });
});

test("desktop owns the placeholder toolbar and does not expose business execution", () => {
  const mainController = readSource("src", "main", "modules", "web-surfaces", "context-menu-controller.ts");
  const surface = readSource("src", "renderer", "service-webview", "ServiceWebviewSurface.tsx");
  const toolbar = readSource("src", "renderer", "service-webview", "WebviewSelectionToolbar.tsx");
  const styles = readSource("src", "renderer", "styles", "webview-selection-toolbar.css");
  const preload = readSource("src", "preload", "service-webview.ts");

  assert.match(mainController, /isTrustedAgentWebclient\(contents, registeredTarget\)/u);
  assert.match(mainController, /isWebviewSelectionToolbarTargetAllowed\(semanticTarget\.kind\)/u);
  assert.match(mainController, /selectionSequenceByGuest\.get\(guestId\) !== selectionSequence/u);
  assert.match(surface, /<WebviewSelectionToolbar/u);
  assert.match(toolbar, /webviewSelectionToolbar\.addToChat/u);
  assert.match(toolbar, /webviewSelectionToolbar\.moreDetails/u);
  assert.match(toolbar, /webviewSelectionToolbar\.askInSideChat/u);
  assert.match(toolbar, /onPointerDown=\{dismissFromPointer\}/u);
  assert.match(styles, /border-radius:\s*16px/u);
  assert.match(styles, /webview-selection-toolbar button:hover/u);
  assert.match(preload, /WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL/u);
  assert.doesNotMatch(mainController, /selectionToolbar\.execute/u);
  assert.doesNotMatch(toolbar, /sendBTW|set-composer-draft|openBTW|desktopAction/u);
});
