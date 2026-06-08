import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BUNDLED_ENV_FILE_NAME,
  prepareBundledEnvZip,
  readEnvZipVersion
} from "../scripts/sync-env-zip.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const silentLogger = {
  log() {}
};

function createFixture(version = "1.2.3") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sync-env-zip-"));
  fs.writeFileSync(path.join(root, "VERSION"), `v${version}\n`, "utf8");
  return root;
}

async function writeZip(zipPath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "build", "resources", "env", "manifest.json"), "utf8"));
}

test("sync-env clears stale env.zip when ENV_ZIP is not provided", async () => {
  const root = createFixture();
  const staleZipPath = path.join(root, "build", "resources", "env", BUNDLED_ENV_FILE_NAME);

  try {
    fs.mkdirSync(path.dirname(staleZipPath), { recursive: true });
    fs.writeFileSync(staleZipPath, "stale", "utf8");

    const result = await prepareBundledEnvZip({
      rootDir: root,
      env: {},
      logger: silentLogger
    });

    assert.equal(result.bundled, false);
    assert.equal(fs.existsSync(staleZipPath), false);
    assert.deepEqual(readManifest(root), {
      bundled: false,
      fileName: null,
      version: "1.2.3"
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync-env copies valid ENV_ZIP into build resources", async () => {
  const root = createFixture();
  const sourceZipPath = path.join(root, "fixtures", "env.zip");
  const outputZipPath = path.join(root, "build", "resources", "env", BUNDLED_ENV_FILE_NAME);

  try {
    await writeZip(sourceZipPath, {
      "env/VERSION": "v1.2.3\n",
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    const result = await prepareBundledEnvZip({
      rootDir: root,
      env: {
        ENV_ZIP: path.relative(root, sourceZipPath)
      },
      logger: silentLogger
    });

    assert.equal(result.bundled, true);
    assert.equal(result.outputPath, outputZipPath);
    assert.equal(fs.existsSync(outputZipPath), true);
    assert.equal(await readEnvZipVersion(outputZipPath), "1.2.3");
    assert.equal(readManifest(root).fileName, BUNDLED_ENV_FILE_NAME);
    assert.match(readManifest(root).sha256, /^[a-f0-9]{64}$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync-env rejects invalid ENV_ZIP inputs", async () => {
  const root = createFixture();
  const textPath = path.join(root, "env.txt");
  const mismatchZipPath = path.join(root, "mismatch.zip");
  const legacyWrapperZipPath = path.join(root, "legacy-wrapper.zip");
  const bareZipPath = path.join(root, "bare.zip");
  const nestedWrapperZipPath = path.join(root, "nested-wrapper.zip");
  const staleOutputZipPath = path.join(root, "build", "resources", "env", BUNDLED_ENV_FILE_NAME);

  try {
    fs.writeFileSync(textPath, "not zip", "utf8");
    await writeZip(mismatchZipPath, {
      "env/VERSION": "9.9.9\n",
      "env/agents/demo/agent.yml": "name: demo\n"
    });
    await writeZip(legacyWrapperZipPath, {
      "zenmind-env/VERSION": "1.2.3\n",
      "zenmind-env/agents/demo/agent.yml": "name: demo\n"
    });
    await writeZip(bareZipPath, {
      "VERSION": "1.2.3\n",
      "agents/demo/agent.yml": "name: demo\n"
    });
    await writeZip(nestedWrapperZipPath, {
      "env/env/VERSION": "1.2.3\n",
      "env/env/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: path.join(root, "missing.zip") },
        logger: silentLogger
      }),
      /ENV_ZIP file not found/
    );
    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: textPath },
        logger: silentLogger
      }),
      /ENV_ZIP must point to a \.zip file/
    );
    fs.mkdirSync(path.dirname(staleOutputZipPath), { recursive: true });
    fs.writeFileSync(staleOutputZipPath, "stale", "utf8");
    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: mismatchZipPath },
        logger: silentLogger
      }),
      /ENV_ZIP VERSION mismatch/
    );
    assert.equal(fs.existsSync(staleOutputZipPath), false);
    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: legacyWrapperZipPath },
        logger: silentLogger
      }),
      /single top-level env\/ directory/
    );
    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: bareZipPath },
        logger: silentLogger
      }),
      /single top-level env\/ directory/
    );
    await assert.rejects(
      () => prepareBundledEnvZip({
        rootDir: root,
        env: { ENV_ZIP: nestedWrapperZipPath },
        logger: silentLogger
      }),
      /nested environment wrapper/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
