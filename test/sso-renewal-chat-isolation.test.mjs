import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const filename = "src/main/app/assembly/identity.ts";
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const implementation = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "createDesktopSsoMaintenance");
assert.ok(implementation);
const compiled = ts.transpileModule(implementation.getText(source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: scheduled SSO maintenance renews only Identity and never rebuilds IM or Kanban`, async () => {
    const context = { exports: {}, app: { platform } };
    vm.runInNewContext(compiled, context);
    const forces = [];
    let renewals = 0;
    const maintain = context.exports.createDesktopSsoMaintenance({
      desktopSsoController: {
        retryDesktopSsoSessionRestoreIfNeeded: async () => ({ state: "authenticated" }),
        ensureBusinessToken: async force => {
          forces.push(force);
          return `renewed-${++renewals}`;
        }
      },
      desktopSsoRestoreState: "authenticated",
      applyDesktopSsoRestoreResult: result => assert.equal(result.state, "authenticated"),
      // Downstream runtimes are not dependencies of maintenance at all; touching them fails.
      get assistantBridgeRuntime() { return assert.fail("maintenance must not reach Kanban"); },
      get enterpriseChatRuntime() { return assert.fail("maintenance must not reach enterprise chat"); }
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await maintain(), `renewed-${attempt}`);
    }
    // Maintenance follows Identity's schedule; it never forces a renewal on a consumer's behalf.
    assert.deepEqual(forces, [false, false, false]);
  });

  test(`${platform}: maintenance skips renewal while Desktop sign-in is temporarily unavailable`, async () => {
    const context = { exports: {}, app: { platform } };
    vm.runInNewContext(compiled, context);
    const dependencies = {
      desktopSsoController: {
        retryDesktopSsoSessionRestoreIfNeeded: async () => ({ state: "temporarily_unavailable" }),
        ensureBusinessToken: async () => assert.fail("unavailable sign-in must not renew")
      },
      desktopSsoRestoreState: "authenticated",
      applyDesktopSsoRestoreResult: result => { dependencies.desktopSsoRestoreState = result.state; }
    };
    assert.equal(await context.exports.createDesktopSsoMaintenance(dependencies)(), "");
  });
}
