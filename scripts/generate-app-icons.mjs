import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { loadBrandConfig, resolveBrandId } from "./lib/brand-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildIconsDir = path.join(projectRoot, "build", "icons");
const iconsetDir = path.join(buildIconsDir, "icon.iconset");
const publicDir = path.join(projectRoot, "public");
const brand = loadBrandConfig(projectRoot, resolveBrandId());
const svgParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true
});
const svgBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  suppressEmptyNode: true
});

const appIconSvgPath = path.join(projectRoot, brand.icons.appIconSvg);
const trayIconSourceSvgPath = path.join(projectRoot, brand.icons.trayIconSvg);
const publicTrayIconSvgPath = path.join(publicDir, "tray-icon.svg");

const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
const icoSizes = [16, 32, 48, 64, 128, 256];
const iconsetEntries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];
const icnsEntries = [
  ["icon_16x16.png", "icp4"],
  ["icon_16x16@2x.png", "ic11"],
  ["icon_32x32.png", "icp5"],
  ["icon_32x32@2x.png", "ic12"],
  ["icon_128x128.png", "ic07"],
  ["icon_128x128@2x.png", "ic13"],
  ["icon_256x256.png", "ic08"],
  ["icon_256x256@2x.png", "ic14"],
  ["icon_512x512.png", "ic09"],
  ["icon_512x512@2x.png", "ic10"]
];

function parseSvgNumber(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^-?(?:\d+\.?\d*|\.\d+)/u);
  if (!match) {
    return Number.NaN;
  }
  return Number(match[0]);
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) < 0.001;
}

function parseStyleAttribute(style, name) {
  for (const part of String(style ?? "").split(";")) {
    const separatorIndex = part.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    if (key === name) {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}

function readSvgAttribute(attributes, name) {
  return attributes[name] ?? parseStyleAttribute(attributes.style, name);
}

function isWhitePaint(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "");

  if (normalized === "white" || normalized === "#fff" || normalized === "#ffffff") {
    return true;
  }

  const rgbMatch = normalized.match(/^rgba?\((\d+),(\d+),(\d+)(?:,([01](?:\.\d+)?))?\)$/u);
  if (!rgbMatch) {
    return false;
  }

  const [, red, green, blue, alpha = "1"] = rgbMatch;
  return Number(red) === 255 && Number(green) === 255 && Number(blue) === 255 && Number(alpha) >= 0.99;
}

function isOpaque(attributes) {
  const opacity = readSvgAttribute(attributes, "opacity");
  const fillOpacity = readSvgAttribute(attributes, "fill-opacity");
  return (
    (opacity === undefined || parseSvgNumber(opacity) >= 0.99) &&
    (fillOpacity === undefined || parseSvgNumber(fillOpacity) >= 0.99)
  );
}

function parseSvgViewport(attributes) {
  const viewBox = String(attributes.viewBox ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(Number);

  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    const [x, y, width, height] = viewBox;
    return { x, y, width, height };
  }

  const width = parseSvgNumber(attributes.width);
  const height = parseSvgNumber(attributes.height);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { x: 0, y: 0, width, height };
  }

  return null;
}

function coordinateCovers(value, expected) {
  if (value === undefined) {
    return nearlyEqual(expected, 0);
  }
  const parsed = parseSvgNumber(value);
  return Number.isFinite(parsed) && nearlyEqual(parsed, expected);
}

function sizeCovers(value, expected) {
  if (String(value ?? "").trim() === "100%") {
    return true;
  }
  const parsed = parseSvgNumber(value);
  return Number.isFinite(parsed) && nearlyEqual(parsed, expected);
}

function preserveOrderNodeName(node) {
  return Object.keys(node).find((key) => key !== ":@");
}

function isFullCanvasWhiteRect(node, viewport) {
  if (preserveOrderNodeName(node) !== "rect") {
    return false;
  }

  const attributes = node[":@"] ?? {};
  const fill = readSvgAttribute(attributes, "fill");
  return (
    isWhitePaint(fill) &&
    isOpaque(attributes) &&
    coordinateCovers(attributes.x, viewport.x) &&
    coordinateCovers(attributes.y, viewport.y) &&
    sizeCovers(attributes.width, viewport.width) &&
    sizeCovers(attributes.height, viewport.height)
  );
}

function removeRootWhiteBackground(svg) {
  let parsed;
  try {
    parsed = svgParser.parse(svg);
  } catch {
    return { svg, removed: false };
  }

  let removed = false;
  for (const node of parsed) {
    if (!Array.isArray(node.svg)) {
      continue;
    }

    const viewport = parseSvgViewport(node[":@"] ?? {});
    if (!viewport) {
      continue;
    }

    node.svg = node.svg.filter((child) => {
      if (!isFullCanvasWhiteRect(child, viewport)) {
        return true;
      }
      removed = true;
      return false;
    });
  }

  return {
    svg: removed ? svgBuilder.build(parsed) : svg,
    removed
  };
}

async function renderSvgToCanvas(svg, size) {
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return canvas;
}

async function renderSvgToPng(svg, size) {
  const canvas = await renderSvgToCanvas(svg, size);
  return canvas.toBuffer("image/png");
}

function connectedTransparentPixels(imageData, width, height) {
  const alpha = imageData.data;
  const totalPixels = width * height;
  const connected = new Uint8Array(totalPixels);
  const queue = new Uint32Array(totalPixels);
  let head = 0;
  let tail = 0;

  const enqueue = (pixelIndex) => {
    if (connected[pixelIndex] || alpha[pixelIndex * 4 + 3] === 255) {
      return;
    }
    connected[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;

    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) {
      enqueue(pixelIndex - 1);
    }
    if (x < width - 1) {
      enqueue(pixelIndex + 1);
    }
    if (y > 0) {
      enqueue(pixelIndex - width);
    }
    if (y < height - 1) {
      enqueue(pixelIndex + width);
    }
  }

  return connected;
}

function composeTransparentAppIcon(originalCanvas, backgroundlessCanvas) {
  const width = originalCanvas.width;
  const height = originalCanvas.height;
  const originalContext = originalCanvas.getContext("2d");
  const backgroundlessContext = backgroundlessCanvas.getContext("2d");
  const originalImage = originalContext.getImageData(0, 0, width, height);
  const backgroundlessImage = backgroundlessContext.getImageData(0, 0, width, height);
  const backgroundPixels = connectedTransparentPixels(backgroundlessImage, width, height);

  for (let pixelIndex = 0; pixelIndex < backgroundPixels.length; pixelIndex += 1) {
    if (!backgroundPixels[pixelIndex]) {
      continue;
    }
    const offset = pixelIndex * 4;
    originalImage.data[offset] = backgroundlessImage.data[offset];
    originalImage.data[offset + 1] = backgroundlessImage.data[offset + 1];
    originalImage.data[offset + 2] = backgroundlessImage.data[offset + 2];
    originalImage.data[offset + 3] = backgroundlessImage.data[offset + 3];
  }

  originalContext.putImageData(originalImage, 0, 0);
  return originalCanvas.toBuffer("image/png");
}

async function renderTransparentAppIconToPng(svg, size) {
  const backgroundless = removeRootWhiteBackground(svg);
  if (!backgroundless.removed) {
    return renderSvgToPng(svg, size);
  }

  // Preserve internal white marks from the supplied SVG while clearing only the outer canvas.
  const originalCanvas = await renderSvgToCanvas(svg, size);
  const backgroundlessCanvas = await renderSvgToCanvas(backgroundless.svg, size);
  return composeTransparentAppIcon(originalCanvas, backgroundlessCanvas);
}

async function countOpaquePixels(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let opaquePixels = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) {
      opaquePixels += 1;
    }
  }
  return opaquePixels;
}

async function assertNonTransparentPng(label, png) {
  const opaquePixels = await countOpaquePixels(png);
  if (opaquePixels === 0) {
    throw new Error(`${label} rendered fully transparent`);
  }
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

function createIcns(pngEntries) {
  const chunks = pngEntries.map(({ type, png }) => {
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

function warnSkippedMacIcns() {
  if (process.platform !== "darwin") {
    console.warn("skipped icon.icns generation; run npm run icons on macOS to refresh the macOS app icon");
  }
}

function runMacIconTool(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

function generateMacIconsetAndIcnsFromPng(sourcePngPath) {
  const tempParent = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const tempRoot = fs.mkdtempSync(path.join(tempParent, "zenmind-app-icons-"));
  const tempIconsetDir = path.join(tempRoot, "icon.iconset");
  fs.mkdirSync(tempIconsetDir, { recursive: true });

  for (const [filename, size] of iconsetEntries) {
    runMacIconTool("/usr/bin/sips", [
      "-z",
      String(size),
      String(size),
      sourcePngPath,
      "--out",
      path.join(tempIconsetDir, filename)
    ]);
  }

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  for (const [filename] of iconsetEntries) {
    fs.copyFileSync(path.join(tempIconsetDir, filename), path.join(iconsetDir, filename));
  }
  writeFileIfChanged(
    path.join(buildIconsDir, "icon.icns"),
    createIcns(
      icnsEntries.map(([filename, type]) => ({
        type,
        png: fs.readFileSync(path.join(tempIconsetDir, filename))
      }))
    )
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
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
    const png = await renderTransparentAppIconToPng(appIconSvg, size);
    renderedAppPngs.set(size, png);
    writeFileIfChanged(path.join(buildIconsDir, `icon-${size}.png`), png);
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.png"), renderedAppPngs.get(1024));
  writeFileIfChanged(path.join(publicDir, "brand-icon.png"), renderedAppPngs.get(256));
  await assertNonTransparentPng("build/icons/icon-1024.png", renderedAppPngs.get(1024));
  await assertNonTransparentPng("public/brand-icon.png", renderedAppPngs.get(256));

  if (process.platform === "darwin") {
    generateMacIconsetAndIcnsFromPng(path.join(buildIconsDir, "icon.png"));
  } else {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    fs.mkdirSync(iconsetDir, { recursive: true });
    for (const [filename, size] of iconsetEntries) {
      const png = renderedAppPngs.get(size) ?? (await renderSvgToPng(appIconSvg, size));
      writeFileIfChanged(path.join(iconsetDir, filename), png);
    }
    warnSkippedMacIcns();
  }

  const renderedTransparentAppPngs = new Map();
  const icoPngEntries = [];
  for (const size of icoSizes) {
    const png = renderedAppPngs.get(size) ??
      renderedTransparentAppPngs.get(size) ??
      (await renderTransparentAppIconToPng(appIconSvg, size));
    renderedTransparentAppPngs.set(size, png);
    icoPngEntries.push({ size, png });
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.ico"), createIco(icoPngEntries));

  const trayPng = await renderSvgToPng(trayIconSvg, 256);
  writeFileIfChanged(path.join(publicDir, "tray-icon.png"), trayPng);
  await assertNonTransparentPng("public/tray-icon.png", trayPng);

  console.log(`generated ${brand.productName} app icons`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
