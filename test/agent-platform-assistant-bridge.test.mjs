import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { AgentPlatformAssistantBridge } = require("../dist-electron/main/assistant/core/agent-platform-bridge.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

const EPOCH_MS = 1_783_000_000_000;

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

test("agent platform assistant bridge waits for a text completion", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    return sseResponse([
      { seq: 1, type: "content.delta", runId: body.runId, chatId: body.chatId, delta: "Hello", timestamp: EPOCH_MS },
      { seq: 2, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS + 1 },
      "[DONE]"
    ]);
  };

  try {
    const result = await bridge.completeText({ message: "Translate this" });
    assert.equal(result.ok, true);
    assert.equal(result.text, "Hello");
    assert.match(result.runId, /^run_/u);
    assert.match(result.chatId, /^chat_/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge proxies global chat search with bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      query: "deploy",
      count: 1,
      results: [
        {
          chatId: "chat-1",
          chatName: "Deploy notes",
          agentKey: "coder",
          runId: "run-1",
          kind: "message",
          role: "assistant",
          timestamp: 1710000000000,
          snippet: "deploy snippet",
          score: 18
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await bridge.searchChats({ query: "  deploy  ", limit: 30 });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chats/search");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.Authorization, "Bearer desktop-token");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      query: "deploy",
      limit: 30
    });
    assert.equal("teamId" in JSON.parse(String(requests[0].init.body)), false);
    assert.equal("agentKey" in JSON.parse(String(requests[0].init.body)), false);
    assert.deepEqual(result.results.map((item) => [item.chatId, item.agentKey, item.snippet]), [
      ["chat-1", "coder", "deploy snippet"]
    ]);
    assert.equal(result.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
        { seq: 1, type: "content.delta", runId: body.runId, chatId: body.chatId, delta: "awake", timestamp: EPOCH_MS },
        { seq: 2, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS + 1 },
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

test("agent platform assistant bridge reuses an existing chat with a new run id", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      return sseResponse([
        { seq: 1, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS + requests.length },
        "[DONE]"
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const first = await bridge.startRun({ chatId: "chat-existing", message: "first pass" });
    await waitFor(() => requests.length === 1, "first rerun was not submitted");
    const second = await bridge.startRun({ chatId: "chat-existing", message: "second pass" });
    await waitFor(() => requests.length === 2, "second rerun was not submitted");

    assert.equal(first.chatId, "chat-existing");
    assert.equal(second.chatId, "chat-existing");
    assert.notEqual(first.runId, second.runId);
    assert.deepEqual(requests.map((request) => request.chatId), ["chat-existing", "chat-existing"]);
    assert.deepEqual(requests.map((request) => request.runId), [first.runId, second.runId]);
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
      timestamp: EPOCH_MS
    });
    streams[0].stream.send({
      seq: 2,
      type: "run.complete",
      runId: streams[0].body.runId,
      chatId: streams[0].body.chatId,
      timestamp: EPOCH_MS + 1
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
      timestamp: EPOCH_MS + 2
    });
    streams[1].stream.send({
      seq: 2,
      type: "run.complete",
      runId: streams[1].body.runId,
      chatId: streams[1].body.chatId,
      timestamp: EPOCH_MS + 3
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
      assert.equal(body.runId, "run-stable-1");
      assert.equal(body.requestId, "request-stable-1");
      assert.equal(body.chatId, "chat-stable-1");
      assert.equal(body.agentKey, "codeAssistant");
      assert.equal(body.accessLevel, "auto_approve");
      assert.equal(body.stream, true);
      assert.equal(body.params.desktop.source, "copilot");
      assert.equal(Object.hasOwn(body.params.desktop, "permissionMode"), false);
      assert.equal(Object.hasOwn(body.params.desktop, "historyBeforeMessageId"), false);
      return sseResponse([
        { seq: 1, type: "run.start", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS },
        { seq: 2, type: "content.delta", runId: body.runId, chatId: body.chatId, delta: "hi", timestamp: EPOCH_MS + 1 },
        { seq: 3, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS + 2 },
        "[DONE]"
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({
      message: "hello platform",
      agentKey: "codeAssistant",
      accessLevel: "auto_approve",
      chatId: "chat-stable-1",
      runId: "run-stable-1",
      requestId: "request-stable-1"
    });
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

test("agent platform assistant bridge rejects ISO, string, seconds, fractional, negative, and missing stream timestamps", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const timestamp of [
      "2026-07-13T00:00:00.000Z",
      String(EPOCH_MS),
      EPOCH_MS / 1_000,
      EPOCH_MS + 0.5,
      -1,
      undefined,
    ]) {
      const { bridge, events } = makeBridge();
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).endsWith("/api/query")) {
          const body = JSON.parse(String(init.body));
          return sseResponse([{
            seq: 1,
            type: "content.delta",
            runId: body.runId,
            chatId: body.chatId,
            delta: "must not reach the desktop",
            ...(timestamp === undefined ? {} : { timestamp })
          }]);
        }
        throw new Error(`unexpected request ${url}`);
      };

      const result = await bridge.startRun({ message: "strict timestamp" });
      assert.equal(result.ok, true);
      await waitFor(() => events.some((event) => event.type === "error"), "malformed stream did not surface a local error");
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      assert.match(events[0].error ?? "", /time_contract_violation/u);
      assert.equal(Object.hasOwn(events[0], "createdAt"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge atomically rejects malformed chat, search, and memory response times", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const value of [
      "2026-07-13T00:00:00.000Z",
      String(EPOCH_MS),
      EPOCH_MS / 1_000,
      EPOCH_MS + 0.5,
      -1,
      undefined,
    ]) {
      const { bridge } = makeBridge();
      const invalid = value === undefined ? {} : { updatedAt: value };
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("/api/chats/search")) {
          return new Response(JSON.stringify({
            query: "time",
            count: 2,
            results: [
              { chatId: "valid", timestamp: EPOCH_MS, snippet: "valid" },
              {
                chatId: "invalid",
                timestamp: value,
                snippet: "invalid",
              },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/api/memory/record/list")) {
          return new Response(JSON.stringify({
            results: [{
              id: "memory-1",
              createdAt: EPOCH_MS,
              ...invalid,
            }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/api/memory/history")) {
          return new Response(JSON.stringify({
            events: [{ operation: "learn", ts: value }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/api/chat?")) {
          return new Response(JSON.stringify({
            chatId: "chat-1",
            createdAt: EPOCH_MS,
            ...invalid,
            events: [],
            runs: [],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.endsWith("/api/chats")) {
          return new Response(JSON.stringify([
            { chatId: "valid", createdAt: EPOCH_MS, updatedAt: EPOCH_MS },
            { chatId: "invalid", createdAt: EPOCH_MS, ...invalid },
          ]), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error(`unexpected request ${target}`);
      };

      await assert.rejects(bridge.listChats(), /time_contract_violation: chats\[1\]\.updatedAt/u);
      await assert.rejects(bridge.getChat("chat-1"), /time_contract_violation: chat\.updatedAt/u);
      await assert.rejects(bridge.searchChats({ query: "time" }), /time_contract_violation: chatSearch\.results\[1\]\.timestamp/u);
      await assert.rejects(bridge.listMemoryItems(), /time_contract_violation: memory\.records\[0\]\.updatedAt/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge rejects malformed memory audit timestamps", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const value of [
      "2026-07-13T00:00:00.000Z",
      String(EPOCH_MS),
      EPOCH_MS / 1_000,
      EPOCH_MS + 0.5,
      -1,
      undefined,
    ]) {
      const { bridge } = makeBridge();
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes("/api/memory/record/list")) {
          return new Response(JSON.stringify({
            results: [{ id: "memory-1", createdAt: EPOCH_MS, updatedAt: EPOCH_MS }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/api/memory/history")) {
          return new Response(JSON.stringify({
            events: [{ operation: "learn", ...(value === undefined ? {} : { ts: value }) }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error(`unexpected request ${target}`);
      };
      await assert.rejects(bridge.getMemorySummary(), /time_contract_violation: memory\.history\[0\]\.ts/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge rejects malformed chat message times", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const value of [
      "2026-07-13T00:00:00.000Z",
      String(EPOCH_MS),
      EPOCH_MS / 1_000,
      EPOCH_MS + 0.5,
      -1,
      undefined,
    ]) {
      const { bridge } = makeBridge();
      globalThis.fetch = async (url) => {
        if (String(url).includes("/api/chat?")) {
          return new Response(JSON.stringify({
            chatId: "chat-1",
            createdAt: EPOCH_MS,
            updatedAt: EPOCH_MS,
            events: [],
            runs: [{ runId: "run-1", initialMessage: "hello", ...(value === undefined ? {} : { startedAt: value }) }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        throw new Error(`unexpected request ${url}`);
      };
      await assert.rejects(bridge.getChat("chat-1"), /time_contract_violation: chat\.runs\[0\]\.startedAt/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge rejects malformed nested awaiting timestamps", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge, events } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/query")) {
      const body = JSON.parse(String(init.body));
      return sseResponse([{
        type: "awaiting.asking",
        runId: body.runId,
        chatId: body.chatId,
        timestamp: EPOCH_MS,
        awaiting: {
          awaitingId: "awaiting-1",
          createdAt: "2026-07-13T00:00:00.000Z",
        },
      }]);
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "validate awaiting" });
    assert.equal(result.ok, true);
    await waitFor(() => events.some((event) => event.type === "error"), "awaiting violation did not surface");
    assert.match(events[0].error ?? "", /stream\.events\[0\]\.awaiting\.createdAt/u);
    assert.equal(Object.hasOwn(events[0], "createdAt"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge preserves nullable optional times and epoch zero", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/chat?")) {
      return new Response(JSON.stringify({
        chatId: "chat-1",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS,
        events: [{
          type: "awaiting.asking",
          runId: "run-1",
          chatId: "chat-1",
          timestamp: EPOCH_MS,
          awaiting: {
            awaitingId: "awaiting-1",
            mode: "question",
            title: "Question",
            runId: "run-1",
            chatId: "chat-1",
            createdAt: null,
          },
        }],
        runs: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/api/memory/record/list")) {
      return new Response(JSON.stringify({
        results: [
          { id: "memory-zero", createdAt: 0, updatedAt: 0, lastAccessedAt: 0 },
          { id: "memory-null", createdAt: EPOCH_MS, updatedAt: EPOCH_MS, lastAccessedAt: null },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${target}`);
  };

  try {
    const detail = await bridge.getChat("chat-1");
    const memory = await bridge.listMemoryItems();
    assert.equal(detail?.events[0].awaiting?.createdAt, null);
    assert.equal(memory.items[0].lastReferencedAt, 0);
    assert.equal(memory.items[1].lastReferencedAt, null);
    assert.equal(memory.stats.lastReferencedAt, 0);
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
          timestamp: EPOCH_MS
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
        { seq: 1, type: "run.complete", runId: body.runId, chatId: body.chatId, timestamp: EPOCH_MS }
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
      { agentKey: "zenmi", displayName: "小宅", role: "平台总管", icon: { name: "summit" }, unreadCount: 1 },
      { agentKey: "codeAssistant", displayName: "代码助手", role: "CLI 代码助手", unreadCount: 3 }
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

test("agent platform assistant bridge marks a single chat read through /api/read", async () => {
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
    const result = await bridge.markChatRead(" chat_1 ", " run_1 ");

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/read");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(requests[0].body, { chatId: "chat_1", runId: "run_1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge honors per-chat archive results", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  const responses = [
    { code: 0, msg: "success", data: { results: [{ chatId: "chat_1", success: false, error: "active run" }] } },
    { code: 0, msg: "success", data: { results: [{ chatId: "chat_1", success: true }] } }
  ];
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "http://127.0.0.1:18888/api/chat/archive");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    assert.deepEqual(JSON.parse(String(init.body)), { chatIds: ["chat_1"] });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const failed = await bridge.archiveChat(" chat_1 ");
    const succeeded = await bridge.archiveChat("chat_1");

    assert.deepEqual(failed, { ok: false, message: "active run" });
    assert.equal(succeeded.ok, true);
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

test("agent platform assistant bridge downloads the generic JSONL transcript", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response([
      JSON.stringify({
        type: "metadata",
        exportVersion: 1,
        kind: "chat-transcript",
        title: "Transcript",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS + 2
      }),
      JSON.stringify({
        type: "turn",
        startedAt: EPOCH_MS,
        completedAt: EPOCH_MS + 2,
        items: [
          { kind: "user-message", content: "hello", createdAt: EPOCH_MS },
          { kind: "assistant-message", content: "ready", createdAt: EPOCH_MS + 1 }
        ]
      })
    ].join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    });
  };

  try {
    const result = await bridge.downloadChatTranscriptExport(" chat_1 ");

    assert.equal(result.ok, true);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chat/export?chatId=chat_1&format=raw");
    assert.equal(requests[0].init.headers.Accept, "application/x-ndjson");
    assert.equal(requests[0].init.headers.Authorization, "Bearer desktop-token");
    assert.equal(result.transcript.kind, "chat-transcript");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge preserves the original chat JSONL bytes", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const originalJsonl = Buffer.from([
    '{"type":"metadata","unknown":{"keep":true}}',
    '{"type":"internal.event","hidden":true,"path":"/Users/example/project"}',
    '{"type":"tool.output","raw":"line one\\nline two"}',
    ""
  ].join("\r\n"), "utf8");
  const { bridge } = makeBridge();
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(originalJsonl, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'inline; filename="Original chat.jsonl"'
      }
    });
  };

  try {
    const result = await bridge.downloadRawChatJSONL(" chat_1 ");

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chat/jsonl?chatId=chat_1");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.headers.Accept, "text/plain, application/x-ndjson");
    assert.equal(requests[0].init.headers.Authorization, "Bearer desktop-token");
    assert.equal(result.filename, "Original chat.jsonl");
    assert.equal(Buffer.compare(result.bytes, originalJsonl), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge rejects raw chat JSONL above 100 MiB", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  globalThis.fetch = async () => new Response("{}\n", {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "content-length": String(100 * 1024 * 1024 + 1)
    }
  });

  try {
    const result = await bridge.downloadRawChatJSONL("chat_1");

    assert.equal(result.ok, false);
    assert.match(result.message, /100 MiB/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge rejects non-JSONL and invalid JSONL transcripts", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  const responses = [
    new Response("# Legacy export", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" }
    }),
    new Response([
      JSON.stringify({
        type: "metadata",
        exportVersion: 2,
        kind: "chat-transcript",
        title: "Unsupported",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS
      }),
      JSON.stringify({ type: "turn", startedAt: EPOCH_MS, items: [] })
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    }),
    new Response('{"type":"metadata"}\nnot-json\n', {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    }),
    new Response('{"type":"metadata"}\n{"type":"turn"}\n', {
      status: 200,
      headers: { "content-type": "application/x-ndjson-legacy" }
    }),
    new Response(JSON.stringify({ code: 0, data: { exportVersion: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    new Response("", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    })
  ];
  globalThis.fetch = async () => responses.shift();

  try {
    const markdown = await bridge.downloadChatTranscriptExport("chat_1");
    const invalidVersion = await bridge.downloadChatTranscriptExport("chat_1");
    const malformed = await bridge.downloadChatTranscriptExport("chat_1");
    const invalidContentType = await bridge.downloadChatTranscriptExport("chat_1");
    const oldJSON = await bridge.downloadChatTranscriptExport("chat_1");
    const empty = await bridge.downloadChatTranscriptExport("chat_1");

    assert.equal(markdown.ok, false);
    assert.equal(invalidVersion.ok, false);
    assert.equal(malformed.ok, false);
    assert.equal(invalidContentType.ok, false);
    assert.equal(oldJSON.ok, false);
    assert.equal(empty.ok, false);
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
