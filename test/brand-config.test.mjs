import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBrandConfig,
  resolveBrandId,
  syncBrandArtifacts
} from "../scripts/lib/brand-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createBrandSyncFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-brand-config-"));
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
  return root;
}

function writeBrandManifest(root, brandId, patch) {
  const manifestPath = path.join(root, "brands", brandId, "brand.json");
  const manifest = readJson(manifestPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8");
}

function walkFiles(root, predicate, result = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, predicate, result);
    } else if (predicate(filePath)) {
      result.push(filePath);
    }
  }
  return result;
}

test("brand resolver defaults to zenmind and accepts explicit cutej", () => {
  assert.equal(resolveBrandId([], {}), "zenmind");
  assert.equal(resolveBrandId(["--brand=cutej"], {}), "cutej");
  assert.equal(resolveBrandId(["--brand", "cutej"], {}), "cutej");

  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  assert.equal(zenmind.appId, "cc.zenmind.desktop");
  assert.equal(zenmind.productName, "ZenMind");
  assert.equal(zenmind.packageName, "zenmind-desktop");
  assert.equal(zenmind.paths.runtimeRootDirName, ".zenmind");
  assert.equal(zenmind.paths.desktopDataSubdir, ".desktop");
  assert.equal(zenmind.paths.programDataDirName, "ZenMind");

  const cutej = loadBrandConfig(projectRoot, "cutej");
  assert.equal(cutej.appId, "cc.cutej.desktop");
  assert.equal(cutej.productName, "cutej");
  assert.equal(cutej.packageName, "cutej-desktop");
  assert.equal(cutej.storageNamespace, "zenmind-desktop");
  assert.equal(cutej.i18n["zh-CN"]["app.name"], "小君");
  assert.match(cutej.i18n["en-US"]["startup.envImport.title"], /cutej/);
  assert.deepEqual(cutej.paths, zenmind.paths);
});

test("brand sync generates runtime constants, package metadata, and builder config", () => {
  const root = createBrandSyncFixture();
  try {
    const brand = syncBrandArtifacts({ rootDir: root, brandId: "cutej" });
    const packageJson = readJson(path.join(root, "package.json"));
    const packageLock = readJson(path.join(root, "package-lock.json"));
    const generatedBrand = readJson(path.join(root, "build", "generated", "brand.json"));
    const builderConfig = readJson(path.join(root, "build", "electron-builder.cutej.json"));
    const generatedTs = fs.readFileSync(path.join(root, "src", "shared", "generated", "brand.ts"), "utf8");
    const installerInclude = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
    const uninstallScript = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");

    assert.equal(brand.id, "cutej");
    assert.equal(packageJson.name, "cutej-desktop");
    assert.equal(packageJson.description, "cutej 应用壳");
    assert.equal(packageJson.build, undefined);
    assert.equal(packageLock.name, "cutej-desktop");
    assert.equal(packageLock.packages[""].name, "cutej-desktop");
    assert.equal(generatedBrand.productName, "cutej");
    assert.equal(generatedBrand.storageNamespace, "zenmind-desktop");
    assert.equal(builderConfig.appId, "cc.cutej.desktop");
    assert.equal(builderConfig.productName, "cutej");
    assert.equal(builderConfig.nsis.include, "build/installer.nsh");
    assert.match(generatedTs, /export const APP_BRAND =/);
    assert.match(generatedTs, /cutej/);
    assert.match(installerInclude, /Requesting cutej to exit before installing/);
    assert.match(installerInclude, /%APPDATA%\\ZenMind/);
    assert.match(uninstallScript, /APP_NAME="cutej"/);
    assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.zenmind\/\.desktop"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("brand manifest validation rejects missing and malformed fields", () => {
  const invalidPackageRoot = createBrandSyncFixture();
  try {
    writeBrandManifest(invalidPackageRoot, "cutej", { packageName: "cutej Desktop" });
    assert.throws(
      () => loadBrandConfig(invalidPackageRoot, "cutej"),
      /packageName is invalid/
    );
  } finally {
    fs.rmSync(invalidPackageRoot, { recursive: true, force: true });
  }

  const invalidAppIdRoot = createBrandSyncFixture();
  try {
    writeBrandManifest(invalidAppIdRoot, "cutej", { appId: "cutej" });
    assert.throws(
      () => loadBrandConfig(invalidAppIdRoot, "cutej"),
      /appId is invalid/
    );
  } finally {
    fs.rmSync(invalidAppIdRoot, { recursive: true, force: true });
  }

  const missingIconRoot = createBrandSyncFixture();
  try {
    fs.rmSync(path.join(missingIconRoot, "brands", "cutej", "icons", "app-icon.svg"));
    assert.throws(
      () => loadBrandConfig(missingIconRoot, "cutej"),
      /Brand icon file not found/
    );
  } finally {
    fs.rmSync(missingIconRoot, { recursive: true, force: true });
  }
});

test("brand icon inputs are manifest-driven and distinct per brand", () => {
  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  const cutej = loadBrandConfig(projectRoot, "cutej");
  const iconScript = fs.readFileSync(path.join(projectRoot, "scripts", "generate-app-icons.mjs"), "utf8");

  assert.notEqual(zenmind.icons.appIconSvg, cutej.icons.appIconSvg);
  assert.notEqual(
    fs.readFileSync(path.join(projectRoot, zenmind.icons.appIconSvg), "utf8"),
    fs.readFileSync(path.join(projectRoot, cutej.icons.appIconSvg), "utf8")
  );
  assert.match(iconScript, /const appIconSvgPath = path\.join\(projectRoot, brand\.icons\.appIconSvg\);/);
  assert.match(iconScript, /const trayIconSourceSvgPath = path\.join\(projectRoot, brand\.icons\.trayIconSvg\);/);
  assert.match(iconScript, /publicDir, "brand-icon\.png"/);
  assert.match(iconScript, /publicDir, "tray-icon\.png"/);
});

test("source keeps user-visible brand strings behind generated constants", () => {
  const sourceFiles = walkFiles(path.join(projectRoot, "src"), (filePath) =>
    /\.(?:ts|tsx|css)$/u.test(filePath) &&
    path.relative(projectRoot, filePath) !== path.join("src", "shared", "generated", "brand.ts")
  );

  const hardcodedBrandMatches = [];
  const forbiddenIdentifierMatches = [];
  for (const filePath of sourceFiles) {
    const relativePath = path.relative(projectRoot, filePath);
    const source = fs.readFileSync(filePath, "utf8");
    if (/ZenMind/u.test(source)) {
      hardcodedBrandMatches.push(relativePath);
    }
    if (/ZENMIND_APP_ID|ZENMIND_PRODUCT_NAME|resolveHomeZenmindRoot|homeZenmind/u.test(source)) {
      forbiddenIdentifierMatches.push(relativePath);
    }
  }

  assert.deepEqual(hardcodedBrandMatches, []);
  assert.deepEqual(forbiddenIdentifierMatches, []);
});
