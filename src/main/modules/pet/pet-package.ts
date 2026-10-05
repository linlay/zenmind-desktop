import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { hasForbiddenDesktopPetManifestKey, sanitizeDesktopPetStates, sanitizeDesktopPetSignatureActions, isForbiddenDesktopPetAssetPath } from "./pet-assets";
const limits = { archiveBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, manifestBytes: 64 * 1024, entries: 256 };
export class PetPackageError extends Error {
  constructor(public readonly code: "invalidPackage" | "packageTooLarge" | "packageExists" | "storageFailed") { super(code); }
}
function safePath(name: string) {
  if (!name || name.includes("\\") || name.includes(":") || name.split("/").some(part => !part || part === "." || part === ".." || /[<>"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))
    throw new PetPackageError("invalidPackage");
  return name;
}
async function boundedFile(file: string, limit: number) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new PetPackageError("invalidPackage");
  if (stat.size > limit)
    throw new PetPackageError("packageTooLarge");
  const handle = await fs.open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new PetPackageError("invalidPackage");
    const data = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let size = 0;
    while (size < data.length) {
      const read = await handle.read(data, size, data.length - size, null);
      if (!read.bytesRead)
        break;
      size += read.bytesRead;
    }
    if (size > limit)
      throw new PetPackageError("packageTooLarge");
    if (size !== stat.size)
      throw new PetPackageError("invalidPackage");
    return data.subarray(0, size);
  }
  finally {
    await handle.close();
  }
}
const invalid = () => new PetPackageError("invalidPackage");
// Check the central-directory count before JSZip creates its name map, so
// duplicate or sanitized paths cannot silently hide extra entries. ZIP64 and
// multipart archives are unnecessary for these deliberately small packages.
function entryCount(data: Buffer) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557)) {
    if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length)
      break;
    end--;
  }
  if (end < Math.max(0, data.length - 65557))
    throw invalid();
  const count = data.readUInt16LE(end + 10);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || !count)
    throw invalid();
  if (count > limits.entries)
    throw new PetPackageError("packageTooLarge");
  if (data.readUInt32LE(end + 12) === 0xffffffff || data.readUInt32LE(end + 16) === 0xffffffff)
    throw invalid();
  return count;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data)
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
type ZipData = {
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
};
const metadata = (entry: JSZip.JSZipObject) => (entry as unknown as {
  _data: ZipData;
})._data;
// Never inflate unchecked entries via async('nodebuffer') or checkCRC32:true:
// declared sizes may lie. Stop the stream at the real output limit, then check
// length and CRC before JSON parsing or handing raster bytes to the decoder.
function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, failed = false;
    // JSZip exposes this on ZipObject; its typings currently omit the method.
    const stream = (entry as JSZip.JSZipObject & {
      internalStream(type: "nodebuffer"): JSZip.JSZipStreamHelper<Buffer>;
    }).internalStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      if (failed)
        return;
      length += chunk.length;
      if (length > limit) {
        failed = true;
        stream.pause();
        chunks.length = 0;
        reject(new PetPackageError("packageTooLarge"));
      }
      else
        chunks.push(chunk);
    });
    stream.on("error", () => { failed = true; reject(invalid()); });
    stream.on("end", () => {
      if (failed)
        return;
      const result = Buffer.concat(chunks);
      const declared = metadata(entry);
      if (result.length !== declared.uncompressedSize || crc32(result) !== (declared.crc32 >>> 0))
        reject(invalid());
      else
        resolve(result);
    });
    stream.resume();
  });
}
async function packageFiles(input: string) {
  const stat = await fs.lstat(input);
  if (stat.isSymbolicLink())
    throw invalid();
  const files = new Map<string, () => Promise<Buffer>>();
  let total = 0, count = 0;
  const addSize = (size: number) => {
    total += size;
    if (!Number.isSafeInteger(size) || size < 0)
      throw invalid();
    if (++count > limits.entries || size > limits.fileBytes || total > limits.expandedBytes)
      throw new PetPackageError("packageTooLarge");
  };
  if (stat.isDirectory()) {
    const walk = async (dir: string, prefix = "") => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".DS_Store" || entry.name === "__MACOSX")
          continue;
        const name = safePath(prefix + entry.name), file = path.join(dir, entry.name);
        const info = await fs.lstat(file);
        if (info.isSymbolicLink())
          throw invalid();
        if (info.isDirectory()) {
          addSize(0);
          await walk(file, name + "/");
        }
        else {
          if (!info.isFile())
            throw invalid();
          addSize(info.size);
          files.set(name, () => boundedFile(file, limits.fileBytes));
        }
      }
    };
    await walk(input);
  }
  else {
    if (!stat.isFile() || path.extname(input).toLowerCase() !== ".zip")
      throw invalid();
    const data = await boundedFile(input, limits.archiveBytes);
    const count = entryCount(data);
    const zip = await JSZip.loadAsync(data, { createFolders: false });
    const entries = Object.values(zip.files);
    if (entries.length !== count)
      throw invalid();
    const names = new Set<string>();
    for (const entry of entries) {
      const raw = (entry as JSZip.JSZipObject & {
        unsafeOriginalName?: string;
      }).unsafeOriginalName ?? entry.name;
      const name = safePath(entry.dir ? raw.replace(/\/$/u, "") : raw);
      if (name !== (entry.dir ? entry.name.replace(/\/$/u, "") : entry.name) || names.has(name.toLowerCase()))
        throw invalid();
      names.add(name.toLowerCase());
      const type = typeof entry.unixPermissions === "number" ? entry.unixPermissions & 0o170000 : 0;
      if (type && type !== (entry.dir ? 0o040000 : 0o100000))
        throw invalid();
      if (entry.dir)
        continue;
      const meta = metadata(entry);
      if (!meta)
        throw invalid();
      addSize(meta.uncompressedSize);
      if (name.startsWith("__MACOSX/") || name.split("/").at(-1) === ".DS_Store")
        continue;
      files.set(name, () => readEntry(entry, limits.fileBytes));
    }
  }
  const names = [...files.keys()];
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length)
    throw invalid();
  return files;
}
// Inspect dimensions before native decode, so a tiny compressed image cannot allocate an unbounded bitmap.
function rasterSize(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR")
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X")
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  throw invalid();
}
function checkSize(width: number, height: number, frames: number) {
  if (!width || !height || width % frames || width > 32768 || height > 4096 || width * height > 16 * 1024 * 1024)
    throw invalid();
}
export async function readPetPackage(input: string) {
  try {
    const files = await packageFiles(input);
    const manifests = [...files.keys()].filter(name => name === "pet.json" || /^[^/]+\/pet\.json$/u.test(name));
    if (manifests.length !== 1)
      throw invalid();
    const manifestBytes = await files.get(manifests[0])!();
    if (manifestBytes.length > limits.manifestBytes)
      throw new PetPackageError("packageTooLarge");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" || hasForbiddenDesktopPetManifestKey(manifest) ||
      typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(manifest.id) ||
      typeof manifest.displayName !== "string" || !manifest.displayName.trim() || typeof manifest.version !== "string" || !manifest.version.trim())
      throw invalid();
    safePath(manifest.id);
    const states = sanitizeDesktopPetStates(manifest.states);
    if (!states)
      throw invalid();
    const resources = new Map<string, number>();
    function asset(name: unknown, frames: number) {
      if (typeof name !== "string" || isForbiddenDesktopPetAssetPath(name) || !/\.(png|webp)$/iu.test(safePath(name)))
        throw invalid();
      if (resources.has(name) && resources.get(name) !== frames && resources.get(name) !== 1 && frames !== 1)
        throw invalid();
      resources.set(name, Math.max(resources.get(name) ?? 1, frames));
    }
    asset(manifest.preview, 1);
    function signatures(raw: unknown) {
      if (raw === undefined)
        return;
      if (!Array.isArray(raw))
        throw invalid();
      const parsed = sanitizeDesktopPetSignatureActions(raw);
      if (raw.length && (!parsed || parsed.length !== raw.length))
        throw invalid();
      for (const action of raw) {
        if (!Array.isArray(action.trigger) || !action.trigger.length || action.trigger.some((trigger: unknown) => trigger !== "manual" && trigger !== "idle-random"))
          throw invalid();
        if (!Array.isArray(action.variants) || !action.variants.length)
          throw invalid();
        for (const v of action.variants) {
          if (!Number.isInteger(v.frameCount) || v.frameCount < 1 || v.frameCount > 120 || !Number.isFinite(v.durationMs) || v.durationMs <= 0)
            throw invalid();
          asset(v.path, v.frameCount);
        }
      }
    }
    for (const [key, state] of Object.entries(states)) {
      const raw = manifest.states[key];
      if (!Number.isInteger(raw.frameCount) || raw.frameCount < 4 || raw.frameCount > 8 || !Number.isFinite(raw.durationMs) || raw.durationMs <= 0)
        throw invalid();
      asset(raw.path, state!.frameCount!);
      signatures(raw.alts);
    }
    signatures(manifest.signature);
    const prefix = manifests[0].slice(0, -8);
    const allowed = new Set([manifests[0], ...[...resources.keys()].map(n => prefix + n)]);
    if ([...files.keys()].some(name => !allowed.has(name)))
      throw invalid();
    const images = new Map<string, Buffer>();
    const { loadImage } = await import("@napi-rs/canvas");
    for (const [name, frames] of resources) {
      const read = files.get(prefix + name);
      if (!read)
        throw invalid();
      const bytes = await read();
      const [width, height] = rasterSize(bytes);
      checkSize(width, height, frames);
      const image = await loadImage(bytes);
      if (image.width !== width || image.height !== height)
        throw invalid();
      images.set(name, bytes);
    }
    return { manifest, images };
  }
  catch (error) {
    if (error instanceof PetPackageError)
      throw error;
    throw invalid();
  }
}
export async function installLocalPetPackage(input: string, root: string, assertOwner = () => { }) {
  const { manifest, images } = await readPetPackage(input);
  assertOwner();
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, manifest.id);
  try {
    await fs.lstat(target);
    throw new PetPackageError("packageExists");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  }
  const stage = await fs.mkdtemp(path.join(root, ".pet-import-"));
  try {
    for (const [name, bytes] of images) {
      const dest = path.join(stage, name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes, { flag: "wx" });
    }
    await fs.writeFile(path.join(stage, "pet.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    assertOwner();
    // Existing identities are never replaced; the IPC serializes local imports.
    try {
      await fs.lstat(target);
      throw new PetPackageError("packageExists");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    await fs.rename(stage, target);
    return `user:${manifest.id}`;
  }
  finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
