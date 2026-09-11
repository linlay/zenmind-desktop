import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeEntryKeysFile, readEntryKeysFile } = require("../dist-electron/main/infrastructure/filesystem/entry-keys-file.js");

test("unchanged order avoids replacement; changed, deleted and externally edited files are persisted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-keys-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "order.json");
  writeEntryKeysFile(file, ["a", "b"]);
  const rename = t.mock.method(fs, "renameSync");
  assert.deepEqual(writeEntryKeysFile(file, [" a ", "b", "a"]), ["a", "b"]);
  assert.equal(rename.mock.callCount(), 0);
  writeEntryKeysFile(file, ["b", "a"]);
  assert.deepEqual(readEntryKeysFile(file), ["b", "a"]);
  fs.writeFileSync(file, "invalid external edit");
  writeEntryKeysFile(file, ["b", "a"]);
  assert.deepEqual(readEntryKeysFile(file), ["b", "a"]);
  fs.unlinkSync(file);
  writeEntryKeysFile(file, ["b", "a"]);
  assert.equal(rename.mock.callCount(), 3);
});

test("failed replacement preserves confirmed order and removes its temporary file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entry-keys-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "order.json");
  writeEntryKeysFile(file, ["a"]);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); });
  assert.throws(() => writeEntryKeysFile(file, ["b"]), /locked/);
  assert.deepEqual(readEntryKeysFile(file), ["a"]);
  assert.deepEqual(fs.readdirSync(root), ["order.json"]);
});
