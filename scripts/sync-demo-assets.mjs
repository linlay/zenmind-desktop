import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

export const DEMO_ENV_VAR = "DEMO";
export const BUNDLED_DEMO_MANIFEST_FILE_NAME = "manifest.json";
export const BUNDLED_DEMO_WEBAPP_TEMPLATES_DIR_NAME = "webapp-templates";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

function bundledDemoRoot(rootDir) {
  return path.join(rootDir, "build", "resources", "demo");
}

function webappTemplatesSourceRoot(rootDir) {
  return path.join(rootDir, "public", BUNDLED_DEMO_WEBAPP_TEMPLATES_DIR_NAME);
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
  const demoRoot = bundledDemoRoot(rootDir);

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

  const sourceRoot = webappTemplatesSourceRoot(rootDir);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`missing webapp demo templates: ${sourceRoot}`);
  }

  const targetRoot = path.join(demoRoot, BUNDLED_DEMO_WEBAPP_TEMPLATES_DIR_NAME);
  fs.cpSync(sourceRoot, targetRoot, {
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
