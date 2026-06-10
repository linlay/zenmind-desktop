import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createDesktopBuildMetadata,
  resolveDesktopBuildTime
} from "../scripts/lib/build-metadata.mjs";

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

test("desktop build metadata resolves deterministic build time inputs", () => {
  assert.equal(
    resolveDesktopBuildTime({ SOURCE_DATE_EPOCH: "1710000000" }),
    "2024-03-09T16:00:00Z"
  );
  assert.equal(
    resolveDesktopBuildTime({
      DESKTOP_BUILD_TIME: "2026-06-10T01:02:03Z",
      BUILD_TIME: "2024-01-01T00:00:00Z",
      SOURCE_DATE_EPOCH: "1710000000"
    }),
    "2026-06-10T01:02:03Z"
  );
  assert.equal(
    resolveDesktopBuildTime({}, () => new Date("2025-05-06T07:08:09.123Z")),
    "2025-05-06T07:08:09Z"
  );

  assert.deepEqual(
    createDesktopBuildMetadata({
      productName: "ZenMind",
      version: "0.2.8",
      env: { BUILD_TIME: "2026-06-10T02:03:04Z" }
    }),
    {
      productName: "ZenMind",
      version: "v0.2.8",
      buildTime: "2026-06-10T02:03:04Z"
    }
  );
});
