import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import plist from "plist";
import { fileURLToPath } from "node:url";
import { brandBuildRoot, loadBrandConfig, resolveRequiredBrandId } from "./lib/brand-config.mjs";
import { resolveDarwinDevSigningIdentity, withDarwinDevSigningKeychain } from "./lib/mac-dev-signing.mjs";
import { buildMacShareExtension, macNativeShareUrlTypes, macShareExtensionPath, signMacShareExtension, verifyMacShareExtension } from "./lib/mac-share-extension.mjs";

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
function run(program, args) {
  return execFileSync(program, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

// Install the extension into an existing development app without rebuilding,
// launching or terminating the Electron app. Its helpers and services keep their
// signatures; only the outer app seal must be updated for the new nested bundle.
export function installDarwinDevShareExtension({ projectRoot, brand, appPath, register = true }) {
  if (process.platform !== "darwin") throw new Error("sharing extension installation is only supported on macOS");
  const hostBundleId = `${brand.appId}.dev`;
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const originalInfo = fs.readFileSync(infoPath);
  const info = plist.parse(originalInfo.toString("utf8"));
  if (info.CFBundleIdentifier !== hostBundleId) throw new Error("sharing development install requires the current brand's development app");
  const signing = resolveDarwinDevSigningIdentity(hostBundleId);
  const working = fs.mkdtempSync(path.join(brandBuildRoot(projectRoot, brand), ".share-install-"));
  const stagedApp = path.join(working, "Prepared.app");
  const extension = macShareExtensionPath(appPath);
  const previous = path.join(working, "Previous.appex");
  let changed = false;
  const sealApp = () => {
    withDarwinDevSigningKeychain(signing.keychain, () => run("/usr/bin/codesign", [
      "--force", "--sign", signing.identity,
      ...(signing.keychain ? ["--keychain", signing.keychain] : []),
      "--timestamp=none", "--preserve-metadata=entitlements", appPath
    ]));
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  };
  try {
    const stagedExtension = buildMacShareExtension({ projectRoot, brand, appPath: stagedApp, hostBundleId });
    signMacShareExtension({ appPath: stagedApp, hostBundleId, ...signing, development: true });
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    if (fs.existsSync(extension)) fs.renameSync(extension, previous);
    changed = true;
    fs.renameSync(stagedExtension, extension);
    const scheme = brand.protocols.open.scheme;
    info.CFBundleURLTypes = macNativeShareUrlTypes([
      ...(info.CFBundleURLTypes || []).filter(entry => !entry.CFBundleURLSchemes?.includes(scheme)),
      { CFBundleURLName: `${hostBundleId}.open`, CFBundleURLSchemes: [scheme], CFBundleTypeRole: "Viewer" }
    ]);
    fs.writeFileSync(infoPath, plist.build(info));
    sealApp();
    verifyMacShareExtension(appPath, { hostBundleId, development: true });
    if (register) {
      run(LSREGISTER, ["-f", appPath]);
      run("/usr/bin/pluginkit", ["-a", extension]);
    }
    return { appPath, extensionPath: extension, bundleId: `${hostBundleId}.share`, registered: register };
  } catch (error) {
    if (changed) {
      fs.writeFileSync(infoPath, originalInfo);
      fs.rmSync(extension, { recursive: true, force: true });
      if (fs.existsSync(previous)) fs.renameSync(previous, extension);
      sealApp();
    }
    throw error;
  } finally {
    fs.rmSync(working, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = process.cwd();
  const brand = loadBrandConfig(projectRoot, resolveRequiredBrandId(process.argv.slice(2), process.env, "install:mac-share"));
  const selected = process.argv.slice(2).find(argument => argument.startsWith("--app="));
  const appPath = selected ? path.resolve(selected.slice("--app=".length)) : path.join(brandBuildRoot(projectRoot, brand), "dev", `${brand.productName}.app`);
  console.log(JSON.stringify(installDarwinDevShareExtension({ projectRoot, brand, appPath })));
}
