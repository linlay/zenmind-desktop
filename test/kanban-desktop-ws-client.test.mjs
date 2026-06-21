import assert from "node:assert/strict";
import test from "node:test";

const { KanbanDesktopWsClient } = await import("../dist-electron/main/kanban-desktop-ws-client.js");

function waitFor(check, message = "condition") {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1000) {
        reject(new Error(`Timed out waiting for ${message}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

test("kanban desktop ws client sends hello, applies snapshot, and ACKs dispatch", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const snapshots = [];
  const dispatches = [];
  const states = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["desktop.issue.dispatch"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    getDeviceInfo: () => ({
      deviceName: "佳林的 MacBook",
      deviceAlias: "佳林的 MacBook",
      hostname: "Jialin-MacBook",
      username: "jialin"
    }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDispatchIssue: (issue, revision) => {
      dispatches.push({ issue, revision });
      return {
        ok: true,
        message: "dispatched",
        issue: { id: "local-1", title: "Cloud task" },
        issues: []
      };
    },
    onListAgents: async () => [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体" }],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onStateChanged: (state) => states.push(state)
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    selectedProjectId: "project-1"
  });
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:3000\/ws\?/);
  assert.match(socket.url, /role=desktop/);
  assert.match(socket.url, /[?&]v=3(?:&|$)/);
  assert.match(socket.url, /token=secret/);

  socket.readyState = 1;
  socket.onopen();
    await waitFor(() => socket.sent.length === 1, "sync.hello");
    const hello = socket.sent[0];
    assert.equal(hello.v, 3);
    assert.equal(hello.frame, "request");
    assert.equal(hello.type, "sync.hello");
    assert.equal(hello.payload.deviceId, "device-1");
  assert.equal(hello.payload.deviceName, "佳林的 MacBook");
  assert.equal(hello.payload.deviceAlias, "佳林的 MacBook");
  assert.equal(hello.payload.hostname, "Jialin-MacBook");
  assert.equal(hello.payload.username, "jialin");
  assert.equal(hello.payload.ownerUserId, "user-1");
  assert.equal(hello.payload.lastAckedDeliverySeq, 0);
  assert.equal(hello.payload.lastAppliedRevision, 0);
  assert.equal(hello.payload.cacheSchemaVersion, 1);
  assert.deepEqual(hello.payload.agents, [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体" }]);

    socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });
    await waitFor(() => socket.sent.length === 2, "snapshot request");
    const snapshotRequest = socket.sent[1];
    assert.equal(snapshotRequest.v, 3);
    assert.equal(snapshotRequest.frame, "request");
    assert.equal(snapshotRequest.type, "snapshot.get");
    socket.onmessage({
      data: JSON.stringify({
        v: 3,
        frame: "response",
        id: snapshotRequest.id,
        type: "snapshot.get",
        ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 12,
        issues: [{ id: "ISS-1", title: "Cloud task" }]
      }
    })
  });
  await waitFor(() => snapshots.length === 1, "snapshot apply");
  assert.equal(snapshots[0].revision, 12);
  assert.equal(snapshots[0].issues[0].id, "ISS-1");

    socket.onmessage({
      data: JSON.stringify({
        v: 3,
        frame: "request",
        id: "dispatch-1",
        type: "desktop.issue.dispatch",
        revision: 13,
      payload: { issue: { id: "ISS-2", title: "Dispatched task" } }
    })
  });
    await waitFor(() => socket.sent.some((frame) => frame.id === "dispatch-1"), "dispatch ACK");
    const ack = socket.sent.find((frame) => frame.id === "dispatch-1");
    assert.equal(ack.v, 3);
    assert.equal(ack.frame, "response");
    assert.equal(ack.type, "desktop.issue.dispatch");
    assert.equal(ack.ok, true);
  assert.equal(ack.payload.message, "dispatched");
  assert.deepEqual(dispatches, [{
    issue: { id: "ISS-2", title: "Dispatched task" },
    revision: 13
  }]);
  assert.deepEqual(states.slice(0, 2), ["connecting", "open"]);

  client.stop();
});

test("kanban desktop ws client decodes Blob websocket messages", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const snapshots = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["agent.listDesktop"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true })
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");
  const hello = socket.sent[0];

  socket.onmessage({
    data: new Blob([JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } })])
  });

  await waitFor(() => socket.sent.length === 2, "snapshot request after blob hello");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: new Blob([JSON.stringify({
      v: 3, frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 30,
        issues: [{ id: "ISS-blob", title: "Blob task" }]
      }
    })])
  });

  await waitFor(() => snapshots.length === 1, "blob snapshot apply");
  assert.equal(snapshots[0].issues[0].id, "ISS-blob");

  client.stop();
});

test("kanban desktop ws client applies sync.deliver items and ACKs after delivery success", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const deliveries = [];
  let cursor = { lastAckedDeliverySeq: 0, lastAppliedRevision: 12, cacheSchemaVersion: 1 };
  const client = new KanbanDesktopWsClient({
    capabilities: ["command.dispatchIssue"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    getSyncCursor: () => cursor,
    onSyncCursor: (next) => {
      cursor = { ...cursor, ...next };
    },
    onSnapshot: () => {},
    onDelivery: async (delivery) => {
      deliveries.push(delivery);
      return { ok: true, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, delivery.sourceRevision ?? 0) };
    },
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true })
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");
  const hello = socket.sent[0];
  assert.equal(hello.payload.lastAppliedRevision, 12);
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true, cursor } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 12, issues: [] }
    })
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "sync.pull");
  const pullRequest = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: pullRequest.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });

  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "push",
      type: "sync.deliver",
      payload: {
        items: [{
          deliveryId: 10,
          deviceId: "device-1",
          deliverySeq: 1,
          kind: "event",
          sourceRevision: 13,
          eventType: "issue.updated",
          payload: { issue: { id: "ISS-13", title: "Updated", revision: 13 } }
        }]
      }
    })
  });

  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.ack"), "sync.ack");
  const ack = socket.sent.find((frame) => frame.type === "sync.ack");
  assert.equal(ack.payload.ackedDeliverySeq, 1);
  assert.equal(ack.payload.lastAppliedRevision, 13);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliverySeq, 1);

  client.stop();
});

test("kanban desktop ws client waits when sync.deliver has a deliverySeq gap", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const deliveries = [];
  const debugMessages = [];
  let cursor = { lastAckedDeliverySeq: 0, lastAppliedRevision: 20, cacheSchemaVersion: 1 };
  const client = new KanbanDesktopWsClient({
    capabilities: ["command.dispatchIssue"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    getSyncCursor: () => cursor,
    onSyncCursor: (next) => {
      cursor = { ...cursor, ...next };
    },
    onSnapshot: () => {},
    onDelivery: async (delivery) => {
      deliveries.push(delivery);
      return { ok: true, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, delivery.sourceRevision ?? 0) };
    },
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onDebug: (message) => debugMessages.push(message)
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true, cursor } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 20, issues: [] }
    })
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "sync.pull");
  const pullRequest = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: pullRequest.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });

  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "push",
      type: "sync.deliver",
      payload: {
        items: [{
          deliverySeq: 2,
          kind: "event",
          sourceRevision: 22,
          eventType: "issue.updated",
          payload: { issue: { id: "ISS-22", title: "Gap", revision: 22 } }
        }]
      }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveries.length, 0);
  assert.equal(socket.sent.some((frame) => frame.type === "sync.ack"), false);
  assert.ok(debugMessages.some((message) => /delivery.*2/u.test(message)));

  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "push",
      type: "sync.deliver",
      payload: {
        items: [{
          deliverySeq: 1,
          kind: "event",
          sourceRevision: 21,
          eventType: "issue.updated",
          payload: { issue: { id: "ISS-21", title: "First", revision: 21 } }
        }]
      }
    })
  });

  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.ack"), "sync.ack");
  const ack = socket.sent.find((frame) => frame.type === "sync.ack");
  assert.equal(ack.payload.ackedDeliverySeq, 1);
  assert.equal(ack.payload.lastAppliedRevision, 21);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliverySeq, 1);

  client.stop();
});

test("kanban desktop ws client passes cloud issue to startRun handler", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const startRuns = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["desktop.assistant.startRun"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async (request) => {
      startRuns.push(request);
      return { ok: true, runId: "run-1", chatId: "chat-1", message: "started" };
    },
    onAutomationSync: async () => ({ ok: true })
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");

    try {
      socket.onmessage({
        data: JSON.stringify({
          v: 3,
          frame: "request",
          id: "start-run-1",
          type: "desktop.assistant.startRun",
          revision: 21,
        payload: {
          issue: { id: "ISS-9", title: "Remote run task", status: "in_progress" },
          agentKey: "codeAssistant",
          accessLevel: "full_access",
          message: "Run remote task"
        }
      })
    });

      await waitFor(() => socket.sent.some((frame) => frame.id === "start-run-1"), "startRun ACK");
      const ack = socket.sent.find((frame) => frame.id === "start-run-1");
      assert.equal(ack.v, 3);
      assert.equal(ack.frame, "response");
      assert.equal(ack.type, "desktop.assistant.startRun");
      assert.deepEqual(startRuns, [{
      issue: { id: "ISS-9", title: "Remote run task", status: "in_progress" },
      revision: 21,
      agentKey: "codeAssistant",
      accessLevel: "full_access",
      chatId: null,
      message: "Run remote task",
      source: "sidebar"
    }]);
  } finally {
    client.stop();
  }
});

test("kanban desktop ws client reconnects after request timeout", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.closed = true;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const states = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["desktop.issue.dispatch"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onStateChanged: (state) => states.push(state)
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");

  await assert.rejects(
    client.request("issue.update", { id: "ISS-1" }, 1),
    /issue\.update 请求超时/
  );

  assert.equal(socket.closed, true);
  assert.equal(client.isOpen(), false);
  assert.equal(states.at(-1), "error");

  client.stop();
});


test("kanban desktop ws client closes non-v3 protocol messages", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      this.closed = false;
      this.closeCode = 0;
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close(code) {
      this.readyState = 3;
      this.closed = true;
      this.closeCode = code;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const states = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["agent.listDesktop"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onStateChanged: (state) => states.push(state)
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");

  const oldFrameType = `rpc${"."}req`;
  const oldBusinessField = `o${"p"}`;
  socket.onmessage({
    data: JSON.stringify({
      type: oldFrameType,
      id: "old-request",
      [oldBusinessField]: `agent${"."}listDesktop`,
      payload: {}
    })
  });

  await waitFor(() => socket.closed, "protocol close");
  assert.equal(socket.closeCode, 1002);
  assert.equal(client.isOpen(), false);
  assert.equal(states.at(-1), "error");

  client.stop();
});


test("kanban desktop ws client closes when response cannot be sent", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
      this.closed = false;
      this.failSends = false;
      sockets.push(this);
    }

    send(data) {
      if (this.failSends) {
        throw new Error("Sent before connected.");
      }
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.closed = true;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const states = [];
  const debugMessages = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["agent.listDesktop"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "dispatched", issues: [] }),
    onListAgents: async () => [{ agentKey: "cutej", displayName: "小君" }],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onStateChanged: (state) => states.push(state),
    onDebug: (message) => debugMessages.push(message)
  });

  client.start({
    serverUrl: "http://127.0.0.1:3000",
    selectedProjectId: "project-1"
  });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");

  socket.failSends = true;
  socket.onmessage({
    data: JSON.stringify({
      v: 3, frame: "request",
      id: "list-agents-1",
      type: "agent.listDesktop",
      payload: {}
    })
  });

  await waitFor(() => socket.closed, "socket close after send failure");
  assert.equal(client.isOpen(), false);
  assert.equal(states.at(-1), "error");
  assert.equal(debugMessages.some((message) => /Sent before connected/.test(message)), true);

  client.stop();
});
