import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { KanbanDesktopWsClient } = await import("../dist-electron/main/kanban-desktop-ws-client.js");
const {
  createLocalDesktopProject,
  findLocalDesktopProject,
  convertLocalProjectIssuesToPrivate,
  listPendingUpstreamIssues,
  applyDesktopIssueSyncResults
} = await import("../dist-electron/main/task-board-local-projects.js");
const { DesktopCloudSyncEngine } = await import("../dist-electron/main/task-board-cloud-sync.js");
const {
  applyDesktopKanbanCloudSnapshot,
  createPrivateDesktopKanbanIssue,
  listDesktopKanbanIssues
} = await import("../dist-electron/main/task-board-local-store.js");

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

function createTempApp(t, prefix = "zenmind-desktop-binding-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    getPath(name) {
      if (name === "home") return home;
      if (name === "appData") return path.join(home, "Library", "Application Support");
      return path.join(home, name);
    }
  };
}

function currentUser(id = "user-1") {
  return {
    id,
    name: "Desktop User",
    email: "desktop@example.com",
    source: "sso"
  };
}

function createFakeWsContext(t) {
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
  return sockets;
}

function createClientOptions(overrides = {}) {
  return {
    capabilities: ["kanban.issue.dispatch", "desktop.project.select"],
    getCurrentUser: () => currentUser(),
    getDeviceId: () => "device-1",
    onSnapshot: () => {},
    onDispatchIssue: () => ({ ok: true, message: "", issues: [] }),
    onListAgents: async () => [],
    onStartRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "" }),
    onAutomationSync: async () => ({ ok: true }),
    onListLocalProjects: async () => ({ ok: true, projects: [], message: "" }),
    onCreateLocalProject: async () => ({ ok: true }),
    onBindProject: async () => ({ ok: true }),
    onUnbindProject: async () => ({ ok: true }),
    ...overrides
  };
}

async function openClient(socket) {
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length >= 1, "desktop.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ type: "rpc.res", id: hello.id, op: "desktop.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length >= 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      type: "rpc.res",
      id: snapshotRequest.id,
      op: "kanban.snapshot",
      ok: true,
      payload: { boardId: "default", projectId: "project-1", revision: 1, issues: [] }
    })
  });
}

test("kanban desktop ws client switches project via desktop.project.select without reconnect", async (t) => {
  const sockets = createFakeWsContext(t);
  const client = new KanbanDesktopWsClient(createClientOptions());

  client.start({ serverUrl: "http://127.0.0.1:3000", token: "secret", selectedProjectId: "project-1" });
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  await openClient(socket);

  client.start({ serverUrl: "http://127.0.0.1:3000", token: "secret", selectedProjectId: "project-2" });
  await waitFor(
    () => socket.sent.some((frame) => frame.op === "desktop.project.select"),
    "desktop.project.select request"
  );
  // 没有新建 socket = 没有重连
  assert.equal(sockets.length, 1);
  const selectRequest = socket.sent.find((frame) => frame.op === "desktop.project.select");
  assert.equal(selectRequest.payload.selectedProjectId, "project-2");

  client.stop();
});

test("kanban desktop ws client falls back to reconnect when project select fails", async (t) => {
  const sockets = createFakeWsContext(t);
  const client = new KanbanDesktopWsClient(createClientOptions());

  client.start({ serverUrl: "http://127.0.0.1:3000", token: "secret", selectedProjectId: "project-1" });
  const socket = sockets[0];
  await openClient(socket);

  client.start({ serverUrl: "http://127.0.0.1:3000", token: "secret", selectedProjectId: "project-2" });
  await waitFor(
    () => socket.sent.some((frame) => frame.op === "desktop.project.select"),
    "desktop.project.select request"
  );
  const selectRequest = socket.sent.find((frame) => frame.op === "desktop.project.select");
  socket.onmessage({
    data: JSON.stringify({
      type: "rpc.res",
      id: selectRequest.id,
      op: "desktop.project.select",
      ok: false,
      error: { code: "unknown_op", message: "未知 WebSocket 操作。" }
    })
  });
  // 服务端不支持时回落整条重连
  await waitFor(() => sockets.length === 2, "reconnect socket");

  client.stop();
});

test("createLocalDesktopProject creates project and is idempotent by id", (t) => {
  const app = createTempApp(t);
  const user = currentUser();

  const created = createLocalDesktopProject(app, user, { name: "新本地项目" });
  assert.equal(created.ok, true);
  assert.ok(created.project.id);
  assert.equal(created.project.name, "新本地项目");

  const again = createLocalDesktopProject(app, user, { id: created.project.id, name: "无所谓" });
  assert.equal(again.ok, true);
  assert.equal(again.project.id, created.project.id);
  assert.equal(again.message, "本地项目已存在。");

  const found = findLocalDesktopProject(app, user, created.project.id);
  assert.ok(found);
  assert.equal(found.name, "新本地项目");
});

test("convertLocalProjectIssuesToPrivate flips cloud issues back to private", (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const project = createLocalDesktopProject(app, user, { name: "绑定项目" }).project;

  applyDesktopKanbanCloudSnapshot(app, user, {
    boardId: "default",
    projectId: project.id,
    revision: 5,
    complete: false,
    scope: "project",
    projects: [],
    projectBindings: [],
    issues: [
      { id: "remote-1", projectId: project.id, title: "云端任务", status: "todo", priority: "medium" }
    ]
  });
  const before = listDesktopKanbanIssues(app, user);
  const cloudIssue = before.issues.find((issue) => issue.remoteIssueId === "remote-1");
  assert.ok(cloudIssue);
  assert.equal(cloudIssue.syncMode, "cloud");

  const converted = convertLocalProjectIssuesToPrivate(app, user, project.id);
  assert.equal(converted, 1);
  const after = listDesktopKanbanIssues(app, user);
  const privateIssue = after.issues.find((issue) => issue.id === cloudIssue.id);
  assert.equal(privateIssue.syncMode, "private");
  assert.equal(privateIssue.remoteIssueId, null);
});

test("listPendingUpstreamIssues collects only local/error desktop issues in bound projects", (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const project = createLocalDesktopProject(app, user, { name: "上行项目" }).project;

  createPrivateDesktopKanbanIssue(app, user, { title: "待上行", projectId: project.id });
  createPrivateDesktopKanbanIssue(app, user, { title: "其他项目", projectId: "default" });

  const pending = listPendingUpstreamIssues(app, user, [project.id]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, "待上行");

  assert.deepEqual(listPendingUpstreamIssues(app, user, []), []);
});

test("applyDesktopIssueSyncResults links created issues and overwrites conflicts with cloud version", (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const project = createLocalDesktopProject(app, user, { name: "回写项目" }).project;
  const created = createPrivateDesktopKanbanIssue(app, user, { title: "本地标题", projectId: project.id });
  const localIssueId = created.issue.id;

  const summary = applyDesktopIssueSyncResults(app, user, [
    {
      localIssueId,
      remoteIssueId: "remote-9",
      status: "created",
      issue: { id: "remote-9", projectId: project.id, title: "本地标题", status: "todo", priority: "medium", revision: 7 }
    }
  ], 7);
  assert.equal(summary.synced, 1);

  const afterCreate = listDesktopKanbanIssues(app, user);
  const linked = afterCreate.issues.find((issue) => issue.id === localIssueId);
  assert.equal(linked.remoteIssueId, "remote-9");
  assert.equal(linked.syncMode, "cloud");
  assert.equal(linked.syncState, "synced");

  // 冲突:云端权威版本覆盖本地
  const conflictSummary = applyDesktopIssueSyncResults(app, user, [
    {
      localIssueId,
      remoteIssueId: "remote-9",
      status: "conflict",
      message: "云端版本已更新",
      issue: { id: "remote-9", projectId: project.id, title: "云端胜出标题", status: "in_progress", priority: "high", revision: 9 }
    }
  ], 9);
  assert.equal(conflictSummary.conflicts, 1);
  const afterConflict = listDesktopKanbanIssues(app, user);
  const overwritten = afterConflict.issues.find((issue) => issue.id === localIssueId);
  assert.equal(overwritten.title, "云端胜出标题");
  assert.equal(overwritten.status, "in_progress");

  // 错误:标记 syncState=error
  const errorSummary = applyDesktopIssueSyncResults(app, user, [
    { localIssueId, status: "error", message: "服务端错误" }
  ], 9);
  assert.equal(errorSummary.errors, 1);
  const afterError = listDesktopKanbanIssues(app, user);
  const errored = afterError.issues.find((issue) => issue.id === localIssueId);
  assert.equal(errored.syncState, "error");
  assert.equal(errored.syncError, "服务端错误");
});

test("DesktopCloudSyncEngine pushes pending issues for active bindings and applies results", async (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const project = createLocalDesktopProject(app, user, { name: "引擎项目" }).project;

  // 通过快照写入活动绑定(deviceId 与引擎一致)
  applyDesktopKanbanCloudSnapshot(app, user, {
    boardId: "default",
    projectId: "cloud-project-1",
    revision: 1,
    complete: false,
    scope: "project",
    projects: [],
    projectBindings: [
      {
        id: "pbind-1",
        projectId: "cloud-project-1",
        deviceId: "device-1",
        localProjectId: project.id,
        localDisplayName: project.name,
        syncPolicy: "all",
        controlMode: "dispatch",
        status: "active",
        lastRemoteRevision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    issues: []
  });
  const created = createPrivateDesktopKanbanIssue(app, user, { title: "引擎上行任务", projectId: project.id });
  const localIssueId = created.issue.id;

  const requests = [];
  const engine = new DesktopCloudSyncEngine({
    app,
    getCurrentUser: () => user,
    getDeviceId: () => "device-1",
    wsClient: {
      isOpen: () => true,
      request: async (op, payload) => {
        requests.push({ op, payload });
        return {
          ok: true,
          revision: 2,
          results: payload.upserts.map((upsert) => ({
            localIssueId: upsert.localIssueId,
            remoteIssueId: `remote-${upsert.localIssueId}`,
            status: "created",
            issue: { ...upsert.input, id: `remote-${upsert.localIssueId}`, revision: 2 }
          }))
        };
      }
    }
  });
  t.after(() => engine.stop());

  const result = await engine.run();
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(result.synced, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].op, "desktop.issue.sync");
  assert.equal(requests[0].payload.projectId, "cloud-project-1");
  assert.equal(requests[0].payload.localProjectId, project.id);
  assert.equal(requests[0].payload.upserts[0].localIssueId, localIssueId);
  // 上行的 input 中 projectId 必须换成云端项目 ID
  assert.equal(requests[0].payload.upserts[0].input.projectId, "cloud-project-1");

  // 回写后 issue 已 synced,二次运行无 pending(防回环)
  const second = await engine.run();
  assert.equal(second.attempted, 0);
});

test("DesktopCloudSyncEngine skips disabled bindings and offline client", async (t) => {
  const app = createTempApp(t);
  const user = currentUser();
  const project = createLocalDesktopProject(app, user, { name: "停用项目" }).project;
  applyDesktopKanbanCloudSnapshot(app, user, {
    boardId: "default",
    projectId: "cloud-project-2",
    revision: 1,
    complete: false,
    scope: "project",
    projects: [],
    projectBindings: [
      {
        id: "pbind-2",
        projectId: "cloud-project-2",
        deviceId: "device-1",
        localProjectId: project.id,
        localDisplayName: project.name,
        syncPolicy: "all",
        controlMode: "disabled",
        status: "active",
        lastRemoteRevision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    issues: []
  });
  createPrivateDesktopKanbanIssue(app, user, { title: "不应上行", projectId: project.id });

  const requests = [];
  const engine = new DesktopCloudSyncEngine({
    app,
    getCurrentUser: () => user,
    getDeviceId: () => "device-1",
    wsClient: {
      isOpen: () => true,
      request: async (op, payload) => {
        requests.push({ op, payload });
        return { ok: true, revision: 2, results: [] };
      }
    }
  });
  t.after(() => engine.stop());

  const result = await engine.run();
  assert.equal(result.attempted, 0);
  assert.equal(requests.length, 0);

  const offlineEngine = new DesktopCloudSyncEngine({
    app,
    getCurrentUser: () => user,
    getDeviceId: () => "device-1",
    wsClient: {
      isOpen: () => false,
      request: async () => {
        throw new Error("unreachable");
      }
    }
  });
  t.after(() => offlineEngine.stop());
  const offlineResult = await offlineEngine.run();
  assert.equal(offlineResult.ok, false);
});
