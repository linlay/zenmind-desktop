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

function createWsHarness({ onQuery, onSend, autoOpen = true } = {}) {
  const sockets = [];
  const queryRequests = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.sent = [];
      this.closed = false;
      this.opened = false;
      sockets.push(this);
      if (autoOpen) {
        queueMicrotask(() => {
          this.open();
        });
      }
    }

    send(data) {
      const frame = JSON.parse(String(data));
      this.sent.push(frame);
      onSend?.({ socket: this, frame });
      if (frame.frame === "request" && frame.type === "/api/query") {
        queryRequests.push({ socket: this, frame, payload: frame.payload });
        onQuery?.({ socket: this, frame, payload: frame.payload });
      }
    }

    receive(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    open() {
      if (this.closed || this.opened) {
        return;
      }
      this.opened = true;
      this.onopen?.();
      this.receive({
        frame: "push",
        type: "connected",
        data: {
          protocolVersion: 2,
          sessionId: `platform-${sockets.indexOf(this) + 1}`,
          serverTime: EPOCH_MS,
          liveness: {
            heartbeatIntervalMs: 30_000,
            silenceTimeoutMs: 100_000,
          },
        },
      });
    }

    close() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.onclose?.();
    }

    disconnect() {
      this.close();
    }
  }

  return {
    sockets,
    queryRequests,
    createWebSocket: (url) => new FakeWebSocket(url),
  };
}

function sendStreamEvent(socket, requestFrame, event, streamId = `stream-${requestFrame.id}`) {
  socket.receive({
    frame: "stream",
    id: requestFrame.id,
    streamId,
    event,
  });
}

function endStream(socket, requestFrame, reason = "done", lastSeq) {
  socket.receive({
    frame: "stream",
    id: requestFrame.id,
    streamId: `stream-${requestFrame.id}`,
    reason,
    ...(lastSeq === undefined ? {} : { lastSeq }),
  });
}

function acceptQuery(socket, frame, timestamp = EPOCH_MS) {
  sendStreamEvent(socket, frame, {
    seq: 1,
    type: "run.start",
    runId: frame.payload.runId,
    chatId: frame.payload.chatId,
    agentKey: frame.payload.agentKey || "codeAssistant",
    timestamp,
  }, "opaque-stream-id");
}

function completeQuery(socket, frame, events = [], reason = "done") {
  acceptQuery(socket, frame);
  events.forEach((event, index) => sendStreamEvent(socket, frame, {
    seq: index + 2,
    runId: frame.payload.runId,
    chatId: frame.payload.chatId,
    timestamp: EPOCH_MS + index + 1,
    ...event,
  }));
  endStream(socket, frame, reason, events.length + 1);
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
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => completeQuery(socket, frame, [
      { type: "content.delta", delta: "Hello" },
      { type: "run.complete" },
    ]),
  });
  const { bridge } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
  };

  try {
    const result = await bridge.completeText({ message: "Translate this" });
    assert.equal(result.ok, true);
    assert.equal(result.text, "Hello");
    assert.match(result.runId, /^run_/u);
    assert.match(result.chatId, /^chat_/u);
    assert.equal(ws.sockets.length, 1);
    assert.equal(ws.queryRequests.length, 1);
    assert.match(ws.sockets[0].url, /^ws:\/\/127\.0\.0\.1:18888\/ws\?/u);
    assert.equal(new URL(ws.sockets[0].url).searchParams.get("source"), "desktop-main");
  } finally {
    bridge.dispose();
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

test("agent platform assistant bridge maps the minimal native history DTO without leaking host credentials", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify([
      {
        chatId: "chat-without-agent",
        chatName: "Team-only chat",
        teamId: "team-1",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS + 20,
        lastRunId: "run-2",
        lastRunContent: "Waiting for input",
        read: { isRead: false },
        awaitingCount: 2,
        awaitingMode: "question",
      },
      {
        chatId: "chat-agent",
        chatName: "Release plan",
        firstAgentKey: "release-agent",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS + 10,
        lastRunId: "run-1",
        lastRunContent: "Ready to ship",
        isRead: true,
        activeRun: { runId: "run-1" },
      },
    ]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await bridge.listHistoryChats();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chats");
    assert.equal(requests[0].init.headers.Authorization, "Bearer desktop-token");
    assert.equal(result.ok, true);
    assert.deepEqual(result.items, [
      {
        chatId: "chat-without-agent",
        chatName: "Team-only chat",
        agentKey: "",
        teamId: "team-1",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS + 20,
        lastRunId: "run-2",
        lastRunContent: "Waiting for input",
        isRead: false,
        hasActiveRun: false,
        hasPendingAwaiting: true,
        awaitingCount: 2,
        awaitingMode: "question",
      },
      {
        chatId: "chat-agent",
        chatName: "Release plan",
        agentKey: "release-agent",
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS + 10,
        lastRunId: "run-1",
        lastRunContent: "Ready to ship",
        isRead: true,
        hasActiveRun: true,
        hasPendingAwaiting: false,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /desktop-token|127\.0\.0\.1:18888/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native history reports platform unavailability and rejects malformed times", async () => {
  const unavailable = makeBridge({
    getServiceState: async () => ({
      status: "stopped",
      message: "platform stopped",
      healthMeta: { webUrl: "", port: null },
    }),
  });
  const unavailableResult = await unavailable.bridge.listHistoryChats();
  assert.equal(unavailableResult.ok, false);
  assert.deepEqual(unavailableResult.items, []);
  assert.equal(unavailableResult.message, "platform stopped");
  assert.equal(Number.isInteger(unavailableResult.updatedAt), true);

  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  globalThis.fetch = async () => new Response(JSON.stringify([{
    chatId: "chat-invalid",
    createdAt: EPOCH_MS,
    updatedAt: "2026-07-13T00:00:00.000Z",
  }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      bridge.listHistoryChats(),
      /time_contract_violation: historyChats\[0\]\.updatedAt/u,
    );
    globalThis.fetch = async () => new Response(JSON.stringify([null]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(
      bridge.listHistoryChats(),
      /historyChats\[0\] must be an object/u,
    );
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
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => {
      assert.deepEqual(wakeLock.calls, ["acquire"]);
      completeQuery(socket, frame, [
        { type: "content.delta", delta: "awake" },
        { type: "run.complete" },
      ]);
    },
  });
  const { bridge, events } = makeBridge({
    wakeLock: wakeLock.wakeLock,
    createWebSocket: ws.createWebSocket,
  });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform" });

    assert.equal(result.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    await waitFor(() => wakeLock.calls.includes("release"), "wake lock was not released after run completion");
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
    assert.deepEqual(events.map((event) => event.type), ["run.start", "content.delta", "run.complete"]);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge reuses an existing chat with a new run id", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const ws = createWsHarness({
    onQuery: ({ socket, frame, payload }) => {
      requests.push(payload);
      completeQuery(socket, frame, [{ type: "run.complete" }]);
    },
  });
  const { bridge } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
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
    assert.equal(ws.sockets.length, 1);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge shares one wake lock across concurrent runs", async () => {
  const originalFetch = globalThis.fetch;
  const wakeLock = makeWakeLockRecorder();
  const streams = [];
  const ws = createWsHarness({
    autoOpen: false,
    onQuery: ({ socket, frame, payload }) => {
      streams.push({ socket, frame, body: payload });
      acceptQuery(socket, frame);
    },
  });
  const { bridge, events } = makeBridge({
    wakeLock: wakeLock.wakeLock,
    createWebSocket: ws.createWebSocket,
  });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const firstPromise = bridge.startRun({ message: "first" });
    const secondPromise = bridge.startRun({ message: "second" });
    await waitFor(() => ws.sockets.length === 1, "shared WebSocket was not created");
    ws.sockets[0].open();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    await waitFor(() => streams.length === 2, "expected both query streams to start");

    const firstStream = streams.find((stream) => stream.body.runId === first.runId);
    const secondStream = streams.find((stream) => stream.body.runId === second.runId);
    assert.ok(firstStream);
    assert.ok(secondStream);
    sendStreamEvent(firstStream.socket, firstStream.frame, {
      seq: 2,
      type: "content.delta",
      runId: firstStream.body.runId,
      chatId: firstStream.body.chatId,
      delta: "first",
      timestamp: EPOCH_MS
    });
    sendStreamEvent(firstStream.socket, firstStream.frame, {
      seq: 3,
      type: "run.complete",
      runId: firstStream.body.runId,
      chatId: firstStream.body.chatId,
      timestamp: EPOCH_MS + 1
    });
    endStream(firstStream.socket, firstStream.frame, "done", 3);
    await waitFor(
      () => events.some((event) => event.runId === first.runId && event.type === "run.complete"),
      "first run did not complete"
    );
    assert.deepEqual(wakeLock.calls, ["acquire"]);

    sendStreamEvent(secondStream.socket, secondStream.frame, {
      seq: 2,
      type: "content.delta",
      runId: secondStream.body.runId,
      chatId: secondStream.body.chatId,
      delta: "second",
      timestamp: EPOCH_MS + 2
    });
    sendStreamEvent(secondStream.socket, secondStream.frame, {
      seq: 3,
      type: "run.complete",
      runId: secondStream.body.runId,
      chatId: secondStream.body.chatId,
      timestamp: EPOCH_MS + 3
    });
    endStream(secondStream.socket, secondStream.frame, "done", 3);
    await waitFor(() => wakeLock.calls.includes("release"), "wake lock was not released after both runs completed");
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge releases wake lock when stopRun interrupt fails", async () => {
  const originalFetch = globalThis.fetch;
  const wakeLock = makeWakeLockRecorder();
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => acceptQuery(socket, frame),
  });
  const { bridge } = makeBridge({
    wakeLock: wakeLock.wakeLock,
    createWebSocket: ws.createWebSocket,
  });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, "Bearer desktop-token");
    if (String(url).endsWith("/api/interrupt")) {
      return new Response("interrupt failed", { status: 500 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform" });
    assert.equal(result.ok, true);
    assert.deepEqual(wakeLock.calls, ["acquire"]);
    assert.equal(ws.queryRequests.length, 1);

    const stop = await bridge.stopRun(result.runId);

    assert.equal(stop.ok, false);
    assert.match(stop.message, /interrupt failed/u);
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge forwards startRun accessLevel and emits aggregated completion message", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const ws = createWsHarness({
    onQuery: ({ socket, frame, payload: body }) => {
      requests.push(frame);
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
      completeQuery(socket, frame, [
        { type: "content.delta", delta: "hi" },
        { type: "run.complete" },
      ]);
    },
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
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
    await waitFor(() => events.some((event) => event.type === "run.complete"), "completion event was not emitted");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].frame, "request");
    assert.equal(requests[0].type, "/api/query");
    assert.match(requests[0].id, /^desktop-query-/u);
    assert.deepEqual(events.map((event) => event.type), ["run.start", "content.delta", "run.complete"]);
    assert.equal(events[1].delta, "hi");
    assert.equal(events[1].runId, result.runId);
    assert.equal(events[1].chatId, result.chatId);
    assert.equal(events[2].runId, result.runId);
    assert.equal(events[2].chatId, result.chatId);
    assert.equal(events[2].message, "hi");
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge accepts a query only after matching run.start and buffers earlier events", async () => {
  const originalFetch = globalThis.fetch;
  let queryRequest;
  const ws = createWsHarness({
    onQuery: (request) => {
      queryRequest = request;
    },
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
  };

  try {
    let settled = false;
    const startPromise = bridge.startRun({
      runId: "run-accept-1",
      chatId: "chat-accept-1",
      requestId: "request-accept-1",
      message: "wait for run.start",
    }).then((result) => {
      settled = true;
      return result;
    });
    await waitFor(() => Boolean(queryRequest), "query request was not sent");
    queryRequest.socket.receive({
      frame: "response",
      type: "/api/query",
      id: queryRequest.frame.id,
      code: 0,
      msg: "success",
      data: {},
    });
    sendStreamEvent(queryRequest.socket, queryRequest.frame, {
      type: "content.delta",
      runId: "run-accept-1",
      chatId: "chat-accept-1",
      delta: "buffered",
      timestamp: EPOCH_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    assert.deepEqual(events, []);

    acceptQuery(queryRequest.socket, queryRequest.frame, EPOCH_MS + 1);
    const result = await startPromise;
    assert.equal(result.ok, true);
    await waitFor(() => events.length === 2, "buffered events were not released after acceptance");
    assert.deepEqual(events.map((event) => event.type), ["content.delta", "run.start"]);
    sendStreamEvent(queryRequest.socket, queryRequest.frame, {
      type: "run.complete",
      runId: "run-accept-1",
      chatId: "chat-accept-1",
      timestamp: EPOCH_MS + 2,
    });
    endStream(queryRequest.socket, queryRequest.frame, "done", 3);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge uploads attachments before sending the WS query and never uses HTTP /api/query", async () => {
  const originalFetch = globalThis.fetch;
  const sequence = [];
  const ws = createWsHarness({
    onQuery: ({ socket, frame, payload }) => {
      sequence.push("ws-query");
      assert.deepEqual(payload.references, [{ id: "upload-1", name: "note.txt" }]);
      completeQuery(socket, frame, [{ type: "run.complete", message: "uploaded" }]);
    },
  });
  const { bridge } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    assert.equal(target.endsWith("/api/query"), false);
    if (target.endsWith("/api/upload")) {
      sequence.push("upload");
      assert.equal(init.headers.Authorization, "Bearer desktop-token");
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: { upload: { id: "upload-1", name: "note.txt" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected HTTP request ${target}`);
  };

  try {
    const result = await bridge.completeText({
      message: "read attachment",
      attachments: [{
        id: "attachment-1",
        name: "note.txt",
        mimeType: "text/plain",
        size: 5,
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(sequence, ["upload", "ws-query"]);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge converges pre-accept frame, identity, and timeout failures to one error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
  };
  try {
    const cases = [
      {
        name: "frame error",
        configure: ({ socket, frame }) => socket.receive({
          frame: "error",
          type: "invalid_request",
          id: frame.id,
          code: 400,
          msg: "bad query",
          data: {},
        }),
        expected: /invalid_request: bad query/u,
      },
      {
        name: "identity conflict",
        configure: ({ socket, frame, payload }) => sendStreamEvent(socket, frame, {
          type: "run.start",
          runId: `${payload.runId}-wrong`,
          chatId: payload.chatId,
          agentKey: "codeAssistant",
          timestamp: EPOCH_MS,
        }),
        expected: /stream runId conflicts with registered Run/u,
      },
      {
        name: "acceptance timeout",
        configure: () => undefined,
        expected: /query acceptance timed out/u,
        acceptanceTimeout: 5,
      },
      {
        name: "connection timeout",
        configure: () => undefined,
        expected: /handshake timed out/u,
        autoOpen: false,
        connectTimeout: 5,
      },
    ];
    for (const failureCase of cases) {
      const ws = createWsHarness({
        onQuery: failureCase.configure,
        autoOpen: failureCase.autoOpen ?? true,
      });
      const { bridge, events } = makeBridge({
        createWebSocket: ws.createWebSocket,
        assistantWsAcceptanceTimeoutMs: failureCase.acceptanceTimeout,
        assistantWsConnectTimeoutMs: failureCase.connectTimeout,
      });
      const result = await bridge.startRun({ message: failureCase.name });
      assert.equal(result.ok, false, failureCase.name);
      await waitFor(() => events.length === 1, `${failureCase.name} did not emit one error`);
      assert.deepEqual(events.map((event) => event.type), ["error"], failureCase.name);
      assert.match(events[0].message, failureCase.expected, failureCase.name);
      bridge.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge recognizes run.cancel and rejects an envelope without a business terminal", async () => {
  const originalFetch = globalThis.fetch;
  let queryCount = 0;
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => {
      queryCount += 1;
      if (queryCount === 1) {
        completeQuery(socket, frame, [{ type: "run.cancel", message: "cancelled" }], "cancelled");
        return;
      }
      acceptQuery(socket, frame);
      endStream(socket, frame, "done", 1);
    },
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
  };

  try {
    const cancelled = await bridge.completeText({ message: "cancel me" });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.text, "cancelled");
    assert.equal(events.some((event) => event.type === "run.cancel"), true);

    const missingTerminal = await bridge.completeText({ message: "missing terminal" });
    assert.equal(missingTerminal.ok, false);
    assert.match(missingTerminal.message, /business terminal event/u);
    assert.equal(events.filter((event) => event.type === "error").length, 1);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge preserves accepted runs on disconnect without replaying query", async () => {
  const originalFetch = globalThis.fetch;
  const interrupts = [];
  let queryCount = 0;
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => {
      queryCount += 1;
      if (queryCount === 1) {
        acceptQuery(socket, frame);
      } else {
        completeQuery(socket, frame, [{ type: "run.complete", message: "reconnected" }]);
      }
    },
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    assert.equal(target.endsWith("/api/query"), false);
    if (target.endsWith("/api/interrupt")) {
      interrupts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected HTTP request ${target}`);
  };

  try {
    const first = await bridge.startRun({
      runId: "run-disconnect-1",
      chatId: "chat-disconnect-1",
      message: "disconnect",
    });
    assert.equal(first.ok, true);
    ws.sockets[0].disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.equal(interrupts.length, 0);
    assert.equal(ws.queryRequests.length, 1);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge refreshes auth on the same WS connection", async () => {
  const originalFetch = globalThis.fetch;
  const issuedReasons = [];
  const authRefreshFrames = [];
  let queryRequest;
  const ws = createWsHarness({
    onQuery: (request) => {
      queryRequest = request;
      acceptQuery(request.socket, request.frame);
    },
    onSend: ({ socket, frame }) => {
      if (frame.frame === "request" && frame.type === "auth.refresh") {
        authRefreshFrames.push(frame);
        socket.receive({
          frame: "response",
          type: "auth.refresh",
          id: frame.id,
          code: 0,
          msg: "success",
          data: { expiresAt: EPOCH_MS + 60_000 },
        });
      }
    },
  });
  const { bridge } = makeBridge({
    createWebSocket: ws.createWebSocket,
    issueAccessToken: async (_app, reason) => {
      issuedReasons.push(reason);
      return { ok: true, token: reason === "unauthorized" ? "fresh-token" : "old-token", message: "" };
    },
  });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected HTTP request ${url}`);
  };

  try {
    const started = await bridge.startRun({ message: "refresh auth" });
    assert.equal(started.ok, true);
    queryRequest.socket.receive({
      frame: "push",
      type: "auth.expiring",
      data: { expiresAt: EPOCH_MS + 1_000 },
    });
    await waitFor(() => authRefreshFrames.length === 1, "auth.refresh was not sent");
    assert.equal(authRefreshFrames[0].payload.token, "fresh-token");
    assert.deepEqual(issuedReasons, ["missing", "unauthorized"]);
    assert.equal(ws.sockets.length, 1);
    sendStreamEvent(queryRequest.socket, queryRequest.frame, {
      type: "run.complete",
      runId: queryRequest.payload.runId,
      chatId: queryRequest.payload.chatId,
      timestamp: EPOCH_MS + 2,
    });
    endStream(queryRequest.socket, queryRequest.frame, "done", 2);
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge responds to reverse requests and dispose closes WS and releases wake lock", async () => {
  const originalFetch = globalThis.fetch;
  const interrupts = [];
  const wakeLock = makeWakeLockRecorder();
  let queryRequest;
  const ws = createWsHarness({
    onQuery: (request) => {
      queryRequest = request;
      acceptQuery(request.socket, request.frame);
    },
  });
  const { bridge, events } = makeBridge({
    createWebSocket: ws.createWebSocket,
    wakeLock: wakeLock.wakeLock,
  });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/interrupt")) {
      interrupts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected HTTP request ${url}`);
  };

  try {
    const started = await bridge.startRun({ message: "reverse actions" });
    assert.equal(started.ok, true);
    queryRequest.socket.receive({ frame: "request", type: "unsupported.request", id: "reverse-1", payload: {} });
    queryRequest.socket.receive({ frame: "request", type: "desktop.unknown", id: "reverse-2", payload: {} });
    queryRequest.socket.receive({ frame: "request", type: "unsupported.request", id: "reverse-1", payload: {} });
    await waitFor(
      () => queryRequest.socket.sent.filter((frame) => frame.frame === "error").length === 3,
      "reverse request errors were not sent",
    );
    assert.deepEqual(
      queryRequest.socket.sent.filter((frame) => frame.frame === "error").map((frame) => frame.type),
      ["unsupported_in_current_view", "unsupported_in_current_view", "unsupported_in_current_view"],
    );
    assert.deepEqual(
      queryRequest.socket.sent.filter((frame) => frame.frame === "error").map((frame) => frame.data.code),
      ["unsupported_in_current_view", "unsupported_in_current_view", "unsupported_in_current_view"],
    );

    bridge.dispose();
    await waitFor(() => interrupts.length === 1, "dispose did not interrupt the active run");
    assert.equal(ws.sockets[0].closed, true);
    assert.deepEqual(wakeLock.calls, ["acquire", "release"]);
    assert.equal(events.some((event) => event.type === "stopped"), false);
  } finally {
    bridge.dispose();
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
      const ws = createWsHarness({
        onQuery: ({ socket, frame, payload: body }) => sendStreamEvent(socket, frame, {
            seq: 1,
            type: "run.start",
            runId: body.runId,
            chatId: body.chatId,
            agentKey: "codeAssistant",
            ...(timestamp === undefined ? {} : { timestamp })
        }),
      });
      const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
      globalThis.fetch = async (url) => {
        throw new Error(`unexpected HTTP request ${url}`);
      };

      const result = await bridge.startRun({ message: "strict timestamp" });
      assert.equal(result.ok, false);
      await waitFor(() => events.some((event) => event.type === "error"), "malformed stream did not surface a local error");
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      assert.match(events[0].error ?? "", /time_contract_violation/u);
      assert.equal(Object.hasOwn(events[0], "createdAt"), false);
      bridge.dispose();
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
      if (value === undefined) {
        assert.equal((await bridge.getChatInfo("chat-1"))?.updatedAt, undefined);
      } else {
        await assert.rejects(bridge.getChatInfo("chat-1"), /time_contract_violation: chatInfo\.updatedAt/u);
      }
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
  const ws = createWsHarness({
    onQuery: ({ socket, frame, payload: body }) => {
      acceptQuery(socket, frame);
      sendStreamEvent(socket, frame, {
        type: "awaiting.asking",
        runId: body.runId,
        chatId: body.chatId,
        timestamp: EPOCH_MS,
        awaiting: {
          awaitingId: "awaiting-1",
          createdAt: "2026-07-13T00:00:00.000Z",
        },
      });
    },
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "validate awaiting" });
    assert.equal(result.ok, true);
    await waitFor(() => events.some((event) => event.type === "error"), "awaiting violation did not surface");
    assert.match(events.at(-1).error ?? "", /ws\.query\[.+\]\.events\[1\]\.awaiting\.createdAt/u);
    assert.equal(Object.hasOwn(events.at(-1), "createdAt"), false);
  } finally {
    bridge.dispose();
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

test("agent platform assistant bridge reads copyable chat information without raw messages", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const { bridge } = makeBridge();
  const payload = {
    chatId: "chat/1",
    chatName: "Planning",
    agentKey: "agent-a",
    firstAgentKey: "agent-a",
    firstAgentName: "Agent A",
    teamId: "team-a",
    source: "desktop",
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS + 1,
    lastRunId: "run-9",
    lastRunContent: "Done",
    events: [{ type: "run.complete" }],
  };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: 0, msg: "ok", data: payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const detail = await bridge.getChatInfo(" chat/1 ");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/chat\?chatId=chat%2F1&includeRawMessages=false$/u);
    assert.equal(requests[0].init.headers.Authorization, "Bearer desktop-token");
    assert.deepEqual(detail, {
      chatId: "chat/1",
      chatName: "Planning",
      agentKey: "agent-a",
      firstAgentKey: "agent-a",
      firstAgentName: "Agent A",
      teamId: "team-a",
      source: "desktop",
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS + 1,
      lastRunId: "run-9",
      lastRunContent: "Done",
      rawJson: JSON.stringify(payload, null, 2),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge handles empty and missing chat information", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  const { bridge } = makeBridge();
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response("not found", { status: 404 });
  };

  try {
    assert.equal(await bridge.getChatInfo("   "), null);
    assert.equal(await bridge.getChatInfo(null), null);
    assert.equal(requestCount, 0);
    assert.equal(await bridge.getChatInfo("missing"), null);
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge surfaces chat information request failures", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  globalThis.fetch = async () => new Response("platform unavailable", { status: 503 });
  try {
    await assert.rejects(bridge.getChatInfo("chat-1"), /platform unavailable/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge uses terminal result payload as completion message", async () => {
  const originalFetch = globalThis.fetch;
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => completeQuery(socket, frame, [
        {
          type: "run.complete",
          data: { result: "云端验证OK" },
        }
    ]),
  });
  const { bridge, events } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant", accessLevel: "auto_approve" });
    assert.equal(result.ok, true);
    await waitFor(() => events.some((event) => event.type === "run.complete"), "completion event was not emitted");
    assert.deepEqual(events.map((event) => event.type), ["run.start", "run.complete"]);
    assert.equal(events[1].runId, result.runId);
    assert.equal(events[1].chatId, result.chatId);
    assert.equal(events[1].message, "云端验证OK");
  } finally {
    bridge.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge falls back to persisted chat jsonl for empty completion events", async () => {
  const originalFetch = globalThis.fetch;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-test-"));
  const ws = createWsHarness({
    onQuery: ({ socket, frame, payload: body }) => {
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
      completeQuery(socket, frame, [{ type: "run.complete" }]);
    },
  });
  const { bridge, events } = makeBridge({
    app: makeApp(homeDir),
    createWebSocket: ws.createWebSocket,
  });
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const result = await bridge.startRun({ message: "hello platform", agentKey: "codeAssistant", accessLevel: "auto_approve" });
    assert.equal(result.ok, true);
    await waitFor(() => events.some((event) => event.type === "run.complete"), "completion event was not emitted");
    assert.deepEqual(events.map((event) => event.type), ["run.start", "run.complete"]);
    assert.equal(events[1].runId, result.runId);
    assert.equal(events[1].chatId, result.chatId);
    assert.equal(events[1].message, "最终回答来自本地会话文件");
  } finally {
    bridge.dispose();
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
    assert.deepEqual(agents.sort((left, right) => left.agentKey.localeCompare(right.agentKey)), [
      { agentKey: "codeAssistant", displayName: "代码助手", role: "CLI 代码助手", unreadCount: 3 },
      { agentKey: "zenmi", displayName: "小宅", role: "平台总管", icon: { name: "summit" }, unreadCount: 1 },
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
  const ws = createWsHarness({
    onQuery: ({ socket, frame }) => acceptQuery(socket, frame),
  });
  const { bridge } = makeBridge({ createWebSocket: ws.createWebSocket });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ code: 0, msg: "success", data: { accepted: true } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const started = await bridge.startRun({
      runId: "run_1",
      chatId: "chat_1",
      agentKey: "codeAssistant",
      message: "keep owner identity",
    });
    assert.equal(started.ok, true);
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
    assert.equal(requests[0].body.agentKey, "codeAssistant");
    assert.equal(requests[1].url, "http://127.0.0.1:18888/api/interrupt");
    assert.equal(requests[1].body.runId, "run_1");
    assert.equal(requests[1].body.agentKey, "codeAssistant");
  } finally {
    bridge.dispose();
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
    assert.equal(requests[0].url, "http://127.0.0.1:18888/api/chat/export?chatId=chat_1&format=markdown");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.headers.Accept, "text/markdown, application/json");
    assert.equal(result.filename, "Renamed chat.md");
    assert.equal(result.bytes.toString("utf8"), "# Exported chat\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge enforces Markdown media type and 2 MiB limit", async () => {
  const originalFetch = globalThis.fetch;
  const { bridge } = makeBridge();
  const responses = [
    new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    }),
    new Response("# Export", {
      status: 200,
      headers: {
        "content-type": "text/markdown",
        "content-length": String(2 * 1024 * 1024 + 1)
      }
    })
  ];
  globalThis.fetch = async () => responses.shift();

  try {
    const invalidContentType = await bridge.downloadChatExport("chat_1");
    const tooLarge = await bridge.downloadChatExport("chat_1");

    assert.equal(invalidContentType.ok, false);
    assert.equal(tooLarge.ok, false);
    assert.match(tooLarge.message, /2 MiB/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent platform assistant bridge creates a trusted Snapshot request descriptor", async () => {
  const { bridge } = makeBridge();
  const result = await bridge.createChatSnapshotRequest(" chat_1 ");

  assert.deepEqual(result, {
    ok: true,
    snapshotUrl: "http://127.0.0.1:18888/api/chat/export?chatId=chat_1&format=snapshot",
    bearerToken: "desktop-token"
  });
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

test("agent platform assistant bridge rejects non-loopback Snapshot endpoints", async () => {
  const { bridge } = makeBridge({
    getServiceState: async () => ({
      status: "running",
      message: "",
      healthMeta: { webUrl: "https://platform.example.test", port: 443 }
    })
  });

  const result = await bridge.createChatSnapshotRequest("chat_1");

  assert.equal(result.ok, false);
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
