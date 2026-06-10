import test from "node:test";
import assert from "node:assert/strict";

const {
  openWebviewDevToolsById,
  registerWebviewDevToolsIpcHandlers
} = await import("../dist-electron/main/ipc/webview-devtools-handlers.js");

function createWebContentsTarget(type = "webview", destroyed = false) {
  const openCalls = [];
  return {
    target: {
      getType: () => type,
      isDestroyed: () => destroyed,
      openDevTools: (options) => {
        openCalls.push(options);
      }
    },
    openCalls
  };
}

test("openWebviewDevToolsById opens detached DevTools for webview contents", () => {
  const { target, openCalls } = createWebContentsTarget("webview");

  assert.deepEqual(openWebviewDevToolsById(42, {
    webContents: {
      fromId: (id) => id === 42 ? target : undefined
    }
  }), { ok: true });
  assert.deepEqual(openCalls, [{ mode: "detach" }]);
});

test("openWebviewDevToolsById rejects invalid, missing, destroyed, and non-webview contents", () => {
  assert.deepEqual(openWebviewDevToolsById(0, {
    webContents: {
      fromId: () => undefined
    }
  }), { ok: false, message: "内嵌网页不可用。" });

  assert.deepEqual(openWebviewDevToolsById(42, {
    webContents: {
      fromId: () => undefined
    }
  }), { ok: false, message: "内嵌网页已关闭。" });

  assert.deepEqual(openWebviewDevToolsById(42, {
    webContents: {
      fromId: () => createWebContentsTarget("webview", true).target
    }
  }), { ok: false, message: "内嵌网页已关闭。" });

  assert.deepEqual(openWebviewDevToolsById(42, {
    webContents: {
      fromId: () => createWebContentsTarget("window").target
    }
  }), { ok: false, message: "目标不是内嵌网页。" });
});

test("registerWebviewDevToolsIpcHandlers registers the webview.openDevTools channel", async () => {
  const handlers = {};
  const { target, openCalls } = createWebContentsTarget("webview");

  registerWebviewDevToolsIpcHandlers({
    handle: (channel, handler) => {
      handlers[channel] = handler;
    }
  }, {
    webContents: {
      fromId: () => target
    }
  });

  assert.equal(typeof handlers["webview.openDevTools"], "function");
  assert.deepEqual(await handlers["webview.openDevTools"]({}, 7), { ok: true });
  assert.deepEqual(openCalls, [{ mode: "detach" }]);
});
