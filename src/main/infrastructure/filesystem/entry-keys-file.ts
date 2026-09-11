import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function normalizeEntryKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === "string").map((key) => key.trim()).filter(Boolean))]
    : [];
}

export function readEntryKeysFile(filePath: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1) throw new Error(`Unsupported entry keys schema: ${filePath}`);
    if (Array.isArray(record.entryKeys)) return normalizeEntryKeys(record.entryKeys);
  }
  throw new Error(`Invalid entry keys file: ${filePath}`);
}

export function writeEntryKeysFile(filePath: string, keys: unknown): string[] {
  const entryKeys = normalizeEntryKeys(keys);
  const serialized = `${JSON.stringify({ schemaVersion: 1, entryKeys }, null, 2)}\n`;
  // Compare the actual file, not a cache: external edits/deletion must still be repaired.
  // Identical bytes need no replacement on either Windows or macOS.
  try {
    if (fs.readFileSync(filePath, "utf8") === serialized) return entryKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
    // Same-directory rename atomically replaces the file on both macOS and Windows.
    // A failed replacement must leave the confirmed file intact.
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return entryKeys;
}
