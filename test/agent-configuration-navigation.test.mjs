import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const compiled = await build({
  entryPoints: [new URL("../src/renderer/services/serviceWebviewBridgeHost.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
const { handleServiceWebviewBridgeMessage } = module.exports;
const requestType = "desktop:agent-webclient:agent-configuration:open";
const responseType = "desktop:agent-webclient:agent-configuration:opened";

function dispatch(overrides = {}, payload = {}) {
  const opened = [];
  const replies = [];
  const handled = handleServiceWebviewBridgeMessage({
    type: requestType, requestId: "request-1", agentKey: "worker/a", ...payload,
  }, {
    serviceId: "agent-webclient",
    activeAgentConfigurationKey: "worker/a",
    openAgentConfiguration: key => opened.push(key),
    sendBridgeMessageToWebview: reply => replies.push(reply),
    setBridgeError: () => assert.fail("navigation errors must stay in the request response"),
    ...overrides,
  });
  return { opened, replies, handled };
}

test("configuration navigation hands the current Agent to the shell without requiring Agent availability", () => {
  const { opened, replies, handled } = dispatch();
  assert.equal(handled, true);
  assert.deepEqual(opened, ["worker/a"]);
  assert.deepEqual(replies, [{ type: responseType, requestId: "request-1", ok: true }]);
});

test("configuration navigation rejects inactive/unauthorized surfaces, stale Agents and missing capability", () => {
  for (const [context, payload] of [
    [{ activeAgentConfigurationKey: undefined }, {}],
    [{ serviceId: "other-service" }, {}],
    [{ openAgentConfiguration: undefined }, {}],
    [{}, { agentKey: "another-agent" }],
    [{}, { agentKey: "" }],
    [{}, { agentKey: { key: "worker/a" } }],
  ]) {
    const { opened, replies } = dispatch(context, payload);
    assert.deepEqual(opened, []);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].requestId, "request-1");
  }
});

test("navigation failure returns a failed acknowledgement; uncorrelated requests do nothing", () => {
  assert.equal(dispatch({ openAgentConfiguration: () => { throw new Error("failed"); } }).replies[0].ok, false);
  const uncorrelated = dispatch({}, { requestId: undefined });
  assert.equal(uncorrelated.handled, false);
  assert.deepEqual(uncorrelated.opened, []);
});

test("renderer supplies only the active Main Chat identity and constructs the management path", () => {
  const source = readFileSync(new URL("../src/renderer/service-webview/ServiceWebviewSurface.tsx", import.meta.url), "utf8");
  assert.match(source, /activeAgentConfigurationKey: ownsActiveSurface && surfaceId === MAIN_CHAT_SURFACE_ID\s*\? readAgentWebclientAgentRouteKey\(currentRoute\)\s*: undefined/);
  assert.match(source, /openAgentConfiguration: \(agentKey\) => navigate\(createAgentWebclientManagementPath\(agentKey\)\)/);
});

test("preload request and response allowlists include the configuration handoff", async () => {
  const shared = await build({
    entryPoints: [new URL("../src/shared/service-webview-bridge.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "cjs",
  });
  const sharedModule = { exports: {} };
  new Function("module", "exports", shared.outputFiles[0].text)(sharedModule, sharedModule.exports);
  assert.equal(sharedModule.exports.isServiceWebviewBridgeRequestType(requestType), true);
  assert.equal(sharedModule.exports.isServiceWebviewBridgeResponseType(responseType), true);
});
