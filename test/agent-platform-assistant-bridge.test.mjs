import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentPlatformAssistantBridge } = require("../dist-electron/main/assistant/agent-platform-bridge.js");

function makeApp() {
  return {
    getPath(name) {
      return name === "userData" ? "/tmp/zenmind-desktop-test" : "/tmp";
    }
  };
}

function runningService() {
  return {
    status: "running",
    message: "",
    healthMeta: {
      webUrl: "http://127.0.0.1:18888",
      port: 18888
    }
  };
}

function makeBridge(overrides = {}) {
  const events = [];
  const bridge = new AgentPlatformAssistantBridge({
    app: makeApp(),
    onEvent: (event) => events.push(event),
    getServiceState: async () => runningService(),
    issueAccessToken: async () => ({ ok: true, token: "desktop-token", message: "" }),
    ...overrides
  });
  return { bridge, events };
}

function sseResponse(frames) {
  const body = frames.map((frame) => {
    if (frame === "[DONE]") {
      return "event: message\ndata: [DONE]\n\n";
    }
    return `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
  }).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("agent platform assistant bridge returns a clear error when platform is unavailable", async () => {
  const { bridge } = makeBridge({
    getServiceState: async () => ({
      status: "stopped",
      message: "platform stopped",
      healthMeta: { webUrl: "", port: null }
    })
  });

  const result = await bridge.startRun({ message: "hello" });

  assert.equal(result.ok, false);
  assert.match(result.message, /platform stopped/u);
});

test("agent platform assistant bridge forwards startRun to /api/query with bearer auth and emits SSE events", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge, events } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.message, "hello platform");
      assert.equal(body.agentKey, "codeAssistant");
      assert.equal(body.stream, true);
      assert.equal(body.params.desktop.source, "copilot");
      assert.equal(Object.hasOwn(body.params.desktop, "permissionMode"), false);
      assert.equal(Object.hasOwn(body.params.desktop, "historyBeforeMessageId"), false);
      return sseResponse([
        { seq: 1, type: "run.start", runId: body.runId, chatId: body.chatId, timestamp: 1 },
        { seq: 2, type: "content.delta", runId: body.runId, chatId: body.chatId, delta: "hi", timestamp: 2 },
        "[DONE]"
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant" });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/query");
    assert.deepEqual(events.map((event) => event.type), ["run.start", "content.delta", "run.complete"]);
    assert.equal(events[1].delta, "hi");
    assert.equal(events[1].runId, result.runId);
    assert.equal(events[1].chatId, result.chatId);
    assert.equal(events[2].runId, result.runId);
    assert.equal(events[2].chatId, result.chatId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge lists and normalizes agents from /api/agents", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: [
        { key: "codeAssistant", name: "代码助手", role: "CLI 代码助手", stats: { unreadCount: 3 } },
        { key: "zenmi", name: "小宅", role: "平台总管", stats: { unreadCount: 1 } },
        { name: "缺少 key" }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const agents = await bridge.listAgents();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/agents");
    assert.deepEqual(agents, [
      { agentKey: "zenmi", displayName: "小宅", role: "平台总管", unreadCount: 1 },
      { agentKey: "codeAssistant", displayName: "代码助手", role: "CLI 代码助手", unreadCount: 3 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge maps submitAwaiting and stopRun to platform endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ code: 0, msg: "success", data: { accepted: true } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const submit = await bridge.submitAwaiting({
      runId: "run_1",
      chatId: "chat_1",
      awaitingId: "await_1",
      action: "submit",
      params: [{ id: "q1", answer: "ok" }]
    });
    const stop = await bridge.stopRun("run_1");

    assert.equal(submit.ok, true);
    assert.equal(stop.ok, true);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/submit");
    assert.deepEqual(requests[0].body.params, [{ id: "q1", answer: "ok" }]);
    assert.equal(requests[1].url, "http://127.0.0.1:18888/api/interrupt");
    assert.equal(requests[1].body.runId, "run_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
