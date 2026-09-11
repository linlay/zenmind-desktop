import JSZip from "jszip";
import { readBoundedFile } from "./appearance-files";
import { BackgroundImageError } from "./appearance-images";
import { SKIN_PACKAGE_LIMITS as limits, SkinPackageError, validateSkinResourcePath, parseSkinPackageManifest } from "../../../shared/desktop-skin-package";

const invalid = () => new SkinPackageError("invalidPackage");
// Check the central-directory count before JSZip creates its name map, so
// duplicate or sanitized paths cannot silently hide extra entries. ZIP64 and
// multipart archives are unnecessary for these deliberately small packages.
function entryCount(data: Buffer) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557)) {
    if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break;
    end--;
  }
  if (end < Math.max(0, data.length - 65557)) throw invalid();
  const count = data.readUInt16LE(end + 10);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || !count) throw invalid();
  if (count > limits.entries) throw new SkinPackageError("packageTooLarge");
  if (data.readUInt32LE(end + 12) === 0xffffffff || data.readUInt32LE(end + 16) === 0xffffffff) throw invalid();
  return count;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
type ZipData = { compressedSize: number; uncompressedSize: number; crc32: number };
const metadata = (entry: JSZip.JSZipObject) => (entry as unknown as { _data: ZipData })._data;

// Never inflate unchecked entries via async('nodebuffer') or checkCRC32:true:
// declared sizes may lie. Stop the stream at the real output limit, then check
// length and CRC before JSON parsing or handing raster bytes to the decoder.
function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, failed = false;
    // JSZip exposes this on ZipObject; its typings currently omit the method.
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: "nodebuffer"): JSZip.JSZipStreamHelper<Buffer> }).internalStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      length += chunk.length;
      if (length > limit) {
        failed = true; stream.pause(); chunks.length = 0;
        reject(new SkinPackageError("packageTooLarge"));
      } else chunks.push(chunk);
    });
    stream.on("error", () => { failed = true; reject(invalid()); });
    stream.on("end", () => {
      if (failed) return;
      const result = Buffer.concat(chunks);
      const declared = metadata(entry);
      if (result.length !== declared.uncompressedSize || crc32(result) !== (declared.crc32 >>> 0)) reject(invalid());
      else resolve(result);
    });
    stream.resume();
  });
}

export async function readSkinPackageArchive(filePath: string) {
  let data: Buffer;
  try { data = readBoundedFile(filePath, limits.archiveBytes); }
  catch (error) {
    if (error instanceof BackgroundImageError) throw new SkinPackageError(error.code === "imageTooLarge" ? "packageTooLarge" : "invalidPackage");
    throw error;
  }
  try {
    const count = entryCount(data);
    const zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
    const entries = Object.values(zip.files);
    if (entries.length !== count) throw invalid();
    const names = new Set<string>();
    const files = new Map<string, JSZip.JSZipObject>();
    let expanded = 0;
    for (const entry of entries) {
      const raw = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      const name = validateSkinResourcePath(entry.dir ? raw.replace(/\/$/, "") : raw);
      if (name !== (entry.dir ? entry.name.replace(/\/$/, "") : entry.name) || names.has(name.toLowerCase())) throw invalid();
      names.add(name.toLowerCase());
      const type = typeof entry.unixPermissions === "number" ? entry.unixPermissions & 0o170000 : 0;
      if (type && type !== (entry.dir ? 0o040000 : 0o100000)) throw invalid();
      if (entry.dir) continue;
      const declared = metadata(entry);
      if (!declared || !Number.isSafeInteger(declared.uncompressedSize) || declared.uncompressedSize < 0) throw invalid();
      expanded += declared.uncompressedSize;
      if (declared.uncompressedSize > limits.fileBytes || expanded > limits.expandedBytes) throw new SkinPackageError("packageTooLarge");
      // Finder metadata is not an asset and is never installed or inflated.
      if (name.startsWith("__MACOSX/") || name.split("/").at(-1) === ".DS_Store") continue;
      files.set(name, entry);
    }
    const manifests = [...files.keys()].filter((name) => name === "skin.json" || /^[^/]+\/skin\.json$/.test(name));
    if (manifests.length !== 1) throw invalid();
    const root = manifests[0].slice(0, -"skin.json".length);
    const manifest = parseSkinPackageManifest(JSON.parse((await readEntry(files.get(manifests[0])!, limits.manifestBytes)).toString("utf8")));
    const resources = new Set([manifest.preview, manifest.variants.light.background?.path, manifest.variants.dark.background?.path].filter((value): value is string => Boolean(value)));
    const allowed = new Set([manifests[0], ...[...resources].map((name) => root + name)]);
    if ([...files.keys()].some((name) => !allowed.has(name))) throw invalid();
    const images = new Map<string, Buffer>();
    for (const name of resources) {
      const entry = files.get(root + name);
      if (!entry) throw invalid();
      images.set(name, await readEntry(entry, limits.fileBytes));
    }
    return { manifest, images };
  } catch (error) {
    if (error instanceof SkinPackageError) throw error;
    throw invalid();
  }
}
