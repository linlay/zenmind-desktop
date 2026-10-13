import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { WebsiteCredentialVaultStatus } from "../../../shared/website-credentials";

/**
 * Wraps the vault key with an operating-system facility. Implementations must
 * report `available() === false` rather than fall back to weaker protection.
 */
export type VaultKeyProtector = {
  available(): boolean;
  protect(key: Buffer): Buffer;
  unprotect(blob: Buffer): Buffer;
};

export const VAULT_FORMAT = 1;
const KEY_ENVELOPE_FILE = "key-envelope";
const VAULT_FILE = "vault";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type OpenedVault =
  | { status: { state: "ready" }; key: Buffer | null; vaultId: string | null; plaintext: Buffer | null }
  | { status: Extract<WebsiteCredentialVaultStatus, { state: "unavailable" }> };

const unavailable = (reason: Extract<WebsiteCredentialVaultStatus, { state: "unavailable" }>["reason"]): OpenedVault => ({
  status: { state: "unavailable", reason }
});

// The format and vault identity are authenticated so a vault file cannot be swapped under another key envelope.
const associatedData = (format: number, vaultId: string) => Buffer.from(`desktop-website-credentials|${format}|${vaultId}`, "utf8");

function readSmallFile(file: string): Buffer | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid vault file");
  return fs.readFileSync(file);
}

function writeFileAtomic(file: string, content: string, flag: "wx" | "replace") {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeSync(handle, content, null, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (flag === "wx" && fs.existsSync(file)) throw new Error("Vault file already exists");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseEnvelope(bytes: Buffer) {
  const value = JSON.parse(bytes.toString("utf8")) as { format?: unknown; vaultId?: unknown; protectedKey?: unknown };
  if (!Number.isInteger(value.format) || (value.format as number) < 1) throw new Error("Invalid key envelope");
  return value as { format: number; vaultId?: unknown; protectedKey?: unknown };
}

/**
 * Reads and decrypts the vault. A vault that exists but cannot be opened is reported
 * as unavailable and left untouched; it is never replaced by an empty one.
 */
export function openVaultFile(directory: string, protector: VaultKeyProtector): OpenedVault {
  if (!protector.available()) return unavailable("protectionUnavailable");
  let envelopeBytes: Buffer | null;
  let vaultBytes: Buffer | null;
  try {
    envelopeBytes = readSmallFile(path.join(directory, KEY_ENVELOPE_FILE));
    vaultBytes = readSmallFile(path.join(directory, VAULT_FILE));
  } catch {
    return unavailable("vaultCorrupted");
  }
  if (!envelopeBytes) return vaultBytes ? unavailable("keyMissing") : { status: { state: "ready" }, key: null, vaultId: null, plaintext: null };

  let vaultId: string;
  let protectedKey: Buffer;
  try {
    const envelope = parseEnvelope(envelopeBytes);
    if (envelope.format > VAULT_FORMAT) return unavailable("vaultTooNew");
    if (typeof envelope.vaultId !== "string" || !envelope.vaultId || typeof envelope.protectedKey !== "string") throw new Error("Invalid key envelope");
    vaultId = envelope.vaultId;
    protectedKey = Buffer.from(envelope.protectedKey, "base64");
  } catch {
    return unavailable("vaultCorrupted");
  }
  let key: Buffer;
  try {
    key = protector.unprotect(protectedKey);
  } catch {
    return unavailable("keyRejected");
  }
  if (key.length !== KEY_BYTES) return unavailable("keyRejected");
  if (!vaultBytes) return { status: { state: "ready" }, key, vaultId, plaintext: null };

  try {
    const stored = JSON.parse(vaultBytes.toString("utf8")) as { format?: unknown; vaultId?: unknown; nonce?: unknown; ciphertext?: unknown; tag?: unknown };
    if (!Number.isInteger(stored.format) || (stored.format as number) < 1) throw new Error("Invalid vault");
    if ((stored.format as number) > VAULT_FORMAT) return unavailable("vaultTooNew");
    if (stored.vaultId !== vaultId || typeof stored.nonce !== "string" || typeof stored.ciphertext !== "string" || typeof stored.tag !== "string") throw new Error("Invalid vault");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.nonce, "base64"));
    decipher.setAAD(associatedData(stored.format as number, vaultId));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]);
    return { status: { state: "ready" }, key, vaultId, plaintext };
  } catch {
    return unavailable("vaultCorrupted");
  }
}

/**
 * Encrypts and atomically replaces the vault. `key`/`vaultId` come from the
 * `openVaultFile` result of the same operation; a first write creates both.
 */
export function writeVaultFile(
  directory: string,
  protector: VaultKeyProtector,
  opened: { key: Buffer | null; vaultId: string | null },
  plaintext: Buffer
) {
  let { key, vaultId } = opened;
  if (!key || !vaultId) {
    key = randomBytes(KEY_BYTES);
    vaultId = randomUUID();
    const envelope = { format: VAULT_FORMAT, vaultId, protectedKey: protector.protect(key).toString("base64") };
    // "wx": a concurrent or pre-existing envelope must never be overwritten, or its vault becomes unreadable.
    writeFileAtomic(path.join(directory, KEY_ENVELOPE_FILE), `${JSON.stringify(envelope)}\n`, "wx");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(VAULT_FORMAT, vaultId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const stored = {
    format: VAULT_FORMAT,
    vaultId,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
  writeFileAtomic(path.join(directory, VAULT_FILE), `${JSON.stringify(stored)}\n`, "replace");
}
