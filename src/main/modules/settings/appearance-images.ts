import type { NativeImage } from "electron";

export const MAX_BACKGROUND_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_BACKGROUND_STORED_BYTES = 8 * 1024 * 1024;

export class BackgroundImageError extends Error {
  constructor(public readonly code: "invalidImage" | "imageTooLarge") { super(code); }
}

// Inspect dimensions before decoding. Accept raster PNG/JPEG only, regardless
// of filename extension; never load SVG, URLs, HTML or OS thumbnail providers.
export function inspectBackgroundImage(data: Buffer) {
  if (data.length > MAX_BACKGROUND_INPUT_BYTES) throw new BackgroundImageError("imageTooLarge");
  let width = 0, height = 0;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 && data.toString("ascii", 12, 16) === "IHDR") {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += size;
    }
  }
  if (!width || !height) throw new BackgroundImageError("invalidImage");
  if (width > 16384 || height > 16384 || width * height > 32_000_000) {
    throw new BackgroundImageError("imageTooLarge");
  }
  return { width, height };
}

export function normalizeBackgroundImage(data: Buffer, decode: (data: Buffer) => NativeImage) {
  inspectBackgroundImage(data);
  let image: NativeImage;
  try { image = decode(data); }
  catch { throw new BackgroundImageError("invalidImage"); }
  if (image.isEmpty()) throw new BackgroundImageError("invalidImage");
  let size = image.getSize();
  if (!size.width || !size.height || size.width * size.height > 32_000_000) {
    throw new BackgroundImageError("imageTooLarge");
  }
  if (Math.max(size.width, size.height) > 3840) {
    const ratio = 3840 / Math.max(size.width, size.height);
    image = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: "best" });
  }
  // Re-encode to strip metadata/animation and preserve PNG transparency. Bound
  // disk and IPC bytes even for incompressible images, reducing size as needed.
  let png = image.toPNG();
  while (png.length > MAX_BACKGROUND_STORED_BYTES) {
    size = image.getSize();
    if (Math.max(size.width, size.height) < 512) throw new BackgroundImageError("imageTooLarge");
    image = image.resize({ width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)), quality: "best" });
    png = image.toPNG();
  }
  if (!png.length) throw new BackgroundImageError("invalidImage");
  return { data: png, ...image.getSize() };
}
