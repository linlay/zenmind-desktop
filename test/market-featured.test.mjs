import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeCatalog, normalizeSkillProfile } = require("../dist-electron/main/modules/marketplace/common.js");

test("skill profile featured is a strict boolean", () => {
  assert.equal(normalizeSkillProfile({ kind: "single", featured: true }).featured, true);
  for (const featured of [false, undefined, "true", 1]) {
    assert.equal(normalizeSkillProfile({ kind: "package", featured }).featured, false);
  }
});

test("catalog projects backend skill.featured without deriving it from downloads", () => {
  const items = normalizeCatalog({ items: [
    { id: "selected", type: "skill", version: "1.0.0", skill: { kind: "single", featured: true }, downloadCount: 1 },
    { id: "popular", type: "skill", version: "1.0.0", skill: { kind: "single", featured: false }, downloadCount: 999 },
    { id: "missing", type: "skill", version: "1.0.0", skill: { kind: "single" }, downloadCount: 999 },
    { id: "disabled", type: "skill", version: "1.0.0", skillFeatured: false, skill: { kind: "single", featured: true } }
  ] }).items;
  assert.deepEqual(items.map((item) => [item.id, item.skillFeatured]), [["selected", true], ["popular", false], ["missing", false], ["disabled", false]]);
});
