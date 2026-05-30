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

test("darwin dev launcher prepares a ZenMind app bundle instead of showing Electron", async () => {
  const { prepareDarwinDevElectronBinary } = await import("../scripts/platform/dev-darwin.mjs");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-dev-app-"));
  try {
    const electronAppRoot = path.join(tempRoot, "node_modules", "electron", "dist", "Electron.app");
    const electronContents = path.join(electronAppRoot, "Contents");
    const electronBinary = path.join(electronContents, "MacOS", "Electron");
    const electronPlist = path.join(electronContents, "Info.plist");
    const frameworkRoot = path.join(electronContents, "Frameworks", "Electron Framework.framework");

    fs.mkdirSync(path.dirname(electronBinary), { recursive: true });
    fs.mkdirSync(path.join(frameworkRoot, "Versions", "A"), { recursive: true });
    fs.symlinkSync("Versions/A/Electron Framework", path.join(frameworkRoot, "Electron Framework"));
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
</dict></plist>`
    );

    const preparedBinary = prepareDarwinDevElectronBinary(electronBinary, tempRoot);
    const preparedPlist = fs.readFileSync(path.join(tempRoot, "build", "dev", "ZenMind.app", "Contents", "Info.plist"), "utf8");

    assert.equal(preparedBinary, path.join(tempRoot, "build", "dev", "ZenMind.app", "Contents", "MacOS", "ZenMind"));
    assert.match(preparedPlist, /<key>CFBundleName<\/key><string>ZenMind<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleDisplayName<\/key><string>ZenMind<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleIdentifier<\/key><string>cc\.zenmind\.desktop\.dev<\/string>/);
    assert.match(preparedPlist, /<key>CFBundleExecutable<\/key><string>ZenMind<\/string>/);
    assert.match(
      fs.readFileSync(path.join(projectRoot, "scripts", "platform", "dev-darwin.mjs"), "utf8"),
      /ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT:\s*path\.join\(projectRoot, "build", "resources", "services"\)/
    );
    assert.equal(
      fs.readlinkSync(path.join(tempRoot, "build", "dev", "ZenMind.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework")),
      "Versions/A/Electron Framework"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
