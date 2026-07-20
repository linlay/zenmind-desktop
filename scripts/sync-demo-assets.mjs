import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { brandResourcesDir, resolveBrandId } from "./lib/brand-config.mjs";

const projectRoot = process.cwd();

export const DEMO_ENV_VAR = "DEMO";
export const WEBAPP_BUILDER_SKILL_DIR_ENV_VAR = "WEBAPP_BUILDER_SKILL_DIR";
export const BUNDLED_DEMO_MANIFEST_FILE_NAME = "manifest.json";
export const BUNDLED_DEMO_WEBAPP_TEMPLATES_DIR_NAME = "webapp-templates";
export const BUNDLED_DEMO_WEBAPP_ID = "demo-node-html";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

function bundledDemoRoot(rootDir, env = process.env) {
  return path.join(brandResourcesDir(rootDir, resolveBrandId([], env)), "demo");
}

function webappDemoSourceDir(env = process.env) {
  const skillDir = String(env[WEBAPP_BUILDER_SKILL_DIR_ENV_VAR] ?? "").trim();
  if (!skillDir) {
    throw new Error(
      `${DEMO_ENV_VAR}=true requires ${WEBAPP_BUILDER_SKILL_DIR_ENV_VAR} to point to the webapp-builder skill`
    );
  }
  return path.join(path.resolve(skillDir), "assets", BUNDLED_DEMO_WEBAPP_ID);
}

function assertWebappDemoSource(sourceDir) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`missing webapp-builder demo asset: ${sourceDir}`);
  }
  const manifestPath = path.join(sourceDir, "webapp.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.id !== BUNDLED_DEMO_WEBAPP_ID) {
      throw new Error(`expected id ${BUNDLED_DEMO_WEBAPP_ID}`);
    }
  } catch (error) {
    throw new Error(
      `invalid webapp-builder demo manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeManifest(demoRoot, manifest) {
  fs.writeFileSync(
    path.join(demoRoot, BUNDLED_DEMO_MANIFEST_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export function parseDemoFlag(env = process.env) {
  const rawValue = String(env[DEMO_ENV_VAR] ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(rawValue)) {
    return true;
  }
  if (FALSE_VALUES.has(rawValue)) {
    return false;
  }
  throw new Error(`${DEMO_ENV_VAR} must be one of: 1, true, yes, on, 0, false, no, off.`);
}

function listWebappTemplateIds(templateRoot) {
  if (!fs.existsSync(templateRoot) || !fs.statSync(templateRoot).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function prepareBundledDemoAssets({
  rootDir = projectRoot,
  env = process.env,
  logger = console
} = {}) {
  const includeDemo = parseDemoFlag(env);
  const demoRoot = bundledDemoRoot(rootDir, env);

  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(demoRoot, { recursive: true });

  if (!includeDemo) {
    const manifest = {
      schemaVersion: 1,
      bundled: false,
      webappTemplates: []
    };
    writeManifest(demoRoot, manifest);
    logger.log(`no ${DEMO_ENV_VAR} requested; packaged app will not include demo assets`);
    return {
      ...manifest,
      outputPath: null
    };
  }

  const sourceDir = webappDemoSourceDir(env);
  assertWebappDemoSource(sourceDir);

  const targetRoot = path.join(demoRoot, BUNDLED_DEMO_WEBAPP_TEMPLATES_DIR_NAME);
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceDir, path.join(targetRoot, BUNDLED_DEMO_WEBAPP_ID), {
    recursive: true,
    force: true
  });

  const webappTemplates = listWebappTemplateIds(targetRoot);
  const manifest = {
    schemaVersion: 1,
    bundled: true,
    webappTemplates
  };
  writeManifest(demoRoot, manifest);
  logger.log(`bundled ${DEMO_ENV_VAR} demo assets into ${path.relative(rootDir, demoRoot)}`);
  return {
    ...manifest,
    outputPath: demoRoot
  };
}

async function main() {
  await prepareBundledDemoAssets();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
