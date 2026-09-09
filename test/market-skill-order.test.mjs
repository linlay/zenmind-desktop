import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { configureSkillMarketPlatformCaller, readMarketSkillPins, saveMarketSkillPins } = require("../dist-electron/main/modules/marketplace/skill-market.js");
const { registerMarketplaceIpcHandlers } = require("../dist-electron/main/modules/marketplace/ipc.js");

test("Desktop reads and updates the official single-key skill order API", async (t) => {
  const calls = [];
  configureSkillMarketPlatformCaller(async (url, options) => { calls.push({ url, options }); return { version: 1, order: ["B", "a"], updatedAt: 1780000000000 }; });
  t.after(() => configureSkillMarketPlatformCaller(null));
  assert.deepEqual((await readMarketSkillPins()).order, ["b", "a"]);
  assert.equal(calls[0].url, "/api/skills/order");
  await saveMarketSkillPins({ key: " A ", pinned: false, user: "must-not-forward" });
  assert.deepEqual(calls[1], { url: "/api/skills/order", options: { method: "PUT", body: { key: "a", pinned: false } } });
});
test("malformed pin mutations are rejected before calling Platform", async (t) => {
  let calls = 0;
  configureSkillMarketPlatformCaller(async () => { calls++; });
  t.after(() => configureSkillMarketPlatformCaller(null));
  for (const value of [{ key: "../x", pinned: true }, { key: "a" }, { pinned: true }, { key: "a", pinned: "false" }, { pinnedItemIds: ["a"], pinnedSkillKeys: ["a"] }]) {
    await assert.rejects(saveMarketSkillPins(value), /market_skill_pins_invalid/);
  }
  assert.equal(calls, 0);
});

test("malformed server order and unavailable service fail instead of fabricating local pins", async (t) => {
  t.after(() => configureSkillMarketPlatformCaller(null));
  for (const result of [null, { version: 2, order: [] }, { version: 1, order: [null] }, { version: 1, order: [" "] }, { version: 1, order: Array(4097).fill("a") }]) {
    configureSkillMarketPlatformCaller(async () => result);
    await assert.rejects(readMarketSkillPins(), /market_skill_pins_invalid/);
  }
  configureSkillMarketPlatformCaller(null);
  await assert.rejects(readMarketSkillPins(), /market_skill_pins_unavailable/);
  await assert.rejects(saveMarketSkillPins({ key: "a", pinned: true }), /market_skill_pins_unavailable/);
});

test("pin IPC accepts only the current main window top frame", async (t) => {
  const handlers = new Map();
  const frame = {};
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  let window = { webContents, isDestroyed: () => false };
  let calls = 0;
  configureSkillMarketPlatformCaller(async () => { calls++; return { version: 1, order: ["a"] }; });
  t.after(() => configureSkillMarketPlatformCaller(null));
  registerMarketplaceIpcHandlers({ handle: (name, fn) => handlers.set(name, fn) }, { app: {}, getMainWindow: () => window });
  for (const channel of ["market.getSkillPins", "market.saveSkillPins"]) {
    const handler = handlers.get(channel);
    const mutation = { key: "a", pinned: true };
    await assert.rejects(handler({ sender: {}, senderFrame: frame }, mutation), /market_skill_pins_forbidden/);
    await assert.rejects(handler({ sender: webContents, senderFrame: {} }, mutation), /market_skill_pins_forbidden/);
    assert.equal(calls, channel === "market.getSkillPins" ? 0 : 1);
    assert.deepEqual((await handler({ sender: webContents, senderFrame: frame }, mutation)).order, ["a"]);
  }
  window = null;
  await assert.rejects(handlers.get("market.getSkillPins")({ sender: webContents, senderFrame: frame }), /market_skill_pins_forbidden/);
  assert.equal(calls, 2);
});
