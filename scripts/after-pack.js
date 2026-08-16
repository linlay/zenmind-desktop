const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

function getAppPath(context) {
  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)([^<]*)(</string>)`, "u");
  if (!pattern.test(plist)) {
    throw new Error(`Missing ${key} in macOS app Info.plist.`);
  }
  return plist.replace(pattern, `$1${value}$3`);
}

function resolveMacAppIconPath(resourcesRoot, configuredIconFile) {
  const iconFileName = path.basename(configuredIconFile);
  const candidates = path.extname(iconFileName)
    ? [iconFileName]
    : [iconFileName, `${iconFileName}.icns`];
  return candidates
    .map((candidate) => path.join(resourcesRoot, candidate))
    .find((candidate) => fs.existsSync(candidate)) || "";
}

function contentAddressMacAppIcon(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const resourcesRoot = path.join(appPath, "Contents", "Resources");
  const plist = fs.readFileSync(plistPath, "utf8");
  const iconMatch = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/u);
  if (!iconMatch) {
    throw new Error(`Missing CFBundleIconFile in ${plistPath}`);
  }

  const sourceIconPath = resolveMacAppIconPath(resourcesRoot, iconMatch[1]);
  if (!sourceIconPath) {
    throw new Error(`macOS app icon not found for CFBundleIconFile=${iconMatch[1]} in ${resourcesRoot}`);
  }

  const iconHash = createHash("sha256").update(fs.readFileSync(sourceIconPath)).digest("hex").slice(0, 12);
  const targetIconFileName = `icon-${iconHash}.icns`;
  const targetIconPath = path.join(resourcesRoot, targetIconFileName);

  if (sourceIconPath !== targetIconPath) {
    fs.renameSync(sourceIconPath, targetIconPath);
  }
  const updatedPlist = setPlistString(plist, "CFBundleIconFile", targetIconFileName);
  if (updatedPlist !== plist) {
    fs.writeFileSync(plistPath, updatedPlist);
  }
  console.log(`[after-pack] Content-addressed macOS app icon as ${targetIconFileName}`);
  return targetIconFileName;
}

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  contentAddressMacAppIcon(getAppPath(context));
};

exports.contentAddressMacAppIcon = contentAddressMacAppIcon;
