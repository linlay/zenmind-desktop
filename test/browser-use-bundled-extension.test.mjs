import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";
import { loadBrandConfig } from "../scripts/lib/brand-config.mjs";
const require = createRequire(import.meta.url);
const { prepareBundledBrowserExtension } = require("../dist-electron/main/modules/browser-use/bundled-extension.js");
const root = path.resolve(import.meta.dirname, "..");
const archive = path.join(root, "resources/chrome-extension/playwright.crx");

test("offline extension preserves official identity and a stable directory; corrupt archives never extract", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-extension-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lock = JSON.parse(await fs.readFile(path.join(root, "scripts/playwright/upstream-lock.json"), "utf8"));
  const data = await fs.readFile(archive);
  assert.equal(crypto.createHash("sha256").update(data).digest("hex"), lock.extension.storeCrxSha256);
  const folder = await prepareBundledBrowserExtension(archive, temporary);
  const manifest = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.version, lock.extension.sourceVersion);
  const id = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  assert.equal(id, lock.extension.id);
  await fs.writeFile(path.join(folder, "status.html"), "corrupted");
  assert.equal(await prepareBundledBrowserExtension(archive, temporary), folder);
  assert.match(await fs.readFile(path.join(folder, "status.html"), "utf8"), /Playwright/);
  data[data.length - 1] ^= 1;
  const corrupt = path.join(temporary, "corrupt.crx");
  await fs.writeFile(corrupt, data);
  await assert.rejects(prepareBundledBrowserExtension(corrupt, path.join(temporary, "not-created")), /integrity/);
  await assert.rejects(fs.stat(path.join(temporary, "not-created")), { code: "ENOENT" });
});

for (const platform of ["darwin", "win32"]) test(`${platform} installer carries the offline extension and its license`, async () => {
  const config = electronBuilderConfig(loadBrandConfig(root, "zenmind"), { os: platform, arch: "arm64" });
  assert.ok(config.extraResources.some(r => r.from === "resources/chrome-extension" && r.to === "resources/chrome-extension"));
  assert.match(await fs.readFile(path.join(root, "resources/chrome-extension/LICENSE"), "utf8"), /Apache License/);
});
