import type { App } from "electron";
import { readJsonFile, installedRecordsPath } from "./market-paths";
import type { InstalledRecord } from "./market-model";
import { normalizeMarketItemType } from "./catalog-normalization";
import path from "node:path";
import fs from "node:fs";
import type { MarketItemType } from "../../../shared/contracts";

export function readInstalledRecords(app: App) {
  const parsed = readJsonFile<{ records?: InstalledRecord[] }>(installedRecordsPath(app), { records: [] });
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  return records
    .map((record): InstalledRecord | null => {
      const type = normalizeMarketItemType(record?.type);
      if (!record || typeof record.id !== "string" || !type) {
        return null;
      }
      return { ...record, type, skillPackage: record.skillPackage === true || undefined };
    })
    .filter((record): record is InstalledRecord => Boolean(record));
}

export function writeInstalledRecords(app: App, records: InstalledRecord[]) {
  const targetPath = installedRecordsPath(app);
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.tmp`);
  const backupPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.bak`);
  let backupActive = false;
  let targetPublished = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ records }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      backupActive = true;
    }
    fs.renameSync(temporaryPath, targetPath);
    targetPublished = true;
  } catch (error) {
    if (targetPublished) {
      fs.rmSync(targetPath, { force: true });
    }
    if (backupActive && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
      backupActive = false;
    }
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  if (backupActive) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // The new record is already committed; hidden backup cleanup is best effort.
    }
  }
}

export function upsertInstalledRecord(app: App, record: InstalledRecord) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === record.id && item.type === record.type));
  records.push(record);
  writeInstalledRecords(app, records);
}

export function removeInstalledRecord(app: App, itemId: string, type?: MarketItemType) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === itemId && (!type || item.type === type)));
  writeInstalledRecords(app, records);
}

export function removeInstalledRecordByResourceKey(app: App, resourceKey: string, type: MarketItemType) {
  const records = readInstalledRecords(app).filter((item) => !(
    item.type === type && (item.id === resourceKey || item.resourceKey === resourceKey)
  ));
  writeInstalledRecords(app, records);
}

export function replaceInstalledRecords(app: App, records: InstalledRecord[]) {
  writeInstalledRecords(app, records);
}
