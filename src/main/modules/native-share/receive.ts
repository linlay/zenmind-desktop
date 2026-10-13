import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  isNativeShareBatchId,
  NATIVE_SHARE_TICKET_HEADER,
  type NativeShareTransfer
} from "../../../shared/native-share";
import { invalidBatch, changedFile, NativeShareInboxError } from "./errors";
import { NativeShareInbox, NATIVE_SHARE_MAX_MANIFEST_BYTES, parseNativeShareManifest } from "./inbox";

const MAX_HEADER_BYTES = 8192;
const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;

export type NativeShareReceiveOptions = {
  /** These are composition/test controls, never fields of a native handoff capability. */
  timeoutMs?: number;
  socketTimeoutMs?: number;
  onAcknowledgementError?(error: unknown): void;
};

export type NativeShareReceiveResult = { reused: boolean; acknowledged: boolean };
type Directory = { path: string; stat: fs.Stats };
type ResponsePolicy = {
  statuses: number[];
  maxBytes: number;
  expectedBytes?: number;
  contentType?: string;
};

function invalidTransfer(): NativeShareInboxError {
  return new NativeShareInboxError("invalid_batch", "The native share transfer is invalid.");
}

function timedOut(): NativeShareInboxError {
  return new NativeShareInboxError("io_error", "The native share transfer timed out.");
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validateTransfer(transfer: NativeShareTransfer): void {
  if (typeof transfer !== "object" || transfer === null || !isNativeShareBatchId(transfer.batchId) ||
      !Number.isSafeInteger(transfer.port) || transfer.port < 1 || transfer.port > 65535 ||
      typeof transfer.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(transfer.ticket) ||
      Object.keys(transfer).some(key => !["batchId", "port", "ticket"].includes(key))) {
    throw new NativeShareInboxError("invalid_request", "The native share handoff is invalid.");
  }
  const bytes = Buffer.from(transfer.ticket, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== transfer.ticket) {
    throw new NativeShareInboxError("invalid_request", "The native share handoff is invalid.");
  }
}

function sameDirectory(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directorySnapshot(directoryPath: string): Promise<Directory> {
  const stat = await fs.promises.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directoryPath) !== directoryPath) throw invalidBatch();
  return { path: directoryPath, stat };
}

async function assertDirectory(directory: Directory): Promise<void> {
  const current = await directorySnapshot(directory.path);
  if (!sameDirectory(current.stat, directory.stat)) throw changedFile();
}

async function ensureOwnedRoot(rootPath: string): Promise<Directory> {
  if (!path.isAbsolute(rootPath)) throw new NativeShareInboxError("invalid_request", "Desktop-owned share storage must be absolute.");
  const resolved = path.resolve(rootPath);
  let directory = path.parse(resolved).root;
  for (const component of resolved.slice(directory.length).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, component);
    try { await fs.promises.mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
    }
    // Check every parent before descending; recursive mkdir must not follow a substituted symlink.
    await directorySnapshot(directory);
  }
  return directorySnapshot(resolved);
}

async function syncDirectory(directory: Directory): Promise<void> {
  const handle = await fs.promises.open(directory.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (!sameDirectory(await handle.stat(), directory.stat)) throw changedFile();
    await handle.sync();
  } finally { await handle.close(); }
}

function parseHeaders(bytes: Buffer, policy: ResponsePolicy): number {
  const lines = bytes.toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.1 ([0-9]{3})(?: [\x20-\x7e]*)?$/u.exec(lines.shift() || "");
  if (!status || !policy.statuses.includes(Number(status[1]))) throw invalidTransfer();
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (/[^\x09\x20-\x7e]/u.test(line)) throw invalidTransfer();
    const separator = line.indexOf(":");
    if (separator <= 0) throw invalidTransfer();
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(key) || /[^\x09\x20-\x7e]/u.test(value) || headers.has(key)) throw invalidTransfer();
    headers.set(key, value);
  }
  // The extension protocol is unencoded, fixed-length, one request per TCP connection.
  const length = headers.get("content-length");
  if (!length || !/^(?:0|[1-9][0-9]*)$/u.test(length) || headers.has("transfer-encoding") || headers.has("content-encoding") ||
      headers.get("connection")?.toLowerCase() !== "close") throw invalidTransfer();
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size > policy.maxBytes ||
      (policy.expectedBytes !== undefined && size !== policy.expectedBytes) ||
      (policy.contentType !== undefined && headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== policy.contentType)) throw invalidTransfer();
  return size;
}

/** A minimal fixed-length HTTP reader also checks EOF, so trailing or truncated bodies cannot publish a batch. */
async function request(
  transfer: NativeShareTransfer,
  method: "GET" | "POST",
  requestPath: string,
  policy: ResponsePolicy,
  deadline: number,
  socketTimeoutMs: number,
  consume: (bytes: Buffer) => Promise<void>
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timedOut();
  // No hostname, URL, proxy, redirect or arbitrary path can come from the share payload.
  const socket = net.createConnection({ host: "127.0.0.1", family: 4, port: transfer.port });
  const timer = setTimeout(() => socket.destroy(timedOut()), remaining);
  socket.setTimeout(Math.min(socketTimeoutMs, remaining), () => socket.destroy(timedOut()));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${method} ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1:${transfer.port}\r\nConnection: close\r\n${NATIVE_SHARE_TICKET_HEADER}: ${transfer.ticket}\r\n${method === "POST" ? "Content-Length: 0\r\n" : ""}\r\n`);
    let header = Buffer.alloc(0);
    let expected: number | undefined;
    let received = 0;
    for await (const value of socket) {
      let bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (expected === undefined) {
        header = Buffer.concat([header, bytes]);
        const boundary = header.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (header.length > MAX_HEADER_BYTES) throw invalidTransfer();
          continue;
        }
        if (boundary + 4 > MAX_HEADER_BYTES) throw invalidTransfer();
        expected = parseHeaders(header.subarray(0, boundary), policy);
        bytes = header.subarray(boundary + 4);
        header = Buffer.alloc(0);
      }
      received += bytes.length;
      if (received > expected) throw invalidTransfer();
      if (bytes.length) await consume(bytes);
      if (Date.now() > deadline) throw timedOut();
    }
    if (expected === undefined || received !== expected) throw invalidTransfer();
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function writeAll(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten === 0) throw new NativeShareInboxError("io_error", "The native share file could not be saved.");
    offset += result.bytesWritten;
  }
}

async function writeNewFile(
  root: Directory,
  staging: Directory,
  name: string,
  size: number,
  write: (handle: fs.promises.FileHandle) => Promise<void>
): Promise<void> {
  await assertDirectory(root);
  await assertDirectory(staging);
  const filePath = path.join(staging.path, name);
  const handle = await fs.promises.open(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const original = await handle.stat();
    await assertDirectory(root);
    await assertDirectory(staging);
    await write(handle);
    await handle.sync();
    const actual = await handle.stat();
    const linked = await fs.promises.lstat(filePath);
    if (!actual.isFile() || actual.nlink !== 1 || actual.size !== size || !sameDirectory(actual, original) ||
        !linked.isFile() || linked.isSymbolicLink() || !sameDirectory(linked, actual) ||
        await fs.promises.realpath(filePath) !== filePath) throw changedFile();
    await assertDirectory(root);
    await assertDirectory(staging);
  } finally { await handle.close(); }
}

async function cachedBatch(inbox: NativeShareInbox, batchId: string, finalPath: string): Promise<boolean> {
  try { await fs.promises.lstat(finalPath); } catch (error) { if (missing(error)) return false; throw error; }
  await inbox.validate(batchId, true);
  return true;
}

export async function receiveNativeShare(
  transfer: NativeShareTransfer,
  localInboxRoot: string,
  options: NativeShareReceiveOptions = {}
): Promise<NativeShareReceiveResult> {
  validateTransfer(transfer);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const socketTimeoutMs = options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(socketTimeoutMs) || socketTimeoutMs <= 0) {
    throw new NativeShareInboxError("invalid_request", "The native share transfer deadline is invalid.");
  }
  const deadline = Date.now() + timeoutMs;
  const root = await ensureOwnedRoot(localInboxRoot);
  const inbox = new NativeShareInbox({ inbox: root.path });
  const finalPath = path.join(root.path, transfer.batchId);
  let reused = await cachedBatch(inbox, transfer.batchId, finalPath);
  let staging: Directory | undefined;
  try {
    if (!reused) {
      const stagingPath = path.join(root.path, `.${transfer.batchId}.${randomUUID()}.partial`);
      await assertDirectory(root);
      await fs.promises.mkdir(stagingPath, { mode: 0o700 });
      staging = await directorySnapshot(stagingPath);
      const manifestParts: Buffer[] = [];
      await request(transfer, "GET", `/v1/share/${transfer.batchId}/manifest`, {
        statuses: [200], maxBytes: NATIVE_SHARE_MAX_MANIFEST_BYTES, contentType: "application/json"
      }, deadline, socketTimeoutMs, async bytes => { manifestParts.push(Buffer.from(bytes)); });
      const manifest = Buffer.concat(manifestParts);
      try { new TextDecoder("utf-8", { fatal: true }).decode(manifest); } catch { throw invalidBatch(); }
      const files = parseNativeShareManifest(manifest, transfer.batchId);
      await writeNewFile(root, staging, "manifest.json", manifest.length, handle => writeAll(handle, manifest));
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        await writeNewFile(root, staging, file.name, file.sizeBytes, handle => request(transfer, "GET", `/v1/share/${transfer.batchId}/file/${index}`, {
          statuses: [200], maxBytes: file.sizeBytes, expectedBytes: file.sizeBytes, contentType: "application/octet-stream"
        }, deadline, socketTimeoutMs, bytes => writeAll(handle, bytes)));
      }
      await assertDirectory(root);
      await assertDirectory(staging);
      await syncDirectory(staging);
      // An already-published copy wins; replay cannot replace its manifest or attachments.
      reused = await cachedBatch(inbox, transfer.batchId, finalPath);
      if (!reused) {
        await fs.promises.rename(staging.path, finalPath);
        staging = undefined;
        await syncDirectory(root);
      }
      await inbox.validate(transfer.batchId, true);
    }
  } finally {
    if (staging) {
      try {
        const current = await fs.promises.lstat(staging.path);
        if (current.isDirectory() && !current.isSymbolicLink() && sameDirectory(current, staging.stat)) {
          await fs.promises.rm(staging.path, { recursive: true });
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
  }
  try {
    await request(transfer, "POST", `/v1/share/${transfer.batchId}/complete`, {
      statuses: [200, 204], maxBytes: 0, expectedBytes: 0
    }, deadline, socketTimeoutMs, async () => {});
    return { reused, acknowledged: true };
  } catch (error) {
    // The complete owned copy is sufficient to restore the draft even if the extension already exited.
    try { options.onAcknowledgementError?.(error); } catch {}
    return { reused, acknowledged: false };
  }
}
