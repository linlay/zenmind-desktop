import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { electronBuilderConfigPath, syncBrandArtifacts, resolveBrandId } from "../lib/brand-config.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./spawn.mjs";

const projectRoot = process.cwd();

async function syncWindowsBuiltinAssets(brand) {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"], withBrandEnv(brand, {
    cwd: projectRoot
  }));
}

function unquoteYamlScalar(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
}

function readLatestInstallerNames(latestYmlPath) {
  if (!fs.existsSync(latestYmlPath)) {
    return [];
  }
  const names = new Set();
  const content = fs.readFileSync(latestYmlPath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:url|path):\s*(.+?)\s*$/u);
    if (!match) {
      continue;
    }
    const value = unquoteYamlScalar(match[1]);
    if (value.toLowerCase().endsWith(".exe")) {
      names.add(path.basename(value));
    }
  }
  return [...names];
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

export function ensureWindowsLatestAliases(brand, rootDir = projectRoot) {
  const outputDir = path.join(rootDir, "dist", brand.id);
  const latestYmlPath = path.join(outputDir, "latest.yml");
  for (const targetName of readLatestInstallerNames(latestYmlPath)) {
    const targetPath = path.join(outputDir, targetName);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const sourceName = installerAliasCandidates(brand, targetName)
      .find((candidate) => fs.existsSync(path.join(outputDir, candidate)));
    if (!sourceName) {
      throw new Error(`latest.yml references missing Windows installer: ${targetName}`);
    }

    const sourcePath = path.join(outputDir, sourceName);
    fs.copyFileSync(sourcePath, targetPath);

    const sourceBlockmapPath = `${sourcePath}.blockmap`;
    const targetBlockmapPath = `${targetPath}.blockmap`;
    if (fs.existsSync(sourceBlockmapPath) && !fs.existsSync(targetBlockmapPath)) {
      fs.copyFileSync(sourceBlockmapPath, targetBlockmapPath);
    }
  }
}

export async function buildOnWindowsHost(brand = syncBrandArtifacts({ brandId: resolveBrandId() })) {
  const target = { os: "win32", arch: "x64" };
  const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

  await runAndWait(npmCmd, ["run", "sync:version"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "sync:demo"], brandProcessOptions({ cwd: projectRoot }));
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
    "--config.win.signAndEditExecutable=false",
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
  await runAndWait(nodeBin(), ["./scripts/verify-win-package.mjs"], brandProcessOptions({ cwd: projectRoot }));
}

function nodeBin() {
  return process.execPath;
}
