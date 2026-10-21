import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import plist from "plist";
import { refreshMacSystemIntegration } from "../dist-electron/main/infrastructure/electron/mac-system-integration.js";
import { listMacApplicationPaths } from "../dist-electron/main/infrastructure/electron/mac-application-registry.js";
import { loadBrandConfig, brandIconDir } from "../scripts/lib/brand-config.mjs";
import { resolveDarwinDevSigningIdentity, withDarwinDevSigningKeychain } from "../scripts/lib/mac-dev-signing.mjs";
import { buildMacShareExtension, signMacShareExtension } from "../scripts/lib/mac-share-extension.mjs";
import { macDocumentTypes } from "../scripts/lib/document-file-associations.mjs";

const register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const run = (program, args) => execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

test("real macOS registrations converge to the newest signed app and preserve a disabled sharing election", {
  skip: process.platform !== "darwin", timeout: 180_000
}, async t => {
  // Use a unique product identity and a disposable signing keychain. No real
  // CuteJ app, extension election, Finder process or chat content is touched.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-registration-qa-")));
  const bundleId = `cc.cutej.registration-qa.${process.pid}`;
  const baseBrand = loadBrandConfig(process.cwd(), "cutej");
  const brand = { ...baseBrand, appId: bundleId, productName: "CuteJ Registration QA" };
  const signingRoot = path.join(root, "signing");
  // LaunchServices intentionally hides launch-disabled apps in the temporary
  // directory. Only these disposable QA bundles live under user Applications.
  const applicationsRoot = path.join(os.homedir(), "Applications");
  fs.mkdirSync(applicationsRoot, { recursive: true });
  const appRoot = fs.realpathSync(fs.mkdtempSync(path.join(applicationsRoot, "CuteJ-Registration-QA-")));
  const applications = [path.join(appRoot, "old", "CuteJ.app"), path.join(appRoot, "new", "CuteJ.app")];
  const extensionPaths = applications.map(appPath => path.join(appPath, "Contents", "PlugIns", "DesktopShare.appex"));
  const extensionPath = extensionPaths[1];
  t.after(() => {
    spawnSync("/usr/bin/pluginkit", ["-e", "default", "-i", `${bundleId}.share`]);
    for (const extension of extensionPaths) spawnSync("/usr/bin/pluginkit", ["-r", extension]);
    for (const appPath of applications) spawnSync(register, ["-u", appPath]);
    const keychain = path.join(signingRoot, "development.keychain-db");
    if (fs.existsSync(keychain)) spawnSync("/usr/bin/security", ["delete-keychain", keychain]);
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const signing = resolveDarwinDevSigningIdentity(`${bundleId}.dev`, { signingRoot, env: {} });
  const iconRoot = brandIconDir(root, brand);
  fs.mkdirSync(iconRoot, { recursive: true });
  fs.copyFileSync(path.join(brandIconDir(process.cwd(), baseBrand), "icon.icns"), path.join(iconRoot, "icon.icns"));
  for (const [index, appPath] of applications.entries()) {
    const contents = path.join(appPath, "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.copyFileSync("/usr/bin/true", path.join(contents, "MacOS", "CuteJ QA"));
    fs.writeFileSync(path.join(contents, "Info.plist"), plist.build({
      CFBundleIdentifier: bundleId, CFBundleName: brand.productName, CFBundleDisplayName: brand.productName,
      CFBundleExecutable: "CuteJ QA", CFBundlePackageType: "APPL",
      CFBundleVersion: index ? "0.5.10" : "0.5.9", CFBundleShortVersionString: index ? "0.5.10" : "0.5.9",
      CFBundleDocumentTypes: macDocumentTypes()
    }));
  }
  buildMacShareExtension({ projectRoot: root, brand, appPath: applications[1], hostBundleId: bundleId, version: "0.5.10" });
  fs.cpSync(extensionPath, extensionPaths[0], { recursive: true });
  const oldInfoPath = path.join(extensionPaths[0], "Contents", "Info.plist");
  const oldInfo = plist.parse(fs.readFileSync(oldInfoPath, "utf8"));
  oldInfo.CFBundleVersion = oldInfo.CFBundleShortVersionString = "0.5.9";
  fs.writeFileSync(oldInfoPath, plist.build(oldInfo));
  const sealLatest = () => {
    signMacShareExtension({ appPath: applications[1], hostBundleId: bundleId, ...signing, development: true });
    withDarwinDevSigningKeychain(signing.keychain, () => run("/usr/bin/codesign", [
      "--force", "--sign", signing.identity, "--keychain", signing.keychain, "--timestamp=none", applications[1]
    ]));
  };
  sealLatest();
  signMacShareExtension({ appPath: applications[0], hostBundleId: bundleId, ...signing, development: true });
  withDarwinDevSigningKeychain(signing.keychain, () => run("/usr/bin/codesign", [
    "--force", "--sign", signing.identity, "--keychain", signing.keychain, "--timestamp=none", applications[0]
  ]));
  for (const appPath of applications) run(register, ["-f", appPath]);
  for (const extension of extensionPaths) run("/usr/bin/pluginkit", ["-a", extension]);
  run("/usr/bin/pluginkit", ["-e", "ignore", "-i", `${bundleId}.share`]);
  const filePath = path.join(root, "probe.html");
  fs.writeFileSync(filePath, "<!doctype html><title>Registration QA</title>");
  const fileHandlers = () => JSON.parse(run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
ObjC.import('AppKit');
const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(filePath)}));
const result = [];
for (let i = 0; i < apps.count; i++) {
  const url = apps.objectAtIndex(i), bundle = $.NSBundle.bundleWithURL(url);
  if (ObjC.unwrap(bundle.bundleIdentifier) === ${JSON.stringify(bundleId)}) result.push({
    path: ObjC.unwrap(url.path), version: ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleShortVersionString'))
  });
}
JSON.stringify(result);`]));
  assert.deepEqual(new Set(listMacApplicationPaths(bundleId)), new Set(applications));
  assert.equal(fileHandlers().length, 2, "the fixture reproduces duplicate Finder candidates");
  const request = appPath => ({
    platform: "darwin", isPackaged: true, bundleId,
    executablePath: path.join(appPath, "Contents", "MacOS", "CuteJ QA"), homePath: os.homedir()
  });
  const result = await refreshMacSystemIntegration(request(applications[1]));
  assert.equal(result.selectedVersion, "0.5.10");
  assert.equal(result.shareRegistered, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unregisteredPaths, [applications[0]]);
  assert.deepEqual(fileHandlers(), [{ path: applications[1], version: "0.5.10" }]);
  assert.ok(fs.existsSync(applications[0]), "cleanup retains the old app's files");
  const election = () => run("/usr/bin/pluginkit", ["-m", "-v", "-i", `${bundleId}.share`]);
  assert.ok(election().includes(extensionPath), "the selected sharing extension comes from the latest containing app");
  assert.match(election(), new RegExp(`^\\s*-\\s+${bundleId.replaceAll(".", "\\.")}\\.share`, "mu"));
  const olderLaunch = await refreshMacSystemIntegration(request(applications[0]));
  assert.equal(olderLaunch.selectedPath, applications[1], "an older launch cannot reclaim the file or sharing registration");
  assert.deepEqual(fileHandlers(), [{ path: applications[1], version: "0.5.10" }]);

  // Simulate the next overwrite at the same path without changing any code or
  // relying on the old LaunchServices version/modification-time snapshot.
  for (const appPath of [applications[1], extensionPath]) {
    const infoPath = path.join(appPath, "Contents", "Info.plist");
    const info = plist.parse(fs.readFileSync(infoPath, "utf8"));
    info.CFBundleVersion = info.CFBundleShortVersionString = "0.5.11";
    fs.writeFileSync(infoPath, plist.build(info));
  }
  sealLatest();
  const overwritten = await refreshMacSystemIntegration(request(applications[1]));
  assert.equal(overwritten.selectedVersion, "0.5.11");
  assert.deepEqual(fileHandlers(), [{ path: applications[1], version: "0.5.11" }]);
  assert.match(election(), /\(0\.5\.11\)/u);
  assert.match(election(), /^\s*-\s+/mu, "an overwrite must not enable a user-disabled sharing extension");
});
