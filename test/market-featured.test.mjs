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

test("catalog uses the administrator-owned top-level featured flag", () => {
  const item = { type: "skill", version: "1.0.0", skill: { kind: "single" } };
  const items = normalizeCatalog({ items: [
    { ...item, id: "selected", featured: true, skillFeatured: false },
    { ...item, id: "popular", downloadCount: 999 },
    { ...item, id: "disabled", featured: false, skillFeatured: true, skill: { kind: "single", featured: true } },
    { ...item, id: "legacy-only", skill: { kind: "single", featured: true } },
    { ...item, id: "string", featured: "true" },
    { ...item, id: "number", featured: 1 }
  ] }).items;
  assert.deepEqual(items.map(item => [item.id, item.skillFeatured]), [
    ["selected", true], ["popular", false], ["disabled", false], ["legacy-only", false], ["string", false], ["number", false]
  ]);
  // Catalog snapshots are normalized again when reused by installation/list APIs.
  assert.deepEqual(normalizeCatalog({ items }).items.map(item => item.skillFeatured), items.map(item => item.skillFeatured));
});
