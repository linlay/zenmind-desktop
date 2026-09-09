import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/skillPinning.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);
const { expandPinnedSkillKeys, sortPinnedSkills, pinnedMarketItems } = module.exports;
const skill = (id, extra = {}) => ({ id, type: "skill", ...extra });

test("package pins expand into concrete children and never use the package id", () => {
  const items = [skill("a"), skill("b"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "a" }, { id: "b" }] } })];
  assert.deepEqual(expandPinnedSkillKeys(items, ["a", "pack"]), ["a", "b"]);
  assert.deepEqual(expandPinnedSkillKeys(items, ["unknown"]), []);
  assert.deepEqual(expandPinnedSkillKeys([{ id: "a", type: "mcp" }], ["a"]), []);
});
test("market pins have deterministic order and unpinned entries retain original order", () => {
  const items = [skill("a"), skill("b"), skill("c"), skill("d")];
  assert.deepEqual(sortPinnedSkills(items, ["d", "b"]).map((item) => item.id), ["d", "b", "a", "c"]);
  assert.deepEqual(sortPinnedSkills(items, []).map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d"]);
});

test("market card pins derive from official order; packages require every concrete child", () => {
  const items = [skill("a"), skill("b"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "a" }, { id: "b" }] } }), skill("empty", { skill: { kind: "package", includedSkills: [] } })];
  assert.deepEqual(pinnedMarketItems(items, ["a"]), ["a"]);
  assert.deepEqual(pinnedMarketItems(items, ["b", "a"]), ["b", "pack", "a"]);
  assert.deepEqual(pinnedMarketItems(items, []), []);
});
