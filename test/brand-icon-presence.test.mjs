import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function readIcoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("Invalid ICO header");
  }
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer.readUInt8(offset) || 256;
    const height = buffer.readUInt8(offset + 1) || 256;
    sizes.push(`${width}x${height}`);
  }
  return sizes;
}

async function readAlphaAt(filePath, x, y) {
  const image = await loadImage(filePath);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(x, y, 1, 1).data[3];
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

test("generated app icon PNGs keep the outer canvas transparent", async () => {
  const iconPaths = [
    path.join(projectRoot, "build", "icons", "icon-1024.png"),
    path.join(projectRoot, "public", "brand-icon.png")
  ];

  for (const iconPath of iconPaths) {
    assert.equal(await readAlphaAt(iconPath, 0, 0), 0, `${iconPath} top-left corner is opaque`);
    assert.equal(await readAlphaAt(iconPath, 0, 10), 0, `${iconPath} left edge is opaque`);
    assert.equal(await readAlphaAt(iconPath, 10, 0), 0, `${iconPath} top edge is opaque`);
  }
});
