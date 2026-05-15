import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

async function renderSvgToPng(svg, size) {
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return canvas.toBuffer("image/png");
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
  const tempIcnsPath = path.join(tempRoot, "icon.icns");
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
  const iconutilResult = spawnSync(
    "/usr/bin/iconutil",
    ["-c", "icns", tempIconsetDir, "-o", tempIcnsPath],
    {
      cwd: projectRoot,
      encoding: "utf8"
    }
  );

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  for (const [filename] of iconsetEntries) {
    fs.copyFileSync(path.join(tempIconsetDir, filename), path.join(iconsetDir, filename));
  }
  if (iconutilResult.status === 0) {
    fs.copyFileSync(tempIcnsPath, path.join(buildIconsDir, "icon.icns"));
  } else {
    console.warn(`iconutil failed; falling back to PNG-backed ICNS: ${iconutilResult.stderr || iconutilResult.stdout}`);
    writeFileIfChanged(
      path.join(buildIconsDir, "icon.icns"),
      createIcns(
        icnsEntries.map(([filename, type]) => ({
          type,
          png: fs.readFileSync(path.join(tempIconsetDir, filename))
        }))
      )
    );
  }
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
    const png = await renderSvgToPng(appIconSvg, size);
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

  const icoPngEntries = [];
  for (const size of icoSizes) {
    const png = renderedAppPngs.get(size) ?? (await renderSvgToPng(appIconSvg, size));
    icoPngEntries.push({ size, png });
  }
  writeFileIfChanged(path.join(buildIconsDir, "icon.ico"), createIco(icoPngEntries));

  const trayPng = await renderSvgToPng(trayIconSvg, 256);
  writeFileIfChanged(path.join(publicDir, "tray-icon.png"), trayPng);
  await assertNonTransparentPng("public/tray-icon.png", trayPng);

  console.log("generated ZenMind app icons");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
