import fs from "node:fs";
import path from "node:path";
import { desktopBuiltinServicesRelativePath } from "./desktop-resources.mjs";

export const DEFAULT_BRAND_ID = "zenmind";
export const SUPPORTED_LOCALES = ["zh-CN", "en-US"];
export const INSTALLER_SHUTDOWN_ARG = "--desktop-shutdown-for-update";
export const DESKTOP_PACKAGE_NAME = "desktop";

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const BRAND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]+$/u;
const REQUIRED_ICON_FILES = ["app-icon.svg", "tray-icon.svg"];
export const BRAND_BUILD_ROOT_DIR = "build/brands";
export const BRAND_RUNTIME_ASSET_DIR_NAME = "brand-assets";
export const BRAND_RUNTIME_ASSET_FILENAMES = [
  "brand-icon.png",
  "brand-mark.png",
  "tray-icon.png",
  "tray-icon.svg"
];
const DESKTOP_PET_REQUIRED_STATE_KEYS = [
  "idle",
  "jumping",
  "moving-left",
  "dragging",
  "done",
  "failed",
  "running",
  "awaiting",
  "review"
];
const DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES = 4;
const DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES = 8;
const DESKTOP_PET_ACTION_TRIGGER_VALUES = new Set(["manual", "idle-random"]);
const DESKTOP_PET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const DESKTOP_PET_SIGNATURE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function parseBooleanEnv(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean value`);
  }
}

function shouldSkipMacTimestamp(env = process.env) {
  return (
    parseBooleanEnv(env.SKIP_NOTARIZE, "SKIP_NOTARIZE") === true ||
    parseBooleanEnv(env.DESKTOP_SKIP_MAC_TIMESTAMP, "DESKTOP_SKIP_MAC_TIMESTAMP") === true
  );
}

export function resolveBrandId(argv = process.argv.slice(2), env = process.env) {
  return normalizeBrandId(resolveExplicitBrandId(argv, env) || DEFAULT_BRAND_ID);
}

export function resolveRequiredBrandId(argv = process.argv.slice(2), env = process.env, label = "build") {
  const explicitBrandId = resolveExplicitBrandId(argv, env);
  if (!explicitBrandId) {
    throw new Error(`${label} requires an explicit brand. Set BRAND=<brand> or pass --brand=<brand>.`);
  }
  return normalizeBrandId(explicitBrandId);
}

function resolveExplicitBrandId(argv = process.argv.slice(2), env = process.env) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--brand" && argv[index + 1]) {
      return argv[index + 1];
    }
    if (arg.startsWith("--brand=")) {
      return arg.slice("--brand=".length);
    }
  }
  return env.BRAND;
}

export function loadBrandConfig(rootDir = process.cwd(), brandId = resolveBrandId()) {
  const id = normalizeBrandId(brandId);
  const brandRoot = path.join(rootDir, "brands", id);
  const manifestPath = path.join(brandRoot, "brand.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Brand manifest not found: ${path.relative(rootDir, manifestPath)}`);
  }

  const manifest = readJson(manifestPath);
  const i18n = loadBrandI18n(rootDir, brandRoot, manifest);
  const icons = validateBrandIcons(rootDir, brandRoot);
  const desktopPet = loadBrandDesktopPet(rootDir, brandRoot);
  const brand = normalizeManifest(rootDir, brandRoot, manifest, i18n, icons, desktopPet);
  return brand;
}

export function syncBrandArtifacts({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  target = currentBrandBuildTarget()
} = {}) {
  const brand = loadBrandConfig(rootDir, brandId);

  writeGeneratedBrandFiles(rootDir, brand);
  writeElectronBuilderConfig(rootDir, brand, target);
  writeInstallerInclude(rootDir, brand);
  writeMacUninstallScript(rootDir, brand);
  cleanupPublicBrandIconArtifacts(rootDir);

  return brand;
}

export function removeStaleRendererBuild({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId)
} = {}) {
  const rendererRoot = brandRendererDir(rootDir, brand);
  if (!fs.existsSync(rendererRoot)) {
    return false;
  }

  const rendererIndexPath = path.join(rendererRoot, "index.html");
  const shouldRemove = !fs.existsSync(rendererIndexPath) || distRendererProblems(rootDir, brand).length > 0;
  if (!shouldRemove) {
    return false;
  }

  fs.rmSync(rendererRoot, { recursive: true, force: true });
  return true;
}

export function assertBrandArtifactsConsistent({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  checkDistRenderer = true
} = {}) {
  const problems = [
    ...generatedBrandProblems(rootDir, brand),
    ...rendererIndexProblems(rootDir, brand),
    ...brandRuntimeIconProblems(rootDir, brand),
    ...stalePublicBrandIconProblems(rootDir)
  ];

  if (checkDistRenderer) {
    problems.push(...distRendererProblems(rootDir, brand));
  }

  if (problems.length > 0) {
    throw new Error(`Brand artifact drift for ${brand.id}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export function electronBuilderConfigPath(rootDir = process.cwd(), brandId = resolveBrandId()) {
  return path.join(rootDir, brandBuildRelativePath(brandId, "electron-builder.json"));
}

export function normalizeBrandBuildTarget(target = currentBrandBuildTarget()) {
  return {
    os: normalizeTargetOs(target.os ?? process.platform),
    arch: normalizeTargetArch(target.arch ?? process.arch)
  };
}

export function brandBuildTargetKey(target = currentBrandBuildTarget()) {
  const normalized = normalizeBrandBuildTarget(target);
  return `${normalized.os}-${normalized.arch}`;
}

export function currentBrandBuildTarget() {
  return {
    os: normalizeTargetOs(process.platform),
    arch: normalizeTargetArch(process.arch)
  };
}

export function brandBuildRelativePath(brandOrId, ...segments) {
  return [BRAND_BUILD_ROOT_DIR, brandIdValue(brandOrId), ...segments].join("/");
}

export function brandBuildRoot(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId));
}

export function brandGeneratedDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "generated"));
}

export function brandRuntimeAssetDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, BRAND_RUNTIME_ASSET_DIR_NAME));
}

export function brandIconDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "icons"));
}

export function brandInstallerDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "installer"));
}

export function brandResourcesDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "resources"));
}

export function brandRendererDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "renderer"));
}

export function brandBundleDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "bundle"));
}

export function brandBundleElectronDir(rootDir, brandOrId) {
  return path.join(brandBundleDir(rootDir, brandOrId), "dist-electron");
}

export function brandStageAppDir(rootDir, brandOrId, target = currentBrandBuildTarget()) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "app", brandBuildTargetKey(target)));
}

function brandIdValue(brandOrId) {
  return normalizeBrandId(typeof brandOrId === "string" ? brandOrId : brandOrId?.id);
}

function normalizeTargetOs(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
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

function normalizeBrandId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!BRAND_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid brand id: ${value}`);
  }
  return normalized;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON ${filePath}: ${message}`);
  }
}

function writeJson(filePath, value) {
  writeFileIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return false;
  }
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return [`${label} is missing`];
  }
  return [];
}

function assertNonEmptyFile(filePath, label) {
  const existsProblems = assertFileExists(filePath, label);
  if (existsProblems.length > 0) {
    return existsProblems;
  }
  if (fs.statSync(filePath).size === 0) {
    return [`${label} is empty`];
  }
  return [];
}

function listForeignBrandMarkers(rootDir, activeBrandId) {
  const brandsRoot = path.join(rootDir, "brands");
  if (!fs.existsSync(brandsRoot)) {
    return [];
  }

  return fs.readdirSync(brandsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== activeBrandId)
    .flatMap((entry) => {
      const manifestPath = path.join(brandsRoot, entry.name, "brand.json");
      if (!fs.existsSync(manifestPath)) {
        return [];
      }
      const manifest = readJson(manifestPath);
      const productName = typeof manifest.productName === "string" ? manifest.productName.trim() : "";
      return [
        `${entry.name}-pet:`,
        `${entry.name}-website-favicon:`,
        ...(productName ? [`<title>${escapeHtmlText(productName)}</title>`] : [])
      ];
    });
}

function htmlBrandProblems(content, label, brand, rootDir) {
  const problems = [];
  const expectedTitle = `<title>${escapeHtmlText(brand.productName)}</title>`;
  if (!content.includes(expectedTitle)) {
    problems.push(`${label} does not contain ${expectedTitle}`);
  }

  const expectedPetProtocol = `${brand.id}-pet:`;
  const petProtocolPattern = new RegExp(`img-src[^"]*${escapeRegExp(expectedPetProtocol)}`, "u");
  if (!petProtocolPattern.test(content)) {
    problems.push(`${label} does not contain ${expectedPetProtocol} in img-src`);
  }

  const expectedWebsiteFaviconProtocol = `${brand.id}-website-favicon:`;
  const websiteFaviconProtocolPattern = new RegExp(`img-src[^"]*${escapeRegExp(expectedWebsiteFaviconProtocol)}`, "u");
  if (!websiteFaviconProtocolPattern.test(content)) {
    problems.push(`${label} does not contain ${expectedWebsiteFaviconProtocol} in img-src`);
  }

  for (const marker of listForeignBrandMarkers(rootDir, brand.id)) {
    if (content.includes(marker)) {
      problems.push(`${label} still contains foreign brand marker ${marker}`);
    }
  }

  return problems;
}

function generatedBrandProblems(rootDir, brand) {
  const problems = [];
  const generatedDir = brandGeneratedDir(rootDir, brand);
  const generatedJsonPath = path.join(generatedDir, "brand.json");
  const generatedTsPath = path.join(generatedDir, "brand.ts");
  const generatedJsonLabel = path.relative(rootDir, generatedJsonPath).replace(/\\/gu, "/");
  const generatedTsLabel = path.relative(rootDir, generatedTsPath).replace(/\\/gu, "/");

  const jsonExistsProblems = assertFileExists(generatedJsonPath, generatedJsonLabel);
  problems.push(...jsonExistsProblems);
  if (jsonExistsProblems.length === 0) {
    const generatedJson = readJson(generatedJsonPath);
    if (generatedJson.id !== brand.id) {
      problems.push(`${generatedJsonLabel} id is ${generatedJson.id}, expected ${brand.id}`);
    }
    if (generatedJson.productName !== brand.productName) {
      problems.push(
        `${generatedJsonLabel} productName is ${generatedJson.productName}, expected ${brand.productName}`
      );
    }
  }

  const tsExistsProblems = assertFileExists(generatedTsPath, generatedTsLabel);
  problems.push(...tsExistsProblems);
  if (tsExistsProblems.length === 0) {
    const generatedTs = fs.readFileSync(generatedTsPath, "utf8");
    if (!generatedTs.includes(`"id": "${brand.id}"`)) {
      problems.push(`${generatedTsLabel} does not contain id ${brand.id}`);
    }
    if (!generatedTs.includes(`"productName": "${brand.productName}"`)) {
      problems.push(`${generatedTsLabel} does not contain productName ${brand.productName}`);
    }
  }

  return problems;
}

function rendererIndexProblems(rootDir, brand) {
  const indexPath = path.join(rootDir, "index.html");
  const existsProblems = assertFileExists(indexPath, "index.html");
  if (existsProblems.length > 0) {
    return existsProblems;
  }
  return htmlBrandProblems(
    renderRendererIndexHtml(fs.readFileSync(indexPath, "utf8"), brand),
    "rendered index.html",
    brand,
    rootDir
  );
}

function filesHaveSameBytes(leftPath, rightPath) {
  return Buffer.compare(fs.readFileSync(leftPath), fs.readFileSync(rightPath)) === 0;
}

function listRelativeFiles(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return [];
  }

  const result = [];
  const visit = (currentDir, relativeDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  };

  visit(rootDir, "");
  return result;
}

function desktopPetDistProblems(rootDir, brand) {
  const sourceRoot = path.join(rootDir, brand.source.desktopPetRoot);
  const rendererRelativePath = brandBuildRelativePath(brand, "renderer");
  const distRoot = path.join(rootDir, rendererRelativePath, "desktop-pet");
  if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
    return [`${rendererRelativePath}/desktop-pet is missing for ${brand.id}`];
  }

  const problems = [];
  const sourceFiles = listRelativeFiles(sourceRoot);
  const distFiles = listRelativeFiles(distRoot);
  const sourceFileSet = new Set(sourceFiles);
  const distFileSet = new Set(distFiles);
  const missingFiles = sourceFiles.filter((fileName) => !distFileSet.has(fileName));
  const unexpectedFiles = distFiles.filter((fileName) => !sourceFileSet.has(fileName));

  if (missingFiles.length > 0) {
    problems.push(`${rendererRelativePath}/desktop-pet is missing ${missingFiles.join(", ")} from ${brand.source.desktopPetRoot}`);
  }
  if (unexpectedFiles.length > 0) {
    problems.push(`${rendererRelativePath}/desktop-pet has stale files for ${brand.id}: ${unexpectedFiles.join(", ")}`);
  }

  for (const fileName of sourceFiles) {
    if (!distFileSet.has(fileName)) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, fileName);
    const distPath = path.join(distRoot, fileName);
    if (!filesHaveSameBytes(sourcePath, distPath)) {
      problems.push(`${rendererRelativePath}/desktop-pet/${fileName} does not match ${brand.source.desktopPetRoot}/${fileName}`);
    }
  }

  return problems;
}

function distRendererProblems(rootDir, brand) {
  const rendererRoot = brandRendererDir(rootDir, brand);
  const rendererRelativePath = brandBuildRelativePath(brand, "renderer");
  if (!fs.existsSync(rendererRoot)) {
    return [];
  }

  const problems = [];
  const distRendererIndexPath = path.join(rendererRoot, "index.html");
  const indexExistsProblems = assertFileExists(distRendererIndexPath, `${rendererRelativePath}/index.html`);
  problems.push(...indexExistsProblems);
  if (indexExistsProblems.length === 0) {
    problems.push(
      ...htmlBrandProblems(
        fs.readFileSync(distRendererIndexPath, "utf8"),
        `${rendererRelativePath}/index.html`,
        brand,
        rootDir
      )
    );
  }

  const distTrayIconSvgPath = path.join(rendererRoot, "tray-icon.svg");
  const generatedTrayIconSvgPath = path.join(brandRuntimeAssetDir(rootDir, brand), "tray-icon.svg");
  if (
    fs.existsSync(distTrayIconSvgPath) &&
    fs.existsSync(generatedTrayIconSvgPath) &&
    !filesHaveSameBytes(distTrayIconSvgPath, generatedTrayIconSvgPath)
  ) {
    problems.push(`${rendererRelativePath}/tray-icon.svg does not match ${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg")}`);
  }

  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    const generatedPath = path.join(brandRuntimeAssetDir(rootDir, brand), fileName);
    const distPath = path.join(rendererRoot, fileName);
    if (fs.existsSync(generatedPath) && fs.existsSync(distPath) && !filesHaveSameBytes(generatedPath, distPath)) {
      problems.push(`${rendererRelativePath}/${fileName} does not match ${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, fileName)}`);
    }
  }

  problems.push(...desktopPetDistProblems(rootDir, brand));

  return problems;
}

function brandRuntimeIconProblems(rootDir, brand) {
  const problems = [];
  const generatedAssetRoot = brandRuntimeAssetDir(rootDir, brand);
  const generatedTrayIconSvgPath = path.join(generatedAssetRoot, "tray-icon.svg");
  const brandTrayIconSvgPath = path.join(rootDir, brand.icons.trayIconSvg);

  problems.push(
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "brand-icon.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png")
    ),
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "brand-mark.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png")
    ),
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "tray-icon.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png")
    ),
    ...assertFileExists(generatedTrayIconSvgPath, brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg"))
  );

  if (fs.existsSync(generatedTrayIconSvgPath)) {
    const generatedTrayIconSvg = fs.readFileSync(generatedTrayIconSvgPath, "utf8");
    const brandTrayIconSvg = fs.readFileSync(brandTrayIconSvgPath, "utf8");
    if (generatedTrayIconSvg !== brandTrayIconSvg) {
      problems.push(`${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg")} does not match ${brand.icons.trayIconSvg}`);
    }
  }

  return problems;
}

function stalePublicBrandIconProblems(rootDir) {
  return BRAND_RUNTIME_ASSET_FILENAMES
    .map((fileName) => path.join(rootDir, "public", fileName))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => `${path.relative(rootDir, filePath)} is stale; active brand icons live under ${BRAND_BUILD_ROOT_DIR}/<brand>/${BRAND_RUNTIME_ASSET_DIR_NAME}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(manifest, key) {
  const value = manifest[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireDesktopPetString(manifest, key, manifestPath) {
  const value = manifest[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Desktop pet manifest field "${key}" must be a non-empty string: ${manifestPath}`);
  }
  return value.trim();
}

function requireNestedString(manifest, group, key) {
  const value = manifest[group]?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${group}.${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNestedString(manifest, group, key) {
  const value = manifest[group]?.[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Brand manifest field "${group}.${key}" must be a non-empty string when provided.`);
  }
  return value.trim();
}

function defaultMacUsageDescriptions(productName) {
  return {
    microphoneUsageDescription: `${productName} 使用麦克风将你的语音输入转成文字。`,
    speechRecognitionUsageDescription: `${productName} 使用系统语音识别将你的语音输入转成文字。`
  };
}

function normalizeManifest(rootDir, brandRoot, manifest, i18n, icons, desktopPet) {
  const id = requireString(manifest, "id").toLowerCase();
  if (!BRAND_ID_PATTERN.test(id)) {
    throw new Error(`Brand manifest field "id" is invalid: ${id}`);
  }
  if (id !== path.basename(brandRoot)) {
    throw new Error(`Brand manifest id "${id}" must match directory "${path.basename(brandRoot)}".`);
  }

  const packageName = requireString(manifest, "packageName");
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`Brand packageName is invalid: ${packageName}`);
  }
  const storageNamespace = requireString(manifest, "storageNamespace");
  if (!PACKAGE_NAME_PATTERN.test(storageNamespace)) {
    throw new Error(`Brand storageNamespace is invalid: ${storageNamespace}`);
  }

  const appId = requireString(manifest, "appId");
  if (!APP_ID_PATTERN.test(appId) || !appId.includes(".")) {
    throw new Error(`Brand appId is invalid: ${appId}`);
  }

  const productName = requireString(manifest, "productName");
  const description = requireString(manifest, "description");
  const runtimeRootDirName = `.${id}`;
  const configuredRuntimeRootDirName = optionalNestedString(manifest, "paths", "runtimeRootDirName");
  if (configuredRuntimeRootDirName && configuredRuntimeRootDirName !== runtimeRootDirName) {
    throw new Error(
      `Brand manifest field "paths.runtimeRootDirName" must be "${runtimeRootDirName}" when provided.`
    );
  }
  const desktopDataSubdir = requireNestedString(manifest, "paths", "desktopDataSubdir");
  const programDataDirName = requireNestedString(manifest, "paths", "programDataDirName");
  const defaultMac = defaultMacUsageDescriptions(productName);
  const microphoneUsageDescription =
    optionalNestedString(manifest, "mac", "microphoneUsageDescription") ?? defaultMac.microphoneUsageDescription;
  const speechRecognitionUsageDescription =
    optionalNestedString(manifest, "mac", "speechRecognitionUsageDescription") ??
    defaultMac.speechRecognitionUsageDescription;

  return {
    id,
    packageName,
    storageNamespace,
    productName,
    appId,
    description,
    paths: {
      runtimeRootDirName,
      desktopDataSubdir,
      programDataDirName
    },
    mac: {
      microphoneUsageDescription,
      speechRecognitionUsageDescription
    },
    icons,
    installer: {
      shutdownArg: INSTALLER_SHUTDOWN_ARG
    },
    desktopPet: desktopPet.manifest,
    i18n,
    source: {
      brandRoot: path.relative(rootDir, brandRoot).replace(/\\/gu, "/"),
      desktopPetRoot: path.relative(rootDir, desktopPet.root).replace(/\\/gu, "/")
    }
  };
}

function normalizeDesktopPetAssetPath(value, field, manifestPath) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Desktop pet manifest field "${field}" must be a non-empty asset path: ${manifestPath}`);
  }
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\/+/u, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error(`Desktop pet manifest field "${field}" must be a safe relative asset path: ${manifestPath}`);
  }
  return parts.join("/");
}

function assertDesktopPetAssetExists(root, relativePath, manifestPath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Desktop pet asset not found for "${relativePath}": ${manifestPath}`);
  }
}

function normalizePositiveInteger(value, field, manifestPath) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || Math.round(numeric) !== numeric) {
    throw new Error(`Desktop pet manifest field "${field}" must be a positive integer: ${manifestPath}`);
  }
  return numeric;
}

function normalizeNonNegativeInteger(value, field, manifestPath) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || Math.round(numeric) !== numeric) {
    throw new Error(`Desktop pet manifest field "${field}" must be a non-negative integer: ${manifestPath}`);
  }
  return numeric;
}

function normalizeDesktopPetSignatureActions(value, root, manifestPath, field, optional = false) {
  if (value === undefined && optional) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Desktop pet manifest field "${field}" must be an array: ${manifestPath}`);
  }
  return value.map((action, actionIndex) => {
    const actionField = `${field}[${actionIndex}]`;
    if (!isRecord(action)) {
      throw new Error(`Desktop pet manifest field "${actionField}" must be an object: ${manifestPath}`);
    }
    const id = requireDesktopPetString(action, "id", manifestPath);
    if (!DESKTOP_PET_SIGNATURE_ID_PATTERN.test(id)) {
      throw new Error(`Desktop pet manifest field "${actionField}.id" is invalid: ${manifestPath}`);
    }
    const label = requireDesktopPetString(action, "label", manifestPath);
    if (!Array.isArray(action.trigger) || action.trigger.length === 0) {
      throw new Error(`Desktop pet manifest field "${actionField}.trigger" must be a non-empty array: ${manifestPath}`);
    }
    const trigger = action.trigger.map((triggerValue, triggerIndex) => {
      if (!DESKTOP_PET_ACTION_TRIGGER_VALUES.has(triggerValue)) {
        throw new Error(`Desktop pet manifest field "${actionField}.trigger[${triggerIndex}]" is invalid: ${manifestPath}`);
      }
      return triggerValue;
    });
    if (!Array.isArray(action.variants) || action.variants.length === 0) {
      throw new Error(`Desktop pet manifest field "${actionField}.variants" must be a non-empty array: ${manifestPath}`);
    }
    const variants = action.variants.map((variant, variantIndex) => {
      const variantField = `${actionField}.variants[${variantIndex}]`;
      if (!isRecord(variant)) {
        throw new Error(`Desktop pet manifest field "${variantField}" must be an object: ${manifestPath}`);
      }
      const assetPath = normalizeDesktopPetAssetPath(variant.path, `${variantField}.path`, manifestPath);
      assertDesktopPetAssetExists(root, assetPath, manifestPath);
      return {
        path: assetPath,
        frameCount: normalizePositiveInteger(variant.frameCount, `${variantField}.frameCount`, manifestPath),
        durationMs: normalizePositiveInteger(variant.durationMs, `${variantField}.durationMs`, manifestPath),
        ...(variant.weight === undefined
          ? {}
          : { weight: normalizePositiveInteger(variant.weight, `${variantField}.weight`, manifestPath) })
      };
    });
    return {
      id,
      label,
      trigger: [...new Set(trigger)],
      variants
    };
  });
}

function normalizeDesktopPetStateAsset(value, root, manifestPath, stateKey) {
  if (!isRecord(value)) {
    throw new Error(`Desktop pet manifest field "states.${stateKey}" must be an object: ${manifestPath}`);
  }
  const assetPath = normalizeDesktopPetAssetPath(value.path, `states.${stateKey}.path`, manifestPath);
  assertDesktopPetAssetExists(root, assetPath, manifestPath);
  const frameCount = normalizePositiveInteger(value.frameCount, `states.${stateKey}.frameCount`, manifestPath);
  if (
    frameCount < DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES ||
    frameCount > DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES
  ) {
    throw new Error(
      `Desktop pet manifest field "states.${stateKey}.frameCount" must be between ${DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES} and ${DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES}: ${manifestPath}`
    );
  }
  return {
    path: assetPath,
    frameCount,
    durationMs: normalizePositiveInteger(value.durationMs, `states.${stateKey}.durationMs`, manifestPath),
    ...(typeof value.loop === "boolean" ? { loop: value.loop } : {}),
    ...(typeof value.mirror === "boolean" ? { mirror: value.mirror } : {}),
    ...(value.holdMs === undefined
      ? {}
      : { holdMs: normalizeNonNegativeInteger(value.holdMs, `states.${stateKey}.holdMs`, manifestPath) }),
    ...(value.alts === undefined
      ? {}
      : { alts: normalizeDesktopPetSignatureActions(value.alts, root, manifestPath, `states.${stateKey}.alts`) })
  };
}

function loadBrandDesktopPet(rootDir, brandRoot) {
  const desktopPetRoot = path.join(brandRoot, "desktop-pet");
  const manifestPath = path.join(desktopPetRoot, "pet.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Brand desktop pet manifest not found: ${path.relative(rootDir, manifestPath)}`);
  }
  const manifest = readJson(manifestPath);
  if (!isRecord(manifest)) {
    throw new Error(`Brand desktop pet manifest must contain an object: ${path.relative(rootDir, manifestPath)}`);
  }
  const id = requireDesktopPetString(manifest, "id", manifestPath);
  if (!DESKTOP_PET_ID_PATTERN.test(id)) {
    throw new Error(`Desktop pet manifest field "id" is invalid: ${manifestPath}`);
  }
  const displayName = requireDesktopPetString(manifest, "displayName", manifestPath);
  const description = requireDesktopPetString(manifest, "description", manifestPath);
  const preview = normalizeDesktopPetAssetPath(manifest.preview, "preview", manifestPath);
  assertDesktopPetAssetExists(desktopPetRoot, preview, manifestPath);
  if (!isRecord(manifest.states)) {
    throw new Error(`Desktop pet manifest field "states" must be an object: ${manifestPath}`);
  }
  const unexpectedStateKeys = Object.keys(manifest.states).filter((key) => !DESKTOP_PET_REQUIRED_STATE_KEYS.includes(key));
  if (unexpectedStateKeys.length > 0) {
    throw new Error(`Desktop pet manifest contains unsupported state keys ${unexpectedStateKeys.join(", ")}: ${manifestPath}`);
  }
  const states = {};
  for (const stateKey of DESKTOP_PET_REQUIRED_STATE_KEYS) {
    states[stateKey] = normalizeDesktopPetStateAsset(manifest.states[stateKey], desktopPetRoot, manifestPath, stateKey);
  }
  const signature = normalizeDesktopPetSignatureActions(
    manifest.signature,
    desktopPetRoot,
    manifestPath,
    "signature",
    true
  );
  return {
    root: desktopPetRoot,
    manifest: {
      id,
      displayName,
      description,
      preview,
      states,
      ...(signature ? { signature } : {})
    }
  };
}

function loadBrandI18n(rootDir, brandRoot, manifest) {
  const value = manifest.i18n;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Brand manifest field \"i18n\" must map locales to JSON files.");
  }

  const result = {};
  for (const locale of SUPPORTED_LOCALES) {
    const relativePath = value[locale];
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error(`Brand manifest field "i18n.${locale}" must be a JSON file path.`);
    }
    const filePath = path.join(brandRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Brand i18n file not found: ${path.relative(rootDir, filePath)}`);
    }
    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Brand i18n file must contain an object: ${path.relative(rootDir, filePath)}`);
    }
    result[locale] = parsed;
  }
  return result;
}

function validateBrandIcons(rootDir, brandRoot) {
  const iconsRoot = path.join(brandRoot, "icons");
  if (!fs.existsSync(iconsRoot) || !fs.statSync(iconsRoot).isDirectory()) {
    throw new Error(`Brand icons directory not found: ${path.relative(rootDir, iconsRoot)}`);
  }

  for (const fileName of REQUIRED_ICON_FILES) {
    const filePath = path.join(iconsRoot, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Brand icon file not found: ${path.relative(rootDir, filePath)}`);
    }
  }

  return {
    appIconSvg: path.relative(rootDir, path.join(iconsRoot, "app-icon.svg")).replace(/\\/gu, "/"),
    trayIconSvg: path.relative(rootDir, path.join(iconsRoot, "tray-icon.svg")).replace(/\\/gu, "/")
  };
}

export function runtimeBrandPayload(brand) {
  return {
    id: brand.id,
    packageName: brand.packageName,
    storageNamespace: brand.storageNamespace,
    productName: brand.productName,
    appId: brand.appId,
    description: brand.description,
    paths: brand.paths,
    installer: brand.installer,
    desktopPet: brand.desktopPet,
    i18n: brand.i18n
  };
}

function containsPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function copyBrandDesktopPetAssets({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  outputDir
} = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("copyBrandDesktopPetAssets requires outputDir");
  }

  const sourceRoot = path.resolve(rootDir, brand.source.desktopPetRoot);
  const targetRoot = path.resolve(outputDir);
  if (containsPath(sourceRoot, targetRoot) || containsPath(targetRoot, sourceRoot)) {
    throw new Error(
      `Refusing to copy desktop pet assets between overlapping paths: ${sourceRoot} -> ${targetRoot}`
    );
  }

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    force: true
  });
  return targetRoot;
}

export function cleanupPublicBrandIconArtifacts(rootDir = process.cwd()) {
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    fs.rmSync(path.join(rootDir, "public", fileName), { force: true });
  }
}

export function copyBrandRuntimeIconAssets({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  outputDir
} = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("copyBrandRuntimeIconAssets requires outputDir");
  }

  const sourceRoot = path.resolve(brandRuntimeAssetDir(rootDir, brand));
  const targetRoot = path.resolve(outputDir);
  if (containsPath(sourceRoot, targetRoot) || containsPath(targetRoot, sourceRoot)) {
    throw new Error(
      `Refusing to copy brand runtime icon assets between overlapping paths: ${sourceRoot} -> ${targetRoot}`
    );
  }

  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    const sourcePath = path.join(sourceRoot, fileName);
    const targetPath = path.join(targetRoot, fileName);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Missing generated brand runtime asset: ${path.relative(rootDir, sourcePath)}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return targetRoot;
}

function writeGeneratedBrandFiles(rootDir, brand) {
  const payload = runtimeBrandPayload(brand);
  const generatedRoot = brandGeneratedDir(rootDir, brand);
  writeJson(path.join(generatedRoot, "brand.json"), payload);
  writeFileIfChanged(
    path.join(generatedRoot, "brand.ts"),
    [
      `export const APP_BRAND = ${JSON.stringify(payload, null, 2)} as const;`,
      "",
      "export const BRAND_ID = APP_BRAND.id;",
      "export const PACKAGE_NAME = APP_BRAND.packageName;",
      "export const STORAGE_NAMESPACE = APP_BRAND.storageNamespace;",
      "export const PRODUCT_NAME = APP_BRAND.productName;",
      "export const APP_ID = APP_BRAND.appId;",
      "export const APP_DESCRIPTION = APP_BRAND.description;",
      "export const INSTALLER_SHUTDOWN_ARG = APP_BRAND.installer.shutdownArg;",
      ""
    ].join("\n")
  );
}

function rendererPetProtocol(brand) {
  return `${brand.id}-pet`;
}

function rendererWebsiteFaviconProtocol(brand) {
  return `${brand.id}-website-favicon`;
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function defaultRendererIndexHtml(brand) {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "  <head>",
    "    <meta charset=\"UTF-8\" />",
    "    <meta",
    "      http-equiv=\"Content-Security-Policy\"",
    `      content="default-src 'self'; img-src 'self' data: ${rendererPetProtocol(brand)}: ${rendererWebsiteFaviconProtocol(brand)}:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; frame-src 'self' http://127.0.0.1:*;"`,
    "    />",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    `    <title>${escapeHtmlText(brand.productName)}</title>`,
    "  </head>",
    "  <body>",
    "    <div id=\"root\"></div>",
    "    <script type=\"module\" src=\"/src/renderer/main.tsx\"></script>",
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

export function renderRendererIndexHtml(content, brand) {
  const petProtocol = `${rendererPetProtocol(brand)}:`;
  const websiteFaviconProtocol = `${rendererWebsiteFaviconProtocol(brand)}:`;
  let next = content.replace(/<title>[\s\S]*?<\/title>/u, () =>
    `<title>${escapeHtmlText(brand.productName)}</title>`
  );

  next = next.replace(/(img-src\s+)([^";]*)(;)/u, (_match, prefix, sources, suffix) => {
    const sourceList = String(sources)
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .filter((source) => !/^[a-z0-9][a-z0-9_-]*-(?:pet|website-favicon):$/iu.test(source));
    sourceList.push(petProtocol);
    sourceList.push(websiteFaviconProtocol);
    return `${prefix}${sourceList.join(" ")}${suffix}`;
  });

  return next;
}

function electronBuilderConfig(brand, target = currentBrandBuildTarget()) {
  return {
    appId: brand.appId,
    productName: brand.productName,
    directories: {
      app: brandBuildRelativePath(brand, "app", brandBuildTargetKey(target)),
      output: path.posix.join("dist", brand.id)
    },
    files: [
      "dist-renderer/**/*",
      "dist-electron/**/*",
      "package.json",
      "node_modules/**/*",
      "!node_modules/@napi-rs/canvas-linux-*",
      "!node_modules/@napi-rs/canvas-linux-*/**/*",
      "!node_modules/**/*.d.ts",
      "!node_modules/**/*.map"
    ],
    asarUnpack: [
      "node_modules/@napi-rs/canvas-*/**/*"
    ],
    npmRebuild: false,
    extraResources: [
      {
        from: desktopBuiltinServicesRelativePath(),
        to: "services"
      },
      {
        from: brandBuildRelativePath(brand, "resources", "env"),
        to: "env"
      },
      {
        from: brandBuildRelativePath(brand, "resources", "demo"),
        to: "demo"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png"),
        to: "brand-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png"),
        to: "brand-mark.png"
      },
      {
        from: brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png"),
        to: "tray-icon.png"
      },
      {
        from: brandBuildRelativePath(brand, "installer", "uninstall.sh"),
        to: "uninstall.sh"
      }
    ],
    mac: {
      icon: brandBuildRelativePath(brand, "icons", "icon.icns"),
      extendInfo: {
        NSMicrophoneUsageDescription: brand.mac.microphoneUsageDescription,
        NSSpeechRecognitionUsageDescription: brand.mac.speechRecognitionUsageDescription
      },
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      notarize: false,
      timestamp: shouldSkipMacTimestamp() ? "none" : undefined
    },
    electronLanguages: ["zh-CN", "en-US"],
    afterPack: "./scripts/fix-mac-sign.js",
    afterSign: "./scripts/verify-mac-services-signing.js",
    win: {
      icon: brandBuildRelativePath(brand, "icons", "icon.ico"),
      target: ["nsis"]
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      include: brandBuildRelativePath(brand, "installer", "installer.nsh")
    }
  };
}

function writeElectronBuilderConfig(rootDir, brand, target) {
  writeJson(electronBuilderConfigPath(rootDir, brand.id), electronBuilderConfig(brand, target));
}

function escapeNsisText(value) {
  return String(value).replace(/\$/gu, "$$").replace(/"/gu, "$\\\"");
}

function nsisIdentifier(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_]/gu, "");
  return normalized || "Desktop";
}

function writeInstallerInclude(rootDir, brand) {
  const productName = escapeNsisText(brand.productName);
  const dataRegistryKey = `Software\\${brand.storageNamespace}`;
  const nsisPrefix = nsisIdentifier(brand.productName);
  const shutdownArg = brand.installer.shutdownArg;
  const programDataDirName = escapeNsisText(brand.paths.programDataDirName);
  const content = `!include nsDialogs.nsh

Var /GLOBAL DesktopDataRoot
!ifndef BUILD_UNINSTALLER
Var /GLOBAL DesktopDataRootInput
Var /GLOBAL DesktopDataRootBrowseButton
!endif

!ifndef BUILD_UNINSTALLER
Function ${nsisPrefix}EnsureDataRootDefault
  \${if} $DesktopDataRoot == ""
    ReadRegStr $DesktopDataRoot HKCU "${dataRegistryKey}" "DataRoot"
  \${endif}
  \${if} $DesktopDataRoot == ""
    StrCpy $DesktopDataRoot "$PROFILE\\${brand.paths.runtimeRootDirName}"
  \${endif}
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
Function un.${nsisPrefix}EnsureDataRootDefault
  \${if} $DesktopDataRoot == ""
    ReadRegStr $DesktopDataRoot HKCU "${dataRegistryKey}" "DataRoot"
  \${endif}
  \${if} $DesktopDataRoot == ""
    StrCpy $DesktopDataRoot "$PROFILE\\${brand.paths.runtimeRootDirName}"
  \${endif}
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
Function ${nsisPrefix}BrowseDataDirectory
  \${NSD_GetText} $DesktopDataRootInput $DesktopDataRoot
  nsDialogs::SelectFolderDialog "Select ${productName} data directory" "$DesktopDataRoot"
  Pop $0
  \${if} $0 != "error"
    StrCpy $DesktopDataRoot "$0"
    \${NSD_SetText} $DesktopDataRootInput "$DesktopDataRoot"
  \${endif}
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
Function ${nsisPrefix}DataDirectoryPage
  \${if} \${Silent}
    Abort
  \${endif}
  Call ${nsisPrefix}EnsureDataRootDefault
  nsDialogs::Create 1018
  Pop $0
  \${if} $0 == "error"
    Abort
  \${endif}
  \${NSD_CreateLabel} 0 0 100% 24u "Choose where ${productName} should store desktop data, service config, credentials, logs, caches, and browser profiles."
  Pop $0
  \${NSD_CreateDirRequest} 0 35u 74% 12u "$DesktopDataRoot"
  Pop $DesktopDataRootInput
  \${NSD_CreateBrowseButton} 78% 34u 22% 14u "Browse..."
  Pop $DesktopDataRootBrowseButton
  \${NSD_OnClick} $DesktopDataRootBrowseButton ${nsisPrefix}BrowseDataDirectory
  nsDialogs::Show
FunctionEnd

Function ${nsisPrefix}DataDirectoryPageLeave
  \${NSD_GetText} $DesktopDataRootInput $DesktopDataRoot
  \${if} $DesktopDataRoot == ""
    MessageBox MB_ICONEXCLAMATION "Please choose a ${productName} data directory."
    Abort
  \${endif}
  IfFileExists "$DesktopDataRoot\\*" ${nsisPrefix}DataDirectoryReady 0
  ClearErrors
  CreateDirectory "$DesktopDataRoot"
  IfErrors ${nsisPrefix}DataDirectoryCreateFailed ${nsisPrefix}DataDirectoryReady
${nsisPrefix}DataDirectoryCreateFailed:
  MessageBox MB_ICONEXCLAMATION "The selected ${productName} data directory could not be created. Please choose another directory."
  Abort
${nsisPrefix}DataDirectoryReady:
FunctionEnd
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom ${nsisPrefix}DataDirectoryPage ${nsisPrefix}DataDirectoryPageLeave
!macroend
!endif

!macro stopManagedServiceProcesses
  DetailPrint "Stopping ${productName} managed service processes..."
  nsExec::ExecToLog \`%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; function Stop-DesktopManagedProcesses { $$programRoot = [Environment]::ExpandEnvironmentVariables('$APPDATA\\${programDataDirName}'); if (Test-Path -LiteralPath $$programRoot) { $$normalizedRoot = [System.IO.Path]::GetFullPath($$programRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar); Get-CimInstance Win32_Process | Where-Object { $$path = [string]$$_.ExecutablePath; $$line = [string]$$_.CommandLine; ($$path -and $$path.StartsWith($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($$line -and $$line.IndexOf($$normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } } }; Stop-DesktopManagedProcesses"\`
  Pop $R2
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.${nsisPrefix}EnsureDataRootDefault
  !else
    Call ${nsisPrefix}EnsureDataRootDefault
  !endif
  !insertmacro FIND_PROCESS "\${APP_EXECUTABLE_FILENAME}" $R0
  \${if} $R0 == 0
    DetailPrint "Requesting ${productName} to exit before installing..."
    \${if} \${FileExists} "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"
      nsExec::ExecToLog \`"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${shutdownArg}\`
      Pop $R2
      Sleep 500
    \${endif}

    StrCpy $R1 0
    waitAppExit:
      !insertmacro FIND_PROCESS "\${APP_EXECUTABLE_FILENAME}" $R0
      \${if} $R0 != 0
        Goto appExited
      \${endif}
      IntOp $R1 $R1 + 1
      \${if} $R1 < 12
        Sleep 500
        Goto waitAppExit
      \${endif}

      DetailPrint "Force closing ${productName} before installing..."
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::ExecToLog \`taskkill /f /im "\${APP_EXECUTABLE_FILENAME}"\`
        Pop $R2
      !else
        nsExec::ExecToLog \`%SYSTEMROOT%\\System32\\cmd.exe /c taskkill /f /im "\${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"\`
        Pop $R2
      !endif

    appExited:
  \${endif}

  !insertmacro stopManagedServiceProcesses
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInstall
  Call ${nsisPrefix}EnsureDataRootDefault
  WriteRegStr HKCU "${dataRegistryKey}" "DataRoot" "$DesktopDataRoot"
!macroend
!endif

!macro customUnInstall
  SetOutPath $TEMP
  SetShellVarContext current
  ReadRegStr $DesktopDataRoot HKCU "${dataRegistryKey}" "DataRoot"
  \${if} $DesktopDataRoot == ""
    StrCpy $DesktopDataRoot "$PROFILE\\${brand.paths.runtimeRootDirName}"
  \${endif}
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete ${productName} app data?$\\r$\\n$\\r$\\nThis removes $DesktopDataRoot and $APPDATA\\${programDataDirName}, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles." /SD IDNO IDYES removeDesktopData IDNO doneDataCleanup

removeDesktopData:
  RMDir /r "$DesktopDataRoot"
  RMDir /r "$APPDATA\\${programDataDirName}"
  DeleteRegValue HKCU "${dataRegistryKey}" "DataRoot"
  DeleteRegKey /ifempty HKCU "${dataRegistryKey}"

doneDataCleanup:
!macroend
`;
  writeFileIfChanged(path.join(brandInstallerDir(rootDir, brand), "installer.nsh"), content);
}

function shellDoubleQuoted(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

function writeMacUninstallScript(rootDir, brand) {
  const appName = shellDoubleQuoted(brand.productName);
  const runtimeRootDirName = shellDoubleQuoted(brand.paths.runtimeRootDirName);
  const desktopDataSubdir = shellDoubleQuoted(brand.paths.desktopDataSubdir);
  const programDataDirName = shellDoubleQuoted(brand.paths.programDataDirName);
  const content = `#!/bin/bash

set -euo pipefail

APP_NAME="${appName}"
APP_PATH="/Applications/\${APP_NAME}.app"
DATA_PATH="\${HOME}/${runtimeRootDirName}/${desktopDataSubdir}"
PROGRAM_DATA_PATH="\${HOME}/Library/Application Support/${programDataDirName}"

show_dialog() {
  local message="$1"

  osascript -e "display dialog \\"$message\\" buttons {\\"OK\\"} default button \\"OK\\" with icon caution" >/dev/null
}

is_app_running() {
  osascript -e "tell application \\"System Events\\" to return (name of processes) contains \\"$APP_NAME\\""
}

remove_application_bundle() {
  if [ ! -d "$APP_PATH" ]; then
    printf '%s\\n' "Application bundle not found at $APP_PATH. Skipping app removal."
    return 0
  fi

  local escaped_app_path
  escaped_app_path=\${APP_PATH//\\"/\\\\\\"}
  osascript -e "do shell script \\"rm -rf \\\\\\"$escaped_app_path\\\\\\"\\" with administrator privileges" >/dev/null
  printf '%s\\n' "Removed application bundle: $APP_PATH"
}

prompt_for_data_cleanup() {
  osascript -e "button returned of (display dialog \\"Do you also want to delete $APP_NAME app data?\\n\\nThis removes $DATA_PATH and $PROGRAM_DATA_PATH, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles.\\" buttons {\\"Keep Data\\", \\"Delete Data\\"} default button \\"Keep Data\\" with icon caution)"
}

if [ "$(is_app_running)" = "true" ]; then
  show_dialog "$APP_NAME is still running. Quit the app and run this uninstall script again."
  printf '%s\\n' "$APP_NAME is still running. Quit it and rerun this script."
  exit 1
fi

remove_application_bundle

if [ "$(prompt_for_data_cleanup)" = "Delete Data" ]; then
  rm -rf "$DATA_PATH"
  rm -rf "$PROGRAM_DATA_PATH"
  printf '%s\\n' "Removed app data: $DATA_PATH"
  printf '%s\\n' "Removed program data: $PROGRAM_DATA_PATH"
else
  printf '%s\\n' "Kept app data: $DATA_PATH"
  printf '%s\\n' "Kept program data: $PROGRAM_DATA_PATH"
fi

printf '%s\\n' "$APP_NAME uninstall finished."
`;
  const scriptPath = path.join(brandInstallerDir(rootDir, brand), "uninstall.sh");
  writeFileIfChanged(scriptPath, content);
  fs.chmodSync(scriptPath, 0o755);
}
