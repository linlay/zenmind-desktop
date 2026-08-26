import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createResourceDirectoryWatcher
} = require("../dist-electron/main/resource-directory-watcher.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "temp") return path.join(root, "tmp");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

test("resource watcher rescans directories only for structural rename events", () => {
  const watchListeners = [];
  const timers = new Map();
  let nextTimerId = 1;
  let readdirCalls = 0;
  let websChanged = 0;
  const watcher = createResourceDirectoryWatcher({
    app: createApp("C:\\watcher-test"),
    platform: "win32",
    fsImpl: {
      existsSync: () => true,
      mkdirSync: () => undefined,
      readdirSync: () => {
        readdirCalls += 1;
        return [];
      },
      statSync: () => ({ isDirectory: () => true }),
      watch: (_targetPath, _options, listener) => {
        watchListeners.push(listener);
        return { close() {} };
      }
    },
    setTimeoutImpl: (callback) => {
      const handle = { id: nextTimerId++ };
      timers.set(handle, callback);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      timers.delete(handle);
    },
    onWebsChanged: () => {
      websChanged += 1;
    }
  });

  const flushTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };

  watcher.start();
  assert.ok(watchListeners.length >= 3);
  assert.ok(readdirCalls > 0);
  const initialReaddirCalls = readdirCalls;
  const websListener = watchListeners[0];

  websListener("change", "order.json");
  flushTimers();
  assert.equal(websChanged, 1);
  assert.equal(readdirCalls, initialReaddirCalls);

  websListener("rename", "new-directory");
  flushTimers();
  assert.equal(websChanged, 2);
  assert.ok(readdirCalls > initialReaddirCalls);

  watcher.stop();
});
