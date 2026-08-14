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

function respondOk(socket, request, payload) {
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: request.id,
      type: request.type,
      ok: true,
      payload
    })
  });
}

function helloPayload(payload = {}) {
  return { ok: true, contractVersion: "1.0", capabilities: [], ...payload };
}

async function respondNextRequest(socket, type, payload, fromIndex = 0) {
  await waitFor(() => socket.sent.slice(fromIndex).some((frame) => frame.type === type), type);
  const request = socket.sent.slice(fromIndex).find((frame) => frame.type === type);
  respondOk(socket, request, payload);
  return request;
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
  const debugMessages = [];
  const wsLogs = [];
  const negotiatedContracts = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["desktop.issue.dispatch"],
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
        issue: { id: "local-1", title: "Cloud issue" },
        issues: []
      };
    },
    onListAgents: async () => [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体" }],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" }),
    onAutomationSync: async () => ({ ok: true }),
    onContractNegotiated: (contractVersion, capabilities) => negotiatedContracts.push({ contractVersion, capabilities }),
    onStateChanged: (state) => states.push(state),
    onDebug: (message) => debugMessages.push(message),
    onWsLog: (entry) => wsLogs.push(entry)
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
  assert.match(socket.url, /[?&]v=1(?:&|$)/);
  assert.match(socket.url, /[?&]contractVersion=1\.0(?:&|$)/);
  assert.match(socket.url, /token=secret/);

  socket.readyState = 1;
  socket.onopen();
    await waitFor(() => socket.sent.length === 1, "sync.hello");
    const hello = socket.sent[0];
    assert.equal(hello.v, 1);
    assert.equal(hello.frame, "request");
    assert.equal(hello.type, "sync.hello");
    assert.equal(hello.payload.deviceId, "device-1");
  assert.equal(hello.payload.deviceName, "佳林的 MacBook");
  assert.equal(hello.payload.deviceAlias, "佳林的 MacBook");
  assert.equal(hello.payload.hostname, "Jialin-MacBook");
  assert.equal(hello.payload.username, "jialin");
  assert.equal("ownerUserId" in hello.payload, false);
  assert.equal(hello.payload.lastAckedDeliverySeq, 0);
  assert.equal(hello.payload.lastAppliedRevision, 0);
  assert.equal(hello.payload.cacheSchemaVersion, 1);
  assert.equal(hello.payload.contractVersion, "1.0");
  assert.deepEqual(hello.payload.agents, [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体" }]);

    socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true, contractVersion: "1.0", capabilities: ["issue.claim", "issue.run.prepare", "run.event.append"] } }) });
    await waitFor(() => socket.sent.length === 2, "snapshot request");
    const snapshotRequest = socket.sent[1];
    assert.equal(snapshotRequest.v, 1);
    assert.equal(snapshotRequest.frame, "request");
    assert.equal(snapshotRequest.type, "snapshot.get");
    socket.onmessage({
      data: JSON.stringify({
        v: 1,
        frame: "response",
        id: snapshotRequest.id,
        type: "snapshot.get",
        ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 12,
        issues: [{ id: "ISS-1", title: "Cloud issue" }]
      }
    })
  });
  await waitFor(() => snapshots.length === 1, "snapshot apply");
  assert.equal(snapshots[0].revision, 12);
  assert.equal(snapshots[0].issues[0].id, "ISS-1");
  assert.equal(client.isOpen(), false);
  assert.deepEqual(states, ["connecting"]);

  const eventPull = await respondNextRequest(socket, "event.pull", { ok: true, events: [], hasMore: false, lastSeq: 12 });
  const syncPull = await respondNextRequest(socket, "sync.pull", { ok: true, items: [], hasMore: false }, socket.sent.indexOf(eventPull) + 1);
  assert.ok(syncPull);
  await waitFor(() => client.isOpen(), "ready websocket state");

    socket.onmessage({
      data: JSON.stringify({
        v: 1,
        frame: "request",
        id: "dispatch-1",
        type: "desktop.issue.dispatch",
        revision: 13,
      payload: { issue: { id: "ISS-2", title: "Dispatched issue" } }
    })
  });
    await waitFor(() => socket.sent.some((frame) => frame.id === "dispatch-1"), "dispatch ACK");
    const ack = socket.sent.find((frame) => frame.id === "dispatch-1");
    assert.equal(ack.v, 1);
    assert.equal(ack.frame, "response");
    assert.equal(ack.type, "desktop.issue.dispatch");
    assert.equal(ack.ok, true);
  assert.equal(ack.payload.message, "dispatched");
  assert.deepEqual(dispatches, [{
    issue: { id: "ISS-2", title: "Dispatched issue" },
    revision: 13
  }]);
  assert.deepEqual(states.slice(0, 2), ["connecting", "open"]);
  assert.deepEqual(negotiatedContracts, [{ contractVersion: "1.0", capabilities: ["issue.claim", "issue.run.prepare", "run.event.append"] }]);
  assert.equal(wsLogs.some((entry) => entry.direction === "send" && entry.envelope.type === "sync.hello"), true);
  assert.equal(wsLogs.some((entry) => entry.direction === "recv" && entry.envelope.type === "sync.hello"), true);
  assert.equal(JSON.stringify(wsLogs).includes("secret"), false);
  assert.equal(debugMessages.some((message) => message.includes("secret") || message.includes("Desktop User")), false);

  client.stop();
});

test("kanban desktop ws client keeps cached data when sync.hello is rejected", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.sent = [];
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.closed = true; }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const snapshots = [];
  const states = [];
  const client = new KanbanDesktopWsClient({
    capabilities: [],
    getDeviceId: () => "device-1",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDispatchIssue: () => ({ ok: true, message: "ok", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "ok" }),
    onAutomationSync: async () => ({ ok: true }),
    onStateChanged: (state) => states.push(state)
  });
  t.after(() => client.stop());

  client.start({ serverUrl: "http://127.0.0.1:3000" });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.hello"), "sync.hello");
  const hello = socket.sent.find((frame) => frame.type === "sync.hello");
  socket.onmessage({ data: JSON.stringify({
    v: 1,
    frame: "response",
    id: hello.id,
    type: "sync.hello",
    ok: false,
    error: { code: "unauthorized", message: "invalid JWT" }
  }) });

  await waitFor(() => socket.closed, "socket close after rejected hello");
  assert.deepEqual(snapshots, []);
  assert.equal(socket.sent.some((frame) => frame.type === "snapshot.get"), false);
  assert.equal(states.at(-1), "error");
});

test("kanban desktop ws client rejects an empty snapshot when hello reports accessible projects", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.sent = [];
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.closed = true; }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const snapshots = [];
  const client = new KanbanDesktopWsClient({
    capabilities: [],
    getDeviceId: () => "device-1",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDispatchIssue: () => ({ ok: true, message: "ok", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "ok" }),
    onAutomationSync: async () => ({ ok: true })
  });
  t.after(() => client.stop());

  client.start({ serverUrl: "http://127.0.0.1:3000" });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  const hello = await respondNextRequest(socket, "sync.hello", helloPayload({
    accessibleProjects: [{ id: "default", name: "Default" }]
  }));
  await respondNextRequest(socket, "snapshot.get", {
    scope: "project_set",
    complete: true,
    projectIds: [],
    projects: [],
    issues: []
  }, socket.sent.indexOf(hello) + 1);

  await waitFor(() => socket.closed, "socket close after empty snapshot");
  assert.deepEqual(snapshots, []);
  assert.equal(client.isOpen(), false);
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
    data: new Blob([JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: helloPayload() })])
  });

  await waitFor(() => socket.sent.length === 2, "snapshot request after blob hello");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: new Blob([JSON.stringify({
      v: 1, frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 30,
        issues: [{ id: "ISS-blob", title: "Blob issue" }]
      }
    })])
  });

  await waitFor(() => snapshots.length === 1, "blob snapshot apply");
  assert.equal(snapshots[0].issues[0].id, "ISS-blob");

  client.stop();
});

test("kanban desktop ws client applies direct issue pushes without delivery ACK", async (t) => {
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

  const issueEvents = [];
  let cursor = { lastAckedDeliverySeq: 0, lastAppliedRevision: 12, cacheSchemaVersion: 1 };
  const client = new KanbanDesktopWsClient({
    capabilities: ["command.dispatchIssue"],
    getDeviceId: () => "device-1",
    getSyncCursor: () => cursor,
    onSyncCursor: (next) => {
      cursor = { ...cursor, ...next };
    },
    onSnapshot: () => {},
    onIssueEvent: async (event) => {
      issueEvents.push(event);
      cursor = { ...cursor, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, event.seq) };
      return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
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
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: helloPayload({ cursor }) }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 12, lastSeq: 12, issues: [] }
    })
  });
  await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", lastSeq: 12, hasMore: false, nextAfterSeq: 12, events: [] });

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "issue.updated",
      projectId: "project-1",
      revision: 13,
      payload: {
        seq: 13,
        eventType: "issue.updated",
        projectId: "project-1",
        issueId: "ISS-13",
        issue: { id: "ISS-13", title: "Updated", revision: 13 }
      }
    })
  });

  await waitFor(() => issueEvents.length === 1, "issue.updated push");
  assert.equal(socket.sent.some((frame) => frame.type === "sync.ack"), false);
  assert.equal(issueEvents[0].seq, 13);
  assert.equal(issueEvents[0].eventType, "issue.updated");
  assert.equal(issueEvents[0].issueId, "ISS-13");
  assert.equal(cursor.lastAppliedRevision, 13);

  client.stop();
});

test("kanban desktop ws client queues issue pushes until snapshot and skips stale seq", async (t) => {
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

  const issueEvents = [];
  let cursor = { lastAckedDeliverySeq: 0, lastAppliedRevision: 10, cacheSchemaVersion: 1 };
  const client = new KanbanDesktopWsClient({
    capabilities: ["command.dispatchIssue"],
    getDeviceId: () => "device-1",
    getSyncCursor: () => cursor,
    onSyncCursor: (next) => {
      cursor = { ...cursor, ...next };
    },
    onSnapshot: (snapshot) => {
      cursor = { ...cursor, lastAppliedRevision: snapshot.lastSeq ?? snapshot.revision ?? cursor.lastAppliedRevision };
    },
    onIssueEvent: async (event) => {
      issueEvents.push(event);
      cursor = { ...cursor, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, event.seq) };
      return { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
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
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: helloPayload({ cursor }) }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "issue.updated",
      projectId: "project-1",
      revision: 12,
      payload: {
        seq: 12,
        eventType: "issue.updated",
        projectId: "project-1",
        issueId: "ISS-12",
        issue: { id: "ISS-12", title: "Queued", revision: 12 }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(issueEvents.length, 0);

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 11, lastSeq: 11, issues: [] }
    })
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === "event.pull"), "event.pull request");
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "issue.created",
      projectId: "project-1",
      revision: 13,
      payload: {
        seq: 13,
        eventType: "issue.created",
        projectId: "project-1",
        issueId: "ISS-13",
        issue: { id: "ISS-13", title: "Queued during pull", revision: 13 }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(issueEvents.length, 0);
  const eventPull = socket.sent.find((frame) => frame.type === "event.pull");
  respondOk(socket, eventPull, { ok: true, projectId: "project-1", lastSeq: 11, hasMore: false, nextAfterSeq: 11, events: [] });
  await waitFor(() => issueEvents.length === 2, "queued issue pushes");
  assert.deepEqual(issueEvents.map((event) => event.seq), [12, 13]);

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "issue.updated",
      projectId: "project-1",
      revision: 11,
      payload: {
        seq: 11,
        eventType: "issue.updated",
        projectId: "project-1",
        issueId: "ISS-11",
        issue: { id: "ISS-11", title: "Stale", revision: 11 }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(issueEvents.length, 2);
  assert.equal(cursor.lastAppliedRevision, 13);

  client.stop();
});

test("kanban desktop ws client resyncs snapshot and deliveries without reconnecting", async (t) => {
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
  let cursor = { lastAckedDeliverySeq: 0, lastAppliedRevision: 12, cacheSchemaVersion: 1 };
  const client = new KanbanDesktopWsClient({
    capabilities: ["command.dispatchIssue"],
    getDeviceId: () => "device-1",
    getSyncCursor: () => cursor,
    onSyncCursor: (next) => {
      cursor = { ...cursor, ...next };
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDelivery: async (delivery) => ({ ok: true, lastAppliedRevision: Math.max(cursor.lastAppliedRevision, delivery.sourceRevision ?? 0) }),
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
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: helloPayload({ cursor }) }) });
  await waitFor(() => socket.sent.length === 2, "initial snapshot request");
  const initialSnapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: initialSnapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 12, lastSeq: 12, issues: [] }
    })
  });
  await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", lastSeq: 12, hasMore: false, nextAfterSeq: 12, events: [] });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "initial sync.pull");
  const initialPullRequest = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: initialPullRequest.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });
  await waitFor(() => client.isOpen(), "initial sync ready");

  const sentBeforeResync = socket.sent.length;
  const resyncPromise = client.resyncFromCloud();
  await waitFor(
    () => socket.sent.slice(sentBeforeResync).some((frame) => frame.type === "snapshot.get"),
    "manual resync snapshot"
  );
  const resyncSnapshotRequest = socket.sent.slice(sentBeforeResync).find((frame) => frame.type === "snapshot.get");
  assert.equal(resyncSnapshotRequest.payload.scope, "project_set");
  assert.equal(resyncSnapshotRequest.payload.deviceId, "device-1");
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: resyncSnapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 13, lastSeq: 13, issues: [{ id: "ISS-13", title: "Resynced" }] }
    })
  });
  await waitFor(
    () => socket.sent.slice(sentBeforeResync).some((frame) => frame.type === "event.pull"),
    "manual resync event pull"
  );
  const resyncEventPullRequest = socket.sent.slice(sentBeforeResync).find((frame) => frame.type === "event.pull");
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: resyncEventPullRequest.id, type: "event.pull", ok: true, payload: { ok: true, projectId: "project-1", events: [], hasMore: false, lastSeq: 13, nextAfterSeq: 13 } }) });
  await waitFor(
    () => socket.sent.slice(sentBeforeResync).some((frame) => frame.type === "sync.pull"),
    "manual resync pull"
  );
  const resyncPullRequest = socket.sent.slice(sentBeforeResync).find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: resyncPullRequest.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });
  await resyncPromise;

  assert.equal(sockets.length, 1);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].revision, 13);
  assert.equal(snapshots[1].issues[0].id, "ISS-13");

  client.stop();
});

test("kanban desktop ws client keeps metadata pushes and converges with a project-set snapshot", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
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
    capabilities: [],
    getDeviceId: () => "device-1",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDispatchIssue: () => ({ ok: true, message: "ok", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "ok" }),
    onAutomationSync: async () => ({ ok: true })
  });

  client.start({ serverUrl: "http://127.0.0.1:3000", selectedProjectId: "default" });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();

  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.hello"), "sync.hello");
  const hello = socket.sent.find((frame) => frame.type === "sync.hello");
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: hello.id,
      type: "sync.hello",
      ok: true,
      payload: { contractVersion: "1.0", cursor: {} }
    })
  });

  await waitFor(() => socket.sent.some((frame) => frame.type === "snapshot.get"), "initial snapshot.get");
  const initialSnapshot = socket.sent.find((frame) => frame.type === "snapshot.get");
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: initialSnapshot.id,
      type: "snapshot.get",
      ok: true,
      payload: {
        scope: "project_set",
        complete: true,
        projectIds: [],
        issues: [],
        issueTypes: [{ key: "story", name: "Story", color: "#8f78c7", icon: "book", isActive: true }],
        workflowStages: [{ id: "stage-todo", workflowId: "workflow-story", key: "todo", name: "Todo", color: "#6f91c9" }]
      }
    })
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "initial sync.pull");
  const initialPull = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({
    data: JSON.stringify({ v: 1, frame: "response", id: initialPull.id, type: "sync.pull", ok: true, payload: { items: [], hasMore: false } })
  });
  await waitFor(() => snapshots.length === 1, "initial snapshot apply");

  const sentBeforePush = socket.sent.length;
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "snapshot.updated",
      revision: 22,
      payload: {
        scope: "project",
        complete: true,
        issueTypes: [{ key: "story", name: "Story", color: "#7185a6", icon: "crown", isActive: false }],
        workflowStages: [{ id: "stage-todo", workflowId: "workflow-story", key: "todo", name: "Todo", color: "#d2a96e" }]
      }
    })
  });

  await waitFor(() => snapshots.length === 2, "metadata push apply");
  assert.deepEqual(
    [snapshots[1].issueTypes[0].color, snapshots[1].issueTypes[0].icon, snapshots[1].issueTypes[0].isActive],
    ["#7185a6", "crown", false]
  );
  assert.equal(snapshots[1].workflowStages[0].color, "#d2a96e");

  await waitFor(
    () => socket.sent.slice(sentBeforePush).some((frame) => frame.type === "snapshot.get"),
    "metadata project-set resync"
  );
  const metadataResync = socket.sent.slice(sentBeforePush).find((frame) => frame.type === "snapshot.get");
  assert.equal(metadataResync.payload.scope, "project_set");
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: metadataResync.id,
      type: "snapshot.get",
      ok: true,
      payload: { scope: "project_set", complete: true, projectIds: [], issues: [], issueTypes: [], workflowStages: [] }
    })
  });
  await waitFor(
    () => socket.sent.slice(sentBeforePush).filter((frame) => frame.type === "sync.pull").length === 1,
    "metadata resync sync.pull"
  );
  const metadataPull = socket.sent.slice(sentBeforePush).find((frame) => frame.type === "sync.pull");
  socket.onmessage({
    data: JSON.stringify({ v: 1, frame: "response", id: metadataPull.id, type: "sync.pull", ok: true, payload: { items: [], hasMore: false } })
  });
  await waitFor(() => snapshots.length === 3, "authoritative metadata snapshot apply");

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
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: helloPayload({ cursor }) }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 20, lastSeq: 20, issues: [] }
    })
  });
  await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", lastSeq: 20, hasMore: false, nextAfterSeq: 20, events: [] });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "sync.pull");
  const pullRequest = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 1, frame: "response", id: pullRequest.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "sync.deliver",
      payload: {
        items: [{
          deliverySeq: 2,
          kind: "command",
          sourceRevision: 22,
          eventType: "command.dispatchIssue",
          payload: { issue: { id: "ISS-22", title: "Gap", revision: 22 } }
        }]
      }
    })
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveries.length, 0);
  assert.equal(socket.sent.some((frame) => frame.type === "sync.ack"), false);
  assert.ok(debugMessages.some((message) => /1/u.test(message) && /2/u.test(message)));

  socket.onmessage({
    data: JSON.stringify({
      v: 1,
      frame: "push",
      type: "sync.deliver",
      payload: {
        items: [{
          deliverySeq: 1,
          kind: "command",
          sourceRevision: 21,
          eventType: "command.dispatchIssue",
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
          v: 1,
          frame: "request",
          id: "start-run-1",
          type: "desktop.assistant.startRun",
          revision: 21,
        payload: {
          issue: { id: "ISS-9", title: "Remote run issue", status: "in_progress" },
          agentKey: "codeAssistant",
          accessLevel: "full_access",
          message: "Run remote issue"
        }
      })
    });

      await waitFor(() => socket.sent.some((frame) => frame.id === "start-run-1"), "startRun ACK");
      const ack = socket.sent.find((frame) => frame.id === "start-run-1");
      assert.equal(ack.v, 1);
      assert.equal(ack.frame, "response");
      assert.equal(ack.type, "desktop.assistant.startRun");
      assert.deepEqual(startRuns, [{
      issue: { id: "ISS-9", title: "Remote run issue", status: "in_progress" },
      revision: 21,
      agentKey: "codeAssistant",
      accessLevel: "full_access",
      chatId: null,
      message: "Run remote issue",
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

  const hello = socket.sent[0];
  respondOk(socket, hello, helloPayload());
  const snapshot = await respondNextRequest(socket, "snapshot.get", {
    scope: "project_set",
    complete: true,
    projectIds: [],
    projects: [],
    issues: []
  });
  await respondNextRequest(socket, "sync.pull", { ok: true, items: [], hasMore: false }, socket.sent.indexOf(snapshot) + 1);
  await waitFor(() => client.isOpen(), "initial sync ready");

  await assert.rejects(
    client.request("issue.update", { id: "ISS-1" }, 1),
    /issue\.update 请求超时/
  );

  assert.equal(socket.closed, true);
  assert.equal(client.isOpen(), false);
  assert.equal(states.at(-1), "error");

  client.stop();
});


test("kanban desktop ws client closes non-v1 protocol messages", async (t) => {
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
      v: 1, frame: "request",
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

test("kanban desktop ws client refuses local issue content before serialization", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.sent = [];
      this.readyState = 0;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const client = new KanbanDesktopWsClient({
    capabilities: [],
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "ok", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "ok" }),
    onAutomationSync: async () => ({ ok: true })
  });
  client.start({ serverUrl: "http://127.0.0.1:3000", selectedProjectId: "default" });
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.hello"), "sync.hello");
  const hello = socket.sent.find((frame) => frame.type === "sync.hello");
  respondOk(socket, hello, helloPayload());
  const snapshot = await respondNextRequest(socket, "snapshot.get", {
    scope: "project_set",
    complete: true,
    projectIds: [],
    projects: [],
    issues: []
  });
  await respondNextRequest(socket, "sync.pull", { ok: true, items: [], hasMore: false }, socket.sent.indexOf(snapshot) + 1);
  await waitFor(() => client.isOpen(), "initial sync ready");
  const sentBefore = socket.sent.length;

  await assert.rejects(
    client.request("issue.update", { issue: { id: "local-1", syncMode: "local", title: "never upload", filePath: "/Users/me/private.txt" } }),
    /local kanban payload/u
  );
  await assert.rejects(
    client.request("issue.update", { issue: { id: "legacy-1", syncMode: "private", title: "legacy never upload" } }),
    /local kanban payload/u
  );
  assert.equal(socket.sent.length, sentBefore);
  assert.equal(socket.readyState, 1);
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
