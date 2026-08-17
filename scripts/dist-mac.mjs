import process from "node:process";
import { syncBrandArtifacts, resolveRequiredBrandId, electronBuilderConfigPath } from "./lib/brand-config.mjs";
import { notarizeAndStapleDmg, resolveMacDmgArtifactPath } from "./lib/mac-notarize.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./platform/spawn.mjs";

const MAC_SIGNING_CERTIFICATE_PREFIX = "Developer ID Application:";
const DARWIN_BUILTIN_SIGN_ENV_KEYS = [
  "DESKTOP_DARWIN_CODESIGN_IDENTITY",
  "MACOS_CODESIGN_IDENTITY",
  "CSC_NAME"
];
const SIGN_DARWIN_BUILTINS_ENV = "DESKTOP_SIGN_DARWIN_BUILTINS";
const NOTARIZE_ENV_KEYS = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE"
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
    parseBooleanEnv(process.env[SIGN_DARWIN_BUILTINS_ENV], SIGN_DARWIN_BUILTINS_ENV) ??
    parseBooleanEnv(process.env.SIGN_MAC_BUILTINS, "SIGN_MAC_BUILTINS");
  if (explicit !== undefined) {
    return explicit;
  }

  return DARWIN_BUILTIN_SIGN_ENV_KEYS.some((envKey) => Boolean(process.env[envKey]?.trim()));
}

function shouldSkipNotarize() {
  return parseBooleanEnv(process.env.SKIP_NOTARIZE, "SKIP_NOTARIZE") ?? false;
}

function disableNotarizationEnvironment() {
  const cleared = NOTARIZE_ENV_KEYS.filter((key) => typeof process.env[key] === "string" && process.env[key]);
  for (const key of cleared) {
    delete process.env[key];
  }
  console.warn(
    `[dist:mac] SKIP_NOTARIZE enabled — cleared ${cleared.length} Apple notary env var(s): ${cleared.join(", ") || "(none)"}`
  );
}

const projectRoot = process.cwd();
const target = { os: "darwin", arch: "arm64" };
const brand = syncBrandArtifacts({ brandId: resolveRequiredBrandId(process.argv.slice(2), process.env, "dist:mac"), target });
process.env.BRAND = brand.id;
normalizeMacSigningEnvironment();
if (shouldSkipNotarize()) {
  disableNotarizationEnvironment();
}
const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
syncBrandArtifacts({ brandId: brand.id, target });
const syncBuiltinAssetArgs = ["./scripts/sync-builtin-assets.mjs", "--use-existing", "--os=darwin", "--arch=arm64"];
if (shouldSignDarwinBuiltinAssets()) {
  syncBuiltinAssetArgs.push("--sign-darwin");
}
await runAndWait("node", syncBuiltinAssetArgs, brandProcessOptions({ cwd: projectRoot }));
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

if (!shouldSkipNotarize()) {
  const dmgPath = resolveMacDmgArtifactPath(projectRoot, brand);
  await notarizeAndStapleDmg(dmgPath, {
    rootDir: projectRoot,
    env: brandProcessOptions().env
  });
}
