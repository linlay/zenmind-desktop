import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  generateWebappToolingBundle,
  WEBAPP_TOOLING_SOURCE_RELATIVE_PATH
} from "../scripts/generate-webapp-tooling-bundle.mjs";
import { loadBrandConfig } from "../scripts/lib/brand-config.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const {
  WEBAPP_TOOLING_RESOURCE_RELATIVE_PATH,
  resolvePackagedWebappToolingPath,
  verifyPackagedWebappTooling
} = require("../scripts/lib/webapp-tooling-resource.js");

test("TypeScript is the only authoritative WebApp Tooling source", () => {
  assert.equal(WEBAPP_TOOLING_SOURCE_RELATIVE_PATH, "src/tooling/webapp-tooling.ts");
  assert.equal(fs.existsSync(path.join(projectRoot, WEBAPP_TOOLING_SOURCE_RELATIVE_PATH)), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "scripts", "webapp-tooling.mjs")), false);
});

function runTooling(toolingPath, args) {
  const result = spawnSync(process.execPath, [toolingPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("production WebApp tooling is standalone and completes the package workflow", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-production-webapp-tooling-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const toolingPath = path.join(temporaryRoot, "Resources", "scripts", "webapp-tooling.mjs");
  await generateWebappToolingBundle({ rootDir: projectRoot, outputPath: toolingPath });

  const projectPath = path.join(temporaryRoot, "example");
  const initialized = runTooling(toolingPath, [
    "manifest", "init", "--project", projectPath, "--key", "production-example", "--label", "Production Example"
  ]);
  assert.equal(initialized.ok, true);
  fs.mkdirSync(path.join(projectPath, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "frontend", "index.html"), "<!doctype html><title>Example</title>\n");

  assert.equal(runTooling(toolingPath, ["package", "validate", "--project", projectPath]).ok, true);
  const archivePath = path.join(temporaryRoot, "example.zip");
  assert.equal(runTooling(toolingPath, ["package", "build", "--project", projectPath, "--output", archivePath]).ok, true);
  assert.equal(runTooling(toolingPath, ["package", "validate", "--archive", archivePath]).ok, true);
});

test("electron-builder publishes WebApp tooling as a directly executable extra resource", () => {
  const brand = loadBrandConfig(projectRoot, "cutej");
  for (const [target, targetKey] of [
    [{ os: "darwin", arch: "arm64" }, "darwin-arm64"],
    [{ os: "win32", arch: "x64" }, "win32-x64"]
  ]) {
    const config = electronBuilderConfig(brand, target);
    assert.ok(!config.files.includes("scripts/webapp-tooling.mjs"));
    assert.ok(!config.asarUnpack.includes("scripts/webapp-tooling.mjs"));
    assert.ok(config.extraResources.some((item) => (
      item.from === `build/brands/cutej/app/${targetKey}/scripts/webapp-tooling.mjs` &&
      item.to === WEBAPP_TOOLING_RESOURCE_RELATIVE_PATH
    )));
  }
});

test("production Tooling has stable macOS and Windows resource paths", () => {
  assert.equal(
    path.posix.join("/Applications/CuteJ.app/Contents/Resources", "scripts", "webapp-tooling.mjs"),
    "/Applications/CuteJ.app/Contents/Resources/scripts/webapp-tooling.mjs"
  );
  assert.equal(
    path.win32.join("C:\\Program Files\\CuteJ\\resources", "scripts", "webapp-tooling.mjs"),
    "C:\\Program Files\\CuteJ\\resources\\scripts\\webapp-tooling.mjs"
  );
});

test("packaged Tooling release gate rejects missing and empty resources", (t) => {
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-resource-"));
  t.after(() => fs.rmSync(resourcesRoot, { recursive: true, force: true }));
  const toolingPath = resolvePackagedWebappToolingPath(resourcesRoot);

  assert.throws(
    () => verifyPackagedWebappTooling(resourcesRoot),
    /packaged WebApp Tooling is missing/u
  );
  fs.mkdirSync(path.dirname(toolingPath), { recursive: true });
  fs.writeFileSync(toolingPath, "");
  assert.throws(
    () => verifyPackagedWebappTooling(resourcesRoot),
    /packaged WebApp Tooling is not a non-empty file/u
  );
  fs.writeFileSync(toolingPath, "#!/usr/bin/env node\n");
  assert.equal(verifyPackagedWebappTooling(resourcesRoot), toolingPath);
});
