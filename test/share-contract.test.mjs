import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("share DTO examples preserve business versions, retired policies and IPC time boundaries", () => {
  const fixture = fileURLToPath(new URL("./fixtures/share-contract-types.ts", import.meta.url));
  const program = ts.createProgram([fixture], {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => path.dirname(fixture),
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  }));
});
