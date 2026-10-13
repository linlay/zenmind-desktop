import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function compile(relative) {
  const compiled = await build({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
  return module.exports;
}
const { handleServiceWebviewBridgeMessage } = await compile("../src/renderer/services/serviceWebviewBridgeHost.ts");
const {
  isServiceWebviewBridgeRequestType, isServiceWebviewBridgeResponseType,
} = await compile("../src/shared/service-webview-bridge.ts");
const {
  readAgentWebclientNativeShareTarget, isAgentWebclientMainChatRouteAligned,
  areAgentWebclientChatBusinessRoutesEquivalent,
} = await compile("../src/shared/agent-webclient-routes.ts");
const target = { agentKey: "cutej", newChat: "1791788400000", batchId: "36f00671-a11c-4417-bdfa-502d2a14de3b" };

test("native share messages are explicit service bridge requests and responses", () => {
  assert.equal(isServiceWebviewBridgeRequestType("desktop:native-share:read"), true);
  assert.equal(isServiceWebviewBridgeResponseType("desktop:native-share:read:response"), true);
  assert.equal(isServiceWebviewBridgeRequestType("desktop:native-share:open-path"), false);
});

test("only an authorized Main Chat native reader receives share requests", async () => {
  const replies = [];
  const calls = [];
  const context = { serviceId: "agent-webclient", sendBridgeMessageToWebview: result => replies.push(result), setBridgeError() {} };
  const request = { type: "desktop:native-share:read", requestId: "share-1", nativeShareRequest: { ...target, operation: "describe" } };
  const readNativeShare = async value => { calls.push(value); return { ok: true, batchId: target.batchId, files: [{ name: "chat.zip", sizeBytes: 5, mimeType: "application/zip" }] }; };
  assert.equal(handleServiceWebviewBridgeMessage(request, context), true);
  assert.equal(replies.pop().nativeShareResult.code, "not_active");
  handleServiceWebviewBridgeMessage(request, { ...context, serviceId: "external-site", readNativeShare });
  assert.equal(replies.pop().nativeShareResult.code, "not_active");
  assert.equal(calls.length, 0);
  handleServiceWebviewBridgeMessage(request, { ...context, readNativeShare });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [request.nativeShareRequest]);
  assert.equal(replies[0].type, "desktop:native-share:read:response");
  assert.equal(replies[0].requestId, "share-1");
  assert.deepEqual(replies[0].nativeShareResult.files, [{ name: "chat.zip", sizeBytes: 5, mimeType: "application/zip" }]);
});

test("native reader failures produce a recoverable response without filesystem error disclosure", async () => {
  const replies = [];
  handleServiceWebviewBridgeMessage({ type: "desktop:native-share:read", requestId: "share-2", nativeShareRequest: { ...target, operation: "read", fileIndex: 0, offset: 0 } }, {
    serviceId: "agent-webclient", sendBridgeMessageToWebview: result => replies.push(result), setBridgeError() {},
    readNativeShare: async () => { throw new Error("private filesystem location"); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].nativeShareResult.code, "io_error");
  assert.doesNotMatch(replies[0].nativeShareResult.message, /private filesystem/u);
});

test("share routes retain the normal new Chat identity and reject conflicting or invalid targets", () => {
  const route = `/agent/cutej?newChat=${target.newChat}&shareBatch=${target.batchId}`;
  assert.deepEqual(readAgentWebclientNativeShareTarget(route), target);
  assert.equal(isAgentWebclientMainChatRouteAligned(route, `http://127.0.0.1:11948${route}&theme=dark`, "http://127.0.0.1:11948"), true);
  assert.equal(areAgentWebclientChatBusinessRoutesEquivalent(route, `/agent/cutej?newChat=${target.newChat}`), true);
  for (const invalid of [
    `${route}&chatId=history`, `${route}&shareBatch=${target.batchId}`, `${route}&newChat=${target.newChat}`,
    route.replace(target.newChat, "1"), route.replace(target.batchId, "../../private"), route.replace("/agent/cutej", "/copilot/cutej"),
  ]) assert.equal(readAgentWebclientNativeShareTarget(invalid), null, invalid);
});
