import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  brandIconDir,
  brandRuntimeAssetDir,
  electronBuilderConfigPath,
  loadBrandConfig,
  resolveRequiredBrandId
} from "./lib/brand-config.mjs";
import { verifyGeneratedAppIcons } from "./generate-app-icons.mjs";

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

function verifyPackagedBrandResources() {
  const generatedResourcesRoot = brandRuntimeAssetDir(projectRoot, brand);
  for (const fileName of ["brand-icon.png", "brand-mark.png", "tray-icon.png"]) {
    const generatedPath = path.join(generatedResourcesRoot, fileName);
    const packagedPath = path.join(resourcesRoot, fileName);
    assertExists(generatedPath, `generated ${fileName}`);
    assertExists(packagedPath, `packaged ${fileName}`);
    if (Buffer.compare(fs.readFileSync(generatedPath), fs.readFileSync(packagedPath)) !== 0) {
      throw new Error(`packaged brand resource differs from generated source: ${fileName}`);
    }
  }
}

function verifyPackagedWebappTooling() {
  const toolingPath = path.join(resourcesRoot, "scripts", "webapp-tooling.mjs");
  assertExists(toolingPath, "packaged WebApp Tooling");
  if (!fs.statSync(toolingPath).isFile() || fs.statSync(toolingPath).size === 0) {
    throw new Error(`packaged WebApp Tooling is not a non-empty file: ${toolingPath}`);
  }
}

function verifyBuilderIconConfig() {
  const configPath = electronBuilderConfigPath(projectRoot, brand.id);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const expectedIcon = path.relative(projectRoot, path.join(brandIconDir(projectRoot, brand), "icon.ico")).replace(/\\/gu, "/");
  if (config.win?.icon !== expectedIcon) {
    throw new Error(`electron-builder Windows icon mismatch: expected ${expectedIcon}, got ${config.win?.icon ?? "(missing)"}`);
  }
  if (config.win?.signAndEditExecutable !== true) {
    throw new Error("electron-builder must keep win.signAndEditExecutable enabled");
  }
}

function verifyNativeExecutableIcon() {
  if (process.platform !== "win32") {
    console.log("verified Windows icon source/config/resources; native EXE icon extraction requires a Windows host");
    return;
  }

  const executablePath = path.join(projectRoot, "dist", brand.id, "win-unpacked", `${brand.productName}.exe`);
  const icoPath = path.join(brandIconDir(projectRoot, brand), "icon.ico");
  assertExists(executablePath, "Windows application executable");
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    "$actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($args[0])",
    "if ($null -eq $actualIcon) { throw 'Unable to extract executable icon' }",
    "$expectedIcon = New-Object System.Drawing.Icon($args[1], 32, 32)",
    "function Convert-IconBitmap([System.Drawing.Icon]$icon) {",
    "  $bitmap = New-Object System.Drawing.Bitmap(32, 32)",
    "  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "  try { $graphics.DrawIcon($icon, 0, 0) } finally { $graphics.Dispose() }",
    "  return $bitmap",
    "}",
    "$actual = Convert-IconBitmap $actualIcon",
    "$expected = Convert-IconBitmap $expectedIcon",
    "try {",
    "  for ($y = 0; $y -lt 32; $y++) {",
    "    for ($x = 0; $x -lt 32; $x++) {",
    "      if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) { throw \"EXE icon pixel mismatch at $x,$y\" }",
    "    }",
    "  }",
    "} finally { $actual.Dispose(); $expected.Dispose(); $actualIcon.Dispose(); $expectedIcon.Dispose() }"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, executablePath, icoPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`Windows EXE icon does not match generated ICO:\n${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

async function main() {
  assertExists(resourcesRoot, "Windows unpacked resources");
  await verifyGeneratedAppIcons({ rootDir: projectRoot, brandId: brand.id, platform: "win32" });
  verifyBuilderIconConfig();
  verifyPackagedBrandResources();
  verifyPackagedWebappTooling();
  verifyNativeExecutableIcon();
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

await main();
