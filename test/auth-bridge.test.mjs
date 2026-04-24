import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol
} = require("../dist-electron/shared/auth-bridge.js");

test("buildPluginEmbeddedUrl appends desktopApp=1 for pan-webclient", () => {
  assert.equal(
    buildPluginEmbeddedUrl("pan-webclient", "http://127.0.0.1:8080/pan/"),
    "http://127.0.0.1:8080/pan/?desktopApp=1"
  );
});

test("buildPluginEmbeddedUrl rewrites agent-webclient to /appagent with desktopApp=1", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/"),
    "http://127.0.0.1:9090/appagent?desktopApp=1"
  );
});

test("buildPluginEmbeddedUrl keeps hostTheme for agent-webclient with desktopApp=1", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/", {
      hostTheme: "dark"
    }),
    "http://127.0.0.1:9090/appagent?desktopApp=1&hostTheme=dark"
  );
});

test("getPluginAuthBridgeProtocol returns per-service request and response types", () => {
  assert.deepEqual(getPluginAuthBridgeProtocol("pan-webclient"), {
    requestType: "zenmind:pan-app-auth:request",
    responseType: "zenmind:pan-app-auth:response"
  });
  assert.deepEqual(getPluginAuthBridgeProtocol("agent-webclient"), {
    requestType: "zenmind:agent-app-auth:request",
    responseType: "zenmind:agent-app-auth:response"
  });
  assert.equal(getPluginAuthBridgeProtocol("mini-app-server"), null);
});
