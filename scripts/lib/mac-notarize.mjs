import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import yaml from "js-yaml";

function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildNotaryToolAuthArgs(env = process.env) {
  const appleId = trimEnv(env.APPLE_ID);
  const appleIdPassword = trimEnv(env.APPLE_APP_SPECIFIC_PASSWORD);
  if (appleId || appleIdPassword) {
    if (!appleId) {
      throw new Error("APPLE_ID env var needs to be set");
    }
    if (!appleIdPassword) {
      throw new Error("APPLE_APP_SPECIFIC_PASSWORD env var needs to be set");
    }
    const teamId = trimEnv(env.APPLE_TEAM_ID);
    if (!teamId) {
      throw new Error("APPLE_TEAM_ID env var needs to be set");
    }
    return ["--apple-id", appleId, "--password", appleIdPassword, "--team-id", teamId];
  }

  const appleApiKey = trimEnv(env.APPLE_API_KEY);
  const appleApiKeyId = trimEnv(env.APPLE_API_KEY_ID);
  const appleApiIssuer = trimEnv(env.APPLE_API_ISSUER);
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
      throw new Error("Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set");
    }
    return ["--key", appleApiKey, "--key-id", appleApiKeyId, "--issuer", appleApiIssuer];
  }

  const keychain = trimEnv(env.APPLE_KEYCHAIN);
  const keychainProfile = trimEnv(env.APPLE_KEYCHAIN_PROFILE);
  if (keychain || keychainProfile) {
    if (!keychainProfile) {
      throw new Error("APPLE_KEYCHAIN_PROFILE env var needs to be set when APPLE_KEYCHAIN is set");
    }
    return keychain
      ? ["--keychain", keychain, "--keychain-profile", keychainProfile]
      : ["--keychain-profile", keychainProfile];
  }

  return null;
}

export function resolveMacDmgArtifactPath(rootDir, brand) {
  const latestMacPath = path.join(rootDir, "dist", brand.id, "latest-mac.yml");
  if (!fs.existsSync(latestMacPath)) {
    throw new Error(`macOS release metadata not found: ${latestMacPath}`);
  }

  const metadata = yaml.load(fs.readFileSync(latestMacPath, "utf8"));
  const artifactName = typeof metadata?.path === "string" ? metadata.path.trim() : "";
  if (!artifactName || !artifactName.toLowerCase().endsWith(".dmg")) {
    throw new Error(`macOS release metadata does not point to a DMG: ${latestMacPath}`);
  }

  const artifactPath = path.resolve(path.dirname(latestMacPath), artifactName);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error(`macOS DMG artifact not found: ${artifactPath}`);
  }
  return artifactPath;
}

export function assertMacNotarizationHost(platform = process.platform) {
  if (platform === "darwin") {
    return;
  }
  if (platform === "win32") {
    throw new Error("macOS DMG notarization requires a macOS host; Windows cannot run xcrun notarytool.");
  }
  throw new Error(`macOS DMG notarization requires a macOS host; ${platform} cannot run xcrun notarytool.`);
}

function runCaptured(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    child.stderr.on("data", (chunk) => chunks.push(chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? -1,
        output: chunks.join("")
      });
    });
  });
}

async function runXcrun(args, options) {
  const result = await runCaptured("xcrun", args, options);
  if (result.code !== 0) {
    throw new Error(`xcrun ${args.slice(0, 2).join(" ")} exited with code ${result.code}\n\n${result.output}`);
  }
  return result.output;
}

async function fetchNotaryLog(submissionId, authArgs, options) {
  try {
    return await runXcrun(["notarytool", "log", submissionId, ...authArgs], options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to fetch notarization log for ${submissionId}: ${message}`;
  }
}

export async function notarizeAndStapleDmg(dmgPath, { rootDir = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const authArgs = buildNotaryToolAuthArgs(env);
  if (!authArgs) {
    console.warn("[dist:mac] skipped final DMG notarization because no Apple notary credentials are configured.");
    return false;
  }
  assertMacNotarizationHost(platform);

  const options = { cwd: rootDir, env };
  console.info(`[dist:mac] submitting final DMG for notarization: ${dmgPath}`);
  const output = await runXcrun(
    ["notarytool", "submit", dmgPath, ...authArgs, "--wait", "--output-format", "json"],
    options
  );
  let submission;
  try {
    submission = JSON.parse(output.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse notarytool JSON output: ${message}\n\n${output}`);
  }

  if (submission?.status !== "Accepted") {
    const submissionId = typeof submission?.id === "string" ? submission.id : "";
    const log = submissionId ? await fetchNotaryLog(submissionId, authArgs, options) : "";
    throw new Error(`Final DMG notarization failed with status ${submission?.status ?? "(missing)"}.\n\n${log}`);
  }

  console.info(`[dist:mac] notarization accepted for final DMG: ${submission.id}`);
  await runXcrun(["stapler", "staple", "-v", dmgPath], options);
  await runXcrun(["stapler", "validate", dmgPath], options);
  console.info(`[dist:mac] stapled and validated final DMG: ${dmgPath}`);
  return true;
}
