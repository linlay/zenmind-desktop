const { spawnSync } = require("child_process");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafed00d,
  0x0dd0feca
]);

function parseBooleanEnv(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean value`);
  }
}

function shouldAllowMissingSecureTimestamp() {
  return (
    parseBooleanEnv(process.env.SKIP_NOTARIZE, "SKIP_NOTARIZE") === true ||
    parseBooleanEnv(process.env.DESKTOP_SKIP_MAC_TIMESTAMP, "DESKTOP_SKIP_MAC_TIMESTAMP") === true ||
    parseBooleanEnv(process.env.DESKTOP_SKIP_MAC_TIMESTAMP_VERIFY, "DESKTOP_SKIP_MAC_TIMESTAMP_VERIFY") === true
  );
}

function getAppPath(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  }
  return context.appOutDir;
}

function getResourcesRoot(appPath) {
  return path.join(appPath, "Contents", "Resources");
}

function getServicesRoot(appPath) {
  return path.join(getResourcesRoot(appPath), "services");
}

function verifyMacPackageBranding(appPath, { projectRoot = "", brandId = "" } = {}) {
  const resourcesRoot = getResourcesRoot(appPath);
  const webappToolingPath = path.join(resourcesRoot, "scripts", "webapp-tooling.mjs");
  if (!fs.existsSync(webappToolingPath) || !fs.statSync(webappToolingPath).isFile() || fs.statSync(webappToolingPath).size === 0) {
    throw new Error(`[verify-mac-services-signing] packaged WebApp Tooling is missing or empty: ${webappToolingPath}`);
  }
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const plist = fs.readFileSync(plistPath, "utf8");
  const iconMatch = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/u);
  if (!iconMatch || !/^icon-[0-9a-f]{12}\.icns$/u.test(iconMatch[1])) {
    throw new Error(`[verify-mac-services-signing] invalid content-addressed CFBundleIconFile in ${plistPath}`);
  }

  const iconPath = path.join(resourcesRoot, iconMatch[1]);
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[verify-mac-services-signing] packaged app icon is missing: ${iconPath}`);
  }
  const iconHash = createHash("sha256").update(fs.readFileSync(iconPath)).digest("hex").slice(0, 12);
  if (iconMatch[1] !== `icon-${iconHash}.icns`) {
    throw new Error(`[verify-mac-services-signing] packaged app icon hash does not match CFBundleIconFile: ${iconMatch[1]}`);
  }

  for (const fileName of ["brand-icon.png", "brand-mark.png", "tray-icon.png"]) {
    const filePath = path.join(resourcesRoot, fileName);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error(`[verify-mac-services-signing] packaged brand resource is missing or empty: ${filePath}`);
    }
    if (projectRoot && brandId) {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(brandId)) {
        throw new Error(`[verify-mac-services-signing] invalid brand id for packaged resource verification: ${brandId}`);
      }
      const generatedPath = path.join(projectRoot, "build", "brands", brandId, "brand-assets", fileName);
      if (!fs.existsSync(generatedPath) || Buffer.compare(fs.readFileSync(filePath), fs.readFileSync(generatedPath)) !== 0) {
        throw new Error(`[verify-mac-services-signing] packaged brand resource differs from generated source: ${fileName}`);
      }
    }
  }
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const result = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        stack.push(path.join(currentPath, entry.name));
      }
      continue;
    }
    if (stat.isFile()) {
      result.push(currentPath);
    }
  }

  return result.sort((left, right) => left.localeCompare(right));
}

function isMachOFile(filePath) {
  const file = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(file, header, 0, header.length, 0) !== header.length) {
      return false;
    }
    return MACHO_MAGICS.has(header.readUInt32BE(0));
  } finally {
    fs.closeSync(file);
  }
}

function runCodesign(args, filePath) {
  const result = spawnSync("codesign", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    throw new Error(`[verify-mac-services-signing] codesign failed for ${filePath}\n${output}`);
  }
  return output;
}

function verifyMachOSignature(filePath) {
  runCodesign(["--verify", "--strict", "--verbose=2", filePath], filePath);
  const details = runCodesign(["-dv", "--verbose=4", filePath], filePath);
  if (!/^Authority=Developer ID Application:/mu.test(details)) {
    throw new Error(`[verify-mac-services-signing] ${filePath} is not signed with a Developer ID Application certificate`);
  }
  if (!/^Timestamp=/mu.test(details) && !shouldAllowMissingSecureTimestamp()) {
    throw new Error(`[verify-mac-services-signing] ${filePath} is missing a secure timestamp`);
  }
  if (!(/^Runtime Version=/mu.test(details) || /^CodeDirectory .*\bflags=.*\bruntime\b/mu.test(details))) {
    throw new Error(`[verify-mac-services-signing] ${filePath} is missing hardened runtime`);
  }
}

function verifyAppServices(appPath, options = {}) {
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`[verify-mac-services-signing] app bundle not found: ${appPath}`);
  }

  verifyMacPackageBranding(appPath, options);

  const servicesRoot = getServicesRoot(appPath);
  const files = walkFiles(servicesRoot);
  const forbiddenArchives = files.filter((filePath) => {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
  });
  if (forbiddenArchives.length > 0) {
    throw new Error(
      "[verify-mac-services-signing] Darwin service archives must not be bundled in the app:\n" +
        forbiddenArchives.map((filePath) => `- ${filePath}`).join("\n")
    );
  }

  if (process.env.DESKTOP_SKIP_MAC_SERVICE_SIGNATURE_VERIFY === "1") {
    console.warn("[verify-mac-services-signing] Skipping service Mach-O signature verification by environment override.");
    return;
  }

  const machOFiles = files.filter((filePath) => isMachOFile(filePath));
  for (const filePath of machOFiles) {
    verifyMachOSignature(filePath);
  }
  console.log(`[verify-mac-services-signing] Verified ${machOFiles.length} service Mach-O file(s).`);
}

exports.verifyAppServices = verifyAppServices;
exports.verifyMacPackageBranding = verifyMacPackageBranding;

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  verifyAppServices(getAppPath(context), {
    projectRoot: context.packager?.projectDir || process.cwd(),
    brandId: process.env.BRAND || ""
  });
};

if (require.main === module) {
  const appPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
  if (!appPath || !appPath.endsWith(".app")) {
    console.error("Usage: node scripts/verify-mac-services-signing.js /path/to/App.app");
    process.exit(2);
  }
  verifyAppServices(appPath);
}
