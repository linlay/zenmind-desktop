import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Release-side helper only: writes a local feed; does not upload or publish. */
export async function createUpdateManifest({ productId, version, keyId, channel, releaseSequence, expiresAt, releaseNotes = {}, artifacts, publishedAt = new Date().toISOString(), schemaVersion = 2 }) {
  const native = schemaVersion === 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error("Invalid schema version");
  if (native && Object.keys(artifacts ?? {}).some(key => !key.startsWith("darwin-"))) throw new Error("Unsigned manifests are only supported for macOS native updates");
  if (!/^[a-z][a-z0-9-]*$/.test(productId ?? "")) throw new Error("Invalid product id");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version ?? "");
  if (!match || version.length > 128 || match[4]?.split(".").some(id => /^0\d+$/.test(id))) throw new Error("Invalid version");
  if (!native && (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId ?? "") || !/^[a-z][a-z0-9-]{0,63}$/.test(channel ?? "") || !Number.isSafeInteger(releaseSequence) || releaseSequence < 1)) throw new Error("Invalid signing metadata");
  expiresAt ??= new Date(Date.parse(publishedAt) + 30 * 86400000).toISOString();
  for (const value of [publishedAt, expiresAt]) if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid release time");
  if (Date.parse(expiresAt) <= Date.parse(publishedAt)) throw new Error("Invalid release validity");
  if (!releaseNotes || typeof releaseNotes !== "object" || Array.isArray(releaseNotes)) throw new Error("Invalid release notes");
  for (const [locale, lines] of Object.entries(releaseNotes)) if (!/^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(locale) || !Array.isArray(lines) || lines.length > 100 || lines.some(line => typeof line !== "string" || line.length > 2000)) throw new Error("Invalid release notes");
  const output = {};
  for (const [key, { file, url }] of Object.entries(artifacts)) {
    if (!/^(darwin|win32)-(arm64|x64)$/.test(key)) throw new Error(`Unsupported platform: ${key}`);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("Artifact URL must use HTTPS");
    const extension = key.startsWith("darwin-") ? ".zip" : ".exe";
    if (!parsed.pathname.toLowerCase().endsWith(extension) || !file.toLowerCase().endsWith(extension)) throw new Error("Wrong artifact format");
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 16 * 1024 ** 3) throw new Error("Artifact is not a non-empty regular file");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    output[key] = { url: parsed.href, size: stat.size, sha256: hash.digest("hex") };
  }
  if (!Object.keys(output).length) throw new Error("At least one artifact is required");
  if (native) return { schemaVersion: 1, productId, version, publishedAt, releaseNotes, artifacts: output };
  return { schemaVersion: 2, keyId, channel, releaseSequence, expiresAt, productId, version, publishedAt, releaseNotes, artifacts: output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: node scripts/create-update-manifest.mjs <release-input.json> <new-release-directory (Windows) | latest.json (macOS-only)>");
  const releaseInput = JSON.parse(fs.readFileSync(input, "utf8"));
  const targets = Object.keys(releaseInput.artifacts ?? {});
  if (targets.length && targets.every(key => key.startsWith("darwin-"))) {
    const manifest = await createUpdateManifest({ ...releaseInput, schemaVersion: 1 });
    fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  } else {
    const { createSignedRelease, signingOptionsFromEnvironment } = await import("./update-signing.mjs");
    await createSignedRelease(releaseInput, output, signingOptionsFromEnvironment());
  }
}
