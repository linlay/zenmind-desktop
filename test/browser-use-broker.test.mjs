import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopRequests } = require("../dist-electron/main/modules/agent-platform/realtime/desktop-requests.js");
const { BrowserUseRuntime } = require("../dist-electron/main/modules/browser-use/runtime.js");

function setup() {
  const runtime = new BrowserUseRuntime({ createClient: () => { throw new Error("No browser connection expected"); } });
  const events = [];
  const provider = {
    onRunPrepared(source) { events.push("prepared"); runtime.prepareRun(source); },
    onRunGranted(source) { events.push("ready"); runtime.registerRun(source); },
    onRunReleased(id) { events.push("released"); runtime.releaseRun(id); },
  };
  const controller = createDesktopRequests({
    desktopBridgeProvider: null, runActionGrants: new Map(), siteControlGrants: { revokeAll() {} },
    clients: {}, inboundDesktopRequests: new Map(), seenInboundDesktopRequestIds: new Set(), getRunChannel() {},
  });
  controller.setDesktopBridgeProvider(provider);
  return { runtime, controller, events, provider };
}
const identity = { sourceId: "main-chat", chatId: "chat-a", runId: "run-a", owner: { agentKey: "cutej" } };
const request = { method: "Surface.list", source: { chatId: "chat-a", runId: "run-a", agentKey: "cutej" } };

test("canonical readiness freezes the browser before granting execution, then revocation closes that lease", async () => {
  const { controller, runtime, events } = setup();
  let ready;
  controller.registerRunActionGrant({ ...identity, ready: new Promise(resolve => { ready = resolve; }) });
  assert.deepEqual(events, ["prepared"]);
  assert.throws(() => runtime.select("chat-a", "chrome"), { code: "browser_busy" });
  await assert.rejects(runtime.cdp(request, undefined, async () => ({ ok: true })), { code: "browser_run_unavailable" });
  ready(); await Promise.resolve();
  assert.deepEqual(events, ["prepared", "ready"]);
  await runtime.cdp({ ...request, method: "Browser.select", params: { browser: "workpanel" } }, undefined, async () => { throw new Error("unexpected fallback"); });
  assert.equal((await runtime.cdp(request, undefined, async () => ({ ok: true }))).ok, true);
  controller.revokeRunActionGrant("run-a");
  await assert.rejects(runtime.cdp(request, undefined, async () => ({ ok: true })), { code: "browser_run_unavailable" });
  assert.equal(events.at(-1), "released");
});

test("failed or superseded readiness cannot revive an old browser authorization", async () => {
  const { controller, runtime, events } = setup();
  let reject;
  controller.registerRunActionGrant({ ...identity, ready: new Promise((_resolve, fail) => { reject = fail; }) });
  reject(new Error("surface lost")); await Promise.resolve();
  assert.deepEqual(events, ["prepared", "released"]);
  assert.equal(runtime.state("chat-a").activeRunIds.length, 0);
  let ready;
  controller.registerRunActionGrant({ ...identity, ready: new Promise(resolve => { ready = resolve; }) });
  controller.revokeRunActionGrant("run-a");
  ready(); await Promise.resolve();
  await assert.rejects(runtime.cdp(request, undefined, async () => ({ ok: true })), { code: "browser_run_unavailable" });
});

test("replacing the Desktop bridge revokes old leases and replays only ready canonical grants", async () => {
  const { controller, runtime, provider } = setup();
  controller.registerRunActionGrant({ ...identity, ready: Promise.resolve() });
  await Promise.resolve();
  controller.setDesktopBridgeProvider(null);
  await assert.rejects(runtime.cdp(request, undefined, async () => ({ ok: true })), { code: "browser_run_unavailable" });
  controller.setDesktopBridgeProvider(provider);
  await runtime.cdp({ ...request, method: "Browser.select", params: { browser: "workpanel" } }, undefined, async () => { throw new Error("unexpected fallback"); });
  assert.equal((await runtime.cdp(request, undefined, async () => ({ ok: true }))).ok, true);
});
