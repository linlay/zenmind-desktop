import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  handleDesktopActionRequest,
  handleDesktopCdpRequest
} = require("../dist-electron/main/desktop-action-bridge.js");
const { DESKTOP_ACTION_DEFINITIONS } = require("../dist-electron/shared/desktop-actions.js");

function createBridgeOptions(overrides = {}) {
  return {
    app: {},
    assistantBridge: {},
    getMainWindow: () => null,
    getCurrentPageSnapshot: () => null,
    navigate: () => {},
    openLogViewer: async () => ({ ok: true }),
    callRendererAction: async () => ({ ok: false }),
    executeCdpCommand: async () => ({
      targetId: "zenmind-test",
      surfaceId: "surface-test",
      result: { value: 42 }
    }),
    ...overrides
  };
}

test("Desktop action catalog does not expose page or embedded web actions", () => {
  const names = DESKTOP_ACTION_DEFINITIONS.map((definition) => definition.name);
  assert.equal(names.some((name) => name.startsWith("desktop.page.")), false);
  assert.equal(names.some((name) => name.startsWith("desktop.embeddedWeb.")), false);
  assert.ok(names.includes("desktop.controlCenter.listServices"));
  assert.ok(names.includes("desktop.agents.deleteAgent"));
});

test("Desktop Action Bridge rejects page actions", async () => {
  const response = await handleDesktopActionRequest(createBridgeOptions(), {
    action: "desktop.page.readCurrent",
    args: {}
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unknown_action");
});

test("Desktop CDP Bridge executes CDP calls", async () => {
  let got;
  const response = await handleDesktopCdpRequest(createBridgeOptions({
    executeCdpCommand: async (request) => {
      got = request;
      return {
        targetId: "zenmind-target",
        surfaceId: "surface-a",
        result: { type: "number", value: 42 }
      };
    }
  }), {
    method: "Runtime.evaluate",
    params: { expression: "6 * 7" },
    targetId: "zenmind-target",
    sessionId: "ignored-by-http-bridge",
    surfaceId: "surface-a"
  });

  assert.equal(response.ok, true);
  assert.equal(response.method, "Runtime.evaluate");
  assert.equal(response.targetId, "zenmind-target");
  assert.equal(response.surfaceId, "surface-a");
  assert.deepEqual(response.result, { type: "number", value: 42 });
  assert.deepEqual(got, {
    method: "Runtime.evaluate",
    params: { expression: "6 * 7" },
    targetId: "zenmind-target",
    surfaceId: "surface-a"
  });
});

test("Desktop CDP Bridge requires method", async () => {
  const response = await handleDesktopCdpRequest(createBridgeOptions(), {
    params: { expression: "document.title" }
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "invalid_args");
});
