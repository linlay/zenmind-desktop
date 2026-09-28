import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hasNumberedSourceSplitName } from "../scripts/lib/source-split-names.mjs";

test("architecture rejects numbered source partitions across naming variants", () => {
  for (const filename of [
    "runtime.operations-4.ts", "bridge.methods-1.ts", "index.part-4.part-2.ts",
    "runtime.part1.ts", "runtime-2.ts", "runtime.3.ts", "runtime_4.ts",
    "runtime-part_2.ts", "runtime-Part2.tsx", "runtime-2-query.ts",
    "C:\\project\\src\\main\\runtime.methods-1.ts"
  ]) assert.equal(hasNumberedSourceSplitName(filename), true, filename);
});

test("architecture permits meaningful names, versions and numeric directory names", () => {
  for (const filename of [
    "run-controller.ts", "i18n.ts", "sha256.ts", "http2-client.ts",
    "kanban-v1-contract.ts", "agent-webclient-v2.ts", "partition-policy.ts",
    "src/2026/runtime.ts", "C:\\project\\1\\runtime.ts", "runtime-2.d.ts",
    "test-windows-release-chain.ps1", "qa/part-files-inventory.md"
  ]) assert.equal(hasNumberedSourceSplitName(filename), false, filename);
});

test("architecture command fails on a numbered implementation and accepts a purpose name", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "source-split-check-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const main = path.join(cwd, "src/main");
  fs.mkdirSync(path.join(main, "modules"), { recursive: true });
  fs.mkdirSync(path.join(main, "app"));
  fs.writeFileSync(path.join(main, "index.ts"), "export {};\n");
  const numbered = path.join(main, "app/runtime.operations-4.ts");
  fs.writeFileSync(numbered, "export function notifyChanged() {}\n");
  const script = fileURLToPath(new URL("../scripts/check-main-architecture.mjs", import.meta.url));
  const rejected = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /runtime\.operations-4\.ts uses a numbered source split/);
  fs.renameSync(numbered, path.join(main, "app/runtime-notifications.ts"));
  const accepted = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
});
