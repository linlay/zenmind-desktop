import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loadBrandConfig,
  syncBrandArtifacts
} from "../scripts/lib/brand-config.mjs";
import { prepareBundledDemoAssets } from "../scripts/sync-demo-assets.mjs";
import { prepareBundledEnvZip } from "../scripts/sync-env-zip.mjs";
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
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

test("brand runtime root directory is derived from brand id", () => {
  const zenmind = loadBrandConfig(projectRoot, "zenmind");
  const cutej = loadBrandConfig(projectRoot, "cutej");
  const zenmindPet = readBrandDesktopPetManifest(projectRoot, "zenmind");
  const cutejPet = readBrandDesktopPetManifest(projectRoot, "cutej");

  assert.equal(zenmind.paths.runtimeRootDirName, ".zenmind");
  assert.equal(cutej.paths.runtimeRootDirName, ".cutej");
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
  assert.match(generator, /writeFileIfChanged\(publicTrayIconSvgPath,\s*Buffer\.from\(trayIconSvg\)\)/u);
  assert.match(generator, /writeFileIfChanged\(path\.join\(publicDir,\s*"tray-icon\.png"\),\s*trayPng\)/u);
  assert.match(generator, /writeFileIfChanged\(path\.join\(publicDir,\s*"brand-icon\.png"\),\s*renderedAppPngs\.get\(256\)\)/u);
});

test("brand sync writes CuteJ isolated runtime paths into generated artifacts", (t) => {
  const root = createBrandFixture(t);

  const brand = syncBrandArtifacts({ rootDir: root, brandId: "cutej" });
  const expectedPet = readBrandDesktopPetManifest(root, "cutej");
  const generatedBrand = readJson(path.join(root, "build", "generated", "brand.json"));
  const electronBuilderConfig = readJson(path.join(root, "build", "electron-builder.cutej.json"));
  const installerInclude = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  const uninstallScript = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");
  const rendererIndex = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const syncedPet = readJson(path.join(root, "public", "desktop-pet", "pet.json"));

  assert.equal(brand.paths.runtimeRootDirName, ".cutej");
  assert.equal(brand.storageNamespace, "cutej-desktop");
  assert.equal(brand.paths.programDataDirName, "CuteJ");
  assert.deepEqual(brand.desktopPet, expectedPet);
  assert.equal(generatedBrand.paths.runtimeRootDirName, ".cutej");
  assert.equal(generatedBrand.storageNamespace, "cutej-desktop");
  assert.equal(generatedBrand.paths.programDataDirName, "CuteJ");
  assert.deepEqual(generatedBrand.desktopPet, expectedPet);
  assert.equal(syncedPet.id, "cutej");
  assert.equal(syncedPet.displayName, expectedPet.displayName);
  assert.equal(fs.existsSync(path.join(root, "public", "desktop-pet", expectedPet.preview)), true);
  assert.equal(
    electronBuilderConfig.extraResources.some((item) => item.from === "build/resources/demo" && item.to === "demo"),
    true
  );
  assert.match(installerInclude, /%APPDATA%\\CuteJ/u);
  assert.match(installerInclude, /%USERPROFILE%\\\.cutej\\\.desktop\\state/u);
  assert.match(uninstallScript, /DATA_PATH="\$\{HOME\}\/\.cutej\/\.desktop"/u);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/CuteJ"/u);
  assert.match(rendererIndex, /<title>CuteJ<\/title>/u);
  assert.match(rendererIndex, /img-src[^"]*cutej-pet:/u);
  assert.doesNotMatch(rendererIndex, /zenmind-pet:/u);
});

test("brand sync keeps ZenMind isolated defaults in generated artifacts", (t) => {
  const root = createBrandFixture(t);

  const brand = syncBrandArtifacts({ rootDir: root, brandId: "zenmind" });
  const expectedPet = readBrandDesktopPetManifest(root, "zenmind");
  const generatedBrand = readJson(path.join(root, "build", "generated", "brand.json"));
  const installerInclude = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  const uninstallScript = fs.readFileSync(path.join(root, "scripts", "uninstall.sh"), "utf8");
  const rendererIndex = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const syncedPet = readJson(path.join(root, "public", "desktop-pet", "pet.json"));

  assert.equal(brand.paths.runtimeRootDirName, ".zenmind");
  assert.equal(brand.storageNamespace, "zenmind-desktop");
  assert.equal(brand.paths.programDataDirName, "ZenMind");
  assert.deepEqual(brand.desktopPet, expectedPet);
  assert.equal(generatedBrand.storageNamespace, "zenmind-desktop");
  assert.equal(generatedBrand.paths.programDataDirName, "ZenMind");
  assert.deepEqual(generatedBrand.desktopPet, expectedPet);
  assert.equal(syncedPet.id, "zenmi");
  assert.equal(syncedPet.displayName, expectedPet.displayName);
  assert.equal(fs.existsSync(path.join(root, "public", "desktop-pet", expectedPet.preview)), true);
  assert.match(installerInclude, /%APPDATA%\\ZenMind/u);
  assert.match(uninstallScript, /PROGRAM_DATA_PATH="\$\{HOME\}\/Library\/Application Support\/ZenMind"/u);
  assert.match(rendererIndex, /<title>ZenMind<\/title>/u);
  assert.match(rendererIndex, /img-src[^"]*zenmind-pet:/u);
  assert.doesNotMatch(rendererIndex, /cutej-pet:/u);
});

test("default desktop pet assets are brand-owned, not script-owned", () => {
  const generator = fs.readFileSync(path.join(projectRoot, "scripts", "generate-desktop-pet-assets.mjs"), "utf8");

  assert.equal(fs.existsSync(path.join(projectRoot, "brands", "zenmind", "desktop-pet", "pet.json")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "brands", "cutej", "desktop-pet", "pet.json")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "scripts", "assets", "desktop-pet", "zenmi")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, "scripts", "assets", "desktop-pet", "cutej")), false);
  assert.match(generator, /brand\.source\.desktopPetRoot/u);
  assert.doesNotMatch(generator, /defaultBuiltInPetId/u);
  assert.doesNotMatch(generator, /brand\.id === "cutej"/u);
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
  const staleZipPath = path.join(root, "build", "resources", "env", "env.zip");
  fs.mkdirSync(path.dirname(staleZipPath), { recursive: true });
  fs.writeFileSync(staleZipPath, "stale", "utf8");

  const result = await prepareBundledEnvZip({
    rootDir: root,
    env: { BRAND: "zenmind" },
    logger: silentLogger
  });
  const manifest = readJson(path.join(root, "build", "resources", "env", "manifest.json"));

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
  assert.equal(fs.existsSync(path.join(root, "build", "resources", "demo", "webapp-templates")), false);
  assert.equal(readJson(path.join(root, "build", "resources", "demo", "manifest.json")).bundled, false);

  const enabledResult = await prepareBundledDemoAssets({
    rootDir: root,
    env: { DEMO: "1" },
    logger: silentLogger
  });
  assert.equal(enabledResult.bundled, true);
  assert.deepEqual(enabledResult.webappTemplates, ["demo-node-html"]);
  assert.equal(
    fs.existsSync(path.join(root, "build", "resources", "demo", "webapp-templates", "demo-node-html", "webapp.json")),
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

test("critical runtime path modules read APP_BRAND runtimeRootDirName", () => {
  const files = [
    "src/main/task-board-db.ts",
    "src/main/task-board-runtime.ts",
    "src/main/copilot/core/agent-platform-config.ts",
    "src/main/copilot/core/agent-platform-bridge.ts"
  ];

  for (const relativePath of files) {
    const content = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(content, /APP_BRAND\.paths\.runtimeRootDirName/u, relativePath);
    assert.doesNotMatch(content, /["'`]\.zenmind["'`]/u, relativePath);
  }
});

test("skill installer keeps legacy runtime roots gated to the ZenMind brand", () => {
  const content = fs.readFileSync(path.join(projectRoot, "src/main/skill-installer.ts"), "utf8");

  assert.match(
    content,
    /const preferredRuntimeRoot = path\.join\(homeDir, APP_BRAND\.paths\.runtimeRootDirName\);/u
  );
  assert.match(content, /if \(String\(APP_BRAND\.id\) === "zenmind"\) \{/u);
  assert.match(content, /return preferredRuntimeRoot;/u);
  assert.equal([...content.matchAll(/path\.join\([^)]*"\.zenmind"[^)]*\)/gu)].length, 2);
});
