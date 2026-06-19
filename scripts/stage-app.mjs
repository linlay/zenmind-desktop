import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { npmCmd, runAndWait } from "./platform/spawn.mjs";
import {
  DESKTOP_PACKAGE_NAME,
  brandBundleElectronDir,
  brandRendererDir,
  brandStageAppDir,
  loadBrandConfig,
  normalizeBrandBuildTarget,
  resolveBrandId,
  syncBrandArtifacts
} from "./lib/brand-config.mjs";
import {
  createDesktopBuildMetadata,
  normalizeDesktopVersion,
  readDesktopVersion
} from "./lib/build-metadata.mjs";

const projectRoot = process.cwd();

function parseArgs(argv) {
  const target = {
    os: process.platform,
    arch: process.arch
  };
  const args = argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.split("=");
    const nextValue = inlineValue ?? args[index + 1];
    if (key === "--os") {
      target.os = normalizeTargetOs(nextValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (key === "--arch") {
      target.arch = normalizeTargetArch(nextValue);
      if (inlineValue === undefined) {
        index += 1;
      }
    }
  }

  return target;
}

function normalizeTargetOs(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing target os");
  }
  switch (normalized) {
    case "darwin":
    case "linux":
    case "win32":
      return normalized;
    case "windows":
      return "win32";
    default:
      throw new Error(`unsupported target os: ${value}`);
  }
}

function normalizeTargetArch(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing target arch");
  }
  switch (normalized) {
    case "x64":
    case "arm64":
      return normalized;
    case "amd64":
      return "x64";
    default:
      throw new Error(`unsupported target arch: ${value}`);
  }
}

function currentTarget() {
  return {
    os: normalizeTargetOs(process.platform),
    arch: normalizeTargetArch(process.arch)
  };
}

function ensureBuildArtifact(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`missing ${label}: ${dirPath}`);
  }
}

function copyDir(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true
  });
}

export function removeRendererWebappTemplatesFromStage(rootDir) {
  if (!rootDir) {
    throw new Error("removeRendererWebappTemplatesFromStage requires a staged app root");
  }
  fs.rmSync(path.join(rootDir, "dist-renderer", "webapp-templates"), {
    recursive: true,
    force: true
  });
}

function readDesktopPackageJson(rootDir = projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
}

function writeStagePackageJson(rootDir, target, stageRoot, activeBrand) {
  const desktopPackage = readDesktopPackageJson(rootDir);
  const desktopVersion = readDesktopVersion(rootDir);
  const desktopBuildMetadata = createDesktopBuildMetadata({
    productName: activeBrand.productName,
    version: desktopVersion
  });
  const stagePackage = {
    name: DESKTOP_PACKAGE_NAME,
    version: normalizeDesktopVersion(desktopVersion).replace(/^v/iu, ""),
    description: activeBrand.description,
    main: "dist-electron/main/index.js",
    productName: activeBrand.productName,
    author: desktopPackage.author,
    dependencies: {
      "@napi-rs/canvas": desktopPackage.dependencies?.["@napi-rs/canvas"]
    },
    desktopBuildTarget: {
      os: target.os,
      arch: target.arch
    },
    desktopBuildMetadata
  };

  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify(stagePackage, null, 2)}\n`,
    "utf8"
  );
}

function expectedCanvasRuntimePackage(target) {
  const key = `${target.os}/${target.arch}`;
  switch (key) {
    case "darwin/arm64":
      return "@napi-rs/canvas-darwin-arm64";
    case "darwin/x64":
      return "@napi-rs/canvas-darwin-x64";
    case "linux/arm64":
      return "@napi-rs/canvas-linux-arm64-gnu";
    case "linux/x64":
      return "@napi-rs/canvas-linux-x64-gnu";
    case "win32/arm64":
      return "@napi-rs/canvas-win32-arm64-msvc";
    case "win32/x64":
      return "@napi-rs/canvas-win32-x64-msvc";
    default:
      return "";
  }
}

function directPackageDir(rootDir, packageName) {
  const segments = packageName.split("/");
  for (const nodeModulesRoot of nodeModulesRoots(rootDir)) {
    const directPath = path.join(nodeModulesRoot, ...segments);
    if (fs.existsSync(directPath)) {
      return fs.realpathSync(directPath);
    }
  }
  return "";
}

function pnpmPackageDir(rootDir, packageName) {
  const encodedPackageName = packageName.replace(/\//g, "+");
  const segments = packageName.split("/");

  for (const nodeModulesRoot of nodeModulesRoots(rootDir)) {
    const pnpmRoot = path.join(nodeModulesRoot, ".pnpm");
    if (!fs.existsSync(pnpmRoot) || !fs.statSync(pnpmRoot).isDirectory()) {
      continue;
    }

    const match = fs
      .readdirSync(pnpmRoot)
      .find((entry) => entry.startsWith(`${encodedPackageName}@`));
    if (!match) {
      continue;
    }

    const packageDir = path.join(pnpmRoot, match, "node_modules", ...segments);
    if (fs.existsSync(packageDir)) {
      return fs.realpathSync(packageDir);
    }
  }
  return "";
}

function findInstalledPackageDir(rootDir, packageName) {
  return directPackageDir(rootDir, packageName) || pnpmPackageDir(rootDir, packageName);
}

function nodeModulesRoots(rootDir) {
  const roots = [];
  let currentDir = path.resolve(rootDir);

  while (true) {
    const nodeModulesRoot = path.join(currentDir, "node_modules");
    if (fs.existsSync(nodeModulesRoot) && fs.statSync(nodeModulesRoot).isDirectory()) {
      roots.push(nodeModulesRoot);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return roots;
}

function copyRuntimePackage(packageName, stageRoot) {
  const packageDir = findInstalledPackageDir(projectRoot, packageName);
  if (!packageDir) {
    throw new Error(`missing installed runtime dependency ${packageName}`);
  }

  const segments = packageName.split("/");
  const targetDir = path.join(stageRoot, "node_modules", ...segments);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  copyDir(packageDir, targetDir);
}

function copyRuntimeDependencies(target, stageRoot) {
  copyRuntimePackage("@napi-rs/canvas", stageRoot);
  const expectedPackage = expectedCanvasRuntimePackage(target);
  if (expectedPackage) {
    copyRuntimePackage(expectedPackage, stageRoot);
  }
  verifyCanvasRuntime(target, stageRoot);
}

function verifyCanvasRuntime(target, stageRoot) {
  const napiRoot = path.join(stageRoot, "node_modules", "@napi-rs");
  const expectedPackage = expectedCanvasRuntimePackage(target);
  const installed = fs.existsSync(napiRoot)
    ? fs.readdirSync(napiRoot).filter((entry) => entry.startsWith("canvas-"))
    : [];

  if (expectedPackage) {
    const expectedDir = expectedPackage.replace("@napi-rs/", "");
    if (!installed.includes(expectedDir)) {
      throw new Error(`missing staged runtime dependency ${expectedPackage}`);
    }
    const disallowed = installed.filter((entry) => entry !== expectedDir);
    if (disallowed.length > 0) {
      throw new Error(
        `unexpected canvas runtime packages in ${target.os}/${target.arch} stage: ${disallowed.join(", ")}`
      );
    }
  }
}

function hasInstalledRuntimeDependencies(target) {
  const requiredPackages = ["@napi-rs/canvas"];
  const expectedPackage = expectedCanvasRuntimePackage(target);
  if (expectedPackage) {
    requiredPackages.push(expectedPackage);
  }
  return requiredPackages.every((packageName) => Boolean(findInstalledPackageDir(projectRoot, packageName)));
}

async function installRuntimeDependencies(target, stageRoot) {
  if (hasInstalledRuntimeDependencies(target)) {
    copyRuntimeDependencies(target, stageRoot);
    return;
  }

  await runAndWait(
    npmCmd,
    [
      "install",
      "--omit=dev",
      "--include=optional",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      `--os=${target.os}`,
      `--cpu=${target.arch}`
    ],
    { cwd: stageRoot }
  );
  verifyCanvasRuntime(target, stageRoot);
}

export async function stageApp(rootDir = projectRoot, target = parseArgs(process.argv)) {
  const normalizedTarget = normalizeBrandBuildTarget(target);
  const activeBrand = loadBrandConfig(rootDir, resolveBrandId());
  const bundleRoot = brandBundleElectronDir(rootDir, activeBrand);
  const rendererRoot = brandRendererDir(rootDir, activeBrand);
  const stageRoot = brandStageAppDir(rootDir, activeBrand, normalizedTarget);

  ensureBuildArtifact(bundleRoot, "bundled dist-electron output");
  ensureBuildArtifact(rendererRoot, "dist-renderer output");

  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  copyDir(rendererRoot, path.join(stageRoot, "dist-renderer"));
  removeRendererWebappTemplatesFromStage(stageRoot);
  copyDir(bundleRoot, path.join(stageRoot, "dist-electron"));
  writeStagePackageJson(rootDir, normalizedTarget, stageRoot, activeBrand);
  await installRuntimeDependencies(normalizedTarget, stageRoot);
  syncBrandArtifacts({ rootDir, brandId: activeBrand.id, target: normalizedTarget });

  return stageRoot;
}

async function main() {
  const target = parseArgs(process.argv);
  const outputDir = await stageApp(projectRoot, target);
  console.log(`staged app into ${path.relative(projectRoot, outputDir)} for ${target.os}/${target.arch}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
