import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildPluginEmbeddedUrl
} = require("../dist-electron/shared/auth-bridge.js");
const {
  areAgentWebclientChatNavigationUrlsEquivalent,
  resolveAgentWebclientWsSource
} = require("../dist-electron/shared/agent-webclient-routes.js");

function buildAgentWebclientUrl(surfaceId, embedPath) {
  return new URL(buildPluginEmbeddedUrl(
    "agent-webclient",
    "http://127.0.0.1:7080/",
    {
      hostTheme: "light",
      hostLocale: "en-US",
      embedPath,
      wsSource: resolveAgentWebclientWsSource(surfaceId, embedPath)
    }
  ));
}

test("agent chat embedded URL keeps chat WebSocket source without auth context", () => {
  const url = buildAgentWebclientUrl(
    "agent-webclient-chat",
    "/agent/zenmi?chatId=chat-1"
  );

  assert.equal(url.pathname, "/agent/zenmi");
  assert.equal(url.searchParams.get("chatId"), "chat-1");
  assert.equal(url.searchParams.get("theme"), "light");
  assert.equal(url.searchParams.get("lang"), "en-US");
  assert.equal(url.searchParams.get("wsSource"), "desktop-chat");
  assert.equal(url.searchParams.has("desktopAuthContext"), false);
});

test("copilot embedded URL keeps copilot WebSocket source", () => {
  const url = buildAgentWebclientUrl(
    "agent-webclient-copilot",
    "/copilot/zenmi"
  );

  assert.equal(url.searchParams.get("wsSource"), "desktop-copilot");
  assert.equal(url.searchParams.has("desktopAuthContext"), false);
});

test("management embedded URLs do not carry WebSocket source or auth context", () => {
  const managementPaths = [
    "/agents",
    "/agents/zenmi",
    "/archives",
    "/automations",
    "/memory",
    "/registries"
  ];

  for (const embedPath of managementPaths) {
    const url = buildAgentWebclientUrl("agent-webclient", embedPath);
    assert.equal(url.searchParams.has("wsSource"), false, embedPath);
    assert.equal(url.searchParams.has("desktopAuthContext"), false, embedPath);
  }
});

test("main chat route comparison ignores host presentation params and their order", () => {
  const current =
    "http://127.0.0.1:19011/agent/cutej?theme=dark&lang=zh-CN&wsSource=desktop-chat&chatId=chat-1";
  const target =
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&wsSource=desktop-chat&theme=light&lang=en-US";

  assert.equal(
    areAgentWebclientChatNavigationUrlsEquivalent(current, target),
    true
  );
  assert.equal(
    areAgentWebclientChatNavigationUrlsEquivalent(
      current,
      "http://127.0.0.1:19011/agent/cutej?chatId=chat-2"
    ),
    false
  );
  assert.equal(
    areAgentWebclientChatNavigationUrlsEquivalent(
      current,
      "http://127.0.0.1:19011/agent/cutej?newChat=2026-07-16T10%3A00%3A00.000Z"
    ),
    false
  );
  assert.equal(
    areAgentWebclientChatNavigationUrlsEquivalent(
      current,
      "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&history=1"
    ),
    false
  );
});
