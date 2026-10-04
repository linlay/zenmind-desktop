import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  "src",
  "renderer",
  "pages",
  "settings",
  "sectionFeedback.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
});
const mod = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", outputText)(
  mod.exports,
  require,
  mod,
  sourcePath,
  path.dirname(sourcePath),
);

const { createSectionNotice, dismissSectionNoticeById, selectSectionFeedback } = mod.exports;

test("API failures stay in their section and success does not replace an error", async () => {
  let notice = null;
  try { await Promise.reject(new Error("save failed")); }
  catch (error) { notice = createSectionNotice(1, "assistant", error.message, "error"); }
  const errors = { general: "read failed" };
  assert.deepEqual(selectSectionFeedback("assistant", notice, errors), { notice, readError: "" });
  assert.deepEqual(selectSectionFeedback("general", notice, errors), { notice: null, readError: "read failed" });
  assert.deepEqual(selectSectionFeedback(null, notice, errors), { notice: null, readError: "" });
  assert.equal(createSectionNotice(2, "assistant", "saved", "success"), null);
  assert.equal(selectSectionFeedback("assistant", notice, errors).notice, notice);
});

test("dismissal and delayed timeout cannot clear a newer error", () => {
  const latest = createSectionNotice(2, "general", "new failure", "error");
  assert.equal(dismissSectionNoticeById(latest, 1), latest);
  assert.equal(dismissSectionNoticeById(latest, 2), null);
  assert.equal(dismissSectionNoticeById(null, 2), null);
});
