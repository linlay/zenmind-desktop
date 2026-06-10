import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function readIcoEntries(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("Invalid ICO header");
  }
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer.readUInt8(offset) || 256;
    const height = buffer.readUInt8(offset + 1) || 256;
    const imageLength = buffer.readUInt32LE(offset + 8);
    const imageOffset = buffer.readUInt32LE(offset + 12);
    if (imageOffset + imageLength > buffer.length) {
      throw new Error(`Invalid ICO image bounds for ${width}x${height}`);
    }
    entries.push({
      width,
      height,
      image: buffer.subarray(imageOffset, imageOffset + imageLength)
    });
  }
  return entries;
}

function readIcoSizes(buffer) {
  return readIcoEntries(buffer).map(({ width, height }) => `${width}x${height}`);
}

async function readRgbaAt(imageSource, x, y) {
  const image = await loadImage(imageSource);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(x, y, 1, 1).data);
}

async function readAlphaAt(imageSource, x, y) {
  return (await readRgbaAt(imageSource, x, y))[3];
}

async function assertOpaqueWhiteAt(imageSource, x, y, label) {
  assert.deepEqual(
    await readRgbaAt(imageSource, x, y),
    [255, 255, 255, 255],
    `${label} should be opaque white at ${x},${y}`
  );
}

test("public brand icon assets exist in the public directory", () => {
  const brandIconPath = path.join(projectRoot, "public", "brand-icon.png");
  const trayIconPngPath = path.join(projectRoot, "public", "tray-icon.png");
  const trayIconSvgPath = path.join(projectRoot, "public", "tray-icon.svg");

  assert.ok(fs.existsSync(brandIconPath), `Missing generated brand icon at: ${brandIconPath}`);
  assert.ok(fs.existsSync(trayIconPngPath), `Missing generated tray icon PNG at: ${trayIconPngPath}`);
  assert.ok(fs.existsSync(trayIconSvgPath), `Missing generated tray icon SVG at: ${trayIconSvgPath}`);
});

test("windows app icon contains the expected multi-size ICO entries", () => {
  const windowsIconPath = path.join(projectRoot, "build", "icons", "icon.ico");

  assert.ok(fs.existsSync(windowsIconPath), `Missing generated Windows app icon at: ${windowsIconPath}`);
  assert.deepEqual(readIcoSizes(fs.readFileSync(windowsIconPath)), [
    "16x16",
    "32x32",
    "48x48",
    "64x64",
    "128x128",
    "256x256"
  ]);
});

test("generated app icon PNGs keep the outer canvas white", async () => {
  const iconPaths = [
    path.join(projectRoot, "build", "icons", "icon-1024.png"),
    path.join(projectRoot, "build", "icons", "icon.png"),
    path.join(projectRoot, "public", "brand-icon.png")
  ];

  for (const iconPath of iconPaths) {
    await assertOpaqueWhiteAt(iconPath, 0, 0, `${iconPath} top-left corner`);
    await assertOpaqueWhiteAt(iconPath, 0, 10, `${iconPath} left edge`);
    await assertOpaqueWhiteAt(iconPath, 10, 0, `${iconPath} top edge`);
  }
});

test("windows app icon keeps the outer canvas transparent", async () => {
  const windowsIconPath = path.join(projectRoot, "build", "icons", "icon.ico");
  const entries = readIcoEntries(fs.readFileSync(windowsIconPath));
  const entry = entries.find(({ width, height }) => width === 256 && height === 256);

  assert.ok(entry, "Missing 256x256 Windows app icon entry");
  assert.equal(await readAlphaAt(entry.image, 0, 0), 0, "Windows icon top-left corner is opaque");
  assert.equal(await readAlphaAt(entry.image, 0, 10), 0, "Windows icon left edge is opaque");
  assert.equal(await readAlphaAt(entry.image, 10, 0), 0, "Windows icon top edge is opaque");
});
