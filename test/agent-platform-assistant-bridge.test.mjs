import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { AgentPlatformAssistantBridge } = require("../dist-electron/main/copilot/core/agent-platform-bridge.js");
const { APP_BRAND } = require("../dist-electron/shared/generated/brand.js");

function makeApp(homeDir = "/tmp") {
  return {
    getPath(name) {
      return name === "userData" ? "/tmp/zenmind-desktop-test" : homeDir;
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
    app: overrides.app ?? makeApp(),
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

function makeWakeLockRecorder() {
  const calls = [];
  return {
    calls,
    wakeLock: {
      acquire: () => calls.push("acquire"),
      release: () => calls.push("release")
    }
  };
}

function sseFrame(frame) {
  if (frame === "[DONE]") {
    return "event: message\ndata: [DONE]\n\n";
  }
  return `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
}

function createControlledSseResponse() {
  const encoder = new TextEncoder();
  let streamController;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    }
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }),
    send(frame) {
      if (!closed) {
        streamController.enqueue(encoder.encode(sseFrame(frame)));
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        streamController.close();
      } catch {
        // Stream cancellation can win races in abort tests.
      }
    }
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
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

test("agent platform assistant bridge does not acquire wake lock for rejected starts", async () => {
  const emptyWakeLock = makeWakeLockRecorder();
  const empty = makeBridge({ wakeLock: emptyWakeLock.wakeLock });

  const emptyResult = await empty.bridge.startRun({ message: "   " });

  assert.equal(emptyResult.ok, false);
  assert.deepEqual(emptyWakeLock.calls, []);

  const unavailableWakeLock = makeWakeLockRecorder();
  const unavailable = makeBridge({
    wakeLock: unavailableWakeLock.wakeLock,
    getServiceState: async () => ({
      status: "stopped",
      message: "platform stopped",
      healthMeta: { webUrl: "", port: null }
    })
  });

  const unavailableResult = await unavailable.bridge.startRun({ message: "hello" });

  assert.equal(unavailableResult.ok, false);
  assert.deepEqual(unavailableWakeLock.calls, []);
});

test("agent platform assistant bridge holds wake lock while a run is active", async () => {
  const originalFetch = globalThis.fetch;
  const wakeLock = makeWakeLockRecorder();
  const { bridge, events } = makeBridge({ wakeLock: wakeLock.wakeLock });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      assert.deepEqual(wakeLock.calls, ["acquire"]);
      const body = JSON.parse(String(init.body));
      return sseResponse([
        { seq: 1, type: "content.delta", runId: body.runId, chatId: body.chatId, delta: "awake", timestamp: 1 },
        "[DONE]"
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform" });

    assert.equal(result.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    await waitFor(() => wakeLock.calls.includes("release"), "wake lock was not released after run completion");
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
    assert.deepEqual(events.map((event) => event.type), ["content.delta", "run.complete"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge shares one wake lock across concurrent runs", async () => {
  const originalFetch = globalThis.fetch;
  const wakeLock = makeWakeLockRecorder();
  const streams = [];
  const { bridge, events } = makeBridge({ wakeLock: wakeLock.wakeLock });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      const stream = createControlledSseResponse();
      streams.push({ body, stream });
      return stream.response;
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const first = await bridge.startRun({ message: "first" });
    const second = await bridge.startRun({ message: "second" });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    await waitFor(() => streams.length === 2, "expected both query streams to start");

    streams[0].stream.send({
      seq: 1,
      type: "content.delta",
      runId: streams[0].body.runId,
      chatId: streams[0].body.chatId,
      delta: "first",
      timestamp: 1
    });
    streams[0].stream.close();
    await waitFor(
      () => events.some((event) => event.runId === first.runId && event.type === "run.complete"),
      "first run did not complete"
    );
    assert.deepEqual(wakeLock.calls, ["acquire"]);

    streams[1].stream.send({
      seq: 1,
      type: "content.delta",
      runId: streams[1].body.runId,
      chatId: streams[1].body.chatId,
      delta: "second",
      timestamp: 1
    });
    streams[1].stream.close();
    await waitFor(() => wakeLock.calls.includes("release"), "wake lock was not released after both runs completed");
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
  } finally {
    streams.forEach(({ stream }) => stream.close());
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge releases wake lock when stopRun interrupt fails", async () => {
  const originalFetch = globalThis.fetch;
  const wakeLock = makeWakeLockRecorder();
  const streams = [];
  const { bridge } = makeBridge({ wakeLock: wakeLock.wakeLock });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      const stream = createControlledSseResponse();
      init.signal?.addEventListener("abort", () => stream.close(), { once: true });
      streams.push(stream);
      return stream.response;
    }
    if (String(url).endsWith("/api/interrupt")) {
      return new Response("interrupt failed", { status: 500 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform" });
    assert.equal(result.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    await waitFor(() => streams.length === 1, "query stream did not start");

    const stop = await bridge.stopRun(result.runId);

    assert.equal(stop.ok, false);
    assert.match(stop.message, /interrupt failed/u);
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
  } finally {
    streams.forEach((stream) => stream.close());
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge forwards startRun accessLevel and emits aggregated completion message", async () => {
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
      assert.equal(body.accessLevel, "auto_approve");
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
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant", accessLevel: "auto_approve" });
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
    assert.equal(events[2].message, "hi");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge uses terminal result payload as completion message", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge, events } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      return sseResponse([
        {
          seq: 1,
          type: "run.complete",
          runId: body.runId,
          chatId: body.chatId,
          data: { result: "云端验证OK" },
          timestamp: 1
        }
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant", accessLevel: "auto_approve" });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events.map((event) => event.type), ["run.complete"]);
    assert.equal(events[0].runId, result.runId);
    assert.equal(events[0].chatId, result.chatId);
    assert.equal(events[0].message, "云端验证OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge falls back to persisted chat jsonl for empty completion events", async () => {
  const originalFetch = globalThis.fetch;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-test-"));
  const { bridge, events } = makeBridge({ app: makeApp(homeDir) });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      const chatDir = path.join(homeDir, APP_BRAND.paths.runtimeRootDirName, "chats");
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(
        path.join(chatDir, `${body.chatId}.jsonl`),
        [
          JSON.stringify({ chatId: body.chatId, runId: body.runId, _type: "query", query: body }),
          JSON.stringify({
            chatId: body.chatId,
            runId: body.runId,
            _type: "react",
            seq: 1,
            messages: [
              { role: "assistant", content: [{ type: "text", text: "最终回答来自本地会话文件" }] }
            ]
          })
        ].join("\n")
      );
      return sseResponse([
        { seq: 1, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: 1 }
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant", accessLevel: "auto_approve" });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events.map((event) => event.type), ["run.complete"]);
    assert.equal(events[0].runId, result.runId);
    assert.equal(events[0].chatId, result.chatId);
    assert.equal(events[0].message, "最终回答来自本地会话文件");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(homeDir, { recursive: true, force: true });
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
        { key: "zenmi", name: "小宅", role: "平台总管", icon: { name: "summit" }, stats: { unreadCount: 1 } },
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
      { agentKey: "codeAssistant", displayName: "代码助手", role: "CLI 代码助手", unreadCount: 3 },
      { agentKey: "zenmi", displayName: "小宅", role: "平台总管", icon: { name: "summit" }, unreadCount: 1 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge returns no agents when platform is installed but stopped", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge({
    getServiceState: async () => ({
      status: "stopped",
      message: "服务已安装，可手动启动。",
      healthMeta: { webUrl: "", port: null }
    })
  });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const agents = await bridge.listAgents();

    assert.deepEqual(agents, []);
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

test("agent platform assistant bridge deletes chats through the platform chat delete endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await bridge.deleteChat(" chat_1 ");

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chat/delete?chatId=chat_1");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(requests[0].body, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge downloads chat export from the current platform endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response("# Exported chat\n", {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": 'attachment; filename="Renamed chat.md"'
      }
    });
  };

  try {
    const result = await bridge.downloadChatExport(" chat_1 ");

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chat/export?chatId=chat_1");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(result.filename, "Renamed chat.md");
    assert.equal(result.bytes.toString("utf8"), "# Exported chat\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge recovers UTF-8 filenames from legacy quoted content disposition", async () => {
  const originalFetch = globalThis.fetch;
  const expectedFilename = "\u6211\u73b0\u5728.md";
  const legacyQuotedFilename = Buffer.from(expectedFilename, "utf8").toString("latin1");
  const { bridge } = makeBridge();
  globalThis.fetch = async (_url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    return new Response("# Exported chat\n", {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${legacyQuotedFilename}"`
      }
    });
  };

  try {
    const result = await bridge.downloadChatExport(" chat_1 ");

    assert.equal(result.ok, true);
    assert.equal(result.filename, expectedFilename);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
