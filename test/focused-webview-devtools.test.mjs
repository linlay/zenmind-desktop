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

test("current webview DevTools shortcut prefers the focused main-chat over stale fallback targets", () => {
  const focusedWebview = new FakeWebContents(1);
  const snapshotWebview = new FakeWebContents(2);
  const copilotWebview = new FakeWebContents(3);

  const result = openCurrentWebviewDevTools({
    focusedWebviewDevToolsTarget: {
      webContentsId: focusedWebview.id
    },
    preferredWebviewDevToolsTarget: {
      webContentsId: copilotWebview.id
    },
    currentPageSnapshot: {
      route: "/service/agent-webclient",
      pageKey: "webview:/service/agent-webclient:agent-webclient",
      pageKind: "webview",
      webContentsId: snapshotWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWebview, snapshotWebview, copilotWebview], snapshotWebview)
  });

  assert.deepEqual(result, { ok: true, source: "focused" });
  assert.equal(focusedWebview.openCount, 1);
  assert.deepEqual(focusedWebview.devtoolsOpenOptions, { mode: "detach" });
  assert.equal(copilotWebview.openCount, 0);
  assert.equal(snapshotWebview.openCount, 0);
});

test("current webview DevTools shortcut follows focus across multiple WorkPanel webviews", () => {
  const mainChatWebview = new FakeWebContents(1);
  const overviewWebview = new FakeWebContents(2);
  const artifactWebview = new FakeWebContents(3);

  const result = openCurrentWebviewDevTools({
    focusedWebviewDevToolsTarget: {
      webContentsId: artifactWebview.id
    },
    currentPageSnapshot: {
      route: "/agent/default",
      pageKey: "webview:/agent/default:main-chat",
      pageKind: "webview",
      webContentsId: mainChatWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi(
      [mainChatWebview, overviewWebview, artifactWebview],
      overviewWebview
    )
  });

  assert.deepEqual(result, { ok: true, source: "focused" });
  assert.equal(mainChatWebview.openCount, 0);
  assert.equal(overviewWebview.openCount, 0);
  assert.equal(artifactWebview.openCount, 1);
  assert.deepEqual(artifactWebview.devtoolsOpenOptions, { mode: "detach" });
});

test("current webview DevTools shortcut uses a live Copilot target when no webview is focused", () => {
  const focusedWindow = new FakeWebContents(1, "window");
  const snapshotWebview = new FakeWebContents(2);
  const copilotWebview = new FakeWebContents(3);

  const result = openCurrentWebviewDevTools({
    preferredWebviewDevToolsTarget: {
      webContentsId: copilotWebview.id
    },
    currentPageSnapshot: {
      route: "/service/agent-webclient",
      pageKey: "webview:/service/agent-webclient:agent-webclient",
      pageKind: "webview",
      webContentsId: snapshotWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWindow, snapshotWebview, copilotWebview], focusedWindow)
  });

  assert.deepEqual(result, { ok: true, source: "copilot" });
  assert.equal(copilotWebview.openCount, 1);
  assert.deepEqual(copilotWebview.devtoolsOpenOptions, { mode: "detach" });
  assert.equal(snapshotWebview.openCount, 0);
});

test("current webview DevTools shortcut falls back when Copilot target is stale", () => {
  const focusedWebview = new FakeWebContents(1);
  const snapshotWebview = new FakeWebContents(2);
  const copilotWebview = new FakeWebContents(3);
  copilotWebview.destroyed = true;

  const result = openCurrentWebviewDevTools({
    preferredWebviewDevToolsTarget: {
      webContentsId: copilotWebview.id
    },
    currentPageSnapshot: {
      route: "/service/agent-webclient",
      pageKey: "webview:/service/agent-webclient:agent-webclient",
      pageKind: "webview",
      webContentsId: snapshotWebview.id,
      pageContext: null
    },
    webContents: createWebContentsApi([focusedWebview, snapshotWebview, copilotWebview], null)
  });

  assert.deepEqual(result, { ok: true, source: "snapshot" });
  assert.equal(copilotWebview.openCount, 0);
  assert.equal(snapshotWebview.openCount, 1);
  assert.equal(focusedWebview.openCount, 0);
});

test("current webview DevTools shortcut ignores a non-webview Copilot target", () => {
  const focusedWebview = new FakeWebContents(1);
  const copilotWindow = new FakeWebContents(3, "window");

  const result = openCurrentWebviewDevTools({
    preferredWebviewDevToolsTarget: {
      webContentsId: copilotWindow.id
    },
    currentPageSnapshot: null,
    webContents: createWebContentsApi([focusedWebview, copilotWindow], focusedWebview)
  });

  assert.deepEqual(result, { ok: true, source: "focused" });
  assert.equal(copilotWindow.openCount, 0);
  assert.equal(focusedWebview.openCount, 1);
});

test("current webview DevTools shortcut uses the active snapshot when no webview is focused", () => {
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
    webContents: createWebContentsApi([focusedWebview, snapshotWebview], null)
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
