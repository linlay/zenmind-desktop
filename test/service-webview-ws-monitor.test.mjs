import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveServiceWebviewWsMonitorUrl
} = require("../dist-electron/shared/service-webview-ws-monitor.js");

function createJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

test("service webview monitor metadata adds source and deviceId to platform websocket URLs", () => {
  const token = createJwt({ device_id: "device-123" });
  const url = resolveServiceWebviewWsMonitorUrl(
    `ws://127.0.0.1:7080/ws?token=${encodeURIComponent(token)}`,
    "http://127.0.0.1:7080/copilot?wsSource=desktop-copilot"
  );
  const parsed = new URL(url);

  assert.equal(parsed.pathname, "/ws");
  assert.equal(parsed.searchParams.get("token"), token);
  assert.equal(parsed.searchParams.get("source"), "desktop-copilot");
  assert.equal(parsed.searchParams.get("deviceId"), "device-123");
});

test("service webview monitor metadata leaves non-platform websocket URLs unchanged", () => {
  const original = "ws://127.0.0.1:7080/api/voice/ws?token=token-1";

  assert.equal(
    resolveServiceWebviewWsMonitorUrl(
      original,
      "http://127.0.0.1:7080/copilot?wsSource=desktop-copilot"
    ),
    original
  );
});

test("service webview monitor metadata leaves websocket URLs unchanged without wsSource", () => {
  const original = "ws://127.0.0.1:7080/ws?token=token-1";

  assert.equal(
    resolveServiceWebviewWsMonitorUrl(original, "http://127.0.0.1:7080/copilot"),
    original
  );
});

test("service webview monitor metadata keeps empty deviceId when token cannot be decoded", () => {
  const url = resolveServiceWebviewWsMonitorUrl(
    "ws://127.0.0.1:7080/ws?token=not-a-jwt",
    "http://127.0.0.1:7080/copilot?wsSource=desktop-copilot"
  );
  const parsed = new URL(url);

  assert.equal(parsed.searchParams.get("source"), "desktop-copilot");
  assert.equal(parsed.searchParams.get("deviceId"), "");
});
