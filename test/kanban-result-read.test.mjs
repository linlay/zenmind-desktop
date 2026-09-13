import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { resolveKanbanResultIdentity: identity } = require("../dist-electron/shared/kanban-result-read.js");
const { registerKanbanIpcHandlers } = require("../dist-electron/main/modules/kanban/ipc.js");
const { createKanbanResultReadStore, kanbanReadScope, kanbanReadScopeToken } = require("../dist-electron/main/modules/kanban/result-read-store.js");
const issue = (extra = {}) => ({ id: "issue-a", syncMode: "local", status: "completed", chatId: "chat-a", runId: "run-1", runState: "completed", updatedAt: "2026-09-13T01:00:00.000Z", ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-result-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: (name) => name === "home" ? root : path.join(root, name) };
  let result = { ok: true, issues: [issue()], currentUser: { id: "user-a" } };
  const calls = [];
  let call = async (app, url, options) => { calls.push({ url, ...options }); return { chatId: options.body.chatId, read: { isRead: true, readRunId: options.body.runId } }; };
  const handlers = new Map();
  registerKanbanIpcHandlers({ handle: (name, fn) => handlers.set(name, fn) }, { app, listKanbanIssues: () => result, callAgentPlatform: (...args) => call(...args) });
  return { app, calls, handlers, get: () => result, set: (next) => { result = next; }, fail: () => { call = async () => { throw new Error("offline"); }; }, caller: (fn) => { call = fn; }, read: (key = identity(result.issues[0], result.cloudDetails).key) => handlers.get("kanban.markResultRead")({}, { issueId: "issue-a", key, scope: kanbanReadScopeToken(kanbanReadScope(app, result)) }) };
}

test("only final Flow completion and free completion produce a reading identity", () => {
  assert.equal(identity(issue({ status: "in_review" })), null);
  assert.equal(identity(issue({ runState: "running" })), null);
  const localWorkflow = { stages: [{ id: "a" }, { id: "b" }] };
  assert.equal(identity(issue({ localWorkflow, stageId: "a" })), null);
  assert.ok(identity(issue({ localWorkflow, stageId: "b" })));
  assert.notEqual(identity(issue()).key, identity(issue({ runId: "run-2" })).key);
  assert.equal(identity(issue()).key, identity(issue({ title: "renamed", updatedAt: "later" })).key);
});

test("reading posts the exact Chat and Run once and persists across store instances", async (t) => {
  const f = fixture(t);
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
  assert.equal((await f.read()).ok, true);
  assert.equal((await f.read()).ok, true);
  assert.deepEqual(f.calls, [{ url: "/api/read", method: "POST", body: { chatId: "chat-a", runId: "run-1" } }]);
  assert.equal(createKanbanResultReadStore(f.app, JSON.stringify(["user-a", ""])).has("issue-a", identity(issue()).key), true);
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, true);
  f.set({ ...f.get(), issues: [issue({ runId: "run-2" })] });
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
  await f.read();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.runId, "run-2");
});

test("failed requests and stale reading keys do not record success", async (t) => {
  const f = fixture(t);
  assert.equal((await f.read("stale")).ok, false);
  assert.equal(f.calls.length, 0);
  f.fail();
  assert.equal((await f.read()).ok, false);
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
});

test("results without Chats record local reading without Platform requests", async (t) => {
  const f = fixture(t);
  f.set({ ...f.get(), issues: [issue({ chatId: null, runId: null })] });
  assert.equal((await f.read()).ok, true);
  assert.equal(f.calls.length, 0);
});

test("inflight reading deduplicates and cannot acknowledge a newer Run", async (t) => {
  const f = fixture(t);
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  f.caller(async () => { requests++; return response; });
  const first = f.read();
  const second = f.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  f.set({ ...f.get(), issues: [issue({ runId: "run-2" })] });
  release({ chatId: "chat-a", read: { readRunId: "run-1" } });
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
});

test("reading receipts are isolated by account", async (t) => {
  const f = fixture(t);
  await f.read();
  f.set({ ...f.get(), currentUser: { id: "user-b" } });
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
});

function cloudSnapshot(deviceId = "other-device") {
  return {
    ok: true, currentUser: { id: "user-a" },
    issues: [issue({ syncMode: "cloud", remoteIssueId: "remote-a", stageId: "stage-end", statusId: "status-end" })],
    cloudDetails: {
      workflowStages: [{ id: "stage-end", isEnd: true }],
      workflowStatuses: [{ id: "status-end", isTerminal: true }],
      issueRuns: [{ id: "issue-run", issueId: "remote-a", issueChatId: "issue-chat", deviceId, externalRunId: "run-1", state: "completed", createdAt: "2026-09-13T01:00:00.000Z" }],
      issueChats: [{ id: "issue-chat", issueId: "remote-a", deviceId, chatId: "chat-a" }]
    }
  };
}

test("cloud terminal metadata and device ownership control the exact read target", async (t) => {
  const f = fixture(t);
  const snapshot = cloudSnapshot();
  assert.equal(identity(snapshot.issues[0], { ...snapshot.cloudDetails, workflowStages: [{ id: "stage-end", isEnd: false }] }), null);
  assert.equal(identity(snapshot.issues[0], { ...snapshot.cloudDetails, workflowStatuses: [{ id: "status-end", isTerminal: false }] }), null);
  f.set(snapshot);
  assert.equal((await f.read()).ok, false);
  assert.equal(f.calls.length, 0);
  const { getDesktopDeviceId } = require("../dist-electron/main/modules/identity/index.js");
  f.set(cloudSnapshot(getDesktopDeviceId(f.app)));
  assert.equal((await f.read()).ok, true);
  assert.deepEqual(f.calls[0].body, { chatId: "chat-a", runId: "run-1" });
});

test("a mismatched Platform read response does not acknowledge the result", async (t) => {
  const f = fixture(t);
  f.caller(async () => ({ chatId: "chat-a", read: { readRunId: "run-other" } }));
  assert.equal((await f.read()).ok, false);
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
});

test("server changes isolate receipts even for the same account and issue", async (t) => {
  const f = fixture(t);
  const previous = process.env.DESKTOP_KANBAN_SERVER_URL;
  t.after(() => { if (previous === undefined) delete process.env.DESKTOP_KANBAN_SERVER_URL; else process.env.DESKTOP_KANBAN_SERVER_URL = previous; });
  process.env.DESKTOP_KANBAN_SERVER_URL = "https://server-a.example.test";
  await f.read();
  process.env.DESKTOP_KANBAN_SERVER_URL = "https://server-b.example.test";
  assert.equal((await f.handlers.get("kanban.listIssues")()).issues[0].resultRead.isRead, false);
});

test("completed local runs use retained lastRun identity after the active Run is cleared", async (t) => {
  const f = fixture(t);
  f.set({ ...f.get(), issues: [issue({ chatId: null, runId: null, activeRunId: null, lastRunChatId: "finished-chat", lastRunId: "finished-run" })] });
  assert.equal((await f.read()).ok, true);
  assert.deepEqual(f.calls[0].body, { chatId: "finished-chat", runId: "finished-run" });
});

test("a request from a previous account scope is rejected before contacting Platform", async (t) => {
  const f = fixture(t);
  const snapshot = await f.handlers.get("kanban.listIssues")();
  const { key, scope } = snapshot.issues[0].resultRead;
  f.set({ ...f.get(), currentUser: { id: "user-b" } });
  const result = await f.handlers.get("kanban.markResultRead")({}, { issueId: "issue-a", key, scope });
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 0);
});
