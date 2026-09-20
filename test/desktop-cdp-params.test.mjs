import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateDesktopCdpParams } = require("../dist-electron/main/modules/web-surfaces/cdp/params.js");
const { handleDesktopCdpRequest } = require("../dist-electron/main/modules/desktop-actions/runtime.js");

test("chat regression: report every string number before sending a mouse event", async () => {
  let calls = 0;
  const options = { executeCdpCommand: async () => { calls++; return { result: {} }; } };
  const params = { type: "mousePressed", x: "646", y: "344", button: "left", clickCount: "1" };
  const response = await handleDesktopCdpRequest(options, { method: "Input.dispatchMouseEvent", params, surfaceId: "desktop-test" });
  assert.equal(calls, 0);
  assert.equal(response.error.code, "invalid_args");
  assert.deepEqual(response.error.details.issues, [
    { path: "params.x", expected: "number", actualType: "string", actualValue: "646" },
    { path: "params.y", expected: "number", actualType: "string", actualValue: "344" },
    { path: "params.clickCount", expected: "integer", actualType: "string", actualValue: "1" }
  ]);
  assert.equal(response.error.details.executed, false);
  assert.equal(response.error.details.retryable, false);
  assert.match(response.error.message, /fractional numbers/);
  assert.match(response.error.message, /button="left" is valid/);
  assert.deepEqual(params, { type: "mousePressed", x: "646", y: "344", button: "left", clickCount: "1" });
  for (const type of ["mousePressed", "mouseReleased", "mouseMoved"]) {
    const success = await handleDesktopCdpRequest(options, { method: "Input.dispatchMouseEvent", params: { type, x: 136.875, y: 255.5, button: "left", clickCount: 1 }, surfaceId: "desktop-test" });
    assert.equal(success.ok, true);
  }
  assert.equal(calls, 3);
});

test("reject malformed objects, booleans, missing values and invalid enums", () => {
  for (const value of [null, [], "{}", 1, true]) {
    assert.throws(() => validateDesktopCdpParams("Page.reload", value), /params expected object/);
  }
  for (const [method, params, expected] of [
    ["Runtime.evaluate", { expression: "1+1", returnByValue: "true", awaitPromise: "false" }, ["params.returnByValue", "params.awaitPromise"]],
    ["Page.reload", { ignoreCache: "true" }, ["params.ignoreCache"]],
    ["Input.dispatchMouseEvent", { type: "mouseClick", x: NaN, y: Infinity, clickCount: 1.5 }, ["params.type", "params.x", "params.y", "params.clickCount"]],
    ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0 }, ["params.deltaX", "params.deltaY"]],
    ["Input.dispatchKeyEvent", { type: "keyDown", autoRepeat: "false" }, ["params.autoRepeat"]],
    ["Page.captureScreenshot", { clip: { x: "1", y: 0, width: 10, height: 10 } }, ["params.clip.x", "params.clip.scale"]],
    ["DOM.querySelector", { nodeId: "1", selector: "input" }, ["params.nodeId"]],
    ["Runtime.evaluate", {}, ["params.expression"]]
  ]) {
    assert.throws(() => validateDesktopCdpParams(method, params), (error) => {
      assert.deepEqual(error.details.issues.map((issue) => issue.path), expected);
      return true;
    });
  }
  validateDesktopCdpParams("Page.reload", { ignoreCache: false });
  validateDesktopCdpParams("Runtime.evaluate", { expression: "1+1", returnByValue: true, awaitPromise: false });
});

test("diagnostics do not echo arbitrary nested values", () => {
  assert.throws(() => validateDesktopCdpParams("Runtime.evaluate", { expression: { secret: "hidden-value" } }), (error) => {
    assert.equal(JSON.stringify(error.details).includes("hidden-value"), false);
    assert.equal(error.message.includes("hidden-value"), false);
    return true;
  });
});

test("target errors have recovery; unknown execution failures do not promise no effects", async () => {
  for (const code of ["target_not_in_current_surface", "cdp_failed"]) {
    const options = { executeCdpCommand: async () => { throw Object.assign(new Error("failed"), { code }); } };
    const response = await handleDesktopCdpRequest(options, { method: "Input.insertText", surfaceId: "desktop-test", params: { text: "text" } });
    assert.equal(response.error.details.surfaceId, "desktop-test");
    assert.equal(response.error.details.executed, code === "cdp_failed" ? undefined : false);
    if (code !== "cdp_failed") assert.match(response.error.details.recovery, /Surface.list/);
  }
});
