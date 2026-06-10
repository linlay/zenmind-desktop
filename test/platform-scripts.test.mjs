import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("platform helpers expose host labels, architecture labels, and spawn defaults", async () => {
  const detect = await import("../scripts/platform/detect.mjs");
  const spawn = await import("../scripts/platform/spawn.mjs");

  assert.equal(typeof detect.isWindows(), "boolean");
  assert.match(detect.hostPlatform(), /^(windows|darwin|linux)$/);
  assert.equal(typeof detect.hostArch(), "string");
  assert.ok(detect.hostArch().length > 0);
  assert.match(detect.syncOsLabel(), /^(windows|darwin|linux)$/);
  assert.equal(spawn.npmCmd, detect.isWindows() ? "npm.cmd" : "npm");
  assert.equal(typeof spawn.run, "function");
  assert.equal(typeof spawn.runAndWait, "function");
});

test("darwin dev launcher prepares a branded app bundle instead of showing Electron", async () => {
  const { prepareDarwinDevElectronBinary } = await import("../scripts/platform/dev-darwin.mjs");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-dev-app-"));
  const brand = {
    productName: "CuteJ",
    appId: "cc.cutej.desktop"
  };
  const iconBytes = Buffer.from("branded-icon");
  try {
    const electronAppRoot = path.join(tempRoot, "node_modules", "electron", "dist", "Electron.app");
    const electronContents = path.join(electronAppRoot, "Contents");
    const electronBinary = path.join(electronContents, "MacOS", "Electron");
    const electronPlist = path.join(electronContents, "Info.plist");
    const frameworkRoot = path.join(electronContents, "Frameworks", "Electron Framework.framework");
    const sourceIconPath = path.join(tempRoot, "build", "icons", "icon.icns");

    fs.mkdirSync(path.dirname(electronBinary), { recursive: true });
    fs.mkdirSync(path.join(frameworkRoot, "Versions", "A"), { recursive: true });
    fs.mkdirSync(path.dirname(sourceIconPath), { recursive: true });
    fs.symlinkSync("Versions/A/Electron Framework", path.join(frameworkRoot, "Electron Framework"));
    fs.writeFileSync(path.join(tempRoot, "VERSION"), "v0.2.8\n");
    fs.writeFileSync(sourceIconPath, iconBytes);
    fs.writeFileSync(electronBinary, "");
    fs.chmodSync(electronBinary, 0o755);
    fs.writeFileSync(
      electronPlist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>org.electronjs.Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
<key>CFBundleShortVersionString</key><string>36.9.5</string>
<key>CFBundleVersion</key><string>36.9.5</string>
</dict></plist>`
    );

    const preparedBinary = prepareDarwinDevElectronBinary(electronBinary, tempRoot, brand);
    const preparedPlist = fs.readFileSync(path.join(tempRoot, "build", "dev", "CuteJ.app", "Contents", "Info.plist"), "utf8");
    const preparedIcon = fs.readFileSync(path.join(tempRoot, "build", "dev", "CuteJ.app", "Contents", "Resources", "icon.icns"));

    assert.equal(preparedBinary, path.join(tempRoot, "build", "dev", "CuteJ.app", "Contents", "MacOS", "CuteJ"));
    assert.match(preparedPlist, /<key>CFBundleName<\/key><string>CuteJ<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleDisplayName<\/key><string>CuteJ<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleIdentifier<\/key><string>cc\.cutej\.desktop\.dev<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleExecutable<\/key><string>CuteJ<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleIconFile<\/key><string>icon\.icns<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleShortVersionString<\/key><string>0\.2\.8<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleVersion<\/key><string>0\.2\.8<\/string>/);
    assert.deepEqual(preparedIcon, iconBytes);
    assert.match(
      fs.readFileSync(path.join(projectRoot, "scripts", "platform", "dev-darwin.mjs"), "utf8"),
      /DESKTOP_BUILTIN_ASSETS_ROOT:\s*path\.join\(projectRoot, "build", "resources", "services"\)[\s\S]*?ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT:\s*path\.join\(projectRoot, "build", "resources", "services"\)/
    );
    assert.match(
      fs.readFileSync(path.join(projectRoot, "scripts", "dev.mjs"), "utf8"),
      /process\.env\.DESKTOP_NODE_BIN = nodeBin;[\s\S]*?process\.env\.ZENMIND_NODE_BIN = nodeBin;/
    );
    assert.match(
      fs.readFileSync(path.join(projectRoot, "scripts", "platform", "dev-darwin.mjs"), "utf8"),
      /ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT:\s*path\.join\(projectRoot, "build", "resources", "services"\)/
    );
    assert.equal(
      fs.readlinkSync(path.join(tempRoot, "build", "dev", "CuteJ.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework")),
      "Versions/A/Electron Framework"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
