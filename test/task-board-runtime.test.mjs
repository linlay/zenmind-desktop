import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ZENMIND_TASK_BOARD_REMOTE_START_ACK_TIMEOUT_MS = "20";

const { TaskBoardRuntime, readTaskBoardWsConfig } = await import("../dist-electron/main/task-board-runtime.js");

function createTempApp(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-task-board-runtime-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

function writeKanbanConfig(app, config) {
  const configPath = path.join(app.getPath("home"), ".zenmind", ".desktop", "config", "desktop", "kanban.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

test("task board websocket config is disabled until remote control is allowed", (t) => {
  const app = createTempApp(t);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a"
  });
  assert.equal(readTaskBoardWsConfig(app), null);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a",
    remoteControlEnabled: true
  });
  assert.deepEqual(readTaskBoardWsConfig(app), {
    serverUrl: "http://127.0.0.1:8080",
    token: "secret",
    selectedProjectId: "project-a"
  });
});

function waitFor(check, message = "condition", timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${message}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

test("task board runtime stores remote startRun issue locally before executing", async (t) => {
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

  const app = createTempApp(t);
  const startRuns = [];
  const runtime = new TaskBoardRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async (request) => {
        startRuns.push(request);
        return { ok: true, runId: "run-remote-1", chatId: "chat-remote-1", message: "started" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "desktop.hello", 3000);
  const hello = socket.sent[0];
  assert.equal(hello.payload.deviceName, "测试桌面");
  assert.equal(hello.payload.deviceAlias, "测试桌面");
  assert.equal(hello.payload.currentUser.name, "测试桌面");
  assert.ok(hello.payload.hostname || hello.payload.username);
  socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      type: "rpc.res",
      id: snapshotRequest.id,
      op: "kanban.snapshot",
      ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 30,
        complete: true,
        scope: "project",
        issues: []
      }
    })
  });

  try {
    socket.onmessage({
      data: JSON.stringify({
        type: "rpc.req",
        id: "start-run-remote",
        op: "desktop.assistant.startRun",
        boardId: "default",
        projectId: "project-1",
        revision: 31,
        payload: {
          issue: {
            id: "ISS-31",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            title: "云端执行任务",
            description: "需要同步到桌面端",
            status: "in_progress",
            priority: "medium",
            severity: "medium",
            assigneeAgentKey: "codeAssistant",
            position: 1,
            revision: 31,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          },
          agentKey: "codeAssistant",
          message: "执行云端任务"
        }
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "start-run-remote"), "remote start ACK");
    const ack = socket.sent.find((frame) => frame.id === "start-run-remote");
    assert.equal(ack.ok, true);
    assert.equal(ack.payload.runId, "run-remote-1");
    assert.equal(startRuns[0].message, "执行云端任务");
    assert.equal(startRuns[0].issue.id, "ISS-31");

    const localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-31");
    assert.ok(localIssue);
    assert.equal(localIssue.title, "云端执行任务");
    assert.equal(localIssue.origin, "cloud_dispatch");
    assert.equal(localIssue.syncMode, "cloud");
    assert.equal(localIssue.runId, "run-remote-1");
    assert.equal(localIssue.chatId, "chat-remote-1");
    assert.equal(localIssue.runState, "running");
  } finally {
    runtime.stop();
  }
});

test("task board runtime reconnects after saving device alias so cloud sees new device name", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
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
      this.closed = true;
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const app = createTempApp(t);
  const runtime = new TaskBoardRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true,
    deviceAlias: "旧设备名"
  });

  const firstSocket = sockets[0];
  firstSocket.readyState = 1;
  firstSocket.onopen();
  await waitFor(() => firstSocket.sent.length === 1, "initial desktop.hello", 3000);
  const firstHello = firstSocket.sent[0];
  assert.equal(firstHello.payload.deviceName, "旧设备名");
  firstSocket.onmessage({
    data: JSON.stringify({ type: "rpc.res", id: firstHello.id, op: "desktop.hello", ok: true, payload: { ok: true } })
  });
  await waitFor(() => firstSocket.sent.length === 2, "initial snapshot request", 3000);

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true,
    deviceAlias: "牛家林"
  });

  await waitFor(() => sockets.length === 2, "reconnect after device alias save", 3000);
  assert.equal(firstSocket.closed, true);
  const secondSocket = sockets[1];
  secondSocket.readyState = 1;
  secondSocket.onopen();
  await waitFor(() => secondSocket.sent.length === 1, "updated desktop.hello", 3000);
  const secondHello = secondSocket.sent[0];
  assert.equal(secondHello.payload.deviceName, "牛家林");
  assert.equal(secondHello.payload.deviceAlias, "牛家林");
  assert.equal(secondHello.payload.currentUser.name, "牛家林");
  runtime.stop();
});

test("task board runtime ACKs slow remote startRun before bridge resolves", async (t) => {
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

  const app = createTempApp(t);
  const startRuns = [];
  const runtime = new TaskBoardRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async (request) => {
        startRuns.push(request);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true, runId: "run-slow-1", chatId: request.chatId, message: "started" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "desktop.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      type: "rpc.res",
      id: snapshotRequest.id,
      op: "kanban.snapshot",
      ok: true,
      payload: {
        boardId: "default",
        projectId: "project-1",
        revision: 30,
        complete: true,
        scope: "project",
        issues: []
      }
    })
  });

  try {
    socket.onmessage({
      data: JSON.stringify({
        type: "rpc.req",
        id: "start-run-slow",
        op: "desktop.assistant.startRun",
        boardId: "default",
        projectId: "project-1",
        revision: 31,
        payload: {
          issue: {
            id: "ISS-SLOW",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            title: "慢启动云端任务",
            description: "需要先 ACK",
            status: "in_progress",
            priority: "medium",
            severity: "medium",
            assigneeAgentKey: "codeAssistant",
            position: 1,
            revision: 31,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          },
          agentKey: "codeAssistant",
          message: "执行慢启动任务"
        }
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "start-run-slow"), "slow start ACK");
    const ack = socket.sent.find((frame) => frame.id === "start-run-slow");
    assert.equal(ack.ok, true);
    assert.equal(ack.payload.ok, true);
    assert.match(ack.payload.runId, /^run_/);
    assert.match(ack.payload.chatId, /^chat_/);

    let localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-SLOW");
    assert.ok(localIssue);
    assert.equal(localIssue.runState, "running");
    assert.equal(localIssue.chatId, ack.payload.chatId);
    assert.equal(localIssue.runId, ack.payload.runId);

    await waitFor(() => {
      const issue = runtime.listIssues().issues.find((item) => item.remoteIssueId === "ISS-SLOW");
      return issue?.runId === "run-slow-1";
    }, "background bridge result", 1000);
    localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-SLOW");
    assert.equal(localIssue.runId, "run-slow-1");
    assert.equal(localIssue.chatId, ack.payload.chatId);
    assert.equal(startRuns[0].chatId, ack.payload.chatId);
  } finally {
    runtime.stop();
  }
});

test("task board runtime falls back to local agents for remote listAgents", async (t) => {
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

  const app = createTempApp(t);
  const runtime = new TaskBoardRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    listLocalAgents: () => [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体", unreadCount: 0 }],
    onChanged: () => {}
  });

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "desktop.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");

  try {
    socket.onmessage({
      data: JSON.stringify({
        type: "rpc.req",
        id: "list-agents-local",
        op: "desktop.assistant.listAgents",
        boardId: "default",
        projectId: "project-1",
        payload: {}
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "list-agents-local"), "local agents ACK");
    const ack = socket.sent.find((frame) => frame.id === "list-agents-local");
    assert.equal(ack.ok, true);
    assert.equal(ack.payload.items[0].agentKey, "cutej");
    assert.equal(ack.payload.items[0].displayName, "小君");
    assert.equal(ack.payload.agents[0].displayName, "小君");
  } finally {
    runtime.stop();
  }
});

test("task board runtime lists installed agents when platform listAgents times out", async (t) => {
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

  const app = createTempApp(t);
  const agentsRoot = path.join(app.getPath("home"), ".zenmind", "agents");
  fs.mkdirSync(path.join(agentsRoot, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "bootstrap", "agent.yml"), "key: bootstrap\nname: 初始化\nrole: 初次引导配置\n", "utf8");
  fs.mkdirSync(path.join(agentsRoot, "cutej"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "cutej", "agent.yml"), "key: cutej\nname: 小君\nrole: 平台总管\n", "utf8");
  fs.mkdirSync(path.join(agentsRoot, "cutej.bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "cutej.bootstrap", "agent.yml"), "key: cutej\nname: 小君 Bootstrap\nrole: 重复配置\n", "utf8");
  const debugMessages = [];
  let platformListAgentsCalled = false;
  const runtime = new TaskBoardRuntime({
    app,
    assistantBridge: {
      listAgents: () => {
        platformListAgentsCalled = true;
        return new Promise(() => {});
      },
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    listLocalAgents: () => [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体", unreadCount: 0 }],
    onChanged: () => {},
    onDebug: (message) => debugMessages.push(message)
  });

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "",
    selectedProjectId: "project-1",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  try {
    socket.readyState = 1;
    socket.onopen();
    await waitFor(() => socket.sent.length === 1, "desktop.hello", 3000);
    const hello = socket.sent[0];
    socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });

    socket.onmessage({
      data: JSON.stringify({
        type: "rpc.req",
        id: "list-agents-timeout",
        op: "desktop.assistant.listAgents",
        boardId: "default",
        projectId: "project-1",
        payload: {}
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "list-agents-timeout"), "installed agents ACK", 3000);
    const ack = socket.sent.find((frame) => frame.id === "list-agents-timeout");
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.payload.items.map((agent) => agent.agentKey), ["bootstrap", "cutej"]);
    assert.equal(ack.payload.items[0].displayName, "初始化");
    assert.equal(ack.payload.items[1].displayName, "小君");
    assert.equal(platformListAgentsCalled, true);
    assert.equal(debugMessages.some((message) => message.includes("安装目录 2")), true);
  } finally {
    runtime.stop();
  }
});
