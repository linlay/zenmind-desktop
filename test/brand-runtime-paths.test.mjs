import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertBrandArtifactsConsistent,
  BRAND_RUNTIME_ASSET_DIR_NAME,
  BRAND_RUNTIME_ASSET_FILENAMES,
  brandBuildRelativePath,
  brandGeneratedDir,
  brandIconDir,
  brandInstallerDir,
  brandRendererDir,
  brandResourcesDir,
  brandRuntimeAssetDir,
  copyBrandDesktopPetAssets,
  copyBrandRuntimeIconAssets,
  electronBuilderConfigPath,
  loadBrandConfig,
  removeStaleRendererBuild,
  renderRendererIndexHtml,
  resolveBrandId,
  syncBrandArtifacts
} from "../scripts/lib/brand-config.mjs";
import { desktopBuiltinServicesRelativePath } from "../scripts/lib/desktop-resources.mjs";
import { renderAppIconToPng, renderBrandMarkToPng } from "../scripts/generate-app-icons.mjs";
import { prepareBundledDemoAssets } from "../scripts/sync-demo-assets.mjs";
import { prepareBundledEnvZip } from "../scripts/sync-env-zip.mjs";
import { ensureWindowsLatestAliases } from "../scripts/platform/dist-win-host.mjs";
import { removeRendererWebappTemplatesFromStage } from "../scripts/stage-app.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const silentLogger = {
  log() {}
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function newestGeneratedBrandPath(root = projectRoot) {
  const brandsRoot = path.join(root, "build", "brands");
  if (!fs.existsSync(brandsRoot) || !fs.statSync(brandsRoot).isDirectory()) {
    return "";
  }
  return fs
    .readdirSync(brandsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(brandsRoot, entry.name, "generated", "brand.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] ?? "";
}

function readBrandDesktopPetManifest(root, brandId) {
  const manifest = readJson(path.join(root, "brands", brandId, "desktop-pet", "pet.json"));
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    preview: manifest.preview,
    states: manifest.states,
    ...(manifest.signature ? { signature: manifest.signature } : {})
  };
}

test("default dev brand resolves to ZenMind when no brand is provided", () => {
  assert.equal(resolveBrandId([], {}), "zenmind");
  assert.equal(resolveBrandId(["--brand", "zenmind"], {}), "zenmind");
  assert.equal(resolveBrandId([], { BRAND: "zenmind" }), "zenmind");
});

function createBrandFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-brand-runtime-"));
  fs.cpSync(path.join(projectRoot, "brands"), path.join(root, "brands"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "placeholder",
      version: "0.0.0",
      description: "placeholder",
      build: { appId: "legacy.hardcoded" }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "placeholder",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "placeholder"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.copyFileSync(path.join(projectRoot, "index.html"), path.join(root, "index.html"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "scripts", "uninstall.sh"), path.join(root, "scripts", "uninstall.sh"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeMinimalGeneratedIconArtifacts(root, brand) {
  const outputRoot = brandRuntimeAssetDir(root, brand);
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.copyFileSync(path.join(root, brand.icons.trayIconSvg), path.join(outputRoot, "tray-icon.svg"));
  fs.writeFileSync(path.join(outputRoot, "brand-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(outputRoot, "brand-mark.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(outputRoot, "tray-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

function writeBrandManifest(root, brandId, update) {
  const manifestPath = path.join(root, "brands", brandId, "brand.json");
  const manifest = readJson(manifestPath);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(update(manifest), null, 2)}\n`,
    "utf8"
  );
}

function listRelativeFiles(root) {
  const result = [];
  const visit = (current, relativeDir) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  };
  visit(root, "");
  return result;
}

function assertDirectoryBytesEqual(actualRoot, expectedRoot) {
  const actualFiles = listRelativeFiles(actualRoot);
  const expectedFiles = listRelativeFiles(expectedRoot);
  assert.deepEqual(actualFiles, expectedFiles);
  for (const fileName of expectedFiles) {
    assert.equal(
      Buffer.compare(fs.readFileSync(path.join(actualRoot, fileName)), fs.readFileSync(path.join(expectedRoot, fileName))),
      0,
      `${actualRoot}/${fileName} should match ${expectedRoot}/${fileName}`
    );
  }
}

function writeMinimalDistRenderer(root, brand) {
  const rendererRoot = brandRendererDir(root, brand);
  fs.mkdirSync(rendererRoot, { recursive: true });
  fs.writeFileSync(
    path.join(rendererRoot, "index.html"),
    renderRendererIndexHtml(fs.readFileSync(path.join(root, "index.html"), "utf8"), brand),
    "utf8"
  );
  copyBrandRuntimeIconAssets({ rootDir: root, brand, outputDir: rendererRoot });
  return rendererRoot;
}

async function writeZip(zipPath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function renderSvgFileHash(filePath, size = 64) {
  const image = await loadImage(Buffer.from(fs.readFileSync(filePath, "utf8")));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return createHash("sha256").update(canvas.toBuffer("image/png")).digest("hex");
}

function inspectCanvasPixels(canvas) {
  const context = canvas.getContext("2d");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const sample = (x, y) => {
    const offset = (y * canvas.width + x) * 4;
    return Array.from(pixels.slice(offset, offset + 4));
  };
  const isBackdropPixel = (red, green, blue, alpha) => (
    alpha > 0 &&
    red >= 248 &&
    green >= 248 &&
    blue >= 248
  );
  let opaquePixels = 0;
  let opaqueNeutralGrayPixels = 0;
  let opaqueMinX = canvas.width;
  let opaqueMinY = canvas.height;
  let opaqueMaxX = -1;
  let opaqueMaxY = -1;
  let coloredMinX = canvas.width;
  let coloredMinY = canvas.height;
  let coloredMaxX = -1;
  let coloredMaxY = -1;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const alpha = pixels[index + 3];
    if (alpha > 0) {
      opaquePixels += 1;
      const pixelIndex = index / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);
      opaqueMinX = Math.min(opaqueMinX, x);
      opaqueMinY = Math.min(opaqueMinY, y);
      opaqueMaxX = Math.max(opaqueMaxX, x);
      opaqueMaxY = Math.max(opaqueMaxY, y);
    }
    if (alpha > 0 && !isBackdropPixel(red, green, blue, alpha)) {
      const pixelIndex = index / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);
      coloredMinX = Math.min(coloredMinX, x);
      coloredMinY = Math.min(coloredMinY, y);
      coloredMaxX = Math.max(coloredMaxX, x);
      coloredMaxY = Math.max(coloredMaxY, y);
    }
    if (
      alpha > 250 &&
      Math.abs(red - green) < 3 &&
      Math.abs(green - blue) < 3 &&
      red > 120 &&
      red < 245
    ) {
      opaqueNeutralGrayPixels += 1;
    }
  }

  return {
    width: canvas.width,
    height: canvas.height,
    opaquePixels,
    opaqueNeutralGrayPixels,
    opaqueBounds: opaqueMaxX === -1
      ? null
      : {
          minX: opaqueMinX,
          minY: opaqueMinY,
          maxX: opaqueMaxX,
          maxY: opaqueMaxY,
          width: opaqueMaxX - opaqueMinX + 1,
          height: opaqueMaxY - opaqueMinY + 1
        },
    coloredBounds: coloredMaxX === -1
      ? null
      : {
          minX: coloredMinX,
          minY: coloredMinY,
          maxX: coloredMaxX,
          maxY: coloredMaxY,
          width: coloredMaxX - coloredMinX + 1,
          height: coloredMaxY - coloredMinY + 1
        },
    cornerSamples: [
      sample(0, 0),
      sample(canvas.width - 1, 0),
      sample(0, canvas.height - 1),
      sample(canvas.width - 1, canvas.height - 1)
    ],
    nearCornerSample: sample(Math.floor(canvas.width * 0.08), Math.floor(canvas.height * 0.08)),
    topCenterSample: sample(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.12)),
    innerBackdropSample: sample(Math.floor(canvas.width * 0.18), Math.floor(canvas.height * 0.18))
  };
}

async function inspectPngPixels(filePath) {
  return inspectPngBuffer(fs.readFileSync(filePath));
}

async function inspectPngBuffer(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return inspectCanvasPixels(canvas);
}

function assertRoundedWhiteBackdrop(stats, label) {
  for (const cornerSample of stats.cornerSamples) {
    assert.equal(cornerSample[3], 0, `${label} should have transparent outer corners`);
  }
  assert.equal(stats.nearCornerSample[3], 0, `${label} should have transparent rounded-corner padding`);
  for (const sample of [stats.topCenterSample, stats.innerBackdropSample]) {
    assert.equal(sample[3], 255, `${label} should keep an opaque rounded light backdrop`);
    assert(sample[0] >= 248 && sample[1] >= 248 && sample[2] >= 248, `${label} should keep a light rounded backdrop`);
    assert(sample[0] <= 253 && sample[1] <= 253 && sample[2] <= 253, `${label} backdrop should use #FCFCFC instead of pure white`);
  }
}

function assertComfortableTileSize(stats, label) {
  assert(stats.opaqueBounds, `${label} should contain an opaque rounded tile`);
  const tileWidthRatio = stats.opaqueBounds.width / stats.width;
  const tileHeightRatio = stats.opaqueBounds.height / stats.height;
  assert(tileWidthRatio <= 0.84, `${label} tile is too wide: ${tileWidthRatio.toFixed(3)}`);
  assert(tileHeightRatio <= 0.84, `${label} tile is too tall: ${tileHeightRatio.toFixed(3)}`);
  assert(tileWidthRatio >= 0.80, `${label} tile is too small: ${tileWidthRatio.toFixed(3)}`);
  assert(tileHeightRatio >= 0.80, `${label} tile is too small: ${tileHeightRatio.toFixed(3)}`);
}

function assertComfortableForegroundSize(stats, label) {
  assert(stats.coloredBounds, `${label} should contain colored foreground art`);
  const foregroundWidthRatio = stats.coloredBounds.width / stats.width;
  const foregroundHeightRatio = stats.coloredBounds.height / stats.height;
  assert(foregroundWidthRatio <= 0.83, `${label} foreground is too wide: ${foregroundWidthRatio.toFixed(3)}`);
  assert(foregroundHeightRatio <= 0.83, `${label} foreground is too tall: ${foregroundHeightRatio.toFixed(3)}`);
  assert(foregroundWidthRatio >= 0.48, `${label} foreground is too small: ${foregroundWidthRatio.toFixed(3)}`);
  assert(foregroundHeightRatio >= 0.48, `${label} foreground is too small: ${foregroundHeightRatio.toFixed(3)}`);
}

function assertNoGrayTile(stats, label) {
  const grayRatio = stats.opaqueNeutralGrayPixels / Math.max(stats.opaquePixels, 1);
  assert(grayRatio <= 0.001, `${label} should not contain a gray app tile: ${grayRatio.toFixed(4)}`);
}

function assertTransparentBrandMark(stats, label) {
  for (const cornerSample of stats.cornerSamples) {
    assert.equal(cornerSample[3], 0, `${label} should keep transparent outer corners`);
  }
  assert(stats.opaqueBounds, `${label} should contain visible brand foreground art`);
  const opaqueRatio = stats.opaquePixels / (stats.width * stats.height);
  assert(opaqueRatio >= 0.06, `${label} brand mark is too sparse: ${opaqueRatio.toFixed(3)}`);
  assert(opaqueRatio <= 0.55, `${label} should not include an app-icon tile backdrop: ${opaqueRatio.toFixed(3)}`);
  assert(stats.opaqueBounds.width / stats.width <= 0.96, `${label} should not fill the full app-icon canvas width`);
  assert(stats.opaqueBounds.height / stats.height <= 0.9, `${label} should not fill the full app-icon canvas height`);
}

test("brand runtime root directory is derived from brand id", () => {
  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  const cutej = loadBrandConfig(projectRoot, "cutej");
  const zenmindPet = readBrandDesktopPetManifest(projectRoot, "zenmind");
  const cutejPet = readBrandDesktopPetManifest(projectRoot, "cutej");

  assert.equal(zenmind.paths.runtimeRootDirName, ".zenmind");
  assert.equal(cutej.paths.runtimeRootDirName, ".cutej");
  assert.equal(zenmind.packageName, "desktop");
  assert.equal(cutej.packageName, "desktop");
  assert.equal(zenmind.storageNamespace, "zenmind-desktop");
  assert.equal(cutej.storageNamespace, "cutej-desktop");
  assert.equal(zenmind.paths.programDataDirName, "ZenMind");
  assert.equal(cutej.paths.programDataDirName, "CuteJ");
  assert.deepEqual(zenmind.desktopPet, zenmindPet);
  assert.deepEqual(cutej.desktopPet, cutejPet);
  assert.equal(zenmind.source.desktopPetRoot, "brands/zenmind/desktop-pet");
  assert.equal(cutej.source.desktopPetRoot, "brands/cutej/desktop-pet");
  assert.equal("runtimeRootDirName" in readJson(path.join(projectRoot, "brands", "zenmind", "brand.json")).paths, false);
  assert.equal("runtimeRootDirName" in readJson(path.join(projectRoot, "brands", "cutej", "brand.json")).paths, false);
});

test("brand icon generation surfaces are brand-owned and distinct", async () => {
  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  const cutej = loadBrandConfig(projectRoot, "cutej");
  const generator = fs.readFileSync(path.join(projectRoot, "scripts", "generate-app-icons.mjs"), "utf8");

  assert.notEqual(zenmind.icons.trayIconSvg, cutej.icons.trayIconSvg);
  assert.notEqual(zenmind.icons.appIconSvg, cutej.icons.appIconSvg);
  assert.notEqual(
    await renderSvgFileHash(path.join(projectRoot, zenmind.icons.trayIconSvg)),
    await renderSvgFileHash(path.join(projectRoot, cutej.icons.trayIconSvg))
  );
  assert.notEqual(
    await renderSvgFileHash(path.join(projectRoot, zenmind.icons.appIconSvg)),
    await renderSvgFileHash(path.join(projectRoot, cutej.icons.appIconSvg))
  );
  assert.match(generator, /cleanupPublicBrandIconArtifacts\(projectRoot\)/u);
  assert.match(generator, /writeFileIfChanged\(generatedTrayIconSvgPath,\s*Buffer\.from\(trayIconSvg\)\)/u);
  assert.match(generator, /brandRuntimeAssetDir\(projectRoot,\s*brand\)/u);
  assert.match(generator, /APP_ICON_BASE_SIZE\s*=\s*1024/u);
  assert.match(generator, /APP_ICON_TILE_SIZE\s*=\s*840/u);
  assert.match(generator, /APP_ICON_CORNER_RADIUS\s*=\s*232/u);
  assert.match(generator, /APP_ICON_TILE_FILL\s*=\s*"#FCFCFC"/u);
  assert.match(generator, /APP_ICON_FOREGROUND_SIZE\s*=\s*800/u);
  assert.match(generator, /renderAppIconToPng\(appIconSvg,\s*size\)/u);
  assert.match(generator, /renderBrandMarkToPng\(appIconSvg,\s*256\)/u);
  assert.doesNotMatch(generator, /renderTransparentAppIconToPng/u);
  assert.doesNotMatch(generator, /removeRootWhiteBackground/u);
  assert.match(generator, /writeFileIfChanged\(path\.join\(brandRuntimeAssetsDir,\s*"tray-icon\.png"\),\s*trayPng\)/u);
  assert.match(generator, /writeFileIfChanged\(path\.join\(brandRuntimeAssetsDir,\s*"brand-icon\.png"\),\s*renderedAppPngs\.get\(256\)\)/u);
  assert.match(generator, /writeFileIfChanged\(path\.join\(brandRuntimeAssetsDir,\s*"brand-mark\.png"\),\s*brandMarkPng\)/u);
  assert.doesNotMatch(generator, /path\.join\(publicDir,\s*"brand-icon\.png"\)/u);
  assert.doesNotMatch(generator, /path\.join\(publicDir,\s*"brand-mark\.png"\)/u);
  assert.doesNotMatch(generator, /path\.join\(publicDir,\s*"tray-icon\.png"\)/u);
});

test("brand app icon generation rounds the white backdrop for every brand", async () => {
  for (const brandId of ["zenmind", "cutej"]) {
    const brand = loadBrandConfig(projectRoot, brandId);
    const iconPath = path.join(projectRoot, brand.icons.appIconSvg);
    const stats = await inspectPngBuffer(await renderAppIconToPng(fs.readFileSync(iconPath, "utf8"), 256));
    assertRoundedWhiteBackdrop(stats, `${brandId} app icon`);
    assertComfortableTileSize(stats, `${brandId} app icon`);
    assertComfortableForegroundSize(stats, `${brandId} app icon`);
    assertNoGrayTile(stats, `${brandId} app icon`);
    assert(stats.opaquePixels > stats.width * stats.height * 0.5, `${brandId} app icon should include a visible rounded backdrop`);
  }
});

test("brand mark generation keeps header art transparent and brand-owned", async () => {
  for (const brandId of ["zenmind", "cutej"]) {
    const brand = loadBrandConfig(projectRoot, brandId);
    const iconPath = path.join(projectRoot, brand.icons.appIconSvg);
    const stats = await inspectPngBuffer(await renderBrandMarkToPng(fs.readFileSync(iconPath, "utf8"), 256));
    assertTransparentBrandMark(stats, `${brandId} brand mark`);
  }
});

test("generated active brand app icon PNGs keep the rounded brand backdrop", async (t) => {
  const generatedBrandPath = newestGeneratedBrandPath();
  if (!fs.existsSync(generatedBrandPath)) {
    t.skip("generated brand icon artifacts are not active");
    return;
  }
  const activeBrandId = readJson(generatedBrandPath).id;

  for (const iconPath of [
    path.join(brandRuntimeAssetDir(projectRoot, activeBrandId), "brand-icon.png"),
    path.join(brandIconDir(projectRoot, activeBrandId), "icon-256.png"),
    path.join(brandIconDir(projectRoot, activeBrandId), "icon.png")
  ]) {
    if (!fs.existsSync(iconPath)) {
      t.skip(`${path.relative(projectRoot, iconPath)} is not generated`);
      return;
    }
    const stats = await inspectPngPixels(iconPath);
    assertRoundedWhiteBackdrop(stats, `${iconPath} for ${activeBrandId}`);
    assertComfortableTileSize(stats, `${iconPath} for ${activeBrandId}`);
    assertComfortableForegroundSize(stats, `${iconPath} for ${activeBrandId}`);
    assertNoGrayTile(stats, `${iconPath} for ${activeBrandId}`);
    assert(stats.opaquePixels > stats.width * stats.height * 0.1, `${iconPath} should contain non-empty ${activeBrandId} icon art`);
  }
});

test("generated active brand mark PNG keeps transparent header foreground", async (t) => {
  const generatedBrandPath = newestGeneratedBrandPath();
  if (!fs.existsSync(generatedBrandPath)) {
    t.skip("generated brand mark artifact is not active");
    return;
  }
  const activeBrandId = readJson(generatedBrandPath).id;
  const brandMarkPath = path.join(brandRuntimeAssetDir(projectRoot, activeBrandId), "brand-mark.png");
  if (!fs.existsSync(brandMarkPath)) {
    t.skip(`generated ${brandBuildRelativePath(activeBrandId, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png")} is not active`);
    return;
  }
  const stats = await inspectPngPixels(brandMarkPath);
  assertTransparentBrandMark(stats, `${brandBuildRelativePath(activeBrandId, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png")} for ${activeBrandId}`);
});

test("generated active tray icon stays outside public for the current brand", async (t) => {
  const generatedBrandPath = newestGeneratedBrandPath();
  if (!fs.existsSync(generatedBrandPath)) {
    t.skip("generated tray icon artifact is not active");
    return;
  }
  const activeBrandId = readJson(generatedBrandPath).id;
  const brand = loadBrandConfig(projectRoot, activeBrandId);
  const generatedTrayPngPath = path.join(brandRuntimeAssetDir(projectRoot, brand), "tray-icon.png");
  const generatedTraySvgPath = path.join(brandRuntimeAssetDir(projectRoot, brand), "tray-icon.svg");
  if (!fs.existsSync(generatedTrayPngPath) || !fs.existsSync(generatedTraySvgPath)) {
    t.skip(`generated ${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME)}/tray-icon assets are not active`);
    return;
  }

  assert.equal(
    fs.readFileSync(generatedTraySvgPath, "utf8"),
    fs.readFileSync(path.join(projectRoot, brand.icons.trayIconSvg), "utf8")
  );
  const stats = await inspectPngPixels(generatedTrayPngPath);
  assert(stats.opaquePixels > 0, `${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png")} should contain ${activeBrandId} tray art`);
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    assert.equal(fs.existsSync(path.join(projectRoot, "public", fileName)), false, `public/${fileName} should stay absent`);
  }
});

test("brand consistency guard catches and clears stale dist-renderer output", (t) => {
  const root = createBrandFixture(t);
  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  writeMinimalGeneratedIconArtifacts(root, brand);

  const staleRendererRoot = brandRendererDir(root, brand);
  fs.mkdirSync(staleRendererRoot, { recursive: true });
  fs.writeFileSync(
    path.join(staleRendererRoot, "index.html"),
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      "  <meta http-equiv=\"Content-Security-Policy\" content=\"img-src 'self' cutej-pet:;\">",
      "  <title>CuteJ</title>",
      "</head>",
      "<body></body>",
      "</html>",
      ""
    ].join("\n"),
    "utf8"
  );

  assert.throws(
    () => assertBrandArtifactsConsistent({ rootDir: root, brand }),
    /build\/brands\/zenmind\/renderer\/index\.html/u
  );
  assert.equal(removeStaleRendererBuild({ rootDir: root, brand }), true);
  assert.equal(fs.existsSync(staleRendererRoot), false);
  assert.doesNotThrow(() => assertBrandArtifactsConsistent({ rootDir: root, brand }));

  fs.mkdirSync(staleRendererRoot, { recursive: true });
  fs.copyFileSync(path.join(root, "index.html"), path.join(staleRendererRoot, "index.html"));
  fs.copyFileSync(
    path.join(root, "brands", "cutej", "icons", "tray-icon.svg"),
    path.join(staleRendererRoot, "tray-icon.svg")
  );

  assert.throws(
    () => assertBrandArtifactsConsistent({ rootDir: root, brand }),
    /build\/brands\/zenmind\/renderer\/tray-icon\.svg/u
  );
  assert.equal(removeStaleRendererBuild({ rootDir: root, brand }), true);
  assert.equal(fs.existsSync(staleRendererRoot), false);
});

test("brand desktop pet copy helper writes the active brand and clears stale files", (t) => {
  const root = createBrandFixture(t);
  const outputDir = path.join(brandRendererDir(root, "zenmind"), "desktop-pet");
  const cutej = loadBrandConfig(root, "cutej");
  const zenmind = loadBrandConfig(root, "zenmind");

  copyBrandDesktopPetAssets({ rootDir: root, brand: cutej, outputDir });
  assertDirectoryBytesEqual(outputDir, path.join(root, cutej.source.desktopPetRoot));

  fs.writeFileSync(path.join(outputDir, "stale-cutej-only.webp"), "stale", "utf8");
  copyBrandDesktopPetAssets({ rootDir: root, brand: zenmind, outputDir });
  assertDirectoryBytesEqual(outputDir, path.join(root, zenmind.source.desktopPetRoot));
  assert.equal(fs.existsSync(path.join(outputDir, "stale-cutej-only.webp")), false);
});

test("brand consistency guard catches stale dist-renderer desktop pet output", (t) => {
  const root = createBrandFixture(t);
  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  writeMinimalGeneratedIconArtifacts(root, brand);
  writeMinimalDistRenderer(root, brand);
  copyBrandDesktopPetAssets({
    rootDir: root,
    brand: loadBrandConfig(root, "cutej"),
    outputDir: path.join(brandRendererDir(root, brand), "desktop-pet")
  });

  assert.throws(
    () => assertBrandArtifactsConsistent({ rootDir: root, brand }),
    /build\/brands\/zenmind\/renderer\/desktop-pet/u
  );
  assert.equal(removeStaleRendererBuild({ rootDir: root, brand }), true);
  assert.equal(fs.existsSync(brandRendererDir(root, brand)), false);
});

test("brand consistency guard accepts active dist-renderer desktop pet output", (t) => {
  const root = createBrandFixture(t);
  const brand = syncBrandArtifacts({ rootDir: root, brandId: "cutej" });
  writeMinimalGeneratedIconArtifacts(root, brand);
  writeMinimalDistRenderer(root, brand);
  copyBrandDesktopPetAssets({
    rootDir: root,
    brand,
    outputDir: path.join(brandRendererDir(root, brand), "desktop-pet")
  });

  assert.doesNotThrow(() => assertBrandArtifactsConsistent({ rootDir: root, brand }));
});

test("brand sync writes CuteJ isolated runtime paths into generated artifacts", (t) => {
  const root = createBrandFixture(t);
  const sourcePackageBefore = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const sourceIndexBefore = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const sourceUninstallBefore = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");

  const brand = syncBrandArtifacts({ rootDir: root, brandId: "cutej" });
  const expectedPet = readBrandDesktopPetManifest(root, "cutej");
  const generatedBrand = readJson(path.join(brandGeneratedDir(root, brand), "brand.json"));
  const generatedBrandTs = fs.readFileSync(path.join(brandGeneratedDir(root, brand), "brand.ts"), "utf8");
  const electronBuilderConfig = readJson(electronBuilderConfigPath(root, brand.id));
  const installerInclude = fs.readFileSync(path.join(brandInstallerDir(root, brand), "installer.nsh"), "utf8");
  const uninstallScript = fs.readFileSync(path.join(brandInstallerDir(root, brand), "uninstall.sh"), "utf8");
  const rendererIndex = renderRendererIndexHtml(fs.readFileSync(path.join(root, "index.html"), "utf8"), brand);

  assert.equal(brand.paths.runtimeRootDirName, ".cutej");
  assert.equal(brand.packageName, "desktop");
  assert.equal(brand.storageNamespace, "cutej-desktop");
  assert.equal(brand.paths.programDataDirName, "CuteJ");
  assert.equal(brand.mac.microphoneUsageDescription, "CuteJ 使用麦克风将你的语音输入转成文字。");
  assert.equal(brand.mac.speechRecognitionUsageDescription, "CuteJ 使用系统语音识别将你的语音输入转成文字。");
  assert.deepEqual(brand.desktopPet, expectedPet);
  assert.equal(generatedBrand.paths.runtimeRootDirName, ".cutej");
  assert.equal(generatedBrand.storageNamespace, "cutej-desktop");
  assert.equal(generatedBrand.paths.programDataDirName, "CuteJ");
  assert.deepEqual(generatedBrand.desktopPet, expectedPet);
  assert.match(generatedBrandTs, /"packageName": "desktop"/u);
  assert.equal(fs.existsSync(path.join(root, "public", "desktop-pet")), false);
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    assert.equal(fs.existsSync(path.join(root, "public", fileName)), false, `public/${fileName} should not be generated`);
  }
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), sourcePackageBefore);
  assert.equal(fs.readFileSync(path.join(root, "index.html"), "utf8"), sourceIndexBefore);
  assert.equal(fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8"), sourceUninstallBefore);
  assert.equal(
    electronBuilderConfig.directories.app.startsWith(brandBuildRelativePath(brand, "app", "")),
    true
  );
  assert.equal(
    electronBuilderConfig.directories.output === "dist/cutej",
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === desktopBuiltinServicesRelativePath() && item.to === "services"),
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, "resources", "services")),
    false
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, "resources", "demo") && item.to === "demo"),
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png") && item.to === "brand-icon.png"),
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png") && item.to === "brand-mark.png"),
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png") && item.to === "tray-icon.png"),
    true
  );
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === brandBuildRelativePath(brand, "installer", "uninstall.sh") && item.to === "uninstall.sh"),
    true
  );
  assert.equal(electronBuilderConfig.mac.icon, brandBuildRelativePath(brand, "icons", "icon.icns"));
  assert.equal(electronBuilderConfig.mac.extendInfo.NSMicrophoneUsageDescription, "CuteJ 使用麦克风将你的语音输入转成文字。");
  assert.equal(electronBuilderConfig.mac.extendInfo.NSSpeechRecognitionUsageDescription, "CuteJ 使用系统语音识别将你的语音输入转成文字。");
  assert.equal(electronBuilderConfig.mac.notarize, false);
  assert.equal(electronBuilderConfig.mac.timestamp, undefined);
  assert.equal(electronBuilderConfig.win.icon, brandBuildRelativePath(brand, "icons", "icon.ico"));
  assert.equal(electronBuilderConfig.nsis.include, brandBuildRelativePath(brand, "installer", "installer.nsh"));
  assert.equal(electronBuilderConfig.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(electronBuilderConfig.nsis.perMachine, false);
  assert.equal(electronBuilderConfig.nsis.allowElevation, false);
  assert.match(installerInclude, /StrCpy \$isForceCurrentInstall "1"/u);
  assert.match(installerInclude, /StrCpy \$DesktopDataRoot "\$PROFILE\\\.cutej"/u);
  assert.match(installerInclude, /Function un\.CuteJEnsureDataRootDefault/u);
  assert.match(installerInclude, /Call un\.CuteJEnsureDataRootDefault/u);
  assert.match(installerInclude, /\$DesktopDataRoot\\programs/u);
  assert.match(installerInclude, /customPageAfterChangeDir/u);
  assert.match(installerInclude, /CuteJDataDirectoryPage/u);
  assert.match(installerInclude, /nsDialogs::SelectFolderDialog/u);
  assert.match(installerInclude, /WriteRegStr HKCU "Software\\cutej-desktop" "DataRoot"/u);
  assert.doesNotMatch(installerInclude, /\$APPDATA\\CuteJ/u);
  assert.doesNotMatch(installerInclude, /\\.desktop\\state/u);
  assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.cutej\/\.desktop"/u);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/CuteJ"/u);
  assert.match(rendererIndex, /<title>CuteJ<\/title>/u);
  assert.match(rendererIndex, /img-src[^"]*cutej-pet:/u);
  assert.doesNotMatch(rendererIndex, /zenmind-pet:/u);
});

test("brand sync disables macOS signing timestamp when notarization is skipped", (t) => {
  const originalSkipNotarize = process.env.SKIP_NOTARIZE;
  process.env.SKIP_NOTARIZE = "1";
  t.after(() => {
    if (originalSkipNotarize === undefined) {
      delete process.env.SKIP_NOTARIZE;
      return;
    }
    process.env.SKIP_NOTARIZE = originalSkipNotarize;
  });

  const root = createBrandFixture(t);
  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  const electronBuilderConfig = readJson(electronBuilderConfigPath(root, brand.id));

  assert.equal(electronBuilderConfig.mac.timestamp, "none");
});

test("brand sync keeps ZenMind isolated defaults in generated artifacts", (t) => {
  const root = createBrandFixture(t);
  const sourcePackageBefore = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const sourceIndexBefore = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const sourceUninstallBefore = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");

  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  const expectedPet = readBrandDesktopPetManifest(root, "zenmind");
  const generatedBrand = readJson(path.join(brandGeneratedDir(root, brand), "brand.json"));
  const electronBuilderConfig = readJson(electronBuilderConfigPath(root, brand.id));
  const installerInclude = fs.readFileSync(path.join(brandInstallerDir(root, brand), "installer.nsh"), "utf8");
  const uninstallScript = fs.readFileSync(path.join(brandInstallerDir(root, brand), "uninstall.sh"), "utf8");
  const rendererIndex = renderRendererIndexHtml(fs.readFileSync(path.join(root, "index.html"), "utf8"), brand);

  assert.equal(brand.paths.runtimeRootDirName, ".zenmind");
  assert.equal(brand.packageName, "desktop");
  assert.equal(brand.storageNamespace, "zenmind-desktop");
  assert.equal(brand.paths.programDataDirName, "ZenMind");
  assert.equal(brand.mac.microphoneUsageDescription, "ZenMind 使用麦克风将你的语音输入转成文字。");
  assert.equal(brand.mac.speechRecognitionUsageDescription, "ZenMind 使用系统语音识别将你的语音输入转成文字。");
  assert.deepEqual(brand.desktopPet, expectedPet);
  assert.equal(generatedBrand.storageNamespace, "zenmind-desktop");
  assert.equal(generatedBrand.paths.programDataDirName, "ZenMind");
  assert.deepEqual(generatedBrand.desktopPet, expectedPet);
  assert.equal(fs.existsSync(path.join(root, "public", "desktop-pet")), false);
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    assert.equal(fs.existsSync(path.join(root, "public", fileName)), false, `public/${fileName} should not be generated`);
  }
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), sourcePackageBefore);
  assert.equal(fs.readFileSync(path.join(root, "index.html"), "utf8"), sourceIndexBefore);
  assert.equal(fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8"), sourceUninstallBefore);
  assert.match(installerInclude, /StrCpy \$isForceCurrentInstall "1"/u);
  assert.match(installerInclude, /StrCpy \$DesktopDataRoot "\$PROFILE\\\.zenmind"/u);
  assert.match(installerInclude, /Function un\.ZenMindEnsureDataRootDefault/u);
  assert.match(installerInclude, /Call un\.ZenMindEnsureDataRootDefault/u);
  assert.match(installerInclude, /\$DesktopDataRoot\\programs/u);
  assert.match(installerInclude, /customPageAfterChangeDir/u);
  assert.match(installerInclude, /ZenMindDataDirectoryPage/u);
  assert.match(installerInclude, /WriteRegStr HKCU "Software\\zenmind-desktop" "DataRoot"/u);
  assert.doesNotMatch(installerInclude, /\$APPDATA\\ZenMind/u);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/ZenMind"/u);
  assert.equal(electronBuilderConfig.mac.extendInfo.NSMicrophoneUsageDescription, "ZenMind 使用麦克风将你的语音输入转成文字。");
  assert.equal(electronBuilderConfig.mac.extendInfo.NSSpeechRecognitionUsageDescription, "ZenMind 使用系统语音识别将你的语音输入转成文字。");
  assert.match(rendererIndex, /<title>ZenMind<\/title>/u);
  assert.match(rendererIndex, /img-src[^"]*zenmind-pet:/u);
  assert.doesNotMatch(rendererIndex, /cutej-pet:/u);
});

test("brand sync keeps source files stable across brand switches", (t) => {
  const root = createBrandFixture(t);
  fs.mkdirSync(path.join(root, "src", "shared"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "src", "shared", "brand.ts"), path.join(root, "src", "shared", "brand.ts"));
  const sourceIndexBefore = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const sourceBrandModuleBefore = fs.readFileSync(path.join(root, "src", "shared", "brand.ts"), "utf8");

  syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  syncBrandArtifacts({ rootDir: root, brandId: "cutej" });
  syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });

  assert.equal(fs.readFileSync(path.join(root, "index.html"), "utf8"), sourceIndexBefore);
  assert.equal(fs.readFileSync(path.join(root, "src", "shared", "brand.ts"), "utf8"), sourceBrandModuleBefore);
  assert.equal(readJson(path.join(brandGeneratedDir(root, "zenmind"), "brand.json")).productName, "ZenMind");
  assert.equal(readJson(path.join(brandGeneratedDir(root, "cutej"), "brand.json")).productName, "CuteJ");
  assert.equal(fs.existsSync(path.join(root, "build", "generated", "brand.json")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "shared", "generated", "brand.ts")), false);
});

test("default desktop pet assets are brand-owned after generator removal", () => {
  const removedPetGenerator = path.join(projectRoot, "scripts", `generate-${["desktop", "pet", "assets"].join("-")}.mjs`);
  const removedPetAssetRoot = path.join(projectRoot, "scripts", "assets", "desktop-pet");

  assert.equal(fs.existsSync(path.join(projectRoot, "brands", "zenmind", "desktop-pet", "pet.json")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "brands", "cutej", "desktop-pet", "pet.json")), true);
  assert.equal(fs.existsSync(removedPetGenerator), false);
  assert.equal(fs.existsSync(removedPetAssetRoot), false);
});

test("brand runtime icons are generated outside public and stale public copies are cleaned", (t) => {
  const root = createBrandFixture(t);
  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  const gitignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  const iconGenerator = fs.readFileSync(path.join(projectRoot, "scripts", "generate-app-icons.mjs"), "utf8");

  assert.match(gitignore, /^public\/brand-mark\.png$/mu);
  assert.match(gitignore, /^public\/brand-icon\.png$/mu);
  assert.match(gitignore, /^public\/tray-icon\.png$/mu);
  assert.match(gitignore, /^public\/tray-icon\.svg$/mu);
  assert.match(iconGenerator, /writeFileIfChanged\(path\.join\(brandRuntimeAssetsDir,\s*"brand-mark\.png"\),\s*brandMarkPng\)/u);
  assert.doesNotMatch(iconGenerator, /writeFileIfChanged\(path\.join\(publicDir/u);

  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    fs.writeFileSync(path.join(root, "public", fileName), "stale", "utf8");
  }

  syncBrandArtifacts({ rootDir: root, brandId: brand.id });
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    assert.equal(fs.existsSync(path.join(root, "public", fileName)), false, `public/${fileName} should be cleaned`);
  }
});

test("brand manifest rejects mismatched explicit runtimeRootDirName", (t) => {
  const root = createBrandFixture(t);

  writeBrandManifest(root, "cutej", (manifest) => ({
    ...manifest,
    paths: {
      ...manifest.paths,
      runtimeRootDirName: ".zenmind"
    }
  }));

  assert.throws(
    () => loadBrandConfig(root, "cutej"),
    /paths\.runtimeRootDirName" must be "\.cutej"/u
  );
});

test("brand manifest keeps explicit mac privacy usage descriptions when provided", (t) => {
  const root = createBrandFixture(t);
  writeBrandManifest(root, "zenmind", (manifest) => ({
    ...manifest,
    mac: {
      microphoneUsageDescription: "ZenMind 需要麦克风权限用于语音输入。",
      speechRecognitionUsageDescription: "ZenMind 需要系统语音识别权限用于转写语音。"
    }
  }));

  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  const electronBuilderConfig = readJson(electronBuilderConfigPath(root, brand.id));

  assert.equal(brand.mac.microphoneUsageDescription, "ZenMind 需要麦克风权限用于语音输入。");
  assert.equal(brand.mac.speechRecognitionUsageDescription, "ZenMind 需要系统语音识别权限用于转写语音。");
  assert.equal(electronBuilderConfig.mac.extendInfo.NSMicrophoneUsageDescription, "ZenMind 需要麦克风权限用于语音输入。");
  assert.equal(electronBuilderConfig.mac.extendInfo.NSSpeechRecognitionUsageDescription, "ZenMind 需要系统语音识别权限用于转写语音。");
});

test("sync-env rejects current brand and legacy env wrapper directories", async (t) => {
  const root = createBrandFixture(t);
  fs.writeFileSync(path.join(root, "VERSION"), "v1.2.3\n", "utf8");

  const cutejWrapperZipPath = path.join(root, "fixtures", "cutej-wrapper.zip");
  await writeZip(cutejWrapperZipPath, {
    "env/.cutej/VERSION": "1.2.3\n",
    "env/.cutej/agents/demo/agent.yml": "name: demo\n"
  });
  await assert.rejects(
    () => prepareBundledEnvZip({
      rootDir: root,
      env: { BRAND: "cutej", ENV_ZIP: cutejWrapperZipPath },
      logger: silentLogger
    }),
    /nested environment wrapper/u
  );

  const legacyWrapperZipPath = path.join(root, "fixtures", "legacy-wrapper.zip");
  await writeZip(legacyWrapperZipPath, {
    "env/.zenmind/VERSION": "1.2.3\n",
    "env/.zenmind/agents/demo/agent.yml": "name: demo\n"
  });
  await assert.rejects(
    () => prepareBundledEnvZip({
      rootDir: root,
      env: { BRAND: "cutej", ENV_ZIP: legacyWrapperZipPath },
      logger: silentLogger
    }),
    /nested environment wrapper/u
  );
});

test("sync-env clears stale bundled env zip when ENV_ZIP is not provided", async (t) => {
  const root = createBrandFixture(t);
  fs.writeFileSync(path.join(root, "VERSION"), "v1.2.3\n", "utf8");
  const staleZipPath = path.join(brandResourcesDir(root, "zenmind"), "env", "env.zip");
  fs.mkdirSync(path.dirname(staleZipPath), { recursive: true });
  fs.writeFileSync(staleZipPath, "stale", "utf8");

  const result = await prepareBundledEnvZip({
    rootDir: root,
    env: { BRAND: "zenmind" },
    logger: silentLogger
  });
  const manifest = readJson(path.join(brandResourcesDir(root, "zenmind"), "env", "manifest.json"));

  assert.equal(result.bundled, false);
  assert.equal(result.fileName, null);
  assert.equal(result.outputPath, null);
  assert.equal(fs.existsSync(staleZipPath), false);
  assert.deepEqual(manifest, {
    bundled: false,
    fileName: null,
    version: "1.2.3"
  });
});

test("dev startup syncs env zip resources before building the main process", () => {
  const devScript = fs.readFileSync(path.join(projectRoot, "scripts", "dev.mjs"), "utf8");
  const syncEnvIndex = devScript.indexOf('["./scripts/sync-env-zip.mjs"]');
  const buildMainIndex = devScript.indexOf('["run", "build:main"]');

  assert.notEqual(syncEnvIndex, -1);
  assert.notEqual(buildMainIndex, -1);
  assert.equal(syncEnvIndex < buildMainIndex, true);
});

test("sync-demo defaults to manifest only and copies webapp templates when enabled", async (t) => {
  const root = createBrandFixture(t);
  const sourceDir = path.join(root, "public", "webapp-templates", "demo-node-html");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "webapp.json"), "{}\n", "utf8");

  const defaultResult = await prepareBundledDemoAssets({
    rootDir: root,
    env: {},
    logger: silentLogger
  });
  assert.equal(defaultResult.bundled, false);
  assert.deepEqual(defaultResult.webappTemplates, []);
  assert.equal(fs.existsSync(path.join(brandResourcesDir(root, "zenmind"), "demo", "webapp-templates")), false);
  assert.equal(readJson(path.join(brandResourcesDir(root, "zenmind"), "demo", "manifest.json")).bundled, false);

  const enabledResult = await prepareBundledDemoAssets({
    rootDir: root,
    env: { DEMO: "1" },
    logger: silentLogger
  });
  assert.equal(enabledResult.bundled, true);
  assert.deepEqual(enabledResult.webappTemplates, ["demo-node-html"]);
  assert.equal(
    fs.existsSync(path.join(brandResourcesDir(root, "zenmind"), "demo", "webapp-templates", "demo-node-html", "webapp.json")),
    true
  );

  await assert.rejects(
    () => prepareBundledDemoAssets({
      rootDir: root,
      env: { DEMO: "maybe" },
      logger: silentLogger
    }),
    /DEMO must be one of/u
  );
});

test("stage-app removes renderer webapp templates from staged app", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-stage-demo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stagedTemplatePath = path.join(root, "dist-renderer", "webapp-templates", "demo-node-html", "webapp.json");
  fs.mkdirSync(path.dirname(stagedTemplatePath), { recursive: true });
  fs.writeFileSync(stagedTemplatePath, "{}\n", "utf8");

  removeRendererWebappTemplatesFromStage(root);

  assert.equal(fs.existsSync(path.join(root, "dist-renderer", "webapp-templates")), false);
});

test("Windows dist latest metadata aliases spaced installer artifacts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-win-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "dist", "cutej");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "CuteJ Setup 0.3.10.exe"), "installer", "utf8");
  fs.writeFileSync(path.join(outputDir, "CuteJ Setup 0.3.10.exe.blockmap"), "blockmap", "utf8");
  fs.writeFileSync(
    path.join(outputDir, "latest.yml"),
    "files:\n  - url: CuteJ-Setup-0.3.10.exe\npath: CuteJ-Setup-0.3.10.exe\n",
    "utf8"
  );

  ensureWindowsLatestAliases({ id: "cutej", productName: "CuteJ" }, root);

  assert.equal(fs.readFileSync(path.join(outputDir, "CuteJ-Setup-0.3.10.exe"), "utf8"), "installer");
  assert.equal(fs.readFileSync(path.join(outputDir, "CuteJ-Setup-0.3.10.exe.blockmap"), "utf8"), "blockmap");
});

test("Windows installer data directory page clears stale NSIS errors before first create check", () => {
  const installerInclude = fs.readFileSync(
    path.join(projectRoot, "build", "brands", "cutej", "installer", "installer.nsh"),
    "utf8"
  );
  const createDirectoryIndex = installerInclude.indexOf('CreateDirectory "$DesktopDataRoot"');
  assert.notEqual(createDirectoryIndex, -1);
  const beforeCreateDirectory = installerInclude.slice(Math.max(0, createDirectoryIndex - 200), createDirectoryIndex);

  assert.match(beforeCreateDirectory, /IfFileExists "\$DesktopDataRoot\\\*" .*DataDirectoryReady/u);
  assert.match(beforeCreateDirectory, /ClearErrors/u);
});

test("critical runtime path modules use shared brand-aware roots", () => {
  const expectations = [
    ["src/main/kanban-db.ts", /getDataRoot/u],
    ["src/main/kanban-runtime.ts", /resolveRuntimeRoot/u],
    ["src/main/assistant/core/agent-platform-config.ts", /resolveRuntimeRoot/u],
    ["src/main/assistant/core/agent-platform-bridge.ts", /resolveRuntimeRoot/u]
  ];

  for (const [relativePath, pattern] of expectations) {
    const content = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(content, pattern, relativePath);
    assert.doesNotMatch(content, /["'`]\.zenmind["'`]/u, relativePath);
  }
});

test("skill installer uses shared runtime root on Windows before legacy ZenMind fallbacks", () => {
  const content = fs.readFileSync(path.join(projectRoot, "src/main/skill-installer.ts"), "utf8");

  assert.match(content, /import \{ resolveRuntimeRootPath \} from "\.\/runtime-root";/u);
  assert.match(content, /const preferredRuntimeRoot = resolveRuntimeRootPath\(/u);
  assert.match(content, /if \(process\.platform === "win32"\) \{\s*return preferredRuntimeRoot;\s*\}/u);
  assert.match(content, /if \(String\(APP_BRAND\.id\) === "zenmind"\) \{/u);
  assert.match(content, /return preferredRuntimeRoot;/u);
  assert.equal([...content.matchAll(/path\.join\([^)]*"\.zenmind"[^)]*\)/gu)].length, 2);
});
