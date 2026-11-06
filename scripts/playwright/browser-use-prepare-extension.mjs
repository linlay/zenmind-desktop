import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

/** Verify and unpack the bundled official artifact for isolated tests. */
export async function preparePlaywrightExtension(rootDir) {
  const lock = JSON.parse(await fs.readFile(path.join(rootDir, "scripts/playwright/upstream-lock.json"), "utf8"));
  const destination = path.join(rootDir, "build/browser-use-fixture");
  const archive = path.join(rootDir, "resources/chrome-extension/playwright.crx");
  await fs.mkdir(destination, { recursive: true });
  const data = await fs.readFile(archive);
  if (crypto.createHash("sha256").update(data).digest("hex") !== lock.extension.storeCrxSha256) throw new Error("Official extension archive changed; review the pinned artifact before running the fixture");
  if (data.subarray(0, 4).toString() !== "Cr24" || data.readUInt32LE(4) !== 3) throw new Error("Expected an official CRX3 extension");
  const zip = await JSZip.loadAsync(data.subarray(12 + data.readUInt32LE(8)));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  const id = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  if (manifest.version !== lock.extension.sourceVersion || id !== lock.extension.id) throw new Error("Official extension identity/version differs from the reviewed artifact");
  const extensionDir = path.join(destination, "extension");
  await fs.rm(extensionDir, { recursive: true, force: true });
  await fs.mkdir(extensionDir, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    // CRX signature metadata is not needed when loading the unchanged extension files unpacked in the fixture.
    if (entry.dir || entry.name.startsWith("_metadata/")) continue;
    const target = path.resolve(extensionDir, entry.name);
    if (!target.startsWith(extensionDir + path.sep)) throw new Error("Invalid extension archive path");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async("nodebuffer"));
  }
  return { extensionDir, id, version: manifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await preparePlaywrightExtension(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."))));
}
