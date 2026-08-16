import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BRAND_ID = "zenmind";
export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en-US"]);
export const DARWIN_BUNDLE_DEVELOPMENT_REGION = "zh-Hans";
export const DARWIN_BUNDLE_LOCALIZATIONS = Object.freeze(["zh-Hans", "en"]);
export const INSTALLER_SHUTDOWN_ARG = "--desktop-shutdown-for-update";
export const DESKTOP_PACKAGE_NAME = "desktop";

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const BRAND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]+$/u;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/u;
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

export function normalizeBrandId(value) {
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
  const openProtocolSchemeValue = manifest.protocols?.open?.scheme;
  if (typeof openProtocolSchemeValue !== "string" || !openProtocolSchemeValue.trim()) {
    throw new Error('Brand manifest field "protocols.open.scheme" must be a non-empty string.');
  }
  const openProtocolScheme = openProtocolSchemeValue.trim();
  if (!URI_SCHEME_PATTERN.test(openProtocolScheme)) {
    throw new Error(`Brand manifest field "protocols.open.scheme" is invalid: ${openProtocolScheme}`);
  }
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
    protocols: {
      open: {
        scheme: openProtocolScheme
      }
    },
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
    protocols: brand.protocols,
    paths: brand.paths,
    installer: brand.installer,
    desktopPet: brand.desktopPet,
    i18n: brand.i18n
  };
}
