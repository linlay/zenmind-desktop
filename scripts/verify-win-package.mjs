import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadBrandConfig, resolveRequiredBrandId } from "./lib/brand-config.mjs";

const projectRoot = process.cwd();
const brandId = resolveRequiredBrandId(process.argv.slice(2), process.env, "verify-win-package");
const brand = loadBrandConfig(projectRoot, brandId);
const resourcesRoot = path.join(projectRoot, "dist", brandId, "win-unpacked", "resources");
const requiredRuntimePackage = "@napi-rs/canvas-win32-x64-msvc";
const canvasRuntimePackagePattern = /@napi-rs\/canvas-(?!win32-x64-msvc\b)[^/]+/u;

function walkFileTree(rootDir) {
  const output = [];
  if (!fs.existsSync(rootDir)) {
    return output;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      output.push(fullPath);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }

  return output;
}

function assertExists(rootDir, label) {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`missing ${label}: ${rootDir}`);
  }
}

function verifySafeRepairArtifact() {
  const version = fs.readFileSync(path.join(projectRoot, "VERSION"), "utf8").trim().replace(/^v/u, "");
  const fileName = `${brand.productName} Safe Repair ${version}.exe`;
  const artifactPath = path.join(projectRoot, "dist", brandId, fileName);
  const checksumPath = `${artifactPath}.sha256`;
  assertExists(artifactPath, "Windows Safe Repair executable");
  assertExists(checksumPath, "Windows Safe Repair checksum");

  const expected = fs.readFileSync(checksumPath, "utf8").trim();
  const actualHash = createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  const actual = `${actualHash} *${fileName}`;
  if (expected !== actual) {
    throw new Error(`Safe Repair checksum mismatch: ${checksumPath}`);
  }

  const latestYmlPath = path.join(projectRoot, "dist", brandId, "latest.yml");
  if (fs.existsSync(latestYmlPath) && fs.readFileSync(latestYmlPath, "utf8").includes("Safe Repair")) {
    throw new Error("latest.yml must not publish Safe Repair as an automatic update target");
  }
  console.log(`verified Safe Repair artifact: ${path.relative(projectRoot, artifactPath)}`);
}

function main() {
  assertExists(resourcesRoot, "Windows unpacked resources");
  const paths = walkFileTree(resourcesRoot)
    .map((filePath) => path.relative(projectRoot, filePath).replace(/\\/g, "/"));

  const requiredMatch = paths.find((filePath) => filePath.includes(requiredRuntimePackage));
  if (!requiredMatch) {
    throw new Error(`missing ${requiredRuntimePackage} in dist/${brandId}/win-unpacked/resources`);
  }

  const forbiddenMatches = paths.filter((filePath) => canvasRuntimePackagePattern.test(filePath));
  if (forbiddenMatches.length > 0) {
    throw new Error(
      `unexpected non-win32-x64 canvas runtime packages in Windows output:\n${forbiddenMatches.join("\n")}`
    );
  }

  verifySafeRepairArtifact();
  console.log(`verified win32 runtime package: ${requiredMatch}`);
}

main();
