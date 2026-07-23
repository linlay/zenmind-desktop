import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadBrandConfig,
  resolveRequiredBrandId,
  safeRepairScriptPath,
  syncBrandArtifacts
} from "./lib/brand-config.mjs";

const projectRoot = process.cwd();

function versionFromFile(rootDir = projectRoot) {
  return fs.readFileSync(path.join(rootDir, "VERSION"), "utf8").trim().replace(/^v/u, "");
}

export function safeRepairArtifactName(brand, version = versionFromFile()) {
  return `${brand.productName} Safe Repair ${version}.exe`;
}

export function safeRepairArtifactPath(brand, rootDir = projectRoot, version = versionFromFile(rootDir)) {
  return path.join(rootDir, "dist", brand.id, safeRepairArtifactName(brand, version));
}

function nsisCacheRoot(env = process.env) {
  if (process.platform === "win32") {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "electron-builder", "Cache", "nsis") : "";
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "electron-builder", "nsis");
  }
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "electron-builder", "nsis");
}

function nsisBinaryForRoot(root) {
  const candidates = process.platform === "win32"
    ? [path.join(root, "makensis.exe"), path.join(root, "Bin", "makensis.exe")]
    : process.platform === "darwin"
      ? [path.join(root, "mac", "makensis"), path.join(root, "makensis")]
      : [path.join(root, "linux", "makensis"), path.join(root, "makensis")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

export function resolveNsisToolchain(env = process.env) {
  const explicitRoot = String(env.ELECTRON_BUILDER_NSIS_DIR ?? "").trim();
  if (explicitRoot) {
    const binary = nsisBinaryForRoot(explicitRoot);
    if (!binary) {
      throw new Error(`makensis not found under ELECTRON_BUILDER_NSIS_DIR: ${explicitRoot}`);
    }
    return { root: explicitRoot, binary };
  }

  const cacheRoot = nsisCacheRoot(env);
  if (cacheRoot && fs.existsSync(cacheRoot)) {
    const roots = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(cacheRoot, entry.name))
      .sort((left, right) => right.localeCompare(left));
    for (const root of roots) {
      const binary = nsisBinaryForRoot(root);
      if (binary) {
        return { root, binary };
      }
    }
  }

  throw new Error("electron-builder NSIS toolchain was not found; build the Windows installer first or set ELECTRON_BUILDER_NSIS_DIR");
}

function writeSha256File(artifactPath) {
  const digest = createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  const checksumPath = `${artifactPath}.sha256`;
  fs.writeFileSync(checksumPath, `${digest} *${path.basename(artifactPath)}\n`, "utf8");
  return checksumPath;
}

export function buildSafeRepair({
  rootDir = projectRoot,
  brand = loadBrandConfig(rootDir, resolveRequiredBrandId(process.argv.slice(2), process.env, "build-safe-repair"))
} = {}) {
  syncBrandArtifacts({ rootDir, brandId: brand.id, target: { os: "win32", arch: "x64" } });
  const sourcePath = safeRepairScriptPath(rootDir, brand);
  const outputPath = safeRepairArtifactPath(brand, rootDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const toolchain = resolveNsisToolchain();
  const result = spawnSync(
    toolchain.binary,
    ["/INPUTCHARSET", "UTF8", `/DSAFE_REPAIR_OUT_FILE=${outputPath}`, sourcePath],
    {
      cwd: rootDir,
      env: { ...process.env, NSISDIR: toolchain.root },
      stdio: "inherit",
      shell: false
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`makensis exited with code ${result.status ?? -1}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Safe Repair artifact was not created: ${outputPath}`);
  }
  const checksumPath = writeSha256File(outputPath);
  console.log(`built Safe Repair: ${outputPath}`);
  console.log(`wrote Safe Repair checksum: ${checksumPath}`);
  return { outputPath, checksumPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildSafeRepair();
}
