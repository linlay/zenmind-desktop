import test from "node:test";
import assert from "node:assert/strict";

test("platform helpers expose host labels, architecture labels, and spawn defaults", async () => {
  const detect = await import("../scripts/platform/detect.mjs");
  const spawn = await import("../scripts/platform/spawn.mjs");

  assert.equal(typeof detect.isWindows(), "boolean");
  assert.match(detect.hostPlatform(), /^(windows|darwin|linux)$/);
  assert.equal(typeof detect.hostArch(), "string");
  assert.ok(detect.hostArch().length > 0);
  assert.match(detect.syncOsLabel(), /^(windows|darwin|linux)$/);
  assert.equal(spawn.npmCmd, detect.isWindows() ? "npm.cmd" : "npm");
  assert.equal(typeof spawn.run, "function");
  assert.equal(typeof spawn.runAndWait, "function");
});
