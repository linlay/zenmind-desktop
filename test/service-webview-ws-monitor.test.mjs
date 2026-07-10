import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  resolveServiceWebviewWsMonitorUrl
} = require("../dist-electron/shared/service-webview-ws-monitor.js");

function unsignedToken(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

test("service webview copies page wsSource into the /ws handshake", () => {
  const token = unsignedToken({ device_id: "desktop-device-1" });
  const result = new URL(resolveServiceWebviewWsMonitorUrl(
    `ws://127.0.0.1:7080/ws?token=${encodeURIComponent(token)}`,
    "http://127.0.0.1:7080/agent/zenmi?wsSource=desktop-chat"
  ));

  assert.equal(result.searchParams.get("source"), "desktop-chat");
  assert.equal(result.searchParams.get("deviceId"), "desktop-device-1");
});

test("service webview leaves WebSocket URLs unchanged without page wsSource", () => {
  const original = "ws://127.0.0.1:7080/ws?token=token-1";
  assert.equal(
    resolveServiceWebviewWsMonitorUrl(
      original,
      "http://127.0.0.1:7080/agents"
    ),
    original
  );
});

test("service webview does not annotate non-platform WebSocket paths", () => {
  const original = "ws://127.0.0.1:7080/api/voice/ws?token=token-1";
  assert.equal(
    resolveServiceWebviewWsMonitorUrl(
      original,
      "http://127.0.0.1:7080/agent/zenmi?wsSource=desktop-chat"
    ),
    original
  );
});
