const { createPublicKey, verify, createHash } = require("node:crypto");

/** @typedef {{productId: string, publicKey: string}} UpdateKey */
/** @typedef {{keys: UpdateKey[]}} UpdateTrust */
/** @param {unknown} value @returns {UpdateTrust} */
function validateTrust(value) {
  const input = /** @type {UpdateTrust} */ (value);
  if (!input || !Array.isArray(input.keys) || input.keys.length > 8) throw new Error("Invalid update trust configuration");
  const publicKeys = new Set();
  for (const key of input.keys) {
    if (!key || typeof key.productId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(key.productId) || typeof key.publicKey !== "string" || !key.publicKey.startsWith("-----BEGIN PUBLIC KEY-----") || key.publicKey.length > 1024 || createPublicKey(key.publicKey).asymmetricKeyType !== "ed25519") throw new Error("Invalid update public key");
    const identity = createPublicKey(key.publicKey).export({ type: "spki", format: "der" }).toString("base64");
    if (publicKeys.has(identity)) throw new Error("Duplicate update public key");
    publicKeys.add(identity);
  }
  return { keys: input.keys.map(key => ({ productId: key.productId, publicKey: String(createPublicKey(key.publicKey).export({ type: "spki", format: "pem" })) })) };
}

/** Verify exact UTF-8 bytes before parsing any fields.
 * @param {unknown} input @param {UpdateTrust} trust @param {string} productId
 * @returns {{value: Record<string, any>, digest: string}}
 */
function verifySignedManifest(input, trust, productId) {
  const envelope = /** @type {{manifest?: unknown, signature?: unknown}} */ (input);
  if (!envelope || typeof envelope.manifest !== "string" || Buffer.byteLength(envelope.manifest) > 256 * 1024 || typeof envelope.signature !== "string" || envelope.signature.length > 128) throw new Error("signatureInvalid");
  const signatureText = envelope.signature.replace(/\r?\n$/, "");
  const signature = Buffer.from(signatureText, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signatureText) throw new Error("signatureInvalid");
  const bytes = Buffer.from(envelope.manifest, "utf8");
  const keys = validateTrust(trust).keys.filter(key => key.productId === productId);
  const key = keys.find(key => verify(null, bytes, key.publicKey, signature));
  if (!key) throw new Error("signatureInvalid");
  const value = JSON.parse(envelope.manifest);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.productId !== productId) throw new Error("signatureInvalid");
  return { value, digest: createHash("sha256").update(bytes).digest("hex") };
}
exports.validateTrust = validateTrust;
exports.verifySignedManifest = verifySignedManifest;
