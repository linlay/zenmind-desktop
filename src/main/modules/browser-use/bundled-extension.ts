import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";

// Reviewed official Chrome Web Store artifact; retain the manifest key for the relay's fixed ID.
const SHA256 = "598517ba87d9f2f3b3642483cb6662bc0ea061401c5d3c1eb188a19847c92b0b";
export async function prepareBundledBrowserExtension(archive: string, root: string): Promise<string> {
  const data = await fs.readFile(archive);
  if (crypto.createHash("sha256").update(data).digest("hex") !== SHA256 ||
    data.subarray(0, 4).toString() !== "Cr24" || data.readUInt32LE(4) !== 3)
    throw new Error("Bundled Chrome extension integrity check failed");
  const zip = await JSZip.loadAsync(data.subarray(12 + data.readUInt32LE(8)));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  const id = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  if (manifest.version !== "0.5.0" || id !== "mmlmfjhmonkocbjadbfplnigmagldckm")
    throw new Error("Unexpected bundled Chrome extension identity");
  const destination = path.join(root, "playwright-0.5.0");
  await fs.mkdir(destination, { recursive: true });
  // Keep a stable directory outside the application: Chrome references unpacked files in place.
  // Restore reviewed bytes when explicitly opening setup, without touching Chrome's profile.
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry.name.startsWith("_metadata/")) continue;
    const target = path.resolve(destination, entry.name);
    if (!target.startsWith(destination + path.sep)) throw new Error("Invalid bundled extension path");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async("nodebuffer"));
  }
  return destination;
}
