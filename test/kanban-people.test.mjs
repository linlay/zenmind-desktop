import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/renderer/pages/kanban/KanbanPage.tsx", "utf8");
const ast = ts.createSourceFile("KanbanPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["shouldShowIssueForAssigneeFilters", "getIssueCardWorkerPresentation", "getIssueCardPeoplePresentation"];
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
const context = {
  React: { createElement: () => null }, UserOutlined: "user", RobotOutlined: "robot",
  getAssigneeName: (key, agents) => agents.find((agent) => agent.agentKey === key)?.displayName || key,
  formatKanbanPersonLabel: (label) => label
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 }
}).outputText, context);

test("local ownership is self regardless of login or cloud assignee fields", () => {
  for (const currentUserId of ["", "me", "other-account"]) {
    for (const assigneeId of [null, "me", "someone-else"]) {
      const issue = { syncMode: "local", assigneeId };
      assert.equal(context.shouldShowIssueForAssigneeFilters(issue, currentUserId, ["self"]), true);
      assert.equal(context.shouldShowIssueForAssigneeFilters(issue, currentUserId, ["others", "unassigned"]), false);
      assert.equal(context.shouldShowIssueForAssigneeFilters(issue, currentUserId, []), false);
    }
  }
});

test("cloud ownership still distinguishes self, others and unassigned", () => {
  for (const [assigneeId, category] of [[null, "unassigned"], ["me", "self"], ["other", "others"]]) {
    for (const filter of ["self", "others", "unassigned"]) {
      assert.equal(context.shouldShowIssueForAssigneeFilters({ syncMode: "cloud", assigneeId }, "me", [filter]), filter === category);
    }
  }
});

test("local cards show only the explicit executor and never add the owner", () => {
  const agents = [{ agentKey: "cutej", displayName: "小君" }];
  const t = (key) => key === "kanban.searchFilter.assigneeSelf" ? "自己" : key;
  for (const status of ["backlog", "todo", "in_progress", "done"]) {
    const local = { syncMode: "local", status, assigneeId: "me" };
    const agent = context.getIssueCardPeoplePresentation({ ...local, workerType: "agent", workerAgent: "cutej" }, agents, [], t);
    assert.equal(agent.people.length, 1);
    assert.equal(agent.people[0].label, "小君");
    assert.equal(agent.people[0].kind, "worker");
    const human = context.getIssueCardPeoplePresentation({ ...local, workerType: "human" }, agents, [], t);
    assert.equal(human.people.length, 1);
    assert.equal(human.people[0].label, "自己");
    assert.equal(human.people[0].kind, "worker");
    assert.equal(context.getIssueCardPeoplePresentation(local, agents, [], t).people.length, 0);
  }
});
