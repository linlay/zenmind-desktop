import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import safety from "../src/main/support/archive/package-safety.js";
import validation from "../src/main/modules/webs/webapps/package-validation.js";

const rejectsWith = code => error => error instanceof safety.WebappPackageValidationError && error.code === code;

test("generic ZIP safety rejects traversal, collisions, links and excessive expansion", () => {
  for (const name of ["../secret", "C:\\secret", "/secret", "a/../secret"]) {
    assert.throws(() => safety.validateZipEntrySafety([{ name }]), rejectsWith("unsafe_path"));
  }
  assert.throws(() => safety.validateZipEntrySafety([{ name: "a" }, { name: "A" }]), rejectsWith("case_collision"));
  assert.throws(() => safety.validateZipEntrySafety([{ name: "link", unixPermissions: 0o120777 }]), rejectsWith("symbolic_link"));
  assert.throws(() => safety.validateZipEntrySafety([{ name: "file", uncompressedSize: 20 }], { maxExpandedBytes: 10 }), rejectsWith("expanded_size_exceeded"));
  // Generic archives may contain names that WebApp packages prohibit.
  assert.doesNotThrow(() => safety.validateZipEntrySafety([{ name: "app/.env" }]));
  assert.throws(() => validation.validateWebappArchiveLayout(["app/webapp.json", "app/.env"], /^app$/), rejectsWith("disallowed_path"));
  assert.equal(validation.validateWebappArchiveLayout(["app/webapp.json", "app/public/index.html"], /^app$/), "app");
  assert.throws(() => validation.validateWebappArchiveLayout(["app/webapp.json", "other/file"], /^app$/), rejectsWith("invalid_root"));
});

test("WebApp directory validation preserves Windows and macOS executable rules", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-package-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public/index.html"), "hello");
  for (const [target, entry, signature] of [["win32-x64", "app.exe", "4d5a0000"], ["darwin-arm64", "app", "cffaedfe"]]) {
    const manifest = { target, frontend: { root: "public", index: "index.html", routeConfig: {} }, backend: { command: { type: "executable", entry } } };
    const executable = path.join(root, entry);
    fs.writeFileSync(executable, Buffer.from(signature, "hex"));
    assert.equal(validation.validateWebappPackageDirectory(root, manifest).files.length, 2);
    fs.writeFileSync(executable, "bad!");
    assert.throws(() => validation.validateWebappPackageDirectory(root, manifest), rejectsWith("invalid_executable_format"));
    fs.rmSync(executable);
  }
});
