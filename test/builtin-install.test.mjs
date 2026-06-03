import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  readPreservedEnvFromSiblingInstallDirs
} = require("../dist-electron/main/services/manager/builtin-install.js");

test("readPreservedEnvFromSiblingInstallDirs returns the newest sibling env", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-env-preserve-"));
  const olderDir = path.join(tempRoot, "v0.1.0");
  const newerDir = path.join(tempRoot, "v0.2.0");

  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(newerDir, { recursive: true });
  const olderEnvPath = path.join(olderDir, ".env");
  const newerEnvPath = path.join(newerDir, ".env");
  fs.writeFileSync(olderEnvPath, "PORT=1000\n", "utf8");
  fs.writeFileSync(newerEnvPath, "PORT=2000\n", "utf8");

  const olderTime = new Date("2026-01-01T00:00:00.000Z");
  const newerTime = new Date("2026-02-01T00:00:00.000Z");
  fs.utimesSync(olderEnvPath, olderTime, olderTime);
  fs.utimesSync(newerEnvPath, newerTime, newerTime);

  try {
    assert.equal(readPreservedEnvFromSiblingInstallDirs([olderDir, newerDir]), "PORT=2000\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
