import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  normalizeDesktopWsUrlInput
} = require("../dist-electron/shared/desktop-ws-protocol.js");

test("desktop ws protocol helper normalizes websocket URLs", () => {
  assert.equal(
    normalizeDesktopWsUrlInput("desktop.example.test"),
    "wss://desktop.example.test/ws"
  );
  assert.equal(
    normalizeDesktopWsUrlInput("wss://desktop.example.test/custom?source=old&deviceId=old#debug"),
    "wss://desktop.example.test/ws"
  );
});
