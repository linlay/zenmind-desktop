import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  brandInstallerDir,
  electronBuilderConfig,
  loadBrandConfig,
  writeInstallerInclude
} from "../scripts/lib/brand-config.mjs";
import { macDocumentTypes } from "../scripts/lib/document-file-associations.mjs";
import { resolveNsisToolchain } from "../scripts/build-safe-repair.mjs";

const require = createRequire(import.meta.url);
const plist = require("plist");
const { validateConfig } = require("app-builder-lib/out/util/config.js");
const { createMacApp } = require("app-builder-lib/out/electron/electronMac.js");
const MacPackager = require("app-builder-lib/out/macPackager.js").default;
const { PlatformPackager } = require("app-builder-lib/out/platformPackager.js");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensions = ["md", "markdown", "html", "htm"];

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-file-associations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function installerSource(t, brand) {
  const root = temporaryDirectory(t);
  writeInstallerInclude(root, brand);
  return fs.readFileSync(path.join(brandInstallerDir(root, brand), "installer.nsh"), "utf8");
}

function macro(source, name) {
  const result = source.match(new RegExp(`!macro ${name}\\n[\\s\\S]*?!macroend`, "u"))?.[0];
  assert.ok(result, `${name} should be present in the generated installer`);
  return result;
}

for (const brandId of ["cutej", "zenmind"]) {
  const brand = loadBrandConfig(projectRoot, brandId);

  test(`${brandId} document registration respects the installed builder schema and platform boundaries`, async () => {
    for (const target of [{ os: "darwin", arch: "arm64" }, { os: "win32", arch: "x64" }]) {
      const config = electronBuilderConfig(brand, target);
      await validateConfig(config, { isEnabled: false });
      assert.equal(config.fileAssociations, undefined);
      assert.deepEqual(config.win.fileAssociations, []);
      assert.equal(config.nsis.perMachine, false);
      assert.deepEqual(config.mac.fileAssociations.flatMap((item) => item.ext), extensions);
      for (const association of config.mac.fileAssociations) {
        assert.equal(association.role, "Viewer");
        assert.equal(association.rank, "Alternate");
      }
    }
  });

  test(`${brandId} builder produces Finder document types matching the development app`, async (t) => {
    const root = temporaryDirectory(t);
    const contents = path.join(root, "Electron.app", "Contents");
    for (const [directory, executable] of [
      [contents, "Electron"],
      [path.join(contents, "Frameworks", "Electron Helper.app", "Contents"), "Electron Helper"]
    ]) {
      fs.mkdirSync(path.join(directory, "MacOS"), { recursive: true });
      fs.mkdirSync(path.join(directory, "Resources"), { recursive: true });
      fs.writeFileSync(path.join(directory, "MacOS", executable), "fixture");
      fs.writeFileSync(path.join(directory, "Info.plist"), plist.build({
        CFBundleExecutable: executable,
        CFBundleName: executable,
        CFBundleIconFile: "electron.icns",
        CFBundleVersion: "1.0.0"
      }));
    }
    const config = electronBuilderConfig(brand, { os: "darwin", arch: "arm64" });
    const packager = {
      config,
      platformSpecificBuildOptions: config.mac,
      info: { framework: { distMacOsAppName: "Electron.app" } },
      appInfo: {
        productName: brand.productName,
        productFilename: brand.productName,
        sanitizedProductName: brand.productName,
        macBundleIdentifier: brand.appId,
        version: "1.0.0",
        buildVersion: "1.0.0",
        copyright: ""
      },
      applyCommonInfo: MacPackager.prototype.applyCommonInfo,
      getIconPath: async () => null,
      getResource: async () => null
    };
    Object.defineProperty(packager, "fileAssociations", Object.getOwnPropertyDescriptor(PlatformPackager.prototype, "fileAssociations"));
    await createMacApp(packager, root, null, false);
    const appPlist = plist.parse(fs.readFileSync(path.join(root, `${brand.productName}.app`, "Contents", "Info.plist"), "utf8"));
    assert.equal(appPlist.CFBundleIdentifier, brand.appId);
    assert.deepEqual(appPlist.CFBundleDocumentTypes, macDocumentTypes("electron.icns"));
    assert.deepEqual(appPlist.CFBundleDocumentTypes.flatMap((item) => item.CFBundleTypeExtensions), extensions);
    assert.deepEqual(appPlist.CFBundleURLTypes[0].CFBundleURLSchemes, [brand.protocols.open.scheme]);
  });

  test(`${brandId} NSIS offers Open With candidates without changing default handlers`, (t) => {
    const source = installerSource(t, brand);
    const register = macro(source, "DesktopRegisterDocumentFileHandlers");
    const unregister = macro(source, "DesktopUnregisterDocumentFileHandlers");
    assert.deepEqual(
      [...register.matchAll(/WriteRegStr HKCU "Software\\Classes\\\.([^\\"]+)\\OpenWithProgids" "([^"]+)" ""/gu)]
        .map((match) => [match[1], match[2]]),
      extensions.map((ext) => [ext, `${brand.appId}.${ext === "md" || ext === "markdown" ? "Markdown" : "HTML"}`])
    );
    assert.doesNotMatch(register, /WriteRegStr HKCU "Software\\Classes\\\.[^\\"]+"/u);
    assert.doesNotMatch(register + unregister, /HKLM|HKCR|UserChoice|APP_ASSOCIATE/u);
    assert.match(register, /'"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "%1"'/u);
    for (const id of ["Markdown", "HTML"]) {
      const key = `Software\\Classes\\${brand.appId}.${id}`;
      assert.ok(unregister.includes(`ReadRegStr $R0 HKCU "${key}\\shell\\open\\command" ""`));
      assert.ok(unregister.includes(`DeleteRegKey HKCU "${key}"`));
    }
    assert.equal((unregister.match(/\$\{if\} \$R0 == '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "%1"'/gu) ?? []).length, 2);
    assert.match(macro(source, "customInstall"), /!insertmacro DesktopRegisterDocumentFileHandlers/u);
    assert.match(macro(source, "customUnInstall"), /doneDataCleanup:\s*!insertmacro DesktopUnregisterDocumentFileHandlers/u);
  });

  test(`${brandId} generated NSIS registration and guarded removal compile`, (t) => {
    let toolchain;
    try {
      toolchain = resolveNsisToolchain();
    } catch {
      t.skip("NSIS toolchain is not installed");
      return;
    }
    const root = temporaryDirectory(t);
    const source = installerSource(t, brand);
    const smokePath = path.join(root, "association-smoke.nsi");
    fs.writeFileSync(smokePath, `Unicode true
RequestExecutionLevel user
Name "Document association compile check"
OutFile "${path.join(root, "association-smoke.exe")}"
!include LogicLib.nsh
!define APP_EXECUTABLE_FILENAME "${brand.productName}.exe"
${macro(source, "DesktopRegisterDocumentFileHandlers")}
${macro(source, "DesktopUnregisterDocumentFileHandlers")}
Section
  !insertmacro DesktopRegisterDocumentFileHandlers
  WriteUninstaller "$TEMP\\association-uninstall.exe"
SectionEnd
Section "Uninstall"
  !insertmacro DesktopUnregisterDocumentFileHandlers
SectionEnd
`);
    const result = spawnSync(toolchain.binary, ["/V2", "/INPUTCHARSET", "UTF8", smokePath], {
      env: { ...process.env, NSISDIR: toolchain.root },
      encoding: "utf8",
      timeout: 30000
    });
    if (process.platform === "darwin" && result.error?.errno === -86) {
      t.skip("Cached NSIS is x86_64 and this macOS host cannot execute it");
      return;
    }
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.statSync(path.join(root, "association-smoke.exe")).size > 0);
  });
}
