import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/renderer/pages/kanban/issueDetailHistory.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { resolveCurrentKanbanRunChat: resolve } = module.exports;
const issue = { id: "local-cache", remoteIssueId: "issue", syncMode: "cloud", stageId: "stage", activeIssueRunId: "run" };
const run = { id: "run", issueId: "issue", stageId: "stage", workerRole: "run", state: "running", deviceId: "device", issueChatId: "binding" };
const chat = { id: "binding", issueId: "issue", stageId: "stage", purpose: "run", state: "active", deviceId: "device", chatId: "chat", agentKey: "agent" };
const details = (runPatch = {}, chatPatch = {}) => ({ issueRuns: [{ ...run, ...runPatch }], issueChats: [{ ...chat, ...chatPatch }] });

test("current cloud run wins over newer reference and historical chats", () => {
  const data = details();
  data.issueChats.push({ ...chat, id: "newer", chatId: "reference", purpose: "human_reference" });
  data.issueRuns.push({ ...run, id: "old-run", issueChatId: "newer", state: "completed" });
  assert.equal(resolve(issue, data, "device").chatId, "chat");
  assert.equal(resolve(issue, data, "device").runRecordId, "run");
  assert.equal(resolve({ ...issue, activeIssueRunId: null }, data, "device"), null);
});

test("reject unavailable, foreign, review and stale-stage bindings", () => {
  for (const patch of [{ state: "completed" }, { deviceId: "other" }, { workerRole: "review" }, { stageId: "old" }, { issueId: "other" }, { issueChatId: null }]) {
    assert.equal(resolve(issue, details(patch), "device"), null, JSON.stringify(patch));
  }
  for (const patch of [{ state: "archived" }, { state: "missing" }, { deviceId: "other" }, { purpose: "human_reference" }, { stageId: "old" }, { issueId: "other" }, { agentKey: "" }]) {
    assert.equal(resolve(issue, details({}, patch), "device"), null, JSON.stringify(patch));
  }
  assert.equal(resolve(issue, details(), ""), null);
});

test("local execution uses current run identity and excludes finished or chatless runs", () => {
  const local = { syncMode: "local", runState: "running", runId: "local-run", chatId: "local-chat" };
  assert.equal(resolve(local, details(), "").chatId, "local-chat");
  assert.equal(resolve(local, details(), "").runRecordId, "run:local-run");
  assert.equal(resolve({ ...local, runId: null, activeRunId: "active" }, details(), "").runRecordId, "run:active");
  assert.equal(resolve({ ...local, runState: "completed" }, details(), ""), null);
  assert.equal(resolve({ ...local, chatId: null }, details(), ""), null);
  assert.equal(resolve({ ...local, runId: null }, details(), ""), null);
});
