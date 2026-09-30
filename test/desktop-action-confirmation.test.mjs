import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { callDesktopActionConfirmation } = require("../dist-electron/main/modules/desktop-actions/confirmation-queue.js");
const { normalizeConfirmationTimeoutSeconds } = require("../dist-electron/shared/desktop-action-confirmation.js");

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const window = new EventEmitter();
  const messages = [];
  window.isDestroyed = () => false;
  window.webContents = new EventEmitter();
  Object.assign(window.webContents, { id: 7, isDestroyed: () => false, send: (...message) => messages.push(message) });
  const pendingRequests = new Map();
  const options = { getMainWindow: () => window, pendingRequests };
  const request = id => ({ requestId: id, buttons: [{ decision: "confirm" }, { decision: "cancel" }], cancelDecision: "cancel" });
  return { window, messages, pendingRequests, options, request };
}

test("default confirmation lasts 120 seconds and closes at expiry", async t => {
  const f = fixture(t);
  const result = callDesktopActionConfirmation(f.request("a"), f.options);
  assert.equal(f.messages[0][1].expiresAt, Date.now() + 120_000);
  t.mock.timers.tick(120_000);
  assert.equal((await result).reason, "timeout");
  assert.equal(f.pendingRequests.size, 0);
  assert.deepEqual(f.messages[1], ["desktopActions.confirmationClosed", "a"]);
});

test("queued requests time out without ever being displayed", async t => {
  const f = fixture(t);
  const first = callDesktopActionConfirmation(f.request("a"), f.options);
  const second = callDesktopActionConfirmation(f.request("b"), { ...f.options, timeoutMs: 1000 });
  assert.equal(f.messages.length, 1);
  t.mock.timers.tick(1000);
  assert.equal((await second).reason, "timeout");
  assert.equal(f.messages.length, 1);
  assert.equal(f.pendingRequests.get("a").accept({ decision: "cancel" }, 7), true);
  assert.equal((await first).reason, undefined);
});

test("FIFO shows next request with its original deadline and rejects forged or late replies", async t => {
  const f = fixture(t);
  const first = callDesktopActionConfirmation(f.request("a"), f.options);
  const second = callDesktopActionConfirmation(f.request("b"), f.options);
  const pending = f.pendingRequests.get("b");
  assert.equal(pending.accept({ decision: "confirm" }, 7), false);
  assert.equal(f.pendingRequests.get("a").accept({ decision: "confirm" }, 99), false);
  t.mock.timers.tick(30_000);
  f.pendingRequests.get("a").accept({ decision: "confirm", reason: "timeout" }, 7);
  assert.deepEqual(await first, { requestId: "a", decision: "confirm" });
  assert.equal(f.messages[2][1].requestId, "b");
  assert.equal(f.messages[2][1].expiresAt, Date.now() + 90_000);
  // Simulate a suspended event loop: expiry must also be checked on receipt.
  t.mock.timers.setTime(Date.now() + 90_000);
  assert.equal(pending.accept({ decision: "confirm" }, 7), false);
  assert.equal((await second).reason, "timeout");
  assert.equal(pending.accept({ decision: "confirm" }, 7), false);
});

test("upstream abort closes active request and removes queued requests", async t => {
  const f = fixture(t);
  const active = new AbortController();
  const queued = new AbortController();
  const first = callDesktopActionConfirmation(f.request("a"), { ...f.options, signal: active.signal });
  const second = callDesktopActionConfirmation(f.request("b"), { ...f.options, signal: queued.signal });
  queued.abort(); active.abort();
  assert.equal((await first).reason, "aborted");
  assert.equal((await second).reason, "aborted");
  assert.equal(f.pendingRequests.size, 0);
  assert.equal(f.window.listenerCount("closed"), 0);
  assert.equal(f.messages.filter(([type]) => type === "desktopActions.confirm").length, 1);
});

for (const event of ["closed", "destroyed", "render-process-gone", "did-start-loading"]) {
  test(`confirmation ends when owner emits ${event}`, async t => {
    const f = fixture(t);
    const result = callDesktopActionConfirmation(f.request("a"), f.options);
    (event === "closed" ? f.window : f.window.webContents).emit(event);
    assert.equal((await result).reason, "unavailable");
    assert.equal(f.pendingRequests.size, 0);
  });
}

test("confirmation uses earlier tool deadline and never exceeds ten minutes", async t => {
  const f = fixture(t);
  const result = callDesktopActionConfirmation(f.request("a"), { ...f.options, deadlineAt: Date.now() + 20_000 });
  assert.equal(f.messages[0][1].expiresAt, Date.now() + 19_000);
  t.mock.timers.tick(19_000);
  assert.equal((await result).reason, "timeout");
  const capped = callDesktopActionConfirmation(f.request("b"), { ...f.options, timeoutMs: 999_000 });
  assert.equal(f.messages.at(-1)[1].expiresAt, Date.now() + 600_000);
  t.mock.timers.tick(600_000);
  await capped;
  assert.equal(normalizeConfirmationTimeoutSeconds(undefined), 120);
  assert.equal(normalizeConfirmationTimeoutSeconds(999), 600);
  assert.equal(normalizeConfirmationTimeoutSeconds(-2), 1);
});

test("window reload drains a long queue without displaying any queued requests", async t => {
  const f = fixture(t);
  const results = Array.from({ length: 25 }, (_, i) => callDesktopActionConfirmation(f.request(String(i)), f.options));
  assert.equal(f.window.listenerCount("closed"), 1);
  f.window.webContents.emit("did-start-loading");
  assert.ok((await Promise.all(results)).every(result => result.reason === "unavailable"));
  assert.equal(f.messages.filter(([type]) => type === "desktopActions.confirm").length, 1);
  assert.equal(f.window.listenerCount("closed"), 0);
  assert.equal(f.pendingRequests.size, 0);
});
