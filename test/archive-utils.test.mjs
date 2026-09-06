import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const {
  extractArchiveToDir,
  listArchiveEntries
} = require("../dist-electron/main/support/archive/archive-utils.js");
const { readManifestFromArchive } = require("../dist-electron/main/support/manifest/manifest-utils.js");

async function writeZipArchive(archivePath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("zip archives expose entries, manifest, and required paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-zip-"));
  const archivePath = path.join(tempRoot, "zip-plugin.zip");
  const extractDir = path.join(tempRoot, "extract");
  const manifest = {
    id: "zip-plugin",
    name: "Zip Plugin",
    version: "v0.1.0",
    runtime: {
      requiredPaths: ["manifest.json", "backend/server.mjs"]
    },
    desktop: {
      bundleTopLevelDir: "zip-plugin"
    }
  };

  await writeZipArchive(archivePath, {
    "zip-plugin/manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "zip-plugin/backend/server.mjs": "export const ok = true;\n"
  });

  try {
    const entries = listArchiveEntries(archivePath);
    assert.equal(entries.has("zip-plugin/manifest.json"), true);
    assert.equal(entries.has("zip-plugin/backend/server.mjs"), true);

    assert.deepEqual(readManifestFromArchive(archivePath), manifest);

    await extractArchiveToDir(archivePath, extractDir);
    assert.equal(fs.existsSync(path.join(extractDir, "zip-plugin", "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(extractDir, "zip-plugin", "backend", "server.mjs")), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("zip extraction rejects zip-slip paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-archive-zipslip-"));
  const archivePath = path.join(tempRoot, "unsafe.zip");
  const extractDir = path.join(tempRoot, "extract");

  await writeZipArchive(archivePath, {
    "zip-plugin/manifest.json": "{}\n",
    "../escaped.txt": "nope\n"
  });

  try {
    await assert.rejects(
      () => extractArchiveToDir(archivePath, extractDir),
      /archive contains unsafe path|archive entry escapes target directory/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
