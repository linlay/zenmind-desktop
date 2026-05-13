import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SystemChromeController, __testInternals } = require("../dist-electron/main/assistant/system-chrome.js");

test("system Chrome discovers existing controlled CDP port after Electron restart", () => {
  const userDataDir = "/Users/jialin/Library/Application Support/zenmind-desktop/controlled-system-chrome";
  const processTable = [
    "123 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=58987 --user-data-dir=/Users/jialin/Library/Application Support/zenmind-desktop/controlled-system-chrome --no-first-run --no-default-browser-check about:blank",
    "456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=60000 --user-data-dir=/Users/jialin/Library/Application Support/Other App/controlled-system-chrome"
  ].join("\n");

  assert.equal(
    __testInternals.findCdpPortInProcessTableForPlatform(processTable, userDataDir, "darwin"),
    58987
  );
});

test("system Chrome process parsing handles quoted Windows user data paths", () => {
  const userDataDir = "C:\\Users\\Jialin\\AppData\\Roaming\\zenmind-desktop\\controlled-system-chrome";
  const processTable = [
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=61234 --user-data-dir="C:\\Users\\Jialin\\AppData\\Roaming\\zenmind-desktop\\controlled-system-chrome" --no-first-run'
  ].join("\n");

  assert.equal(
    __testInternals.findCdpPortInProcessTableForPlatform(processTable, userDataDir, "win32"),
    61234
  );
});

test("system Chrome waits for target execution context after creating a tab", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-system-chrome-ready-"));
  const userDataDir = path.join(root, "controlled-system-chrome");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), "61234\n/devtools/browser/test\n", "utf8");

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let runtimeEvaluateAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === "http://127.0.0.1:61234/json/version") {
      return new Response(JSON.stringify({ Browser: "Chrome" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.startsWith("http://127.0.0.1:61234/json/new")) {
      assert.equal(init.method, "PUT");
      return new Response(JSON.stringify({
        id: "target-1",
        type: "page",
        url: "https://www.google.com/",
        title: "Google",
        webSocketDebuggerUrl: "ws://127.0.0.1:61234/devtools/page/target-1"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  class FakeWebSocket {
    readyState = 1;
    onopen = null;
    onerror = null;
    onmessage = null;
    onclose = null;

    constructor() {
      setTimeout(() => this.onopen?.({}), 0);
    }

    send(payload) {
      const request = JSON.parse(String(payload));
      let response;
      if (request.method === "Runtime.evaluate") {
        runtimeEvaluateAttempts += 1;
        response = runtimeEvaluateAttempts < 3
          ? {
              id: request.id,
              error: {
                message: runtimeEvaluateAttempts === 1
                  ? "Cannot find default execution context"
                  : "Execution context was destroyed."
              }
            }
          : {
              id: request.id,
              result: {
                result: {
                  value: {
                    readyState: "complete",
                    url: "https://www.google.com/",
                    title: "Google"
                  }
                }
              }
            };
      } else {
        response = { id: request.id, result: {} };
      }
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(response) }), 0);
    }

    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }
  globalThis.WebSocket = FakeWebSocket;

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  const controller = new SystemChromeController({
    isPackaged: false,
    getPath(name) {
      if (name === "userData") return root;
      if (name === "home") return os.homedir();
      if (name === "desktop") return path.join(root, "Desktop");
      return root;
    }
  });

  const result = await controller.openUrl({ url: "https://www.google.com/", label: "谷歌" });

  assert.equal(result.ok, true);
  assert.equal(runtimeEvaluateAttempts, 3);
});
