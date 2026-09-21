import fs from "node:fs";
import { type Manifest } from "../../../shared/contracts";
import { listArchiveEntries, readFileFromArchive } from "../archive/archive-utils";

export function readManifestFile(manifestPath: string) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

export function listTarEntries(archivePath: string) {
  return [...listArchiveEntries(archivePath)];
}

export function findManifestEntry(archivePath: string) {
  return listTarEntries(archivePath).find((entry) => entry.endsWith("/manifest.json") || entry.endsWith("\\manifest.json") || entry === "manifest.json") ?? null;
}

export function readManifestFromArchive(archivePath: string) {
  const manifestEntry = findManifestEntry(archivePath);
  if (!manifestEntry) {
    throw new Error(`archive does not contain manifest.json: ${archivePath}`);
  }

  const manifestContent = readFileFromArchive(archivePath, manifestEntry);
  return JSON.parse(manifestContent) as Manifest;
}
