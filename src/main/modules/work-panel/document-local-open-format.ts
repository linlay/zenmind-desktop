import JSZip from "jszip";
import type { LocalDocumentExtension } from "../../infrastructure/electron/local-document-apps";

export const LOCAL_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;
const OLE_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

const officeParts = {
  ".docx": ["word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
  ".xlsx": ["xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
  ".pptx": ["ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
} as const;

function zipEntryCount(bytes: Buffer): number {
  let end = bytes.length - 22;
  const minimum = Math.max(0, bytes.length - 65_557);
  while (end >= minimum) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end--;
  }
  if (end < minimum) throw new Error("Invalid ZIP directory");
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_ZIP_ENTRIES || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) ||
      bytes.readUInt16LE(end + 8) !== count || size === 0xffffffff || offset === 0xffffffff || offset + size !== end) {
    throw new Error("Unsupported ZIP directory");
  }
  // Do not trust only the EOCD count: JSZip scans directory records, and a false
  // count must not bypass the entry cap before its object map is allocated.
  let position = offset;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50 || (bytes.readUInt16LE(position + 8) & 1)) {
      throw new Error("Invalid ZIP entry");
    }
    position += 46 + bytes.readUInt16LE(position + 28) + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    if (position > end) throw new Error("Invalid ZIP entry size");
  }
  if (position !== end) throw new Error("Invalid ZIP entry count");
  return count;
}

function readSmallZipEntry(entry: JSZip.JSZipObject): Promise<Buffer> {
  // Only the small content-type manifest is inflated. Streaming keeps a false
  // compressed-size declaration from turning the file check into a ZIP bomb.
  return new Promise((resolve, reject) => {
    const stream = (entry as JSZip.JSZipObject & {
      internalStream(type: "nodebuffer"): JSZip.JSZipStreamHelper<Buffer>;
    }).internalStream("nodebuffer");
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_CONTENT_TYPES_BYTES) {
        failed = true;
        stream.pause();
        chunks.length = 0;
        reject(new Error("Office content types are too large"));
      } else chunks.push(chunk);
    });
    stream.on("error", () => { failed = true; reject(new Error("Invalid Office content types")); });
    stream.on("end", () => { if (!failed) resolve(Buffer.concat(chunks, total)); });
    stream.resume();
  });
}

async function isOpenXmlDocument(bytes: Buffer, extension: keyof typeof officeParts): Promise<boolean> {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const count = zipEntryCount(bytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const entries = Object.values(zip.files);
  if (entries.length !== count) return false;
  for (const entry of entries) {
    const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    if (originalName !== undefined && originalName !== entry.name) return false;
  }
  const [mainPart, contentType] = officeParts[extension];
  const manifest = zip.file("[Content_Types].xml");
  const main = zip.file(mainPart);
  if (!manifest || !main) return false;
  const mainSize = (main as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof mainSize !== "number" || mainSize <= 0) return false;
  const xml = (await readSmallZipEntry(manifest)).toString("utf8");
  return xml.includes(contentType) && xml.includes(`/${mainPart}`);
}

function isLegacyOfficeDocument(bytes: Buffer, extension: ".doc" | ".xls" | ".ppt"): boolean {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(OLE_SIGNATURE) || bytes.readUInt16LE(28) !== 0xfffe) return false;
  const major = bytes.readUInt16LE(26);
  const shift = bytes.readUInt16LE(30);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) return false;
  const sectorSize = 2 ** shift;
  if (bytes.length < sectorSize * 2 || bytes.length % sectorSize !== 0) return false;
  const sectorCount = bytes.length / sectorSize - 1;
  const sector = (id: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= sectorCount) throw new Error("Invalid compound-file sector");
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const fatCount = bytes.readUInt32LE(44);
  if (!fatCount || fatCount > sectorCount) return false;
  const fatIds: number[] = [];
  for (let offset = 76; offset < 512; offset += 4) {
    const id = bytes.readUInt32LE(offset);
    if (id !== FREE_SECTOR) fatIds.push(id);
  }
  let difatId = bytes.readUInt32LE(68);
  const difatCount = bytes.readUInt32LE(72);
  if (difatCount > sectorCount) return false;
  const visitedDifat = new Set<number>();
  for (let index = 0; index < difatCount; index++) {
    if (visitedDifat.has(difatId)) return false;
    visitedDifat.add(difatId);
    const data = sector(difatId);
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      const id = data.readUInt32LE(offset);
      if (id !== FREE_SECTOR) fatIds.push(id);
    }
    if (fatIds.length > fatCount) return false;
    difatId = data.readUInt32LE(sectorSize - 4);
  }
  if (fatIds.length !== fatCount || new Set(fatIds).size !== fatIds.length ||
      (difatCount > 0 && difatId !== END_OF_CHAIN)) return false;
  const fatSectors = fatIds.map(sector);
  const nextSector = (id: number) => {
    const fatIndex = Math.floor(id / (sectorSize / 4));
    const fat = fatSectors[fatIndex];
    if (!fat) throw new Error("Missing compound-file allocation table");
    return fat.readUInt32LE((id % (sectorSize / 4)) * 4);
  };
  const expectedNames = extension === ".doc" ? ["WordDocument"]
    : extension === ".xls" ? ["Workbook", "Book"] : ["PowerPoint Document"];
  let directoryId = bytes.readUInt32LE(48);
  const visitedDirectories = new Set<number>();
  let hasRoot = false;
  let hasMainStream = false;
  // Directory sectors are small, but cap traversal independently of input size.
  while (directoryId !== END_OF_CHAIN) {
    if (visitedDirectories.size >= 4096 || visitedDirectories.has(directoryId)) return false;
    visitedDirectories.add(directoryId);
    const directory = sector(directoryId);
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const nameBytes = directory.readUInt16LE(offset + 64);
      const type = directory[offset + 66];
      if (type === 0) continue;
      if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0 || directory.readUInt16LE(offset + nameBytes - 2) !== 0) return false;
      const name = directory.subarray(offset, offset + nameBytes - 2).toString("utf16le");
      if (type === 5 && name === "Root Entry") hasRoot = true;
      if (type === 2 && expectedNames.includes(name) && directory.readBigUInt64LE(offset + 120) > 0n) hasMainStream = true;
    }
    directoryId = nextSector(directoryId);
  }
  return hasRoot && hasMainStream;
}

/** Container/type validation, not a document parser or a document repair step. */
export async function isLocalDocumentBytes(bytes: Buffer, extension: LocalDocumentExtension): Promise<boolean> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LOCAL_DOCUMENT_MAX_BYTES) return false;
  try {
    if (extension === ".pdf") {
      // PDF readers permit a leading BOM or short transport prefix. Only inspect
      // the first 1 KiB; an arbitrary occurrence deep in another file is not PDF.
      return /%PDF-\d\.\d(?=[\r\n\t ])/u.test(bytes.subarray(0, 1024).toString("latin1"));
    }
    if (extension === ".docx" || extension === ".xlsx" || extension === ".pptx") return await isOpenXmlDocument(bytes, extension);
    if (extension === ".doc" || extension === ".xls" || extension === ".ppt") return isLegacyOfficeDocument(bytes, extension);
    return false;
  } catch { return false; }
}
