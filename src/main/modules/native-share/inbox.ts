import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  NATIVE_SHARE_CHUNK_BYTES,
  NATIVE_SHARE_MAX_BYTES,
  NATIVE_SHARE_MAX_FILES,
  type NativeShareFileDescriptor
} from "../../../shared/native-share";
import { alreadyCompleted, changedFile, invalidBatch, staleTarget } from "./errors";

const MANIFEST_NAME = "manifest.json";
const COMPLETED_NAME = ".completed.json";
export const NATIVE_SHARE_MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILENAME_BYTES = 240;

type Snapshot = { path: string; stat: fs.Stats };
type SharedFile = Snapshot & NativeShareFileDescriptor;

export type ValidatedShareBatch = {
  id: string;
  root: Snapshot;
  directory: Snapshot;
  manifest: Snapshot;
  files: SharedFile[];
};

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." &&
    !/[\/\\\p{Cc}]/u.test(value) && Buffer.byteLength(value, "utf8") <= MAX_FILENAME_BYTES &&
    ![MANIFEST_NAME, COMPLETED_NAME].includes(value.normalize("NFD").toLowerCase());
}

function mimeType(name: string): string {
  const mimeTypes: Record<string, string> = {
    ".zip": "application/zip", ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".pdf": "application/pdf", ".xml": "application/xml",
    ".htm": "text/html", ".html": "text/html", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return mimeTypes[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function directorySnapshot(directory: string): Promise<Snapshot> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) throw invalidBatch();
  return { path: directory, stat };
}

async function fileSnapshot(filePath: string): Promise<Snapshot> {
  const stat = await fs.promises.lstat(filePath);
  // Extension-owned copies have one link; reject links into another source as well as symlinks.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) ||
      await fs.promises.realpath(filePath) !== filePath) throw invalidBatch();
  return { path: filePath, stat };
}

async function assertDirectory(snapshot: Snapshot): Promise<void> {
  const current = await directorySnapshot(snapshot.path);
  if (!sameIdentity(current.stat, snapshot.stat)) throw changedFile();
}

async function assertFile(snapshot: Snapshot): Promise<void> {
  const current = await fileSnapshot(snapshot.path);
  if (!sameFile(current.stat, snapshot.stat)) throw changedFile();
}

async function assertNotCompleted(batch: Pick<ValidatedShareBatch, "directory">): Promise<void> {
  try {
    const marker = await fs.promises.lstat(path.join(batch.directory.path, COMPLETED_NAME));
    if (!marker.isFile() || marker.isSymbolicLink()) throw invalidBatch();
    throw alreadyCompleted();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function openSnapshot(snapshot: Snapshot): Promise<FileHandle> {
  const handle = await fs.promises.open(snapshot.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(snapshot.stat, stat)) throw changedFile();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readExact(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) throw changedFile();
    filled += bytesRead;
  }
  return buffer;
}

export function parseNativeShareManifest(bytes: Buffer, id: string): Array<{ name: string; sizeBytes: number }> {
  let manifest: unknown;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw invalidBatch(); }
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || manifest.version !== 1 ||
      !("id" in manifest) || manifest.id !== id || !("files" in manifest) || !Array.isArray(manifest.files) ||
      manifest.files.length === 0 || manifest.files.length > NATIVE_SHARE_MAX_FILES) throw invalidBatch();
  const names = new Set<string>();
  let totalBytes = 0;
  return manifest.files.map((file: unknown) => {
    if (typeof file !== "object" || file === null || !("name" in file) || !safeName(file.name) ||
        !("sizeBytes" in file) || typeof file.sizeBytes !== "number" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw invalidBatch();
    const nameKey = file.name.normalize("NFD").toLowerCase();
    if (names.has(nameKey)) throw invalidBatch();
    names.add(nameKey);
    totalBytes += file.sizeBytes;
    if (totalBytes > NATIVE_SHARE_MAX_BYTES) throw invalidBatch();
    return { name: file.name, sizeBytes: file.sizeBytes };
  });
}

export class NativeShareInbox {
  constructor(private readonly options: { inbox: string }) {}

  private rootPath(): string {
    return path.resolve(this.options.inbox);
  }

  async validate(id: string, allowCompleted = false): Promise<ValidatedShareBatch> {
    const root = await directorySnapshot(this.rootPath());
    const directory = await directorySnapshot(path.join(root.path, id));
    if (!allowCompleted) await assertNotCompleted({ directory });
    const manifest = await fileSnapshot(path.join(directory.path, MANIFEST_NAME));
    if (manifest.stat.size === 0 || manifest.stat.size > NATIVE_SHARE_MAX_MANIFEST_BYTES) throw invalidBatch();
    const manifestHandle = await openSnapshot(manifest);
    let bytes: Buffer;
    try {
      bytes = await readExact(manifestHandle, 0, manifest.stat.size);
      if (!sameFile(await manifestHandle.stat(), manifest.stat)) throw changedFile();
    } finally { await manifestHandle.close(); }
    const files: SharedFile[] = [];
    for (const file of parseNativeShareManifest(bytes, id)) {
      const snapshot = await fileSnapshot(path.join(directory.path, file.name));
      if (snapshot.stat.size !== file.sizeBytes) throw invalidBatch();
      files.push({ ...snapshot, ...file, mimeType: mimeType(file.name) });
    }
    const batch = { id, root, directory, manifest, files };
    await this.assertStable(batch, allowCompleted);
    return batch;
  }

  async assertStable(batch: ValidatedShareBatch, allowCompleted = false): Promise<void> {
    await assertDirectory(batch.root);
    await assertDirectory(batch.directory);
    if (!allowCompleted) await assertNotCompleted(batch);
    await assertFile(batch.manifest);
    for (const file of batch.files) await assertFile(file);
    await assertDirectory(batch.root);
    await assertDirectory(batch.directory);
    if (!allowCompleted) await assertNotCompleted(batch);
    else await this.hasReceipt(batch);
  }

  private async hasReceipt(batch: ValidatedShareBatch): Promise<boolean> {
    const markerPath = path.join(batch.directory.path, COMPLETED_NAME);
    try { await fs.promises.lstat(markerPath); } catch (error) { if (isMissing(error)) return false; throw error; }
    const snapshot = await fileSnapshot(markerPath);
    if (snapshot.stat.size === 0 || snapshot.stat.size > 1024) throw invalidBatch();
    const handle = await openSnapshot(snapshot);
    let receipt: unknown;
    try {
      const bytes = await readExact(handle, 0, snapshot.stat.size);
      if (!sameFile(await handle.stat(), snapshot.stat)) throw changedFile();
      try { receipt = JSON.parse(bytes.toString("utf8")); } catch { throw invalidBatch(); }
    } finally { await handle.close(); }
    if (typeof receipt !== "object" || receipt === null || !("version" in receipt) || receipt.version !== 1 ||
        !("id" in receipt) || receipt.id !== batch.id || !("completedAt" in receipt) ||
        typeof receipt.completedAt !== "number" || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt <= 0) throw invalidBatch();
    await assertFile(snapshot);
    return true;
  }

  async read(batch: ValidatedShareBatch, fileIndex: number, offset: number, allowCompleted = false): Promise<Buffer> {
    await this.assertStable(batch, allowCompleted);
    const file = batch.files[fileIndex];
    const handle = await openSnapshot(file);
    try {
      const bytes = await readExact(handle, offset, Math.min(NATIVE_SHARE_CHUNK_BYTES, file.sizeBytes - offset));
      if (!sameFile(await handle.stat(), file.stat)) throw changedFile();
      await this.assertStable(batch, allowCompleted);
      return bytes;
    } finally { await handle.close(); }
  }

  async complete(batch: ValidatedShareBatch, isStillActive: () => boolean): Promise<void> {
    await this.assertStable(batch, true);
    // The atomic receipt may exist even when a prior acknowledgement was lost or directory fsync failed.
    if (await this.hasReceipt(batch)) {
      await this.assertStable(batch, true);
      if (!isStillActive()) throw staleTarget();
      return;
    }
    await this.assertStable(batch);
    const temporaryPath = path.join(batch.directory.path, `.completed-${randomUUID()}.tmp`);
    const markerPath = path.join(batch.directory.path, COMPLETED_NAME);
    let handle: FileHandle | undefined;
    let temporaryIdentity: fs.Stats | undefined;
    try {
      handle = await fs.promises.open(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      temporaryIdentity = await handle.stat();
      await this.assertStable(batch);
      if (!isStillActive()) throw staleTarget();
      await handle.writeFile(JSON.stringify({ version: 1, id: batch.id, completedAt: Date.now() }));
      await handle.sync();
      const written = await handle.stat();
      const current = await fileSnapshot(temporaryPath);
      if (!sameFile(current.stat, written) || !sameIdentity(written, temporaryIdentity)) throw changedFile();
      await this.assertStable(batch);
      if (!isStillActive()) throw staleTarget();
      // link() commits the fully written record atomically and cannot overwrite an existing receipt.
      await fs.promises.link(temporaryPath, markerPath);
      const directory = await fs.promises.open(batch.directory.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(await directory.stat(), batch.directory.stat)) throw changedFile();
        await directory.sync();
      } finally { await directory.close(); }
    } finally {
      if (handle) await handle.close();
      if (temporaryIdentity) {
        try {
          const stat = await fs.promises.lstat(temporaryPath);
          if (sameIdentity(stat, temporaryIdentity)) await fs.promises.unlink(temporaryPath);
        } catch (error) { if (!isMissing(error)) throw error; }
      }
    }
  }
}
