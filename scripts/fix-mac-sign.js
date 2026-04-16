const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[fix-mac-sign] Re-signing ${appPath} with ad-hoc identity...`);

  // Deep sign all nested frameworks/helpers first, then the app itself
  execSync(
    `codesign --force --deep --sign - "${appPath}"`,
    { stdio: "inherit" }
  );
};
