import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";
import { brandBuildRoot, brandIconDir } from "./brand-config.mjs";
import { readDesktopVersion } from "./build-metadata.mjs";
import { verifyMacReleaseApp } from "./mac-app-signing.js";

export const MAC_SHARE_EXTENSION_NAME = "DesktopShare.appex";
export const MAC_SHARE_EXTENSION_EXECUTABLE = "DesktopShare";
export const macShareExtensionSourceRoot = fileURLToPath(new URL("../../native/macos-share/", import.meta.url));
export const macShareExtensionEntitlementsPath = path.join(macShareExtensionSourceRoot, "entitlements.plist");
// Reuse SDK modules across brands, staged apps and temporary test projects. Each
// native output still has its own source fingerprint and architecture cache.
export function macShareExtensionModuleCachePath(arch = process.arch) {
  return path.resolve(macShareExtensionSourceRoot, "..", "..", "build", "macos-share-module-cache", arch);
}
const SOURCE_FILES = ["ShareInbox.swift", "ShareLoopbackServer.swift", "ShareViewController.swift"];
const RESOURCE_FILES = ["en.lproj/Localizable.strings", "zh-Hans.lproj/Localizable.strings"];
const EXTENSION_ENTITLEMENTS = Object.freeze({
  "com.apple.security.app-sandbox": true,
  "com.apple.security.files.user-selected.read-only": true,
  "com.apple.security.network.server": true
});

export function macShareExtensionPath(appPath) {
  return path.join(appPath, "Contents", "PlugIns", MAC_SHARE_EXTENSION_NAME);
}

export function macShareExtensionInfo({ hostBundleId, productName, scheme, version }) {
  if (typeof hostBundleId !== "string" || !/^[a-z\d][a-z\d.-]*$/iu.test(hostBundleId) || !hostBundleId.includes(".")) {
    throw new Error("macOS sharing requires the containing app's bundle identifier");
  }
  if (typeof productName !== "string" || !productName.trim()) throw new Error("macOS sharing requires the brand name");
  if (typeof scheme !== "string" || !/^[a-z][a-z\d+.-]*$/iu.test(scheme)) {
    throw new Error("macOS sharing requires the brand's explicit open URL scheme");
  }
  const normalizedVersion = String(version || "").replace(/^v/iu, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z\d.+-]+)?$/iu.test(normalizedVersion)) {
    throw new Error("macOS sharing requires the Desktop version");
  }
  return {
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: productName,
    CFBundleDisplayName: productName,
    CFBundleIdentifier: `${hostBundleId}.share`,
    CFBundleExecutable: MAC_SHARE_EXTENSION_EXECUTABLE,
    CFBundlePackageType: "XPC!",
    CFBundleShortVersionString: normalizedVersion,
    CFBundleVersion: normalizedVersion,
    CFBundleDevelopmentRegion: "zh-Hans",
    CFBundleLocalizations: ["zh-Hans", "en"],
    CFBundleIconFile: "icon.icns",
    LSMinimumSystemVersion: "12.0",
    DesktopShareURLScheme: scheme,
    DesktopShareHostBundleIdentifier: hostBundleId,
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.share-services",
      NSExtensionPrincipalClass: "DesktopShareViewController",
      NSExtensionAttributes: {
        NSExtensionActivationRule: {
          NSExtensionActivationDictionaryVersion: 2,
          NSExtensionActivationSupportsFileWithMaxCount: 16,
          NSExtensionActivationSupportsImageWithMaxCount: 16,
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 16
        }
      }
    }
  };
}

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], ...options
  });
}

function swiftToolchain(run) {
  try {
    return {
      sdk: run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]).trim(),
      compiler: run("/usr/bin/xcrun", ["--find", "swiftc"]).trim()
    };
  } catch (error) {
    // An unlicensed full Xcode can be selected even when the independently
    // installed Command Line Tools work. Do not modify xcode-select or accept
    // a license on the user's behalf; use that existing toolchain explicitly.
    const root = "/Library/Developer/CommandLineTools";
    const compiler = path.join(root, "usr", "bin", "swiftc");
    const sdk = path.join(root, "SDKs", "MacOSX.sdk");
    if (error.status !== 69 || !fs.existsSync(compiler) || !fs.existsSync(sdk)) throw error;
    console.warn("[mac-share] Using the installed Command Line Tools because the selected Xcode toolchain is unavailable.");
    return { compiler, sdk };
  }
}

export function buildMacShareExtension({
  projectRoot,
  brand,
  appPath,
  hostBundleId = brand?.appId,
  arch = process.arch,
  version,
  platform = process.platform,
  run = command
}) {
  if (platform !== "darwin") throw new Error("macOS sharing extensions can only be built on macOS");
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported macOS sharing architecture: ${arch}`);
  const info = macShareExtensionInfo({
    hostBundleId, productName: brand?.productName, scheme: brand?.protocols?.open?.scheme,
    version: version ?? readDesktopVersion(projectRoot)
  });
  const icon = path.join(brandIconDir(projectRoot, brand), "icon.icns");
  const sourceFiles = [...SOURCE_FILES, ...RESOURCE_FILES, "entitlements.plist"];
  const { sdk, compiler } = swiftToolchain(run);
  const compilerVersion = run(compiler, ["--version"]).trim();
  const fingerprint = createHash("sha256").update(JSON.stringify({ info, sdk, compilerVersion, arch, buildVersion: 1 }));
  for (const file of sourceFiles) fingerprint.update(file).update(fs.readFileSync(path.join(macShareExtensionSourceRoot, file)));
  fingerprint.update(fs.readFileSync(icon));
  const digest = fingerprint.digest("hex");
  const cacheRoot = path.join(brandBuildRoot(projectRoot, brand), "native-share", `${arch}-${hostBundleId}`);
  const cacheApp = path.join(cacheRoot, MAC_SHARE_EXTENSION_NAME);
  const receipt = path.join(cacheRoot, "build-sha256");
  if (!fs.existsSync(receipt) || fs.readFileSync(receipt, "utf8").trim() !== digest ||
      !fs.existsSync(path.join(cacheApp, "Contents", "MacOS", MAC_SHARE_EXTENSION_EXECUTABLE))) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const stagingRoot = fs.mkdtempSync(path.join(cacheRoot, ".build-"));
    const stagedApp = path.join(stagingRoot, MAC_SHARE_EXTENSION_NAME);
    const contents = path.join(stagedApp, "Contents");
    const executable = path.join(contents, "MacOS", MAC_SHARE_EXTENSION_EXECUTABLE);
    try {
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      run(compiler, [
        "-O", "-parse-as-library", "-application-extension", "-module-name", "DesktopShare",
        "-target", `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`, "-sdk", sdk,
        "-module-cache-path", macShareExtensionModuleCachePath(arch),
        ...SOURCE_FILES.map(file => path.join(macShareExtensionSourceRoot, file)),
        "-o", executable,
        "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
        "-Xlinker", "-rpath", "-Xlinker", "/usr/lib/swift"
      ], { timeout: 300_000 });
      fs.chmodSync(executable, 0o755);
      fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(info));
      const resources = path.join(contents, "Resources");
      fs.mkdirSync(resources, { recursive: true });
      fs.copyFileSync(icon, path.join(resources, "icon.icns"));
      for (const file of RESOURCE_FILES) {
        const target = path.join(resources, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(macShareExtensionSourceRoot, file), target);
      }
      fs.rmSync(cacheApp, { recursive: true, force: true });
      fs.renameSync(stagedApp, cacheApp);
      fs.writeFileSync(receipt, `${digest}\n`);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  const extension = macShareExtensionPath(appPath);
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  const stagedInstall = path.join(path.dirname(extension), `.share-install-${randomUUID()}.appex`);
  try {
    fs.cpSync(cacheApp, stagedInstall, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(extension, { recursive: true, force: true });
    fs.renameSync(stagedInstall, extension);
  } finally {
    fs.rmSync(stagedInstall, { recursive: true, force: true });
  }
  return extension;
}

function readExtensionInfo(extension) {
  const infoPath = path.join(extension, "Contents", "Info.plist");
  if (fs.lstatSync(extension).isSymbolicLink()) throw new Error("macOS sharing extension must not be a symbolic link");
  return plist.parse(fs.readFileSync(infoPath, "utf8"));
}

function assertExtensionInfo(extension, hostBundleId) {
  const info = readExtensionInfo(extension);
  if (info.CFBundleIdentifier !== `${hostBundleId}.share` ||
      info.DesktopShareHostBundleIdentifier !== hostBundleId ||
      info.CFBundleExecutable !== MAC_SHARE_EXTENSION_EXECUTABLE ||
      info.NSExtension?.NSExtensionPointIdentifier !== "com.apple.share-services") {
    throw new Error("macOS sharing extension does not match its containing app");
  }
  const executable = path.join(extension, "Contents", "MacOS", MAC_SHARE_EXTENSION_EXECUTABLE);
  if (!fs.lstatSync(executable).isFile()) throw new Error("macOS sharing extension executable must be a regular file");
  fs.accessSync(executable, fs.constants.X_OK);
}

function assertExtensionEntitlements(extension, run) {
  const details = run("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", extension]);
  const entitlements = plist.parse(details.slice(details.indexOf("<?xml")));
  if (Object.keys(entitlements).length !== Object.keys(EXTENSION_ENTITLEMENTS).length ||
      Object.entries(EXTENSION_ENTITLEMENTS).some(([key, value]) => entitlements[key] !== value)) {
    throw new Error("macOS sharing extension requires its own sandbox entitlements; Electron JIT and inherited entitlements are not allowed");
  }
}

export function signMacShareExtension({ appPath, hostBundleId, identity, keychain, timestamp, development = false, run = command }) {
  if (!identity?.trim() || identity.trim() === "-") throw new Error("macOS sharing extension requires the containing app's signing certificate");
  const extension = macShareExtensionPath(appPath);
  assertExtensionInfo(extension, hostBundleId);
  const entitlements = plist.parse(fs.readFileSync(macShareExtensionEntitlementsPath, "utf8"));
  if (JSON.stringify(entitlements) !== JSON.stringify(EXTENSION_ENTITLEMENTS)) throw new Error("invalid macOS sharing sandbox entitlements");
  run("/usr/bin/codesign", [
    "--force", "--sign", identity,
    ...(keychain ? ["--keychain", keychain] : []),
    ...(development || timestamp === "none" ? ["--timestamp=none"] : timestamp ? [`--timestamp=${timestamp}`] : ["--timestamp"]),
    "--options", "runtime", "--entitlements", macShareExtensionEntitlementsPath, extension
  ]);
  run("/usr/bin/codesign", ["--verify", "--strict", extension]);
  assertExtensionEntitlements(extension, run);
  return extension;
}

export function verifyMacShareExtension(appPath, { hostBundleId, development = false, run = command, verifyRelease = verifyMacReleaseApp } = {}) {
  const extension = macShareExtensionPath(appPath);
  assertExtensionInfo(extension, hostBundleId);
  assertExtensionEntitlements(extension, run);
  if (development) {
    run("/usr/bin/codesign", ["--verify", "--strict", extension]);
    return extension;
  }
  // The extension must belong to the same Apple publisher, in addition to being
  // a valid Developer ID executable under the containing app's bundle identity.
  const host = verifyRelease(appPath, { expectedBundleId: hostBundleId });
  return verifyRelease(extension, { expectedBundleId: `${hostBundleId}.share`, expectedTeamId: host.teamIdentifier });
}
