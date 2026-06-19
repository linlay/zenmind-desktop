import process from "node:process";
import { syncBrandArtifacts, resolveRequiredBrandId, electronBuilderConfigPath } from "./lib/brand-config.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./platform/spawn.mjs";

const MAC_SIGNING_CERTIFICATE_PREFIX = "Developer ID Application:";
const DARWIN_BUILTIN_SIGN_ENV_KEYS = [
  "ZENMIND_DARWIN_CODESIGN_IDENTITY",
  "MACOS_CODESIGN_IDENTITY",
  "CSC_NAME"
];

function normalizeMacSigningEnvironment() {
  const cscName = process.env.CSC_NAME;
  if (typeof cscName !== "string") {
    return;
  }

  const normalizedName = cscName.trim().startsWith(MAC_SIGNING_CERTIFICATE_PREFIX)
    ? cscName.trim().slice(MAC_SIGNING_CERTIFICATE_PREFIX.length).trim()
    : "";
  if (!normalizedName) {
    return;
  }

  process.env.CSC_NAME = normalizedName;
  console.warn(`[dist:mac] Removed "${MAC_SIGNING_CERTIFICATE_PREFIX}" prefix from CSC_NAME for electron-builder.`);
}

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

function shouldSignDarwinBuiltinAssets() {
  const explicit =
    parseBooleanEnv(process.env.ZENMIND_SIGN_DARWIN_BUILTINS, "ZENMIND_SIGN_DARWIN_BUILTINS") ??
    parseBooleanEnv(process.env.SIGN_MAC_BUILTINS, "SIGN_MAC_BUILTINS");
  if (explicit !== undefined) {
    return explicit;
  }

  return DARWIN_BUILTIN_SIGN_ENV_KEYS.some((envKey) => Boolean(process.env[envKey]?.trim()));
}

const projectRoot = process.cwd();
const target = { os: "darwin", arch: "arm64" };
const brand = syncBrandArtifacts({ brandId: resolveRequiredBrandId(process.argv.slice(2), process.env, "dist:mac"), target });
process.env.BRAND = brand.id;
normalizeMacSigningEnvironment();
const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

await runAndWait(npmCmd, ["run", "sync:version"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "sync:demo"], brandProcessOptions({ cwd: projectRoot }));
syncBrandArtifacts({ brandId: brand.id, target });
const syncBuiltinAssetArgs = ["./scripts/sync-builtin-assets.mjs", "--os=darwin", "--arch=arm64"];
if (shouldSignDarwinBuiltinAssets()) {
  syncBuiltinAssetArgs.push("--sign-darwin");
}
await runAndWait("node", syncBuiltinAssetArgs, brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "icons"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "build"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=darwin", "--arch=arm64"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, [
  "exec",
  "electron-builder",
  "--",
  "--config",
  electronBuilderConfigPath(projectRoot, brand.id),
  "--mac",
  "--arm64"
], brandProcessOptions({ cwd: projectRoot }));
