import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const filename = "src/main/app/assembly/identity.ts";
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const implementation = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "createDesktopSsoTokenRefresher");
assert.ok(implementation);
const compiled = ts.transpileModule(implementation.getText(source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: repeated business 401 renewals preserve the healthy IM connection and conversation`, async () => {
    const context = {
      exports: {}, app: { platform },
      desktopSsoIdTokenNeedsRefresh: () => false,
      safeConsoleError: (...args) => assert.fail(String(args))
    };
    vm.runInNewContext(compiled, context);
    const chat = { connectionState: "connected", activeConversationId: "direct-employee", draft: "hello" };
    let renewals = 0;
    let kanbanRefreshes = 0;
    let chatRefreshes = 0;
    const refresh = context.exports.createDesktopSsoTokenRefresher({
      desktopSsoController: {
        retryDesktopSsoSessionRestoreIfNeeded: async () => ({ state: "authenticated" }),
        ensureBusinessToken: async force => {
          assert.equal(force, true);
          return `renewed-${++renewals}`;
        }
      },
      desktopSsoRestoreState: "authenticated",
      applyDesktopSsoRestoreResult: result => assert.equal(result.state, "authenticated"),
      assistantBridgeRuntime: { refreshKanbanDeviceInfo: () => kanbanRefreshes++ },
      enterpriseChatRuntime: { refresh: async () => {
        chatRefreshes++;
        chat.connectionState = "connecting";
        chat.activeConversationId = "";
      } }
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await refresh(true), `renewed-${attempt}`);
    }
    assert.equal(kanbanRefreshes, 3);
    assert.equal(chatRefreshes, 0);
    assert.deepEqual(chat, { connectionState: "connected", activeConversationId: "direct-employee", draft: "hello" });
  });
}
