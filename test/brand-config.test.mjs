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

test("brand resolver defaults to zenmind and accepts explicit xiaojun", () => {
  assert.equal(resolveBrandId([], {}), "zenmind");
  assert.equal(resolveBrandId(["--brand=xiaojun"], {}), "xiaojun");
  assert.equal(resolveBrandId(["--brand", "xiaojun"], {}), "xiaojun");

  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  assert.equal(zenmind.appId, "cc.zenmind.desktop");
  assert.equal(zenmind.productName, "ZenMind");
  assert.equal(zenmind.packageName, "zenmind-desktop");
  assert.equal(zenmind.paths.runtimeRootDirName, ".zenmind");
  assert.equal(zenmind.paths.desktopDataSubdir, ".desktop");
  assert.equal(zenmind.paths.programDataDirName, "ZenMind");

  const xiaojun = loadBrandConfig(projectRoot, "xiaojun");
  assert.equal(xiaojun.appId, "cc.xiaojun.desktop");
  assert.equal(xiaojun.productName, "XiaoJun");
  assert.equal(xiaojun.packageName, "xiaojun-desktop");
  assert.equal(xiaojun.storageNamespace, "zenmind-desktop");
  assert.equal(xiaojun.i18n["zh-CN"]["app.name"], "XiaoJun");
  assert.match(xiaojun.i18n["en-US"]["startup.envImport.title"], /XiaoJun/);
  assert.deepEqual(xiaojun.paths, zenmind.paths);
});

test("brand sync generates runtime constants, package metadata, and builder config", () => {
  const root = createBrandSyncFixture();
  try {
    const brand = syncBrandArtifacts({ rootDir: root, brandId: "xiaojun" });
    const packageJson = readJson(path.join(root, "package.json"));
    const packageLock = readJson(path.join(root, "package-lock.json"));
    const generatedBrand = readJson(path.join(root, "build", "generated", "brand.json"));
    const builderConfig = readJson(path.join(root, "build", "electron-builder.xiaojun.json"));
    const generatedTs = fs.readFileSync(path.join(root, "src", "shared", "generated", "brand.ts"), "utf8");
    const installerInclude = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
    const uninstallScript = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");

    assert.equal(brand.id, "xiaojun");
    assert.equal(packageJson.name, "xiaojun-desktop");
    assert.equal(packageJson.description, "XiaoJun 应用壳");
    assert.equal(packageJson.build, undefined);
    assert.equal(packageLock.name, "xiaojun-desktop");
    assert.equal(packageLock.packages[""].name, "xiaojun-desktop");
    assert.equal(generatedBrand.productName, "XiaoJun");
    assert.equal(generatedBrand.storageNamespace, "zenmind-desktop");
    assert.equal(builderConfig.appId, "cc.xiaojun.desktop");
    assert.equal(builderConfig.productName, "XiaoJun");
    assert.equal(builderConfig.nsis.include, "build/installer.nsh");
    assert.match(generatedTs, /export const APP_BRAND =/);
    assert.match(generatedTs, /XiaoJun/);
    assert.match(installerInclude, /Requesting XiaoJun to exit before installing/);
    assert.match(installerInclude, /%APPDATA%\\ZenMind/);
    assert.match(uninstallScript, /APP_NAME="XiaoJun"/);
    assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.zenmind\/\.desktop"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("brand manifest validation rejects missing and malformed fields", () => {
  const invalidPackageRoot = createBrandSyncFixture();
  try {
    writeBrandManifest(invalidPackageRoot, "xiaojun", { packageName: "XiaoJun Desktop" });
    assert.throws(
      () => loadBrandConfig(invalidPackageRoot, "xiaojun"),
      /packageName is invalid/
    );
  } finally {
    fs.rmSync(invalidPackageRoot, { recursive: true, force: true });
  }

  const invalidAppIdRoot = createBrandSyncFixture();
  try {
    writeBrandManifest(invalidAppIdRoot, "xiaojun", { appId: "xiaojun" });
    assert.throws(
      () => loadBrandConfig(invalidAppIdRoot, "xiaojun"),
      /appId is invalid/
    );
  } finally {
    fs.rmSync(invalidAppIdRoot, { recursive: true, force: true });
  }

  const missingIconRoot = createBrandSyncFixture();
  try {
    fs.rmSync(path.join(missingIconRoot, "brands", "xiaojun", "icons", "app-icon.svg"));
    assert.throws(
      () => loadBrandConfig(missingIconRoot, "xiaojun"),
      /Brand icon file not found/
    );
  } finally {
    fs.rmSync(missingIconRoot, { recursive: true, force: true });
  }
});

test("brand icon inputs are manifest-driven and distinct per brand", () => {
  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  const xiaojun = loadBrandConfig(projectRoot, "xiaojun");
  const iconScript = fs.readFileSync(path.join(projectRoot, "scripts", "generate-app-icons.mjs"), "utf8");

  assert.notEqual(zenmind.icons.appIconSvg, xiaojun.icons.appIconSvg);
  assert.notEqual(
    fs.readFileSync(path.join(projectRoot, zenmind.icons.appIconSvg), "utf8"),
    fs.readFileSync(path.join(projectRoot, xiaojun.icons.appIconSvg), "utf8")
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
