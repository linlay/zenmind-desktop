import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildPluginEmbeddedUrl,
  clearAuthBridgeProtocols,
  getPluginAuthBridgeProtocol,
  registerAuthBridgeProtocol,
  registerBuiltinAuthBridgeProtocols
} = require("../dist-electron/shared/auth-bridge.js");

function resetRegistry() {
  clearAuthBridgeProtocols();
  registerBuiltinAuthBridgeProtocols();
}

test("buildPluginEmbeddedUrl appends desktopApp=1 for pan-webclient", () => {
  resetRegistry();
  assert.equal(
    buildPluginEmbeddedUrl(
      {
        id: "pan-webclient",
        frontend: {
          embedParams: {
            desktopApp: "1"
          }
        }
      },
      "http://127.0.0.1:8080/pan/"
    ),
    "http://127.0.0.1:8080/pan/?desktopApp=1"
  );
});

test("buildPluginEmbeddedUrl rewrites agent-webclient to /appagent and appends desktopApp=1", () => {
  resetRegistry();
  assert.equal(
    buildPluginEmbeddedUrl(
      {
        id: "agent-webclient",
        frontend: {
          embedPath: "/appagent",
          embedParams: {
            desktopApp: "1"
          }
        }
      },
      "http://127.0.0.1:9090/agent/"
    ),
    "http://127.0.0.1:9090/appagent?desktopApp=1"
  );
});

test("getPluginAuthBridgeProtocol returns per-service request and response types from the registry", () => {
  resetRegistry();
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

test("registerAuthBridgeProtocol allows custom services to register bridge protocols", () => {
  clearAuthBridgeProtocols();
  registerAuthBridgeProtocol("custom-plugin", {
    requestType: "custom:auth:request",
    responseType: "custom:auth:response"
  });

  assert.deepEqual(getPluginAuthBridgeProtocol("custom-plugin"), {
    requestType: "custom:auth:request",
    responseType: "custom:auth:response"
  });
});
