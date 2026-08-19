import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildServiceWebviewUrl
} = require("../dist-electron/shared/auth-bridge.js");
const {
  areAgentWebclientHostRouteParamsEqual,
  areAgentWebclientChatBusinessRoutesEquivalent,
  areAgentWebclientChatNavigationUrlsEquivalent,
  createAgentWebclientAgentPath,
  createAgentWebclientCopilotPath,
  createAgentWebclientManagementPath,
  createAgentWebclientOverviewPath,
  createAgentWebclientProjectPath,
  resolveAgentWebclientDesktopChatRouteFromUrl,
  resolveAgentWebclientWsSource
} = require("../dist-electron/shared/agent-webclient-routes.js");

function buildAgentWebclientUrl(surfaceId, embedPath, allowMainWindowDrag = false) {
  return new URL(buildServiceWebviewUrl(
    "agent-webclient",
    "http://127.0.0.1:7080/",
    {
      hostTheme: "light",
      hostLocale: "en-US",
      embedPath,
      wsSource: resolveAgentWebclientWsSource(surfaceId, embedPath),
      allowMainWindowDrag
    }
  ));
}

test("main service webview URL opts into the guest window drag bridge", () => {
  const mainSurface = buildAgentWebclientUrl(
    "main-chat",
    "/agent/zenmi?chatId=chat-1",
    true
  );
  const nestedSurface = buildAgentWebclientUrl(
    "main-chat",
    "/agent/zenmi?chatId=chat-1"
  );

  assert.equal(mainSurface.searchParams.get("desktopWindowDrag"), "1");
  assert.equal(nestedSurface.searchParams.has("desktopWindowDrag"), false);
});

test("agent chat embedded URL keeps chat WebSocket source without auth context", () => {
  const url = buildAgentWebclientUrl(
    "main-chat",
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
    "copilot-chat",
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
    "/mcp-servers",
    "/registries"
  ];

  for (const embedPath of managementPaths) {
    const url = buildAgentWebclientUrl("agent-webclient", embedPath);
    assert.equal(url.searchParams.has("wsSource"), false, embedPath);
    assert.equal(url.searchParams.has("desktopAuthContext"), false, embedPath);
  }
});

test("project embedded URL carries project identity without a WebSocket source", () => {
  const embedPath = createAgentWebclientProjectPath({
    agentKey: "知识库 alpha",
    chatId: "chat-1",
    runId: "run-2"
  });
  const url = buildAgentWebclientUrl(
    "proj:fixture",
    embedPath
  );

  assert.equal(url.pathname, "/project/%E7%9F%A5%E8%AF%86%E5%BA%93%20alpha");
  assert.equal(url.searchParams.has("agentKey"), false);
  assert.equal(url.searchParams.get("chatId"), "chat-1");
  assert.equal(url.searchParams.get("runId"), "run-2");
  assert.equal(url.searchParams.has("wsSource"), false);
  assert.equal(url.searchParams.has("desktopAuthContext"), false);
});

test("overview route uses the chat identity as its only dynamic path segment", () => {
  assert.equal(
    createAgentWebclientOverviewPath({ chatId: "chat 1" }),
    "/overview/chat%201",
  );
  assert.equal(
    createAgentWebclientOverviewPath({ chatId: "对话/二" }),
    "/overview/%E5%AF%B9%E8%AF%9D%2F%E4%BA%8C",
  );
  assert.equal(createAgentWebclientOverviewPath({ chatId: "  " }), "");
  assert.equal(new URL(createAgentWebclientOverviewPath({ chatId: "chat-2" }), "https://example.test").search, "");
});

test("main chat route comparison ignores host presentation params and their order", () => {
  const current =
    "http://127.0.0.1:19011/agent/cutej?theme=dark&lang=zh-CN&wsSource=desktop-chat&desktopWindowDrag=1&chatId=chat-1";
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

test("host presentation comparison detects every host parameter change", () => {
  const base =
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=light&hostTheme=light&lang=zh-CN&wsSource=desktop-chat&desktopWindowDrag=1";
  const reorderedBase =
    "http://127.0.0.1:19011/agent/cutej?desktopWindowDrag=1&wsSource=desktop-chat&lang=zh-CN&hostTheme=light&theme=light&chatId=chat-1";

  assert.equal(areAgentWebclientHostRouteParamsEqual(base, reorderedBase), true);
  for (const changed of [
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=dark&hostTheme=light&lang=zh-CN&wsSource=desktop-chat",
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=light&hostTheme=dark&lang=zh-CN&wsSource=desktop-chat",
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=light&hostTheme=light&lang=en-US&wsSource=desktop-chat",
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=light&hostTheme=light&lang=zh-CN&wsSource=desktop-management&desktopWindowDrag=1",
    "http://127.0.0.1:19011/agent/cutej?chatId=chat-1&theme=light&hostTheme=light&lang=zh-CN&wsSource=desktop-chat"
  ]) {
    assert.equal(areAgentWebclientHostRouteParamsEqual(base, changed), false);
  }
});

test("agent family paths keep non-ASCII keys at one encoding layer", () => {
  assert.equal(
    createAgentWebclientAgentPath("AI建设文档"),
    "/agent/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3"
  );
  assert.equal(
    createAgentWebclientManagementPath("AI建设文档"),
    "/agents/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3"
  );
  assert.equal(
    createAgentWebclientCopilotPath("AI建设文档"),
    "/copilot/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3"
  );
  assert.equal(
    createAgentWebclientAgentPath("100%助手"),
    "/agent/100%25%E5%8A%A9%E6%89%8B"
  );
  assert.doesNotMatch(createAgentWebclientAgentPath("AI建设文档"), /%25E5/u);
});

test("agent chat business routes compare semantic keys and ignore host params", () => {
  const desktopRoute =
    "/agent/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3?chatId=chat-1&custom=%E4%B8%AD%E6%96%87";
  const webviewUrl =
    "http://127.0.0.1:19011/agent/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3?theme=dark&custom=%E4%B8%AD%E6%96%87&chatId=chat-1&lang=zh-CN&wsSource=desktop-chat";

  assert.equal(
    areAgentWebclientChatBusinessRoutesEquivalent(desktopRoute, webviewUrl),
    true
  );
  assert.equal(
    areAgentWebclientChatBusinessRoutesEquivalent(
      desktopRoute,
      webviewUrl.replace("chat-1", "chat-2")
    ),
    false
  );
});

test("webview chat routes mirror all business params but no host params", () => {
  const webviewSrcUrl = "http://127.0.0.1:19011/agents";
  const webviewUrl =
    "http://127.0.0.1:19011/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?theme=dark&chatId=chat-1&custom=%E4%B8%AD%E6%96%87&lang=zh-CN&wsSource=desktop-chat";

  assert.equal(
    resolveAgentWebclientDesktopChatRouteFromUrl(webviewUrl, webviewSrcUrl),
    "/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?chatId=chat-1&custom=%E4%B8%AD%E6%96%87"
  );
  assert.equal(
    resolveAgentWebclientDesktopChatRouteFromUrl(
      webviewUrl.replace("127.0.0.1:19011", "127.0.0.1:19012"),
      webviewSrcUrl
    ),
    ""
  );
  assert.equal(
    resolveAgentWebclientDesktopChatRouteFromUrl(
      webviewUrl.replace("chatId=chat-1&", ""),
      webviewSrcUrl
    ),
    ""
  );
});

test("desktop and webview chat routing stays byte-stable for 100 sync rounds", () => {
  const webviewOrigin = "http://127.0.0.1:19011";
  const initialRoute =
    "/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?chatId=chat-1&custom=%E4%B8%AD%E6%96%87";
  let desktopRoute = initialRoute;

  for (let index = 0; index < 100; index += 1) {
    const parsed = new URL(desktopRoute, "http://desktop.local");
    const rawAgentKey = /^\/agent\/([^/]+)$/u.exec(parsed.pathname)?.[1] ?? "";
    const agentKey = decodeURIComponent(rawAgentKey);
    const webviewUrl = new URL(
      createAgentWebclientAgentPath(agentKey, parsed.searchParams),
      webviewOrigin
    ).toString();
    desktopRoute = resolveAgentWebclientDesktopChatRouteFromUrl(
      webviewUrl,
      `${webviewOrigin}/agents`
    );
    assert.equal(desktopRoute, initialRoute, `sync round ${index + 1}`);
  }
});

test("newChat converges to chatId once and stable guest routes are no-ops", () => {
  const webviewOrigin = "http://127.0.0.1:19011";
  let desktopRoute =
    "/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?newChat=1710000000000";
  const stableWebviewUrl =
    `${webviewOrigin}/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?chatId=chat-1&theme=dark&lang=zh-CN&wsSource=desktop-chat`;
  let replaceCount = 0;

  for (let index = 0; index < 100; index += 1) {
    const nextRoute = resolveAgentWebclientDesktopChatRouteFromUrl(
      stableWebviewUrl,
      `${webviewOrigin}/agents`
    );
    if (!areAgentWebclientChatBusinessRoutesEquivalent(desktopRoute, nextRoute)) {
      desktopRoute = nextRoute;
      replaceCount += 1;
    }
  }

  assert.equal(replaceCount, 1);
  assert.equal(
    desktopRoute,
    "/agent/%E5%86%92%E7%83%9F%E6%96%87%E6%A1%A3?chatId=chat-1"
  );
});

test("copilot path generation uses the semantic catalog key", () => {
  const requestedPath = "/copilot/AI%E5%BB%BA%E8%AE%BE%E6%96%87%E6%A1%A3";
  const rawAgentKey = /^\/copilot\/([^/]+)$/u.exec(requestedPath)?.[1] ?? "";
  const semanticAgentKey = decodeURIComponent(rawAgentKey);
  const catalogKeys = ["冒烟文档", "AI建设文档"];

  assert.equal(catalogKeys.includes(semanticAgentKey), true);
  assert.equal(createAgentWebclientCopilotPath(semanticAgentKey), requestedPath);
});
