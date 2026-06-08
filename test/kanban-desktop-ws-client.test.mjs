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
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const snapshots = [];
  const dispatches = [];
  const states = [];
  const client = new KanbanDesktopWsClient({
    capabilities: ["kanban.issue.dispatch"],
    getCurrentUser: () => ({
      id: "user-1",
      name: "Desktop User",
      email: "desktop@example.com",
      source: "sso"
    }),
    getDeviceId: () => "device-1",
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
    onListAgents: async () => [],
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
  assert.match(socket.url, /token=secret/);

  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "desktop.hello");
  const hello = socket.sent[0];
  assert.equal(hello.op, "desktop.hello");
  assert.equal(hello.payload.deviceId, "device-1");
  assert.equal(hello.payload.scope, "current_user");
  assert.deepEqual(hello.payload.currentUser, {
    id: "user-1",
    name: "Desktop User",
    email: "desktop@example.com",
    source: "sso"
  });

  socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  assert.equal(snapshotRequest.op, "kanban.snapshot.get");
  socket.onmessage({
    data: JSON.stringify({
      type: "rpc.res",
      id: snapshotRequest.id,
      op: "kanban.snapshot",
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
      type: "rpc.req",
      id: "dispatch-1",
      op: "desktop.kanban.issue.dispatch",
      revision: 13,
      payload: { issue: { id: "ISS-2", title: "Dispatched task" } }
    })
  });
  await waitFor(() => socket.sent.some((frame) => frame.id === "dispatch-1"), "dispatch ACK");
  const ack = socket.sent.find((frame) => frame.id === "dispatch-1");
  assert.equal(ack.type, "rpc.res");
  assert.equal(ack.ok, true);
  assert.equal(ack.payload.message, "dispatched");
  assert.deepEqual(dispatches, [{
    issue: { id: "ISS-2", title: "Dispatched task" },
    revision: 13
  }]);
  assert.deepEqual(states.slice(0, 2), ["connecting", "open"]);

  client.stop();
});
