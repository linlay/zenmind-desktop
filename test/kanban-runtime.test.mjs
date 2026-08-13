import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DESKTOP_KANBAN_REMOTE_START_ACK_TIMEOUT_MS = "20";

const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
const { KanbanRuntime, readKanbanSettings, readKanbanWsConfig } = await import("../dist-electron/main/kanban-runtime.js");
const { readDesktopSsoSiteTokenFile } = await import("../dist-electron/main/sso-site-token.js");
const {
  listDesktopKanbanRunEvents,
  recordDesktopKanbanCommandReceipt,
  updateDesktopKanbanCommandReceipt,
} = await import("../dist-electron/main/kanban-local-store.js");

function createTempApp(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-kanban-runtime-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      if (name === "appData") {
        return path.join(tempRoot, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return app;
}

function desktopRoot(app) {
  return path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function runtimeRoot(app) {
  return path.join(app.getPath("home"), APP_BRAND.paths.runtimeRootDirName);
}

function writeKanbanConfig(app, config) {
  const configPath = path.join(desktopRoot(app), "config", "desktop", "kanban.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writeDesktopConfig(app, fileName, value) {
  const configPath = path.join(desktopRoot(app), "config", "desktop", fileName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return configPath;
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createSiteJwt(payload = {}) {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart({
    sub: "user-1",
    name: "Lin Lay",
    email: "lin@example.test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload
  })}.signature`;
}

function writeSsoSiteToken(app, payload = {}, options = {}) {
  const token = options.token || createSiteJwt(payload);
  const fieldName = options.fieldName || "accessToken";
  const tokenPath = path.join(desktopRoot(app), "secrets", "sso-site-token.json");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${JSON.stringify({ [fieldName]: token }, null, 2)}\n`, "utf8");
  return token;
}

test("Kanban websocket config requires remote control and sso site token", (t) => {
  const app = createTempApp(t);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080"
  });
  assert.equal(readKanbanWsConfig(app), null);

  writeKanbanConfig(app, {
    serverUrl: "http://127.0.0.1:8080",
    remoteControlEnabled: true
  });
  assert.equal(readKanbanWsConfig(app), null);

  const token = writeSsoSiteToken(app);
  assert.deepEqual(readKanbanWsConfig(app), {
    serverUrl: "http://127.0.0.1:8080",
    token,
    selectedProjectId: "default"
  });

  process.env.DESKTOP_KANBAN_TOKEN = "env-token";
  t.after(() => {
    delete process.env.DESKTOP_KANBAN_TOKEN;
  });
  assert.deepEqual(readKanbanWsConfig(app), {
    serverUrl: "http://127.0.0.1:8080",
    token: "env-token",
    selectedProjectId: "default"
  });
});

test("desktop sso site token helper reads claims and rejects bad tokens", (t) => {
  const app = createTempApp(t);

  const token = writeSsoSiteToken(app, { sub: "user-2", name: "User Two", email: "user2@example.test" }, { fieldName: "access_token" });
  const record = readDesktopSsoSiteTokenFile(app);
  assert.equal(record.token, token);
  assert.equal(record.user.sub, "user-2");
  assert.equal(record.user.name, "User Two");
  assert.equal(record.user.email, "user2@example.test");

  writeSsoSiteToken(app, {}, { token: "not-a-jwt" });
  assert.equal(readDesktopSsoSiteTokenFile(app), null);

  writeSsoSiteToken(app, { exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal(readDesktopSsoSiteTokenFile(app), null);
});

test("Kanban server URL preserves explicit disabled setting", (t) => {
  const app = createTempApp(t);

  writeKanbanConfig(app, {
    schemaVersion: 1,
    enabled: false,
    cloud: {
      serverUrl: "http://47.90.247.3",
      token: "",
      selectedProjectId: "default",
      remoteControlEnabled: true,
      deviceAlias: "家林"
    }
  });

  assert.equal(readKanbanSettings(app).enabled, false);
  assert.equal(readKanbanWsConfig(app), null);

  const configPath = path.join(desktopRoot(app), "config", "desktop", "kanban.json");
  const migrated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(migrated.enabled, false);
  assert.equal("selectedProjectId" in migrated.cloud, false);
});

test("Kanban settings read and save enabled plus cloud config", (t) => {
  const app = createTempApp(t);
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  try {
    const initial = runtime.getSettings();
    assert.equal(initial.ok, true);
    assert.equal(initial.settings.enabled, false);
    assert.deepEqual(initial.settings.cloud, {
      serverUrl: "",
      token: "",
      remoteControlEnabled: false,
      deviceAlias: ""
    });

    const serverOnly = runtime.saveSettings({
      enabled: true,
      cloud: {
        serverUrl: "http://127.0.0.1:3000",
        remoteControlEnabled: true,
        deviceAlias: "桌面 A"
      }
    });
    assert.equal(serverOnly.settings.enabled, true);
    assert.equal(serverOnly.settings.cloud.serverUrl, "http://127.0.0.1:3000");
    assert.equal(serverOnly.settings.cloud.token, "");
    assert.equal(serverOnly.connectionState, "auth_required");
    assert.equal(readKanbanSettings(app).enabled, true);

    const saved = runtime.saveSettings({
      enabled: true,
      cloud: {
        serverUrl: "http://127.0.0.1:3000",
        token: "secret",
        remoteControlEnabled: true,
        deviceAlias: "桌面 A"
      }
    });
    assert.equal(saved.settings.enabled, true);
    assert.equal(saved.settings.cloud.serverUrl, "http://127.0.0.1:3000");
    assert.equal(saved.settings.cloud.token, "secret");
    assert.equal(saved.connectionState, "auth_required");
    assert.equal(readKanbanSettings(app).enabled, true);
  } finally {
    runtime.stop();
  }
});

test("Kanban runtime reports sign-in required when SSO credentials are unavailable", (t) => {
  const app = createTempApp(t);
  writeKanbanConfig(app, {
    schemaVersion: 1,
    enabled: true,
    cloud: {
      serverUrl: "https://kanban.example.test",
      remoteControlEnabled: true
    }
  });
  writeSsoSiteToken(app);

  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    canUseDesktopSsoCredentials: () => false,
    onChanged: () => {}
  });

  try {
    assert.equal(runtime.getSettings().connectionState, "auth_required");
    assert.equal(runtime.getCloudConfig().connectionState, "auth_required");
    assert.equal(runtime.listIssues().connectionState, "auth_required");
  } finally {
    runtime.stop();
  }
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

test("Kanban navigation push updates Local Issues only for the exact active runId", async (t) => {
  const app = createTempApp(t);
  let changedCount = 0;
  const debugMessages = [];
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "unused", chatId: "unused", message: "started" }),
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => { changedCount += 1; },
    onDebug: (message) => debugMessages.push(message),
  });
  t.after(() => runtime.stop());

  const cases = [
    { suffix: "completed", status: "completed", finishReason: "complete", expectedStatus: "completed", expectedRunState: "completed" },
    { suffix: "failed", status: "failed", finishReason: "error", expectedStatus: "todo", expectedRunState: "failed" },
    { suffix: "cancelled", status: "interrupted", finishReason: "cancel", expectedStatus: "todo", expectedRunState: "cancelled" },
  ];
  for (const item of cases) {
    const created = await runtime.createIssue({ title: `Local ${item.suffix}`, status: "todo" });
    const runId = `run-${item.suffix}`;
    await runtime.updateIssue(created.issue.id, {
      status: "in_progress",
      chatId: "shared-chat",
      runId,
      runState: "running",
    });
    const beforeStartedPush = changedCount;
    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.started",
      chatId: "shared-chat",
      runId,
      status: null,
      finishReason: null,
      startedAt: 1_783_000_000_000,
    });
    assert.equal(changedCount, beforeStartedPush + 1);

    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.activity",
      chatId: "shared-chat",
      runId,
      status: "completed",
      finishReason: "complete",
      finishedAt: 1_783_000_000_001,
    });
    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.finished",
      chatId: "shared-chat",
      runId: `old-${runId}`,
      status: "completed",
      finishReason: "complete",
      finishedAt: 1_783_000_000_002,
    });
    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.finished",
      chatId: "shared-chat",
      runId,
      status: item.status,
      finishReason: item.status === "completed" ? "error" : null,
      finishedAt: 1_783_000_000_003,
    });
    let issue = runtime.listIssues().issues.find((candidate) => candidate.id === created.issue.id);
    assert.equal(issue.status, "in_progress");
    assert.equal(issue.runState, "running");
    assert.equal(issue.runId, runId);

    const beforeAcceptedPush = changedCount;
    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.finished",
      chatId: "shared-chat",
      runId,
      status: item.status,
      finishReason: item.finishReason,
      finishedAt: 1_783_000_000_004,
    });
    issue = runtime.listIssues().issues.find((candidate) => candidate.id === created.issue.id);
    assert.equal(issue.status, item.expectedStatus);
    assert.equal(issue.runState, item.expectedRunState);
    assert.equal(issue.runId, null);
    assert.equal(changedCount, beforeAcceptedPush + 1);

    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.finished",
      chatId: "shared-chat",
      runId,
      status: item.status,
      finishReason: item.finishReason,
      finishedAt: 1_783_000_000_004,
    });
    assert.equal(changedCount, beforeAcceptedPush + 1);
  }
  assert.ok(debugMessages.some((message) => message.includes("ignored invalid navigation push")));
  assert.ok(debugMessages.some((message) => message.includes("ignored invalid run.finished protocol")));
});

test("Kanban navigation push queues Cloud Issue terminals without changing the cached workflow state", async (t) => {
  const app = createTempApp(t);
  writeSsoSiteToken(app);
  const currentUser = { id: "user-1", name: "Lin Lay", email: "lin@example.test", source: "sso" };
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "unused", chatId: "unused", message: "started" }),
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {},
  });
  t.after(() => runtime.stop());

  const terminals = [
    { status: "completed", finishReason: "complete", eventType: "run.completed" },
    { status: "failed", finishReason: "error", eventType: "run.failed" },
    { status: "interrupted", finishReason: "cancel", eventType: "run.cancelled" },
  ];
  for (const [index, terminal] of terminals.entries()) {
    const issueId = `CLOUD-${index + 1}`;
    const receiptResult = recordDesktopKanbanCommandReceipt(app, currentUser, {
      commandId: `command-${index + 1}`,
      deliverySeq: index + 1,
      projectId: "project-1",
      sourceRevision: index + 1,
      payload: { issueRunId: `issue-run-${index + 1}`, agentKey: "coder" },
      issue: {
        id: issueId,
        boardId: "default",
        projectId: "project-1",
        workflowId: "workflow-standard-requirement",
        title: `Cloud ${index + 1}`,
        description: "Server-authoritative state",
        status: "in_progress",
        priority: "P2",
        severity: "medium",
        position: index + 1,
        revision: index + 1,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
    });
    const { runId, chatId } = receiptResult.receipt;
    runtime.sendNavigationPushEvent({
      frame: "push",
      type: "run.finished",
      chatId,
      runId,
      status: terminal.status,
      finishReason: terminal.finishReason,
      finishedAt: 1_783_000_000_100 + index,
    });
    await waitFor(
      () => listDesktopKanbanRunEvents(app, currentUser).some((event) => event.runId === runId && event.eventType === terminal.eventType),
      terminal.eventType,
    );
    const cachedIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === issueId);
    assert.equal(cachedIssue.status, "in_progress");
  }
});

function respondOk(socket, request, payload) {
  socket.onmessage({
    data: JSON.stringify({
      v: request.v,
      frame: "response",
      id: request.id,
      type: request.type,
      ok: true,
      payload
    })
  });
}

async function respondNextRequest(socket, type, payload, fromIndex = 0, timeoutMs = 3000) {
  await waitFor(() => socket.sent.slice(fromIndex).some((frame) => frame.type === type), type, timeoutMs);
  const request = socket.sent.slice(fromIndex).find((frame) => frame.type === type);
  respondOk(socket, request, payload);
  return request;
}

test("Kanban runtime atomically claims and starts a normal Chat run through v4", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });

  const app = createTempApp(t);
  const starts = [];
  const stopped = [];
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "Code Assistant" }],
      startRun: async (request) => {
        starts.push(request);
        return { ok: true, runId: request.runId, chatId: request.chatId, message: "started" };
      },
      stopRun: async (runId) => {
        stopped.push(runId);
        return { ok: true, message: "stopped" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });
  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "手动运行测试"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.hello"), "sync.hello", 3000);
  const hello = socket.sent.find((frame) => frame.type === "sync.hello");
  assert.equal(hello.payload.contractVersion, "4.0");
  respondOk(socket, hello, {
    ok: true,
    contractVersion: "4.0",
    capabilities: ["issue.claim", "issue.run.prepare", "run.event.append"],
    cursor: { lastAckedDeliverySeq: 0, lastAppliedRevision: 12, cacheSchemaVersion: 2 },
    links: []
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === "snapshot.get"), "snapshot.get", 3000);
  const snapshot = socket.sent.find((frame) => frame.type === "snapshot.get");
  const cloudIssue = {
    id: "ISS-MANUAL-1",
    projectId: "default",
    workflowId: "workflow-standard-story",
    title: "Desktop manual issue",
    description: "Use the normal chat pipeline",
    status: "todo",
    priority: "P2",
    severity: "medium",
    position: 1,
    revision: 12,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
  respondOk(socket, snapshot, {
    ok: true,
    projectId: "default",
    projectIds: ["default"],
    scope: "project_set",
    complete: true,
    revision: 12,
    lastSeq: 12,
    issues: [cloudIssue]
  });
  await waitFor(() => runtime.listIssues().issues.some((issue) => issue.remoteIssueId === cloudIssue.id), "cloud issue cache", 3000);
  assert.deepEqual(runtime.listIssues().cloudCapabilities, ["issue.claim", "run.event.append"]);

  const localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === cloudIssue.id);
  const claimPromise = runtime.claimIssue(localIssue.id);
  await waitFor(() => socket.sent.some((frame) => frame.type === "issue.claim"), "issue.claim", 3000);
  const claim = socket.sent.find((frame) => frame.type === "issue.claim");
  assert.deepEqual(claim.payload, { id: cloudIssue.id, baseIssueRevision: 12 });
  assert.equal("ownerUserId" in claim.payload, false);
  respondOk(socket, claim, { ok: true, revision: 13, issue: { ...cloudIssue, assigneeId: "user-1", revision: 13 } });
  assert.equal((await claimPromise).ok, true);

  const claimedIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === cloudIssue.id);
  const runPromise = runtime.runIssue({ issueId: claimedIssue.id, agentKey: "codeAssistant" });
  await waitFor(() => socket.sent.some((frame) => frame.type === "issue.run.prepare"), "issue.run.prepare", 3000);
  const prepared = socket.sent.find((frame) => frame.type === "issue.run.prepare");
  respondOk(socket, prepared, { ok: true, issueRun: { id: "issue-run-manual-1" } });
  await waitFor(() => socket.sent.some((frame) => frame.type === "run.event.append"), "run.event.append", 3000);
  const started = socket.sent.find((frame) => frame.type === "run.event.append");
  assert.equal(started.payload.eventType, "run.started");
  assert.equal(started.payload.payload.source, "desktop_manual");
  assert.equal(started.payload.payload.agentKey, "codeAssistant");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].runId, started.payload.externalRunId);
  assert.equal(starts[0].chatId, started.payload.chatId);
  assert.equal(starts[0].requestId, started.payload.externalRunId);
  respondOk(socket, started, { ok: true, revision: 14 });
  const runResult = await runPromise;
  assert.equal(runResult.ok, true);
  assert.equal(runResult.runId, started.payload.externalRunId);
  assert.deepEqual(stopped, []);

  const conflictPromise = runtime.runIssue({ issueId: claimedIssue.id, agentKey: "codeAssistant" });
  await waitFor(() => socket.sent.filter((frame) => frame.type === "issue.run.prepare").length === 2, "conflicting issue.run.prepare", 3000);
  const conflictPrepared = socket.sent.filter((frame) => frame.type === "issue.run.prepare")[1];
  respondOk(socket, conflictPrepared, { ok: true, issueRun: { id: "issue-run-manual-2" } });
  await waitFor(() => socket.sent.filter((frame) => frame.type === "run.event.append").length === 2, "conflicting run.event.append", 3000);
  const conflictStarted = socket.sent.filter((frame) => frame.type === "run.event.append")[1];
  respondOk(socket, conflictStarted, { ok: false, message: "another Desktop already started this issue" });
  const conflictResult = await conflictPromise;
  assert.equal(conflictResult.ok, false);
  assert.deepEqual(stopped, [conflictStarted.payload.externalRunId]);

  runtime.stop();
});

test("Kanban runtime resyncs cloud board over the existing websocket", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  try {
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
    const hello = socket.sent[0];
    socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true, cursor: { lastAckedDeliverySeq: 0, lastAppliedRevision: 30, cacheSchemaVersion: 1 } } }) });
    await waitFor(() => socket.sent.length === 2, "initial snapshot request");
    const initialSnapshotRequest = socket.sent[1];
    socket.onmessage({
      data: JSON.stringify({
        v: 3,
        frame: "response",
        id: initialSnapshotRequest.id,
        type: "snapshot.get",
        ok: true,
        payload: {
          boardId: "default",
          projectId: "project-1",
          revision: 30,
          lastSeq: 30,
          complete: true,
          scope: "project",
          issues: []
        }
      })
    });
    await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", events: [], hasMore: false, lastSeq: 30, nextAfterSeq: 30 });
    await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "initial sync.pull");
    const initialPull = socket.sent.find((frame) => frame.type === "sync.pull");
    socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: initialPull.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });

    const sentBeforeResync = socket.sent.length;
    const resyncPromise = runtime.resyncCloudBoard();
    await waitFor(
      () => socket.sent.slice(sentBeforeResync).some((frame) => frame.type === "snapshot.get"),
      "resync snapshot request"
    );
    const resyncSnapshotRequest = socket.sent.slice(sentBeforeResync).find((frame) => frame.type === "snapshot.get");
    socket.onmessage({
      data: JSON.stringify({
        v: 3,
        frame: "response",
        id: resyncSnapshotRequest.id,
        type: "snapshot.get",
        ok: true,
        payload: {
          boardId: "default",
          projectId: "project-1",
          revision: 31,
          lastSeq: 31,
          complete: true,
          scope: "project",
          projects: [{ id: "project-1", name: "Project One", path: "Project One", updatedAt: "2026-06-09T00:00:00.000Z" }],
          issues: [{
            id: "ISS-RESYNC",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            title: "重新同步议题",
            description: "通过手动重新同步拉取",
            status: "todo",
            priority: "P2",
            severity: "medium",
            position: 1,
            revision: 31,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          }]
        }
      })
    });
    await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", events: [], hasMore: false, lastSeq: 31, nextAfterSeq: 31 }, sentBeforeResync);
    await waitFor(
      () => socket.sent.slice(sentBeforeResync).some((frame) => frame.type === "sync.pull"),
      "resync sync.pull"
    );
    const resyncPull = socket.sent.slice(sentBeforeResync).find((frame) => frame.type === "sync.pull");
    socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: resyncPull.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });
    const result = await resyncPromise;

    assert.equal(result.ok, true);
    assert.equal(sockets.length, 1);
    assert.ok(result.issues.some((issue) => issue.remoteIssueId === "ISS-RESYNC" && issue.title === "重新同步议题"));
    assert.ok(result.projects.some((project) => project.id === "project-1"));
  } finally {
    runtime.stop();
  }
});

test("Kanban runtime applies paged issue event pulls and tombstones deleted issues", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  try {
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
    const hello = socket.sent[0];
    respondOk(socket, hello, { ok: true, cursor: { lastAckedDeliverySeq: 0, lastAppliedRevision: 10, cacheSchemaVersion: 1 } });
    await waitFor(() => socket.sent.length === 2, "snapshot request");
    const snapshotRequest = socket.sent[1];
    respondOk(socket, snapshotRequest, {
      boardId: "default",
      projectId: "project-1",
      revision: 10,
      lastSeq: 10,
      complete: true,
      scope: "project",
      issues: []
    });

    const firstPull = await respondNextRequest(socket, "event.pull", {
      ok: true,
      projectId: "project-1",
      lastSeq: 13,
      hasMore: true,
      nextAfterSeq: 11,
      events: [{
        seq: 11,
        eventType: "issue.updated",
        projectId: "project-1",
        issueId: "ISS-PULL-1",
        issue: {
          id: "ISS-PULL-1",
          boardId: "default",
          projectId: "project-1",
          workflowId: "workflow-standard-requirement",
          title: "First pulled issue",
          description: "Will be deleted by the next page",
          status: "todo",
          priority: "P2",
          severity: "medium",
          position: 1,
          revision: 11,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        }
      }]
    });
    assert.equal(firstPull.payload.afterSeq, 10);

    await waitFor(() => socket.sent.filter((frame) => frame.type === "event.pull").length === 2, "second event.pull", 3000);
    const secondPull = socket.sent.filter((frame) => frame.type === "event.pull").at(-1);
    assert.equal(secondPull.payload.afterSeq, 11);
    respondOk(socket, secondPull, {
      ok: true,
      projectId: "project-1",
      lastSeq: 13,
      hasMore: false,
      nextAfterSeq: 13,
      events: [{
        seq: 12,
        eventType: "issue.deleted",
        projectId: "project-1",
        issueId: "ISS-PULL-1",
        deletedIssueId: "ISS-PULL-1"
      }, {
        seq: 13,
        eventType: "issue.updated",
        projectId: "project-1",
        issueId: "ISS-PULL-2",
        issue: {
          id: "ISS-PULL-2",
          boardId: "default",
          projectId: "project-1",
          workflowId: "workflow-standard-requirement",
          title: "Second pulled issue",
          description: "Survives the event pull",
          status: "in_progress",
          priority: "P1",
          severity: "medium",
          position: 2,
          revision: 13,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        }
      }]
    });
    await respondNextRequest(socket, "sync.pull", { ok: true, items: [], hasMore: false });

    const issues = runtime.listIssues().issues;
    assert.equal(issues.some((issue) => issue.remoteIssueId === "ISS-PULL-1"), false);
    const pulled = issues.find((issue) => issue.remoteIssueId === "ISS-PULL-2");
    assert.ok(pulled);
    assert.equal(pulled.title, "Second pulled issue");
    assert.equal(pulled.revision, 13);
  } finally {
    runtime.stop();
  }
});

test("Kanban runtime stores remote startRun issue locally before executing", async (t) => {
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
  const runtime = new KanbanRuntime({
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

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
  const hello = socket.sent[0];
  assert.equal(hello.payload.deviceName, "测试桌面");
  assert.equal(hello.payload.deviceAlias, "测试桌面");
  assert.equal(hello.payload.ownerUserId, "user-1");
  assert.ok(hello.payload.hostname || hello.payload.username);
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 3, frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
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
        v: 3, frame: "request",
        id: "start-run-remote",
        type: "desktop.assistant.startRun",
        boardId: "default",
        projectId: "project-1",
        revision: 31,
        payload: {
          issue: {
            id: "ISS-31",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            stageId: "workflow-stage-build",
            stageName: "构建阶段",
            statusId: "workflow-status-in-progress",
            statusName: "进行中状态",
            title: "云端执行议题",
            description: "需要同步到桌面端",
            status: "in_progress",
            priority: "P2",
            severity: "medium",
            assigneeAgentKey: "codeAssistant",
            position: 1,
            revision: 31,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          },
          agentKey: "codeAssistant",
          message: "执行云端议题"
        }
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "start-run-remote"), "remote start ACK");
    const ack = socket.sent.find((frame) => frame.id === "start-run-remote");
    assert.equal(ack.ok, true);
    assert.equal(ack.payload.runId, "run-remote-1");
    assert.equal(startRuns[0].message, "执行云端议题");
    assert.equal(startRuns[0].issue.id, "ISS-31");

    const localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-31");
    assert.ok(localIssue);
    assert.equal(localIssue.title, "云端执行议题");
    assert.equal(localIssue.stageId, "workflow-stage-build");
    assert.equal(localIssue.stageName, "构建阶段");
    assert.equal(localIssue.statusId, "workflow-status-in-progress");
    assert.equal(localIssue.statusName, "进行中状态");
    assert.equal(localIssue.origin, "cloud_dispatch");
    assert.equal(localIssue.syncMode, "cloud");
    assert.equal(localIssue.runId, "run-remote-1");
    assert.equal(localIssue.chatId, "chat-remote-1");
    assert.equal(localIssue.runState, "running");
  } finally {
    runtime.stop();
  }
});

test("Kanban runtime persists and ACKs command.runIssue before starting one stable run", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async (request) => {
        startRuns.push(request);
        return { ok: true, runId: request.runId, chatId: request.chatId, message: "started" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true, cursor: { lastAckedDeliverySeq: 0, lastAppliedRevision: 40, cacheSchemaVersion: 1 } } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
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
        revision: 40,
        lastSeq: 40,
        complete: true,
        scope: "project",
        issues: []
      }
    })
  });
  await respondNextRequest(socket, "event.pull", { ok: true, projectId: "project-1", events: [], hasMore: false, lastSeq: 40, nextAfterSeq: 40 });
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.pull"), "sync.pull");
  const pull = socket.sent.find((frame) => frame.type === "sync.pull");
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: pull.id, type: "sync.pull", ok: true, payload: { ok: true, items: [], hasMore: false } }) });

  socket.onmessage({
    data: JSON.stringify({
      v: 3,
      frame: "push",
      type: "sync.deliver",
      projectId: "project-1",
      payload: {
        items: [{
          deliveryId: 101,
          deviceId: "device-1",
          deliverySeq: 1,
          projectId: "project-1",
          kind: "command",
          commandId: "cmd-run-1",
          eventType: "command.runIssue",
          payload: {
            issueId: "ISS-V3-RUN",
            issue: {
              id: "ISS-V3-RUN",
              boardId: "default",
              projectId: "project-1",
              workflowId: "workflow-standard-requirement",
              title: "v3 可靠派发议题",
              description: "通过 delivery 执行",
              status: "in_progress",
              priority: "P2",
              severity: "medium",
              assigneeAgentKey: "codeAssistant",
              position: 1,
              revision: 40,
              createdAt: "2026-06-09T00:00:00.000Z",
              updatedAt: "2026-06-09T00:00:00.000Z"
            },
            agentKey: "codeAssistant",
            message: "执行 v3 delivery"
          }
        }]
      }
    })
  });

  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.ack"), "sync.ack", 3000);
  const ack = socket.sent.find((frame) => frame.type === "sync.ack");
  assert.equal(ack.payload.ackedDeliverySeq, 1);
  assert.equal(ack.payload.lastAppliedRevision, 40);
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: ack.id, type: "sync.ack", ok: true, payload: { ok: true, cursor: { lastAckedDeliverySeq: 1, lastAppliedRevision: 40, cacheSchemaVersion: 2 } } }) });

  await waitFor(() => socket.sent.some((frame) => frame.type === "run.event.append"), "run.event.append", 3000);
  const runEvent = socket.sent.find((frame) => frame.type === "run.event.append");
  assert.equal(runEvent.payload.sourceDeliverySeq, 1);
  assert.equal(runEvent.payload.issueId, "ISS-V3-RUN");
  assert.equal(runEvent.payload.eventType, "run.started");
  assert.match(runEvent.payload.payload.runId, /^run_kanban_/);
  assert.match(runEvent.payload.clientEventId, /:ISS-V3-RUN:run_kanban_[^:]+:run\.started$/);
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: runEvent.id, type: "run.event.append", ok: true, payload: { ok: true, revision: 41 } }) });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(startRuns.length, 1);
  assert.equal(startRuns[0].message, "执行 v3 delivery");
  assert.match(startRuns[0].runId, /^run_kanban_/);
  assert.match(startRuns[0].requestId, /^request_kanban_/);

  const localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-V3-RUN");
  assert.ok(localIssue);
  assert.match(localIssue.runId, /^run_kanban_/);
  assert.match(localIssue.chatId, /^chat_kanban_/);
  assert.equal(localIssue.runState, "running");

  runtime.stop();
});

test("Kanban runtime recovers a terminal starting receipt without launching a duplicate run", async (t) => {
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

  const app = createTempApp(t);
  const currentUser = { id: "user-1", name: "Lin Lay", email: "lin@example.test", source: "sso" };
  const issue = {
    id: "ISS-RECOVER-1",
    projectId: "default",
    workflowId: "workflow-standard-requirement",
    title: "Recover terminal run",
    description: "",
    status: "in_progress",
    priority: "P2",
    severity: "medium",
    position: 1,
    revision: 70,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
  const stored = recordDesktopKanbanCommandReceipt(app, currentUser, {
    commandId: "command-recover-1",
    deliverySeq: 1,
    projectId: "default",
    sourceRevision: 70,
    payload: { issue, agentKey: "codeAssistant", message: "recover" },
    issue
  });
  updateDesktopKanbanCommandReceipt(app, currentUser, stored.receipt.commandId, "starting", null, true);
  let startCount = 0;
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => {
        startCount += 1;
        return { ok: true, runId: stored.receipt.runId, chatId: stored.receipt.chatId, message: "started" };
      },
      getChat: async () => ({
        messages: [{ runId: stored.receipt.runId }],
        events: [{
          runId: stored.receipt.runId,
          seq: 9,
          type: "run.complete",
          status: "ok",
          message: "already completed"
        }]
      })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });
  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "恢复测试"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.some((frame) => frame.type === "sync.hello"), "sync.hello", 3000);
  const hello = socket.sent.find((frame) => frame.type === "sync.hello");
  respondOk(socket, hello, { ok: true, cursor: { lastAckedDeliverySeq: 1, lastAppliedRevision: 70, cacheSchemaVersion: 2 }, links: [] });
  await waitFor(() => socket.sent.some((frame) => frame.type === "snapshot.get"), "snapshot.get", 3000);
  const snapshot = socket.sent.find((frame) => frame.type === "snapshot.get");
  respondOk(socket, snapshot, {
    ok: true,
    projectId: "",
    projectIds: ["default"],
    scope: "project_set",
    complete: true,
    revision: 70,
    lastSeq: 70,
    projects: [],
    issues: [issue]
  });
  await respondNextRequest(socket, "event.pull", { ok: true, projectIds: ["default"], events: [], hasMore: false, lastSeq: 70, nextAfterSeq: 70 });
  await respondNextRequest(socket, "sync.pull", { ok: true, items: [], hasMore: false });
  await waitFor(() => socket.sent.some((frame) => frame.type === "run.event.append"), "recovered terminal event", 3000);
  const terminal = socket.sent.find((frame) => frame.type === "run.event.append");
  assert.equal(terminal.payload.eventType, "run.completed");
  assert.match(terminal.payload.clientEventId, new RegExp(`:ISS-RECOVER-1:${stored.receipt.runId}:run\\.completed$`));
  assert.equal(startCount, 0);
  respondOk(socket, terminal, { ok: true, revision: 71 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.stop();
});

test("Kanban runtime stores cloud dispatch issue without auto-starting", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async (request) => {
        startRuns.push(request);
        return { ok: true, runId: "run-dispatch-1", chatId: "chat-dispatch-1", message: "started" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "测试桌面"
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 3, frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
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
        v: 3, frame: "request",
        id: "dispatch-run",
        type: "desktop.issue.dispatch",
        boardId: "default",
        projectId: "project-1",
        revision: 32,
        payload: {
          issue: {
            id: "ISS-DISPATCH",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            title: "旧派发协议待本机确认",
            description: "云端派发只展示议题，本机人员拖到进行中后才执行",
            status: "todo",
            priority: "P2",
            severity: "medium",
            assigneeAgentKey: "codeAssistant",
            position: 1,
            revision: 32,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          },
          agentKey: "codeAssistant",
          accessLevel: "full_access",
          message: "执行旧派发议题"
        }
      })
    });

    await waitFor(() => socket.sent.some((frame) => frame.id === "dispatch-run"), "dispatch ACK");
    const ack = socket.sent.find((frame) => frame.id === "dispatch-run");
    assert.equal(ack.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(startRuns.length, 0);

    const localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-DISPATCH");
    assert.ok(localIssue);
    assert.equal(localIssue.status, "todo");
    assert.equal(localIssue.origin, "cloud_dispatch");
    assert.equal(localIssue.syncMode, "cloud");
    assert.equal(localIssue.assigneeAgentKey, "codeAssistant");
    assert.equal(localIssue.runId, null);
    assert.equal(localIssue.chatId, null);
    assert.equal(localIssue.runState, null);
  } finally {
    runtime.stop();
  }
});

test("Kanban runtime reconnects after saving device alias so cloud sees new device name", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "旧设备名"
  });

  const firstSocket = sockets[0];
  firstSocket.readyState = 1;
  firstSocket.onopen();
  await waitFor(() => firstSocket.sent.length === 1, "initial sync.hello", 3000);
  const firstHello = firstSocket.sent[0];
  assert.equal(firstHello.payload.deviceName, "旧设备名");
  firstSocket.onmessage({
    data: JSON.stringify({ v: 3, frame: "response", id: firstHello.id, type: "sync.hello", ok: true, payload: { ok: true } })
  });
  await waitFor(() => firstSocket.sent.length === 2, "initial snapshot request", 3000);

  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true,
    deviceAlias: "牛家林"
  });

  await waitFor(() => sockets.length === 2, "reconnect after device alias save", 3000);
  assert.equal(firstSocket.closed, true);
  const secondSocket = sockets[1];
  secondSocket.readyState = 1;
  secondSocket.onopen();
  await waitFor(() => secondSocket.sent.length === 1, "updated sync.hello", 3000);
  const secondHello = secondSocket.sent[0];
  assert.equal(secondHello.payload.deviceName, "牛家林");
  assert.equal(secondHello.payload.deviceAlias, "牛家林");
  assert.equal(secondHello.payload.ownerUserId, "user-1");

  writeDesktopConfig(app, "profile.json", {
    schemaVersion: 1,
    general: {
      deviceName: "全局桌面",
      preventSleepWhileRunning: true,
      desktopWsServerEnabled: false
    }
  });
  runtime.refreshDeviceInfo();
  await waitFor(() => sockets.length === 3, "reconnect after global device name save", 3000);
  assert.equal(secondSocket.closed, true);
  const thirdSocket = sockets[2];
  thirdSocket.readyState = 1;
  thirdSocket.onopen();
  await waitFor(() => thirdSocket.sent.length === 1, "global device name sync.hello", 3000);
  const thirdHello = thirdSocket.sent[0];
  assert.equal(thirdHello.payload.deviceName, "全局桌面");
  assert.equal(thirdHello.payload.deviceAlias, "全局桌面");
  assert.equal(thirdHello.payload.ownerUserId, "user-1");
  runtime.stop();
});

test("Kanban runtime ACKs slow remote startRun before bridge resolves", async (t) => {
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
  let resolveSlowStartRun = () => {};
  const slowStartRunGate = new Promise((resolve) => {
    resolveSlowStartRun = resolve;
  });
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [{ agentKey: "codeAssistant", displayName: "小君" }],
      startRun: async (request) => {
        startRuns.push(request);
        await slowStartRunGate;
        return { ok: true, runId: "run-slow-1", chatId: request.chatId, message: "started" };
      }
    },
    callAgentPlatform: async () => ({ ok: true }),
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");
  const snapshotRequest = socket.sent[1];
  socket.onmessage({
    data: JSON.stringify({
      v: 3, frame: "response",
      id: snapshotRequest.id,
      type: "snapshot.get",
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
        v: 3, frame: "request",
        id: "start-run-slow",
        type: "desktop.assistant.startRun",
        boardId: "default",
        projectId: "project-1",
        revision: 31,
        payload: {
          issue: {
            id: "ISS-SLOW",
            boardId: "default",
            projectId: "project-1",
            workflowId: "workflow-standard-requirement",
            title: "慢启动云端议题",
            description: "需要先 ACK",
            status: "in_progress",
            priority: "P2",
            severity: "medium",
            assigneeAgentKey: "codeAssistant",
            position: 1,
            revision: 31,
            createdAt: "2026-06-09T00:00:00.000Z",
            updatedAt: "2026-06-09T00:00:00.000Z"
          },
          agentKey: "codeAssistant",
          message: "执行慢启动议题"
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

    resolveSlowStartRun();
    await waitFor(() => {
      const issue = runtime.listIssues().issues.find((item) => item.remoteIssueId === "ISS-SLOW");
      return issue?.runId === "run-slow-1";
    }, "background bridge result", 1000);
    localIssue = runtime.listIssues().issues.find((issue) => issue.remoteIssueId === "ISS-SLOW");
    assert.equal(localIssue.runId, "run-slow-1");
    assert.equal(localIssue.chatId, ack.payload.chatId);
    assert.equal(startRuns[0].chatId, ack.payload.chatId);
  } finally {
    resolveSlowStartRun();
    runtime.stop();
  }
});

test("Kanban runtime falls back to local agents for remote listAgents", async (t) => {
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
  const runtime = new KanbanRuntime({
    app,
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    callAgentPlatform: async () => ({ ok: true }),
    listLocalAgents: () => [{ agentKey: "cutej", displayName: "小君", role: "桌面智能体", unreadCount: 0 }],
    onChanged: () => {}
  });

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await waitFor(() => socket.sent.length === 1, "sync.hello");
  const hello = socket.sent[0];
  socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });
  await waitFor(() => socket.sent.length === 2, "snapshot request");

  try {
    socket.onmessage({
      data: JSON.stringify({
        v: 3, frame: "request",
        id: "list-agents-local",
        type: "agent.listDesktop",
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

test("Kanban runtime lists installed agents when platform listAgents times out", async (t) => {
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
  const agentsRoot = path.join(runtimeRoot(app), "agents");
  fs.mkdirSync(path.join(agentsRoot, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "bootstrap", "agent.yml"), "key: bootstrap\nname: 初始化\nrole: 初次引导配置\n", "utf8");
  fs.mkdirSync(path.join(agentsRoot, "cutej"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "cutej", "agent.yml"), "key: cutej\nname: 小君\nrole: 平台总管\n", "utf8");
  fs.mkdirSync(path.join(agentsRoot, "cutej.bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "cutej.bootstrap", "agent.yml"), "key: cutej\nname: 小君 Bootstrap\nrole: 重复配置\n", "utf8");
  const debugMessages = [];
  let platformListAgentsCalled = false;
  const runtime = new KanbanRuntime({
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

  writeSsoSiteToken(app);
  runtime.saveCloudConfig({
    serverUrl: "http://127.0.0.1:3000",
    token: "secret",
    remoteControlEnabled: true
  });

  const socket = sockets[0];
  try {
    socket.readyState = 1;
    socket.onopen();
    await waitFor(() => socket.sent.length === 1, "sync.hello", 3000);
    const hello = socket.sent[0];
    socket.onmessage({ data: JSON.stringify({ v: 3, frame: "response", id: hello.id, type: "sync.hello", ok: true, payload: { ok: true } }) });

    socket.onmessage({
      data: JSON.stringify({
        v: 3, frame: "request",
        id: "list-agents-timeout",
        type: "agent.listDesktop",
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
