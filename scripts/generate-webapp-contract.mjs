import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "src", "shared", "webapp-manifest.ts");
const contractRoot = path.join(repoRoot, "contracts", "webapp");
const validatorName = "webapp-manifest-validator.mjs";
const schemaName = "webapp.schema.json";
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const skillRootIndex = args.indexOf("--skill-root");
const skillRoot = skillRootIndex >= 0 && args[skillRootIndex + 1]
  ? path.resolve(args[skillRootIndex + 1])
  : "";

function assertSameFile(expectedPath, generatedPath) {
  if (!fs.existsSync(expectedPath) || !fs.readFileSync(expectedPath).equals(fs.readFileSync(generatedPath))) {
    throw new Error(`generated WebApp contract is stale: ${path.relative(repoRoot, expectedPath)}`);
  }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-contract-"));
try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: temporaryRoot,
      lib: {
        entry,
        formats: ["es"],
        fileName: () => validatorName
      },
      rollupOptions: {
        output: { generatedCode: "es2015" }
      }
    }
  });
  const generatedValidator = path.join(temporaryRoot, validatorName);
  const normalizedValidator = fs.readFileSync(generatedValidator, "utf8")
    .replace(/[ \t]+$/gmu, "");
  fs.writeFileSync(generatedValidator, normalizedValidator, "utf8");
  const contract = await import(`${pathToFileURL(generatedValidator).href}?v=${Date.now()}`);
  const schema = contract.createWebappManifestJsonSchema();
  schema.title = "Desktop WebApp Manifest v2";
  schema.description = "Desktop's authoritative host contract. Business configuration belongs in appConfig; editable user values are stored outside the package.";
  schema["x-desktop-manifestMaxBytes"] = contract.WEBAPP_MANIFEST_MAX_BYTES;
  if (schema.properties?.appConfig) {
    schema.properties.appConfig["x-desktop-maxBytes"] = contract.WEBAPP_APP_CONFIG_MAX_BYTES;
    schema.properties.appConfig.description =
      "Arbitrary JSON business configuration owned by the WebApp. Secrets are forbidden.";
  }
  if (schema.properties?.userConfig) {
    schema.properties.userConfig["x-desktop-maxBytes"] = contract.WEBAPP_USER_CONFIG_MAX_BYTES;
    schema.properties.userConfig.description =
      "Settings form definitions and non-secret defaults. Desktop stores actual user values separately.";
  }
  const generatedSchema = path.join(temporaryRoot, schemaName);
  fs.writeFileSync(generatedSchema, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

  if (checkOnly) {
    assertSameFile(path.join(contractRoot, validatorName), generatedValidator);
    assertSameFile(path.join(contractRoot, schemaName), generatedSchema);
  } else {
    fs.mkdirSync(contractRoot, { recursive: true });
    fs.copyFileSync(generatedValidator, path.join(contractRoot, validatorName));
    fs.copyFileSync(generatedSchema, path.join(contractRoot, schemaName));
  }

  if (skillRoot) {
    const generatedRoot = path.join(skillRoot, "references", "generated");
    fs.mkdirSync(generatedRoot, { recursive: true });
    for (const name of [validatorName, schemaName]) {
      fs.copyFileSync(path.join(temporaryRoot, name), path.join(generatedRoot, name));
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
