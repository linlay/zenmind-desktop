import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { WEBSITE_CREDENTIAL_BACKUP_PASSWORD_MIN_LENGTH, WebsiteCredentialError, type WebsiteCredentialInput } from "../../../shared/website-credentials";

export const WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS = 5000;

export type WebsiteCredentialTransferEntry = WebsiteCredentialInput & { agentAllowed?: boolean };

/** RFC 4180: quoted fields, doubled quotes, and line breaks inside quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"' && !field) quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
      if (rows.length > WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS + 1) throw new WebsiteCredentialError("importTooLarge");
    } else field += char;
  }
  row.push(field);
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

// Column names used by the password exports of Chrome/Edge, Firefox, Safari and Bitwarden.
const CSV_COLUMNS = {
  origin: ["url", "login_uri", "website"],
  username: ["username", "login_username"],
  password: ["password", "login_password"],
  note: ["note", "notes"]
} as const;

/**
 * Reads a browser password export. Rows that cannot become a credential (no HTTPS
 * address, missing username or password) are counted by the store, not rejected here.
 */
export function parseWebsiteCredentialCsv(bytes: Buffer): WebsiteCredentialTransferEntry[] {
  if (bytes.length > WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES) throw new WebsiteCredentialError("importTooLarge");
  const [header, ...rows] = parseCsvRows(bytes.toString("utf8").replace(/^﻿/u, ""));
  if (!header) throw new WebsiteCredentialError("importUnrecognized");
  const names = header.map(name => name.trim().toLowerCase());
  const column = (candidates: readonly string[]) => names.findIndex(name => candidates.includes(name));
  const origin = column(CSV_COLUMNS.origin);
  const username = column(CSV_COLUMNS.username);
  const password = column(CSV_COLUMNS.password);
  const note = column(CSV_COLUMNS.note);
  if (origin < 0 || username < 0 || password < 0) throw new WebsiteCredentialError("importUnrecognized");
  if (rows.length > WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS) throw new WebsiteCredentialError("importTooLarge");
  return rows.map(row => ({ origin: row[origin] ?? "", username: row[username] ?? "", password: row[password] ?? "", note: note < 0 ? "" : row[note] ?? "" }));
}

const BACKUP_KIND = "desktop-website-credentials-backup";
const BACKUP_FORMAT = 1;
// Interactive-login cost: the backup leaves the machine, so the export password is all that protects it.
const SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const scryptKey = (password: string, salt: Buffer, cost: { N: number; r: number; p: number }) =>
  scryptSync(password.normalize("NFKC"), salt, 32, { ...cost, maxmem: 256 * 1024 * 1024 });
const backupAad = Buffer.from(`${BACKUP_KIND}|${BACKUP_FORMAT}`, "utf8");

export function isWebsiteCredentialBackup(bytes: Buffer) {
  try {
    return (JSON.parse(bytes.toString("utf8")) as { kind?: unknown }).kind === BACKUP_KIND;
  } catch {
    return false;
  }
}

export function encryptWebsiteCredentialBackup(entries: WebsiteCredentialTransferEntry[], password: unknown): Buffer {
  if (typeof password !== "string" || password.length < WEBSITE_CREDENTIAL_BACKUP_PASSWORD_MIN_LENGTH || password.length > 1024) throw new WebsiteCredentialError("invalidInput");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptKey(password, salt, SCRYPT), nonce);
  cipher.setAAD(backupAad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ credentials: entries }), "utf8"), cipher.final()]);
  return Buffer.from(`${JSON.stringify({
    kind: BACKUP_KIND,
    format: BACKUP_FORMAT,
    kdf: { name: "scrypt", ...SCRYPT, salt: salt.toString("base64") },
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  })}\n`, "utf8");
}

export function decryptWebsiteCredentialBackup(bytes: Buffer, password: unknown): WebsiteCredentialTransferEntry[] {
  if (bytes.length > WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES * 2) throw new WebsiteCredentialError("importTooLarge");
  if (typeof password !== "string" || !password) throw new WebsiteCredentialError("backupPasswordIncorrect");
  let stored: any;
  try {
    stored = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WebsiteCredentialError("importUnrecognized");
  }
  if (stored?.kind !== BACKUP_KIND || stored.format !== BACKUP_FORMAT || stored.kdf?.name !== "scrypt"
    // The cost parameters come from the file: accept only what this version writes, so a crafted file cannot exhaust memory.
    || stored.kdf.N !== SCRYPT.N || stored.kdf.r !== SCRYPT.r || stored.kdf.p !== SCRYPT.p
    || [stored.kdf.salt, stored.nonce, stored.ciphertext, stored.tag].some(value => typeof value !== "string")) {
    throw new WebsiteCredentialError("importUnrecognized");
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", scryptKey(password, Buffer.from(stored.kdf.salt, "base64"), SCRYPT), Buffer.from(stored.nonce, "base64"));
    decipher.setAAD(backupAad);
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // An authentication failure is a wrong password or a damaged file; the two are indistinguishable.
    throw new WebsiteCredentialError("backupPasswordIncorrect");
  }
  const entries = (JSON.parse(plaintext) as { credentials?: unknown }).credentials;
  if (!Array.isArray(entries) || entries.length > WEBSITE_CREDENTIAL_IMPORT_MAX_ROWS) throw new WebsiteCredentialError("importUnrecognized");
  return entries.map(entry => ({ origin: entry?.origin, username: entry?.username, password: entry?.password, note: entry?.note, agentAllowed: entry?.agentAllowed }));
}
