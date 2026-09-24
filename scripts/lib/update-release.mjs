import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateTrust } from "../../src/main/modules/updates/signing.js";

export function loadPlatformUpdateTrust(root, brandId, platform, env = process.env) {
  if (platform === "darwin") return { channel: "production", keys: [] };
  return loadBuildUpdateTrust(root, brandId, env);
}

/** Only build-time inputs may change trust; runtime URLs never supply keys. */
export function loadBuildUpdateTrust(root, brandId, env = process.env, required = false) {
  const file = env.DESKTOP_UPDATE_TRUST_FILE || path.join(root, "brands", brandId, "update-trust.json");
  if (!fs.existsSync(file)) {
    if (required || env.DESKTOP_UPDATE_TRUST_FILE) throw new Error("Update public trust file is required for release packaging");
    return { channel: "production", keys: [] };
  }
  const trust = validateTrust(JSON.parse(fs.readFileSync(file, "utf8")));
  if (trust.keys.some(key => key.productId !== brandId) || (required && !trust.keys.length)) throw new Error("Update public trust must contain keys for the packaged product");
  return trust;
}
/** Runs after platform signing/packaging. Build Manager inherits these environment inputs. */
export async function finalizeUpdateRelease(root, brandId, target, env = process.env) {
  if (!env.DESKTOP_UPDATE_RELEASE_INPUT) return undefined; // Baseline/manual installer only.
  const { createSignedRelease, signingOptionsFromEnvironment } = await import("../update-signing.mjs");
  const input = JSON.parse(fs.readFileSync(env.DESKTOP_UPDATE_RELEASE_INPUT, "utf8"));
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim().replace(/^v/, "");
  if (input.productId !== brandId || input.version !== version) throw new Error("Release product/version does not match the built application");
  const artifact = input.artifacts?.[target];
  if (!artifact || Object.keys(input.artifacts).length !== 1) throw new Error("Platform packaging requires exactly its own update artifact");
  const outputRoot = fs.realpathSync(path.join(root, "dist", brandId));
  const artifactPath = fs.realpathSync(path.resolve(root, artifact.file));
  const relative = path.relative(outputRoot, artifactPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Release installer must come from this brand's final dist directory");
  input.artifacts[target].file = artifactPath;
  const trust = loadBuildUpdateTrust(root, brandId, env, true);
  const embedded = validateTrust(JSON.parse(fs.readFileSync(path.join(root, "build", "brands", brandId, "bundle", "dist-electron", "update-trust.json"), "utf8")));
  if (JSON.stringify(trust) !== JSON.stringify(embedded)) throw new Error("Signing trust differs from the public keys embedded in this build");
  const options = signingOptionsFromEnvironment({ ...env, DESKTOP_UPDATE_TRUST_FILE: env.DESKTOP_UPDATE_TRUST_FILE || path.join(root, "brands", brandId, "update-trust.json") });
  const directory = path.join(outputRoot, "updates", trust.channel, version, randomUUID());
  await createSignedRelease(input, directory, options);
  return directory;
}
