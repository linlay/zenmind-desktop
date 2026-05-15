import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildIconsDir = path.join(projectRoot, "build", "icons");
const iconsetDir = path.join(buildIconsDir, "icon.iconset");
const publicDir = path.join(projectRoot, "public");

const appIconSvgPath = path.join(buildIconsDir, "app-icon.svg");
const trayIconSourceSvgPath = path.join(buildIconsDir, "tray-icon.svg");
const publicTrayIconSvgPath = path.join(publicDir, "tray-icon.svg");

const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
const icoSizes = [16, 32, 48, 64, 128, 256];
const iconsetEntries = [
  ["icon_16x16.png", 16, "icp4"],
  ["icon_16x16@2x.png", 32, "ic11"],
  ["icon_32x32.png", 32, "icp5"],
  ["icon_32x32@2x.png", 64, "ic12"],
  ["icon_64x64.png", 64, "icp6"],
  ["icon_64x64@2x.png", 128, null],
  ["icon_128x128.png", 128, "ic07"],
  ["icon_128x128@2x.png", 256, "ic13"],
  ["icon_256x256.png", 256, "ic08"],
  ["icon_256x256@2x.png", 512, "ic14"],
  ["icon_512x512.png", 512, "ic09"],
  ["icon_512x512@2x.png", 1024, "ic10"]
];

async function renderSvgToPng(svg, size) {
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return canvas.toBuffer("image/png");
}

function writeFileIfChanged(filePath, content) {
  if (fs.existsSync(filePath) && Buffer.compare(fs.readFileSync(filePath), content) === 0) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

function createIco(pngEntries) {
  const headerSize = 6;
  const directorySize = 16 * pngEntries.length;
  let imageOffset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize + directorySize);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngEntries.length, 4);

  pngEntries.forEach(({ size, png }, index) => {
    const directoryOffset = headerSize + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, directoryOffset);
    header.writeUInt8(size >= 256 ? 0 : size, directoryOffset + 1);
    header.writeUInt8(0, directoryOffset + 2);
    header.writeUInt8(0, directoryOffset + 3);
    header.writeUInt16LE(1, directoryOffset + 4);
    header.writeUInt16LE(32, directoryOffset + 6);
    header.writeUInt32LE(png.length, directoryOffset + 8);
    header.writeUInt32LE(imageOffset, directoryOffset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...pngEntries.map(({ png }) => png)]);
}

function createIcns(icnsEntries) {
  const chunks = icnsEntries.map(({ type, png }) => {
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks], totalLength);
}

async function main() {
  fs.mkdirSync(buildIconsDir, { recursive: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  const appIconSvg = fs.readFileSync(appIconSvgPath, "utf8");
  const trayIconSvg = fs.readFileSync(trayIconSourceSvgPath, "utf8");
  writeFileIfChanged(publicTrayIconSvgPath, Buffer.from(trayIconSvg));

  const renderedAppPngs = new Map();
  for (const size of pngSizes) {
    const png = await renderSvgToPng(appIconSvg, size);
    renderedAppPngs.set(size, png);
    writeFileIfChanged(path.join(buildIconsDir, `icon-${size}.png`), png);
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.png"), renderedAppPngs.get(1024));
  writeFileIfChanged(path.join(publicDir, "brand-icon.png"), renderedAppPngs.get(256));

  const iconsetIcnsEntries = [];
  for (const [filename, size, type] of iconsetEntries) {
    const png = renderedAppPngs.get(size) ?? (await renderSvgToPng(appIconSvg, size));
    writeFileIfChanged(path.join(iconsetDir, filename), png);
    if (type) {
      iconsetIcnsEntries.push({ type, png });
    }
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.icns"), createIcns(iconsetIcnsEntries));

  const icoPngEntries = [];
  for (const size of icoSizes) {
    const png = renderedAppPngs.get(size) ?? (await renderSvgToPng(appIconSvg, size));
    icoPngEntries.push({ size, png });
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.ico"), createIco(icoPngEntries));

  writeFileIfChanged(path.join(publicDir, "tray-icon.png"), await renderSvgToPng(trayIconSvg, 256));

  console.log("generated ZenMind app icons");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
