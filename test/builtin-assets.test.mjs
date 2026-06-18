import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBuiltinArchive(sourceRoot, id) {
  const version = "v999.0.0";
  const assetFileName = `${id}-${version}-darwin-arm64.tar.gz`;
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenmind-${id}-archive-`));
  const bundleRoot = path.join(stagingRoot, id);
  fs.mkdirSync(bundleRoot, { recursive: true });
  writeJson(path.join(bundleRoot, "manifest.json"), {
    kind: "builtin",
    id,
    name: id,
    version,
    platform: {
      os: "darwin",
      arch: "arm64"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    desktop: {
      assetFileName,
      bundleTopLevelDir: id
    }
  });

  const archivePath = path.join(sourceRoot, assetFileName);
  fs.mkdirSync(sourceRoot, { recursive: true });
  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, id]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  return archivePath;
}

async function importBuiltinAssetsModule(cacheKey) {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "scripts", "lib", "builtin-assets.mjs"));
  moduleUrl.search = `?cache=${cacheKey}`;
  return import(moduleUrl.href);
}

test("desktop builtin asset discovery skips the external tunnel hub agent executable bundle", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-assets-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(tempRoot, "release");
  writeBuiltinArchive(sourceRoot, "example-desktop-tool");
  writeBuiltinArchive(sourceRoot, "tunnel-hub-agent");

  const previousSource = process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
  const previousLegacySource = process.env.ZENMIND_BUILTIN_ASSETS_SOURCE;
  process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = sourceRoot;
  delete process.env.ZENMIND_BUILTIN_ASSETS_SOURCE;
  t.after(() => {
    if (previousSource === undefined) {
      delete process.env.DESKTOP_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.DESKTOP_BUILTIN_ASSETS_SOURCE = previousSource;
    }
    if (previousLegacySource === undefined) {
      delete process.env.ZENMIND_BUILTIN_ASSETS_SOURCE;
    } else {
      process.env.ZENMIND_BUILTIN_ASSETS_SOURCE = previousLegacySource;
    }
  });

  const { discoverBuiltinServices } = await importBuiltinAssetsModule(Date.now());
  const services = discoverBuiltinServices({ os: "darwin", arch: "arm64" });
  const serviceIds = new Set(services.map((service) => service.id));

  assert.equal(serviceIds.has("example-desktop-tool"), true);
  assert.equal(serviceIds.has("tunnel-hub-agent"), false);
});
