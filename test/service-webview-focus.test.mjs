import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the real navigation effect with a WebView that models Electron's
// stale host activeElement: focus() alone cannot hand focus back to the guest.
const source = fs.readFileSync(new URL("../src/renderer/service-webview/ServiceWebviewSurface.tsx", import.meta.url), "utf8");
const start = source.indexOf("const requestId = Number.isSafeInteger(focusRequestId)");
const end = source.indexOf("}, [active, focusRequestId,", start);
assert.ok(start >= 0 && end > start);
const script = ts.transpileModule(`(function () { ${source.slice(start, end)} })()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(staleHostFocus = true, overrides = {}) {
  const calls = [];
  let guestFocused = false;
  const document = { activeElement: null };
  const webview = {
    blur() { calls.push("blur"); document.activeElement = null; },
    focus() {
      calls.push("focus");
      if (document.activeElement !== webview) {
        document.activeElement = webview;
        guestFocused = true;
      }
    },
  };
  if (staleHostFocus) document.activeElement = webview;
  const context = {
    document, focusRequestId: 1, active: true, serviceId: "agent-webclient", surfaceId: "main-chat",
    lastHandledFocusRequestIdRef: { current: 0 }, webviewRef: { current: webview },
    isAgentWebclientChatSurface: (service, surface) => service === "agent-webclient" && surface === "main-chat",
    onFocusRequestHandled: (id) => { assert.equal(guestFocused, true); calls.push(`ack:${id}`); },
    ...overrides,
  };
  return { calls, webview, context, hasGuestFocus: () => guestFocused, run: () => vm.runInNewContext(script, context) };
}

test("navigation restores guest keyboard focus even if the host still reports the WebView as active", () => {
  const view = fixture();
  view.webview.focus();
  assert.equal(view.hasGuestFocus(), false);
  view.calls.length = 0;
  view.run();
  assert.equal(view.hasGuestFocus(), true);
  assert.deepEqual(view.calls, ["blur", "focus", "ack:1"]);
  view.run();
  assert.deepEqual(view.calls, ["blur", "focus", "ack:1"]);
});

test("navigation from another host element focuses without an unnecessary blur", () => {
  const view = fixture(false); view.run();
  assert.deepEqual(view.calls, ["focus", "ack:1"]);
});

for (const overrides of [{ active: false }, { focusRequestId: 0 }, { surfaceId: "management" }, { webviewRef: { current: null } }]) {
  test(`does not claim focus for an unavailable or ineligible surface: ${JSON.stringify(overrides)}`, () => {
    const view = fixture(true, overrides); view.run();
    assert.deepEqual(view.calls, []);
    assert.equal(view.context.lastHandledFocusRequestIdRef.current, 0);
  });
}

test("a failed handoff leaves the request available for retry", () => {
  const view = fixture();
  const focus = view.webview.focus;
  view.webview.focus = () => { throw new Error("guest not ready"); };
  view.run();
  assert.equal(view.context.lastHandledFocusRequestIdRef.current, 0);
  view.webview.focus = focus; view.run();
  assert.equal(view.hasGuestFocus(), true);
  assert.deepEqual(view.calls, ["blur", "focus", "ack:1"]);
});
