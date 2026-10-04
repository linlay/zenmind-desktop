import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("architecture checks CommonJS and TypeScript require dependencies across boundaries", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-architecture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const file of ["scripts/check-main-architecture.mjs", "scripts/lib/source-split-names.mjs"]) {
    write(file, fs.readFileSync(file));
  }
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  write("src/main/index.ts", "export {};");
  write("src/main/modules/webs/index.ts", "export {};");
  const run = () => spawnSync(process.execPath, ["scripts/check-main-architecture.mjs"], { cwd: root, encoding: "utf8" });
  write("src/main/support/archive/check.js", 'module.exports = {};');
  assert.equal(run().status, 0);
  write("src/main/support/archive/check.js", 'require("../../modules/webs");');
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not depend on business module webs/);
  write("src/main/support/archive/check.js", 'module.exports = {};');
  write("src/main/support/archive/check.ts", 'import webs = require("../../modules/webs");');
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not depend on business module webs/);
});
