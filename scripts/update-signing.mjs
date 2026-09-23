import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createUpdateManifest } from "./create-update-manifest.mjs";
import { validateTrust, verifySignedManifest } from "../src/main/modules/updates/signing.js";

export function signingOptionsFromEnvironment(env = process.env) {
  if (!env.DESKTOP_UPDATE_PRIVATE_KEY_FILE || !env.DESKTOP_UPDATE_TRUST_FILE) throw new Error("DESKTOP_UPDATE_PRIVATE_KEY_FILE and DESKTOP_UPDATE_TRUST_FILE are required");
  const privateKey = createPrivateKey({ key: fs.readFileSync(env.DESKTOP_UPDATE_PRIVATE_KEY_FILE), passphrase: env.DESKTOP_UPDATE_KEY_PASSPHRASE });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  return { privateKey, trust: validateTrust(JSON.parse(fs.readFileSync(env.DESKTOP_UPDATE_TRUST_FILE, "utf8"))) };
}
function checkTime(value) {
  if (Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.publishedAt) > Date.now() + 300000) throw new Error("Release expired or device clock invalid");
}
export async function createSignedRelease(input, outputDirectory, { privateKey, trust }) {
  if (fs.existsSync(outputDirectory)) throw new Error("Release directory already exists; use a new sequence directory");
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  const manifest = await createUpdateManifest(input);
  checkTime(manifest);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  const signature = sign(null, Buffer.from(text), privateKey).toString("base64");
  verifySignedManifest({ manifest: text, signature }, trust, input.productId);
  // Populate a new sibling directory and rename only after full verification.
  fs.mkdirSync(path.dirname(path.resolve(outputDirectory)), { recursive: true });
  const staging = `${outputDirectory}.${randomUUID()}.tmp`;
  fs.mkdirSync(staging);
  try {
    fs.writeFileSync(path.join(staging, "desktop-latest.json"), text, { flag: "wx" });
    fs.writeFileSync(path.join(staging, "desktop-latest.json.sig"), signature + "\n", { flag: "wx" });
    await verifyRelease(staging, trust, input.productId, input.artifacts);
    if (fs.existsSync(outputDirectory)) throw new Error("Release directory already exists");
    fs.renameSync(staging, outputDirectory);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return manifest;
}
export async function verifyRelease(directory, trust, productId, artifacts) {
  const envelope = { manifest: fs.readFileSync(path.join(directory, "desktop-latest.json"), "utf8"), signature: fs.readFileSync(path.join(directory, "desktop-latest.json.sig"), "utf8") };
  const { value } = verifySignedManifest(envelope, trust, productId);
  if (value.schemaVersion !== 2) throw new Error("Unsupported update protocol");
  checkTime(value);
  const computed = await createUpdateManifest({ ...value, artifacts });
  if (JSON.stringify(computed.artifacts) !== JSON.stringify(value.artifacts)) throw new Error("Final artifacts do not match signed metadata");
  return value;
}
export function generateSigningKey(directory, productId, channel, keyId, passphrase) {
  const repository = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const target = path.resolve(directory);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  const relative = path.relative(repository, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Signing keys must be generated outside the repository");
  }
  if (!passphrase || passphrase.length < 12) throw new Error("Set DESKTOP_UPDATE_KEY_PASSPHRASE to at least 12 characters");
  const pair = generateKeyPairSync("ed25519");
  const trust = validateTrust({ channel, keys: [{ keyId, productId, channel, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }] });
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "private-key.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(directory, "public-trust.json"), JSON.stringify(trust, null, 2) + "\n", { flag: "wx" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, first, second, third, fourth] = process.argv.slice(2);
    if (command === "keygen" && first && second && third && fourth) generateSigningKey(first, second, third, fourth, process.env.DESKTOP_UPDATE_KEY_PASSPHRASE);
    else if (command === "sign" && first && second) await createSignedRelease(JSON.parse(fs.readFileSync(first, "utf8")), second, signingOptionsFromEnvironment());
    else if (command === "verify" && first && second && third) {
      const input = JSON.parse(fs.readFileSync(third, "utf8"));
      await verifyRelease(first, validateTrust(JSON.parse(fs.readFileSync(second, "utf8"))), input.productId, input.artifacts);
    } else throw new Error("Usage: update-signing.mjs keygen <new-key-dir> <product> <channel> <key-id> | sign <release-input.json> <new-release-dir> | verify <release-dir> <public-trust.json> <release-input.json>");
    console.log("Update signing operation succeeded");
  } catch (error) { console.error(error instanceof Error ? error.message : "Update signing failed"); process.exitCode = 1; }
}
