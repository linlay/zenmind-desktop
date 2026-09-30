import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

async function compile(relative) {
  const result = await build({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true,
    write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
  return module.exports;
}
const { handleServiceWebviewBridgeMessage } = await compile("../src/renderer/services/serviceWebviewBridgeHost.ts");
const shared = await compile("../src/shared/service-webview-bridge.ts");
const routes = await compile("../src/shared/agent-webclient-routes.ts");
const requestType = "desktop:agent-webclient:connector-configuration:open";
const responseType = "desktop:agent-webclient:connector-configuration:opened";

function dispatch(context = {}, payload = {}) {
  const opened = [], replies = [];
  const handled = handleServiceWebviewBridgeMessage({ type: requestType, requestId: "request-1",
    connectorId: "wecom-cli-connector", ...payload }, { serviceId: "agent-webclient",
    canOpenConnectorConfiguration: true, openConnectorConfiguration: id => opened.push(id),
    sendBridgeMessageToWebview: reply => replies.push(reply), setBridgeError: () => assert.fail("request-local error"), ...context });
  return { opened, replies, handled };
}

test("Main Chat connector configuration navigation uses the installed package identity", () => {
  assert.deepEqual(dispatch().opened, ["wecom-cli-connector"]);
  assert.deepEqual(dispatch().replies, [{ type: responseType, requestId: "request-1", ok: true }]);
  assert.equal(routes.createAgentWebclientConnectorManagementPath("wecom-cli-connector"), "/connectors/wecom-cli-connector");
});

test("inactive, non-Main, unavailable and arbitrary destinations do not navigate", () => {
  for (const [context, payload] of [
    [{ serviceId: "other" }, {}], [{ canOpenConnectorConfiguration: false }, {}],
    [{ canOpenConnectorConfiguration: undefined }, {}], [{ openConnectorConfiguration: undefined }, {}],
    [{}, { connectorId: "../private" }], [{}, { connectorId: "wecom/child" }],
    [{}, { connectorId: { id: "wecom-cli-connector" } }], [{}, { connectorId: "" }],
    [{}, { url: "https://untrusted.example" }], [{}, { requestId: "x".repeat(129) }],
  ]) {
    const result = dispatch(context, payload);
    assert.deepEqual(result.opened, []);
    assert.equal(result.replies[0].ok, false);
  }
  assert.equal(dispatch({}, { requestId: undefined }).handled, false);
  assert.equal(dispatch({ openConnectorConfiguration: () => { throw new Error("unavailable"); } }).replies[0].ok, false);
});

test("connector handoff is allowed through both preload lists and requires live Main Chat route alignment", () => {
  assert.equal(shared.isServiceWebviewBridgeRequestType(requestType), true);
  assert.equal(shared.isServiceWebviewBridgeResponseType(responseType), true);
  const source = readFileSync(new URL("../src/renderer/service-webview/ServiceWebviewSurface.tsx", import.meta.url), "utf8");
  assert.match(source, /canOpenConnectorConfiguration: ownsActiveSurface && surfaceId === MAIN_CHAT_SURFACE_ID &&\s*isAgentWebclientMainChatRouteAligned\(currentRoute, readCurrentPromotionGuestUrl\(\), webviewSrcUrl\)/);
  assert.match(source, /openConnectorConfiguration: \(connectorId\) => navigate\(createAgentWebclientConnectorManagementPath\(connectorId\)\)/);
});

test("management handoff accepts explicit text or empty composer intent without a Skill", () => {
  const origin = "http://127.0.0.1:17080";
  for (const composerDraft of ["我想使用「企业微信」查询信息。", ""]) {
    const query = new URLSearchParams({ newChat: "1790000000000", composerDraft });
    const target = `${origin}/agent/cutej?${query}`;
    assert.equal(routes.resolveAgentWebclientDesktopComposerRouteFromUrl(target, `${origin}/connectors/wecom-cli-connector`), `/agent/cutej?${query}`);
    for (const invalid of [target.replace(origin, "https://untrusted.example"), `${target}&chatId=previous`,
      `${target}&composerDraft=again`, `${target}&newChat=1790000000001`, `${target}&composerSkill=`,
      `${target}&composerSkill=untrusted-skill`, `${target}#other`]) {
      assert.equal(routes.resolveAgentWebclientDesktopComposerRouteFromUrl(invalid, origin), "");
    }
  }
  const missing = `${origin}/agent/cutej?newChat=1790000000000`;
  assert.equal(routes.resolveAgentWebclientDesktopComposerRouteFromUrl(missing, origin), "");
  for (const composerDraft of [" ", "a".repeat(2049)]) {
    const query = new URLSearchParams({ newChat: "1790000000000", composerDraft });
    assert.equal(routes.resolveAgentWebclientDesktopComposerRouteFromUrl(`${origin}/agent/cutej?${query}`, origin), "");
  }
});
