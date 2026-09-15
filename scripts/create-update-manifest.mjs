import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Release-side helper only: writes a local feed; does not upload or publish. */
export async function createUpdateManifest({ productId, channel = "stable", version, releaseNotes, artifacts, publishedAt = new Date().toISOString() }) {
  if (!/^[a-z][a-z0-9-]*$/.test(productId ?? "")) throw new Error("Invalid product id");
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error("Invalid channel");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("Invalid version");
  const output = {};
  for (const [key, { file, url }] of Object.entries(artifacts)) {
    if (!/^(darwin|win32)-(arm64|x64)$/.test(key)) throw new Error(`Unsupported platform: ${key}`);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("Artifact URL must use HTTPS");
    const extension = key.startsWith("darwin-") ? ".zip" : ".exe";
    if (!parsed.pathname.toLowerCase().endsWith(extension) || !file.toLowerCase().endsWith(extension)) throw new Error("Wrong artifact format");
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || !stat.size) throw new Error("Artifact is not a non-empty file");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    output[key] = { url: parsed.href, size: stat.size, sha256: hash.digest("hex") };
  }
  if (!Object.keys(output).length) throw new Error("At least one artifact is required");
  return { schemaVersion: 1, productId, channel, version, publishedAt, releaseNotes, artifacts: output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: node scripts/create-update-manifest.mjs <release-input.json> <latest.json>");
  const manifest = await createUpdateManifest(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
}
