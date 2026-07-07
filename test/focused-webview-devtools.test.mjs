import test from "node:test";
import assert from "node:assert/strict";

const { openCurrentWebviewDevTools } = await import(
  "../dist-electron/main/focused-webview-devtools.js"
);

class FakeWebContents {
  constructor(id, type = "webview") {
    this.id = id;
    this.type = type;
  }

  destroyed = false;
  devtoolsOpenOptions = null;
  openCount = 0;

  getType() {
    return this.type;
  }

  isDestroyed() {
    return this.destroyed;
  }

  openDevTools(options) {
    this.devtoolsOpenOptions = options;
    this.openCount += 1;
  }
}

function createWebContentsApi(contents, focusedContents) {
  const byId = new Map(contents.map((item) => [item.id, item]));
  return {
    fromId: (id) => byId.get(id) ?? null,
    getFocusedWebContents: () => focusedContents
  };
}

test("current webview DevTools shortcut prefers the active snapshot webview", () => {
  const focusedWebview = new FakeWebContents(1);
  const snapshotWebview = new FakeWebContents(2);

  const result = openCurrentWebviewDevTools({
    currentPageSnapshot: {
      route: "/service/agent-webclient",
      pageKey: "webview:/service/agent-webclient:agent-webclient",
      pageKind: "webview",
      webContentsId: snapshotWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWebview, snapshotWebview], focusedWebview)
  });

  assert.deepEqual(result, { ok: true, source: "snapshot" });
  assert.equal(snapshotWebview.openCount, 1);
  assert.deepEqual(snapshotWebview.devtoolsOpenOptions, { mode: "detach" });
  assert.equal(focusedWebview.openCount, 0);
});

test("current webview DevTools shortcut falls back when snapshot target is stale", () => {
  const focusedWebview = new FakeWebContents(1);
  const snapshotWebview = new FakeWebContents(2);
  snapshotWebview.destroyed = true;

  const result = openCurrentWebviewDevTools({
    currentPageSnapshot: {
      route: "/service/agent-platform",
      pageKey: "webview:/service/agent-platform:agent-platform",
      pageKind: "webview",
      webContentsId: snapshotWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWebview, snapshotWebview], focusedWebview)
  });

  assert.deepEqual(result, { ok: true, source: "focused" });
  assert.equal(snapshotWebview.openCount, 0);
  assert.equal(focusedWebview.openCount, 1);
  assert.deepEqual(focusedWebview.devtoolsOpenOptions, { mode: "detach" });
});

test("current webview DevTools shortcut falls back when snapshot target is not a webview", () => {
  const focusedWebview = new FakeWebContents(1);
  const snapshotContents = new FakeWebContents(2, "window");

  const result = openCurrentWebviewDevTools({
    currentPageSnapshot: {
      route: "/service/agent-platform",
      pageKey: "webview:/service/agent-platform:agent-platform",
      pageKind: "webview",
      webContentsId: snapshotContents.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWebview, snapshotContents], focusedWebview)
  });

  assert.deepEqual(result, { ok: true, source: "focused" });
  assert.equal(snapshotContents.openCount, 0);
  assert.equal(focusedWebview.openCount, 1);
});

test("native current snapshot only opens DevTools through a valid focused webview fallback", () => {
  const focusedWebview = new FakeWebContents(1);
  const nativeSnapshot = {
    route: "/settings",
    pageKey: "native:/settings",
    pageKind: "native",
    pageContext: null
  };

  const fallbackResult = openCurrentWebviewDevTools({
    currentPageSnapshot: nativeSnapshot,
    webContents: createWebContentsApi([focusedWebview], focusedWebview)
  });

  assert.deepEqual(fallbackResult, { ok: true, source: "focused" });
  assert.equal(focusedWebview.openCount, 1);

  const focusedWindow = new FakeWebContents(3, "window");
  const blockedResult = openCurrentWebviewDevTools({
    currentPageSnapshot: nativeSnapshot,
    webContents: createWebContentsApi([focusedWindow], focusedWindow)
  });

  assert.deepEqual(blockedResult, { ok: false, reason: "not-webview" });
  assert.equal(focusedWindow.openCount, 0);
});
