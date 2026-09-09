import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { createRequire } from "node:module";
const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/skillDiscovery.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function("module", "exports", "require", output)(module, module.exports, createRequire(import.meta.url));
const { featuredSkills, isInstalledSkill, matchesSkillCategory } = module.exports;
const skill = (id, downloadCount, extra = {}) => ({ id, name: id, type: "skill", source: "cloud", state: "not-installed", tags: [], downloadCount, ...extra });

test("featured skills use the explicit market flag, never download counts", () => {
  const items = [skill("a", 3, { skillFeatured: true }), skill("popular", 9999), skill("b", 0, { skillFeatured: true }), skill("c", 5, { skillFeatured: true }), skill("d", 30, { skillFeatured: true }), skill("local", 999, { source: "local", skillFeatured: true }), skill("web", 999, { type: "website-app", skillFeatured: true })];
  assert.deepEqual(featuredSkills(items).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(featuredSkills(items, 3).map((item) => item.id), ["d", "a", "b"]);
  assert.deepEqual(featuredSkills(items, 6).map((item) => item.id), ["c", "d", "a"]);
  assert.equal(items[0].id, "a");
  assert.equal(featuredSkills([]).length, 0);
  assert.equal(featuredSkills([skill("a", undefined)]).length, 0);
  assert.deepEqual(featuredSkills([skill("a", 0, { skillFeatured: true })], 99).map((item) => item.id), ["a"]);
  assert.equal(featuredSkills([skill("a", 0, { skillFeatured: "true" })]).length, 0);
});
test("installed view includes imported and updatable skills and excludes uninstalled entries", () => {
  for (const state of ["installed", "local-imported", "update-available"]) assert.equal(isInstalledSkill(skill("a", 0, { state })), true);
  assert.equal(isInstalledSkill(skill("a", 0)), false);
});
test("category filtering uses declared category, scenario or tags, not product-name guesses", () => {
  assert.equal(matchesSkillCategory(skill("demo", 0, { skill: { category: "office" } }), "office"), true);
  assert.equal(matchesSkillCategory(skill("demo", 0, { tags: ["finance"] }), "finance"), true);
  assert.equal(matchesSkillCategory(skill("finance", 0), "finance"), false);
  assert.equal(matchesSkillCategory(skill("demo", 0), "all"), true);
});
