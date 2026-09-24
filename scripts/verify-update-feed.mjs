import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { validateTrust, verifySignedManifest } from "../src/main/modules/updates/signing.js";
const require = createRequire(import.meta.url);
// Use the same compiled transport and validation as the client (build:main:types first).
const { fetchUpdateManifest, downloadUpdateFile } = require("../dist-electron/main/modules/updates/download.js");
const { parseUpdateManifest } = require("../dist-electron/main/modules/updates/manifest.js");
const { verifyUpdateTime } = require("../dist-electron/main/modules/updates/security.js");

export async function verifyPublicFeed(url, trust, productId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-verify-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60 * 60_000);
  try {
    const envelope = await fetchUpdateManifest(url, controller.signal);
    const { value } = verifySignedManifest(envelope, validateTrust(trust), productId);
    const manifest = parseUpdateManifest(value, productId);
    verifyUpdateTime(manifest, Date.now());
    if (!Object.keys(manifest.artifacts).length) throw new Error("Release has no artifacts");
    for (const [target, artifact] of Object.entries(manifest.artifacts)) {
      await downloadUpdateFile(artifact, path.join(root, target), controller.signal, () => {});
    }
    verifyUpdateTime(manifest, Date.now());
    return manifest;
  } finally { clearTimeout(timer); fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [url, trustFile, productId] = process.argv.slice(2);
    if (!url || !trustFile || !productId) throw new Error("Usage: verify-update-feed.mjs <HTTPS-feed> <public-trust.json> <product-id>");
    const release = await verifyPublicFeed(url, JSON.parse(fs.readFileSync(trustFile, "utf8")), productId);
    console.log(`Verified release ${release.version}`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Public release verification failed"); process.exitCode = 1; }
}
