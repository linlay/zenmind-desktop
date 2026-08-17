import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { electronBuilderConfigPath, syncBrandArtifacts, resolveBrandId } from "../lib/brand-config.mjs";
import { buildSafeRepair } from "../build-safe-repair.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./spawn.mjs";

const projectRoot = process.cwd();

async function syncWindowsBuiltinAssets(brand) {
  await runAndWait(process.execPath, ["./scripts/sync-builtin-assets.mjs", "--use-existing", "--os=windows", "--arch=amd64"], withBrandEnv(brand, {
    cwd: projectRoot
  }));
}

function unquoteYamlScalar(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
}

function readLatestInstallerEntries(latestYmlPath) {
  if (!fs.existsSync(latestYmlPath)) {
    return [];
  }
  const entries = new Map();
  const content = fs.readFileSync(latestYmlPath, "utf8");
  let currentEntry = null;
  for (const line of content.split(/\r?\n/u)) {
    const nameMatch = line.match(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/u);
    if (nameMatch) {
      const value = unquoteYamlScalar(nameMatch[1]);
      if (!value.toLowerCase().endsWith(".exe")) {
        currentEntry = null;
        continue;
      }
      const name = path.basename(value);
      currentEntry = entries.get(name) ?? { name, size: null, sha512: null };
      entries.set(name, currentEntry);
      continue;
    }

    const sizeMatch = line.match(/^\s*size:\s*(\d+)\s*$/u);
    if (sizeMatch && currentEntry && currentEntry.size == null) {
      currentEntry.size = Number(sizeMatch[1]);
      continue;
    }

    const shaMatch = line.match(/^\s*sha512:\s*(.+?)\s*$/u);
    if (shaMatch && currentEntry && currentEntry.sha512 == null) {
      currentEntry.sha512 = unquoteYamlScalar(shaMatch[1]);
    }
  }
  return [...entries.values()];
}

function installerAliasCandidates(brand, targetName) {
  const candidates = [];
  const hyphenPrefix = `${brand.productName}-Setup-`;
  const spacedPrefix = `${brand.productName} Setup `;
  if (targetName.startsWith(hyphenPrefix)) {
    candidates.push(`${brand.productName} Setup ${targetName.slice(hyphenPrefix.length)}`);
  }
  if (targetName.startsWith(spacedPrefix)) {
    candidates.push(`${brand.productName}-Setup-${targetName.slice(spacedPrefix.length)}`);
  }
  return candidates;
}

function fileSha512(filePath) {
  return createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function fileMatchesLatestEntry(filePath, entry) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  if (entry.size != null && fs.statSync(filePath).size !== entry.size) {
    return false;
  }
  if (entry.sha512 && fileSha512(filePath) !== entry.sha512) {
    return false;
  }
  return true;
}

export function ensureWindowsLatestAliases(brand, rootDir = projectRoot) {
  const outputDir = path.join(rootDir, "dist", brand.id);
  const latestYmlPath = path.join(outputDir, "latest.yml");
  for (const entry of readLatestInstallerEntries(latestYmlPath)) {
    const targetPath = path.join(outputDir, entry.name);
    if (fileMatchesLatestEntry(targetPath, entry)) {
      continue;
    }

    const sourceName = installerAliasCandidates(brand, entry.name)
      .find((candidate) => fileMatchesLatestEntry(path.join(outputDir, candidate), entry))
      ?? installerAliasCandidates(brand, entry.name)
        .find((candidate) => fs.existsSync(path.join(outputDir, candidate)));
    if (!sourceName) {
      throw new Error(`latest.yml references missing Windows installer: ${entry.name}`);
    }

    const sourcePath = path.join(outputDir, sourceName);
    if (!fileMatchesLatestEntry(sourcePath, entry)) {
      throw new Error(`latest.yml references Windows installer ${entry.name}, but ${sourceName} does not match its metadata`);
    }
    fs.copyFileSync(sourcePath, targetPath);

    const sourceBlockmapPath = `${sourcePath}.blockmap`;
    const targetBlockmapPath = `${targetPath}.blockmap`;
    if (fs.existsSync(sourceBlockmapPath)) {
      fs.copyFileSync(sourceBlockmapPath, targetBlockmapPath);
    }
  }
}

export async function buildOnWindowsHost(brand = syncBrandArtifacts({ brandId: resolveBrandId() })) {
  const target = { os: "win32", arch: "x64" };
  const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

  await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
  syncBrandArtifacts({ brandId: brand.id, target });
  await syncWindowsBuiltinAssets(brand);
  await runAndWait(npmCmd, ["run", "build"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=win32", "--arch=x64"], brandProcessOptions({
    cwd: projectRoot
  }));
  await runAndWait(npmCmd, [
    "exec",
    "electron-builder",
    "--",
    "--config",
    electronBuilderConfigPath(projectRoot, brand.id),
    "--win",
    "--x64"
  ], brandProcessOptions({
    cwd: projectRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    }
  }));
  ensureWindowsLatestAliases(brand);
  buildSafeRepair({ brand });
  await runAndWait(nodeBin(), ["./scripts/verify-win-package.mjs"], brandProcessOptions({ cwd: projectRoot }));
}

function nodeBin() {
  return process.execPath;
}
