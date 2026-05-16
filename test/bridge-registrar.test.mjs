import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getBridgeRegistrationState
} = require("../dist-electron/main/bridge-registrar.js");

test("getBridgeRegistrationState returns default state for unknown service", () => {
  const state = getBridgeRegistrationState("nonexistent-service");
  assert.equal(state.registered, false);
  assert.equal(state.channelId, null);
  assert.equal(state.channelName, null);
  assert.equal(state.lastError, null);
});
