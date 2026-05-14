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

test("buildPluginEmbeddedUrl rewrites agent-webclient to root without desktopApp query", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/"),
    "http://127.0.0.1:9090/"
  );
});

test("buildPluginEmbeddedUrl keeps hostTheme for agent-webclient without desktopApp query", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/", {
      hostTheme: "dark"
    }),
    "http://127.0.0.1:9090/?hostTheme=dark"
  );
});

test("buildPluginEmbeddedUrl carries desktop auth context for agent-webclient", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/", {
      hostTheme: "dark",
      desktopAuthContext: "webclient:101:platform:202"
    }),
    "http://127.0.0.1:9090/?hostTheme=dark&desktopAuthContext=webclient%3A101%3Aplatform%3A202"
  );
});

test("buildPluginEmbeddedUrl opens agent-webclient desktop sections with auth context", () => {
  for (const embedPath of ["/agents", "/schedules", "/memory"]) {
    assert.equal(
      buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/", {
        hostTheme: "dark",
        desktopAuthContext: "webclient:101:platform:202",
        embedPath
      }),
      `http://127.0.0.1:9090${embedPath}?hostTheme=dark&desktopAuthContext=webclient%3A101%3Aplatform%3A202`
    );
  }
});

test("buildPluginEmbeddedUrl normalizes agent-webclient desktop section paths", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "http://127.0.0.1:9090/agent/", {
      embedPath: "agents"
    }),
    "http://127.0.0.1:9090/agents"
  );
});

test("buildPluginEmbeddedUrl resolves relative agent-webclient URLs from the service base", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "/agent/", {
      baseUrl: "http://127.0.0.1:18082"
    }),
    "http://127.0.0.1:18082/"
  );
});

test("buildPluginEmbeddedUrl accepts localhost URLs without a protocol", () => {
  assert.equal(
    buildPluginEmbeddedUrl("agent-webclient", "127.0.0.1:18082/agent/"),
    "http://127.0.0.1:18082/"
  );
});

test("buildPluginEmbeddedUrl returns empty string for invalid URLs", () => {
  assert.equal(buildPluginEmbeddedUrl("agent-webclient", "http://[bad"), "");
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
