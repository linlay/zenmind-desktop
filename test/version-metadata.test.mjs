import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, ...segments), "utf8"));
}

function readDesktopVersion() {
  const version = fs.readFileSync(path.join(projectRoot, "VERSION"), "utf8").trim().replace(/^v/iu, "");
  assert.ok(version, "VERSION must not be empty");
  return version;
}

test("desktop package metadata is synchronized with VERSION", () => {
  const version = readDesktopVersion();
  const packageJson = readJson("package.json");

  assert.equal(packageJson.version, version);

  const packageLockPath = path.join(projectRoot, "package-lock.json");
  if (fs.existsSync(packageLockPath)) {
    const packageLock = readJson("package-lock.json");
    assert.equal(packageLock.version, version);
    assert.equal(packageLock.packages[""].version, version);
  }
});
