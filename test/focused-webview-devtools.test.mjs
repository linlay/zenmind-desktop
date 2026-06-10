import test from "node:test";
import assert from "node:assert/strict";

const {
  openFocusedWebviewDevTools
} = await import("../dist-electron/main/focused-webview-devtools.js");

function createContents(type, options = {}) {
  const openCalls = [];
  return {
    contents: {
      getType: () => type,
      isDestroyed: () => Boolean(options.destroyed),
      openDevTools: (openOptions) => {
        openCalls.push(openOptions);
      }
    },
    openCalls
  };
}

test("openFocusedWebviewDevTools opens detached DevTools for focused webviews", () => {
  const { contents, openCalls } = createContents("webview");

  assert.deepEqual(openFocusedWebviewDevTools(contents), { ok: true });
  assert.deepEqual(openCalls, [{ mode: "detach" }]);
});

test("openFocusedWebviewDevTools ignores non-webview focused contents", () => {
  const { contents, openCalls } = createContents("window");

  assert.deepEqual(openFocusedWebviewDevTools(contents), { ok: false, reason: "not-webview" });
  assert.deepEqual(openCalls, []);
});

test("openFocusedWebviewDevTools ignores missing or destroyed focused contents", () => {
  assert.deepEqual(openFocusedWebviewDevTools(null), { ok: false, reason: "no-focused-webview" });

  const { contents, openCalls } = createContents("webview", { destroyed: true });
  assert.deepEqual(openFocusedWebviewDevTools(contents), { ok: false, reason: "no-focused-webview" });
  assert.deepEqual(openCalls, []);
});
