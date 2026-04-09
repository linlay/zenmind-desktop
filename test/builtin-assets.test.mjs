import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  builtinServices,
  listTarEntries,
  validateBundleArchive
} from "../scripts/lib/builtin-assets.mjs";

function createTarBundle(service, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-builtin-asset-"));
  const bundleRoot = path.join(root, service.bundleTopLevelDir);
  fs.mkdirSync(bundleRoot, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(bundleRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }

  const tarPath = path.join(root, `${service.id}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", root, service.bundleTopLevelDir]);
  return { root, tarPath };
}

test("actual synced agent-container-hub asset includes required entries", () => {
  const service = builtinServices.find((item) => item.id === "agent-container-hub");
  assert.ok(service);
  const assetPath = path.join(
    process.cwd(),
    "build",
    "resources",
    "services",
    service.id,
    service.assetFileName
  );
  validateBundleArchive(service, assetPath);

  const entries = listTarEntries(assetPath);
  assert.ok(entries.has("agent-container-hub/start.sh"));
  assert.ok(entries.has("agent-container-hub/stop.sh"));
  assert.ok(entries.has("agent-container-hub/agent-container-hub"));
});

test("validateBundleArchive fails when required entries are missing", () => {
  const service = builtinServices.find((item) => item.id === "agent-container-hub");
  assert.ok(service);

  const fixture = createTarBundle(service, {
    ".env.example": "BIND_ADDR=127.0.0.1:11960\n",
    "README.txt": "broken bundle\n"
  });

  assert.throws(
    () => validateBundleArchive(service, fixture.tarPath),
    /Missing required entries: .*start\.sh/
  );

  fs.rmSync(fixture.root, { recursive: true, force: true });
});
