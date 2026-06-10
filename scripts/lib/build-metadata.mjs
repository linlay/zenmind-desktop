import fs from "node:fs";
import path from "node:path";

export function normalizeDesktopVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/iu, "");
  return version ? `v${version}` : "";
}

export function formatUtcBuildTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function normalizeExplicitBuildTime(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? formatUtcBuildTime(new Date(timestamp)) : trimmed;
}

function buildTimeFromSourceDateEpoch(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) {
    return "";
  }
  return formatUtcBuildTime(new Date(seconds * 1000));
}

export function resolveDesktopBuildTime(env = process.env, now = () => new Date()) {
  return (
    normalizeExplicitBuildTime(env.DESKTOP_BUILD_TIME) ||
    normalizeExplicitBuildTime(env.BUILD_TIME) ||
    buildTimeFromSourceDateEpoch(env.SOURCE_DATE_EPOCH) ||
    formatUtcBuildTime(now())
  );
}

export function readDesktopVersion(rootDir = process.cwd()) {
  const versionFile = path.join(rootDir, "VERSION");
  if (fs.existsSync(versionFile)) {
    const version = fs.readFileSync(versionFile, "utf8").trim();
    if (!version) {
      throw new Error(`empty VERSION file: ${versionFile}`);
    }
    return normalizeDesktopVersion(version);
  }

  const packagePath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return normalizeDesktopVersion(packageJson.version);
}

export function createDesktopBuildMetadata({
  productName,
  version,
  env = process.env,
  now = () => new Date()
}) {
  return {
    productName,
    version: normalizeDesktopVersion(version),
    buildTime: resolveDesktopBuildTime(env, now)
  };
}
