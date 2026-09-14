import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("Kanban registration injects the token provider into the real Platform caller", async () => {
  const registry = ts.createSourceFile("registry.ts", fs.readFileSync("src/main/app/module-registry.part-2.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let caller;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(registry) === "registerKanbanIpcHandlers") {
      caller = node.arguments[1].properties.find((property) => property.name?.getText(registry) === "callAgentPlatform");
    }
    ts.forEachChild(node, visit);
  }
  visit(registry);
  assert.ok(caller, "Kanban must register a Platform caller");
  const source = ts.createSourceFile("caller.ts", fs.readFileSync("src/main/modules/desktop-actions/runtime.part-2.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const implementation = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "callAgentPlatform");
  const reasons = [];
  const app = {};
  const context = {
    exports: {},
    options: { issueAgentAccessToken: async (targetApp, reason) => {
      assert.equal(targetApp, app);
      reasons.push(reason);
      return { ok: true, token: `test-${reason}` };
    } },
    getResponsiveServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:1234" } }),
    fetchAgentPlatformWithAuth: async (baseUrl, route, request) => {
      assert.equal(baseUrl, "http://127.0.0.1:1234");
      assert.equal(route, "/api/read");
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, { chatId: "chat-a", runId: "run-a" });
      assert.equal((await request.issueToken("missing")).token, "test-missing");
      assert.equal((await request.issueToken("unauthorized")).token, "test-unauthorized");
      return { chatId: "chat-a", read: { readRunId: "run-a" } };
    }
  };
  vm.createContext(context);
  const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compile(implementation.getText(source)), context);
  const expression = ts.isShorthandPropertyAssignment(caller) ? caller.name.getText(registry) : caller.initializer.getText(registry);
  const wired = vm.runInContext(compile(`(${expression})`), context);
  const result = await wired(app, "/api/read", { method: "POST", body: { chatId: "chat-a", runId: "run-a" } });
  assert.equal(result.read.readRunId, "run-a");
  assert.deepEqual(reasons, ["missing", "unauthorized"]);
});
