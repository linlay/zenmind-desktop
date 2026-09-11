const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { verifyPlatformBuiltinsInServices } = require("./lib/platform-builtins.js");

async function prepareDarwinAppServices(servicesRoot, identity, options = {}) {
  const { signDarwinServiceDirectory, computeAssetSignature } = await import("./lib/builtin-assets.mjs");
  const indexPath = path.join(servicesRoot, "manifest.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index.services) || !index.services.some((entry) => entry.id === "agent-platform")) {
    throw new Error(`Missing Platform service in ${indexPath}`);
  }
  const bundles = index.services.map((entry) => {
    if (!/^[a-z0-9-]+$/u.test(entry.id) || !entry.assetFileName ||
        path.basename(entry.assetFileName) !== entry.assetFileName ||
        entry.assetFileName === "." || entry.assetFileName === ".." || entry.assetType !== "directory") {
      throw new Error(`Invalid Darwin service directory in ${indexPath}`);
    }
    const root = path.join(servicesRoot, entry.id, entry.assetFileName);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.platform?.os !== "darwin") {
      throw new Error(`Darwin service manifest does not match asset index: ${root}`);
    }
    return { entry, root, manifest };
  });
  // Fail before signing any service if Platform input integrity is already bad.
  verifyPlatformBuiltinsInServices(servicesRoot, options.runManifest);
  for (const { entry, root, manifest } of bundles) {
    signDarwinServiceDirectory(root, manifest, identity, options);
    entry.assetSignature = computeAssetSignature(root);
  }
  // Runtime uses this index to decide whether the installed bundle needs refresh.
  fs.writeFileSync(indexPath, `${JSON.stringify({ ...index, generatedAt: new Date().toISOString() }, null, 2)}\n`);
}

async function signMacApp(options, {
  prepareServices = prepareDarwinAppServices,
  verifyServices = verifyPlatformBuiltinsInServices,
  signAsync
} = {}) {
  if (options.platform !== "darwin" || !options.identity) {
    throw new Error("Desktop service signing requires a Darwin signing identity");
  }
  // electron-builder may pass a relative app path, while osx-sign walks absolute
  // paths. Normalize before constructing the recursive-signing exclusion.
  const app = path.resolve(options.app);
  const servicesRoot = path.join(app, "Contents", "Resources", "services");
  await prepareServices(servicesRoot, options.identity, { keychain: options.keychain });
  const previousIgnore = options.ignore == null ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore];
  const ignoreServices = (file) => file === servicesRoot || file.startsWith(`${servicesRoot}${path.sep}`);
  // The installed osx-sign normalizer drops array-valued ignore options. A
  // single predicate preserves both the builder's exclusions and our boundary.
  const ignore = (file) => ignoreServices(file) || previousIgnore.some((rule) =>
    typeof rule === "function" ? rule(file) : Boolean(file.match(rule))
  );
  // Service binaries and their manifest are final now. The outer app seals them
  // as resources; recursively re-signing them would invalidate Platform hashes.
  const builderRequire = createRequire(require.resolve("app-builder-lib"));
  await (signAsync || builderRequire("@electron/osx-sign").signAsync)({
    ...options,
    app,
    ignore
  });
  verifyServices(servicesRoot);
}

exports.sign = signMacApp;
exports.prepareDarwinAppServices = prepareDarwinAppServices;
