const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Platform owns both the manifest schema and the tree digest algorithm. Desktop
// treats the verification receipt as opaque and only orchestrates signing.
function runPlatformBuiltinsManifest(bundleRoot, action, expectedManifestSha256, run = execFileSync) {
  const root = path.resolve(bundleRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.id !== "agent-platform") {
    throw new Error(`Expected an agent-platform bundle: ${root}`);
  }
  const targetOS = manifest.platform?.os;
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  const hostOS = process.platform === "win32" ? "windows" : process.platform;
  if (targetOS !== hostOS || manifest.platform?.arch !== hostArch) {
    throw new Error(`Platform builtin verification requires a matching ${targetOS}/${manifest.platform?.arch} host`);
  }
  const binaryName = targetOS === "windows" ? "agent-platform.exe" : "agent-platform";
  const binary = path.join(root, "backend", binaryName);
  const args = ["builtins-manifest", action, "--bundle-root", root];
  if (expectedManifestSha256) {
    args.push("--expected-manifest-sha256", expectedManifestSha256);
  }
  try {
    const output = run(binary, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });
    const receipt = JSON.parse(output);
    const manifestSha256 = createHash("sha256")
      .update(fs.readFileSync(path.join(root, "builtins.manifest.json"))).digest("hex");
    if (receipt.schemaVersion !== 1 || receipt.manifestSha256 !== manifestSha256) {
      throw new Error("Invalid Platform builtin verification receipt");
    }
    return receipt;
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim();
    throw new Error(
      `Platform builtins-manifest ${action} failed in ${root}: ${detail}\n` +
      "Rebuild agent-platform with the builtins-manifest packaging command and sync its verified release; do not repair installed manifests."
    );
  }
}

function verifyPlatformBuiltinsInServices(servicesRoot, runManifest = runPlatformBuiltinsManifest) {
  const root = path.join(servicesRoot, "agent-platform");
  const bundles = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (bundles.length === 0) {
    throw new Error(`No unpacked agent-platform bundle in ${root}`);
  }
  for (const bundle of bundles) {
    runManifest(path.join(root, bundle.name), "verify");
  }
}

module.exports = { runPlatformBuiltinsManifest, verifyPlatformBuiltinsInServices };
