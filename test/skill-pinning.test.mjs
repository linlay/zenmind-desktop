import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/skillPinning.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);
const { marketSkillPinKeys, sortPinnedSkills, pinnedMarketItems } = module.exports;
const skill = (id, extra = {}) => ({ id, type: "skill", ...extra });

test("package and standalone pins each use their own id", () => {
  const items = [skill("a"), skill("b"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "a" }, { id: "b" }] } })];
  assert.deepEqual(marketSkillPinKeys(items, ["a", "pack", "a"]), ["a", "pack"]);
  assert.deepEqual(marketSkillPinKeys(items, ["unknown"]), []);
  assert.deepEqual(marketSkillPinKeys([{ id: "a", type: "mcp" }], ["a"]), []);
  assert.deepEqual(marketSkillPinKeys([skill("empty", { skill: { kind: "package", includedSkills: [] } })], ["empty"]), ["empty"]);
});
test("market pins have deterministic order and unpinned entries retain original order", () => {
  const items = [skill("a"), skill("b"), skill("c"), skill("d")];
  assert.deepEqual(sortPinnedSkills(items, ["d", "b"]).map((item) => item.id), ["d", "b", "a", "c"]);
  assert.deepEqual(sortPinnedSkills(items, []).map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d"]);
});

test("package pins share the official order without being inferred from members", () => {
  const items = [skill("a"), skill("b"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "pack/a" }, { id: "pack/b" }] } }), skill("empty", { skill: { kind: "package", includedSkills: [] } })];
  assert.deepEqual(pinnedMarketItems(items, ["a"]), ["a"]);
  assert.deepEqual(pinnedMarketItems(items, ["pack/a", "pack/b", "b", "a"]), ["b", "a"]);
  assert.deepEqual(pinnedMarketItems(items, ["pack", "a"]), ["pack", "a"]);
  const pins = pinnedMarketItems(items, ["EMPTY", "b", "pack", "a"]);
  assert.deepEqual(pins, ["empty", "b", "pack", "a"]);
  assert.deepEqual(sortPinnedSkills(items, pins).map((item) => item.id), ["empty", "b", "pack", "a"]);
  assert.deepEqual(pinnedMarketItems(items, []), []);
});

function hookHarness(items, initialOrder, legacy = []) {
  const slots = [];
  const pendingEffects = [];
  const writes = [];
  const storage = new Map([["market.skillPins", JSON.stringify(legacy)]]);
  let order = [...initialOrder];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (next) => { slots[index].value = typeof next === "function" ? next(slots[index].value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => !Object.is(value, slots[index][i]))) {
        slots[index] = dependencies;
        pendingEffects.push(effect);
      }
    },
  };
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const window = {
    addEventListener() {}, removeEventListener() {},
    electronAPI: { market: {
      getSkillPins: async () => ({ order: [...order] }),
      saveSkillPins: async (update) => {
        writes.push(update);
        if (update.pinned && !order.includes(update.key)) order.unshift(update.key);
        if (!update.pinned) order = order.filter((key) => key !== update.key);
        return { order: [...order] };
      },
    } },
  };
  const hookSource = fs.readFileSync(new URL("../src/renderer/pages/functional-market/useMarketSkillPins.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const hookModule = { exports: {} };
  new Function("module", "exports", "require", "window", "localStorage", outputText)(
    hookModule, hookModule.exports, (name) => name === "react" ? react : module.exports, window, localStorage,
  );
  return {
    writes, storage, order: () => order,
    render() {
      cursor = 0;
      const hook = hookModule.exports.useMarketSkillPins(items, false);
      pendingEffects.splice(0).forEach((effect) => effect());
      return hook;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("market package toggle makes one request and preserves existing member pins", async () => {
  const items = [skill("a"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "pack/a" }] } })];
  const h = hookHarness(items, ["pack/a", "a"]);
  h.render();
  await flush();
  assert.deepEqual(h.render().pins, ["a"]);
  await h.render().toggle("pack");
  assert.deepEqual(h.writes, [{ key: "pack", pinned: true }]);
  assert.deepEqual(h.order(), ["pack", "pack/a", "a"]);
  assert.deepEqual(h.render().pins, ["pack", "a"]);
  await h.render().toggle("pack");
  assert.deepEqual(h.writes, [{ key: "pack", pinned: true }, { key: "pack", pinned: false }]);
  assert.deepEqual(h.order(), ["pack/a", "a"]);
  assert.deepEqual(h.render().pins, ["a"]);
});

test("legacy market migration keeps package IDs and does not replace member preferences", async () => {
  const items = [skill("a"), skill("pack", { skill: { kind: "package", includedSkills: [{ id: "pack/a" }] } })];
  const h = hookHarness(items, ["pack/a"], ["pack", "a"]);
  h.render();
  await flush();
  assert.deepEqual(h.writes, [{ key: "a", pinned: true }, { key: "pack", pinned: true }]);
  assert.deepEqual(h.order(), ["pack", "a", "pack/a"]);
  assert.deepEqual(h.render().pins, ["pack", "a"]);
  assert.equal(h.storage.get("market.skillPins.orderMigrated"), "1");
});
