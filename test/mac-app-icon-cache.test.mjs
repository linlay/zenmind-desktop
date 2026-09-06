import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { contentAddressMacAppIcon } = require("../scripts/after-pack.js");
const { verifyMacPackageBranding } = require("../scripts/verify-mac-services-signing.js");

function createMacAppFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-mac-icon-cache-"));
  const appPath = path.join(root, "CuteJ.app");
  const contentsRoot = path.join(appPath, "Contents");
  const resourcesRoot = path.join(contentsRoot, "Resources");
  fs.mkdirSync(resourcesRoot, { recursive: true });
  fs.writeFileSync(
    path.join(contentsRoot, "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\"><dict>",
      "<key>CFBundleIdentifier</key><string>cc.cutej.desktop</string>",
      "<key>CFBundleIconFile</key><string>icon.icns</string>",
      "</dict></plist>"
    ].join("\n"),
    "utf8"
  );
  const icon = Buffer.from("current-cutej-icon");
  fs.writeFileSync(path.join(resourcesRoot, "icon.icns"), icon);
  for (const fileName of ["brand-icon.png", "brand-mark.png", "tray-icon.png"]) {
    fs.writeFileSync(path.join(resourcesRoot, fileName), Buffer.from(fileName));
    const generatedPath = path.join(root, "build", "brands", "cutej", "brand-assets", fileName);
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, Buffer.from(fileName));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, appPath, contentsRoot, resourcesRoot, icon };
}

test("macOS packaged app icon uses a content-addressed filename before signing", (t) => {
  const fixture = createMacAppFixture(t);
  const iconHash = createHash("sha256").update(fixture.icon).digest("hex").slice(0, 12);
  const expectedIconFileName = `icon-${iconHash}.icns`;

  assert.equal(contentAddressMacAppIcon(fixture.appPath), expectedIconFileName);
  assert.equal(fs.existsSync(path.join(fixture.resourcesRoot, "icon.icns")), false);
  assert.deepEqual(fs.readFileSync(path.join(fixture.resourcesRoot, expectedIconFileName)), fixture.icon);
  assert.match(
    fs.readFileSync(path.join(fixture.contentsRoot, "Info.plist"), "utf8"),
    new RegExp(`<key>CFBundleIconFile</key><string>${expectedIconFileName}</string>`, "u")
  );

  assert.equal(contentAddressMacAppIcon(fixture.appPath), expectedIconFileName);
  const brandingOptions = { projectRoot: fixture.root, brandId: "cutej" };
  assert.doesNotThrow(() => verifyMacPackageBranding(fixture.appPath, brandingOptions));

  fs.appendFileSync(path.join(fixture.resourcesRoot, "brand-mark.png"), "tampered");
  assert.throws(() => verifyMacPackageBranding(fixture.appPath, brandingOptions), /brand resource differs/u);
  fs.writeFileSync(path.join(fixture.resourcesRoot, "brand-mark.png"), "brand-mark.png");

  fs.appendFileSync(path.join(fixture.resourcesRoot, expectedIconFileName), "tampered");
  assert.throws(() => verifyMacPackageBranding(fixture.appPath), /icon hash does not match/u);
});
