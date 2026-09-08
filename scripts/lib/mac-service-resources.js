const fs = require("node:fs");
const path = require("node:path");
const { verifyPlatformBuiltinsInServices } = require("./platform-builtins.js");

function copyDarwinServiceResources(sourceRoot, destinationRoot, verifyServices = verifyPlatformBuiltinsInServices) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (source === destination || source.startsWith(`${destination}${path.sep}`) || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("Service source and packaged destination must not overlap");
  }
  verifyServices(source);
  // electron-builder's file matcher omits empty directories and normalizes file
  // permissions. Both participate in Platform tree hashes. Copy the complete
  // verified resource tree, including empty directories, before app signing.
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  verifyServices(destination);
}

module.exports = { copyDarwinServiceResources };
