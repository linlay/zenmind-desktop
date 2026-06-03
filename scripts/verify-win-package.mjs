import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const resourcesRoot = path.join(projectRoot, "dist", "win-unpacked", "resources");
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

function main() {
  assertExists(resourcesRoot, "Windows unpacked resources");
  const paths = walkFileTree(resourcesRoot)
    .map((filePath) => path.relative(projectRoot, filePath).replace(/\\/g, "/"));

  const requiredMatch = paths.find((filePath) => filePath.includes(requiredRuntimePackage));
  if (!requiredMatch) {
    throw new Error(`missing ${requiredRuntimePackage} in dist/win-unpacked/resources`);
  }

  const forbiddenMatches = paths.filter((filePath) => canvasRuntimePackagePattern.test(filePath));
  if (forbiddenMatches.length > 0) {
    throw new Error(
      `unexpected non-win32-x64 canvas runtime packages in Windows output:\n${forbiddenMatches.join("\n")}`
    );
  }

  console.log(`verified win32 runtime package: ${requiredMatch}`);
}

main();
