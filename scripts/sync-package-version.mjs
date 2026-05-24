import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function readVersion() {
  const versionPath = path.join(projectRoot, "VERSION");
  const version = fs.readFileSync(versionPath, "utf8").trim().replace(/^v/iu, "");

  if (!version) {
    throw new Error(`empty VERSION file: ${versionPath}`);
  }

  return version;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const version = readVersion();
const packagePath = path.join(projectRoot, "package.json");
const packageLockPath = path.join(projectRoot, "package-lock.json");

const packageJson = readJson(packagePath);
packageJson.version = version;
writeJson(packagePath, packageJson);

if (fs.existsSync(packageLockPath)) {
  const packageLock = readJson(packageLockPath);
  packageLock.version = version;

  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }

  writeJson(packageLockPath, packageLock);
}

console.log(`synced package metadata version ${version}`);
