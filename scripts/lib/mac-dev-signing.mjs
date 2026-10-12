import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(program, args, options = {}) {
  try {
    return execFileSync(program, args, {
      encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"], ...options
    });
  } catch (error) {
    // security receives keychain passwords in argv. Never include its command
    // or the original exception in build logs.
    throw new Error(`macOS development signing: ${path.basename(program)} ${args[0]} failed (exit ${error.status ?? "unknown"}).`);
  }
}

function removeFromKeychainSearchList(keychainPath) {
  const current = run("/usr/bin/security", ["list-keychains", "-d", "user"])
    .split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  const canonical = file => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const remaining = current.filter(file => canonical(file) !== canonical(keychainPath));
  if (remaining.length !== current.length) {
    run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...remaining]);
  }
}

function createLocalIdentity(root, bundleId, keychainPath) {
  const working = fs.mkdtempSync(path.join(root, "prepare-"));
  fs.chmodSync(working, 0o700);
  const password = randomBytes(32).toString("base64url");
  const configPath = path.join(working, "certificate.cnf");
  const privateKey = path.join(working, "private.pem");
  const certificate = path.join(working, "certificate.pem");
  const archive = path.join(working, "identity.p12");
  let created = false;
  try {
    fs.writeFileSync(configPath, [
      "[req]", "prompt=no", "distinguished_name=subject", "x509_extensions=extensions",
      "[subject]", `CN=Desktop Local Development ${bundleId}`,
      "[extensions]", "basicConstraints=critical,CA:false",
      "keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,codeSigning", ""
    ].join("\n"), { mode: 0o600 });
    run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
      "-config", configPath, "-keyout", privateKey, "-out", certificate]);
    const fingerprint = run("/usr/bin/openssl", ["x509", "-in", certificate, "-fingerprint", "-sha1", "-noout"])
      .trim().split("=").at(-1).replaceAll(":", "");
    if (!/^[a-f\d]{40}$/iu.test(fingerprint)) throw new Error("Invalid development certificate fingerprint.");
    run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", privateKey, "-in", certificate,
      "-out", archive, "-passout", "stdin"], { input: `${password}\n` });
    run("/usr/bin/security", ["create-keychain", "-p", password, keychainPath]);
    created = true;
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychainPath]);
    run("/usr/bin/security", ["import", archive, "-k", keychainPath, "-P", password, "-T", "/usr/bin/codesign"]);
    run("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychainPath]);
    const metadata = { version: 1, bundleId, fingerprint, password };
    fs.writeFileSync(path.join(root, "identity.json"), `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
    return metadata;
  } catch (error) {
    if (created) run("/usr/bin/security", ["delete-keychain", keychainPath]);
    throw error;
  } finally {
    // Keep this private development identity out of the default/production
    // signing search list. No login keychain or trust settings are changed.
    try {
      removeFromKeychainSearchList(keychainPath);
    } finally {
      fs.rmSync(working, { recursive: true, force: true });
    }
  }
}

export function resolveDarwinDevSigningIdentity(bundleId, {
  env = process.env,
  signingRoot = path.join(os.homedir(), "Library", "Application Support", "ZenMind Desktop", "DevelopmentSigning", bundleId)
} = {}) {
  if (process.platform !== "darwin") throw new Error("Development keychain signing is only supported on macOS.");
  if (!/^[a-z\d][a-z\d.-]*\.dev$/iu.test(bundleId)) throw new Error("Invalid development bundle identifier.");
  const explicitIdentity = env.DESKTOP_DEV_CODESIGN_IDENTITY?.trim();
  if (explicitIdentity) {
    if (explicitIdentity === "-") throw new Error("macOS development signing requires a persistent certificate; ad hoc signing invalidates saved screen-recording grants.");
    return { identity: explicitIdentity, keychain: env.DESKTOP_DEV_CODESIGN_KEYCHAIN?.trim() || undefined };
  }

  fs.mkdirSync(signingRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(signingRoot).isSymbolicLink()) throw new Error("Development signing directory must not be a symlink.");
  fs.chmodSync(signingRoot, 0o700);
  const metadataPath = path.join(signingRoot, "identity.json");
  const keychainPath = path.join(signingRoot, "development.keychain-db");
  if (!fs.existsSync(metadataPath) && fs.existsSync(keychainPath)) {
    throw new Error(`Development signing metadata is missing in ${signingRoot}; restore it instead of replacing the certificate and invalidating saved permissions.`);
  }
  if ([metadataPath, keychainPath].some(file => fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) {
    throw new Error("Development signing identity files must not be symlinks.");
  }
  let metadata;
  const readMetadata = () => {
    try {
      return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      throw new Error(`Invalid development signing metadata in ${signingRoot}; restore the original identity.`);
    }
  };
  if (fs.existsSync(metadataPath)) {
    metadata = readMetadata();
  } else {
    const lockPath = path.join(signingRoot, "prepare.lock");
    let lock;
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      throw new Error(`Development signing identity is being prepared in ${signingRoot}; retry after the other build finishes.`);
    }
    try {
      // A previous creator may have finished after our initial existence check.
      // Reuse its certificate, never replace an identity that already has grants.
      if (fs.existsSync(metadataPath)) metadata = readMetadata();
      else if (fs.existsSync(keychainPath)) throw new Error(`Development signing metadata is missing in ${signingRoot}; restore the original identity.`);
      else metadata = createLocalIdentity(signingRoot, bundleId, keychainPath);
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
  if (!metadata || typeof metadata !== "object" || metadata.version !== 1 || metadata.bundleId !== bundleId ||
      !/^[a-f\d]{40}$/iu.test(metadata.fingerprint) || typeof metadata.password !== "string" || !metadata.password ||
      !fs.existsSync(keychainPath) || fs.lstatSync(metadataPath).isSymbolicLink() || fs.lstatSync(keychainPath).isSymbolicLink()) {
    throw new Error(`Invalid development signing identity in ${signingRoot}; restore the original identity instead of silently generating another one.`);
  }
  fs.chmodSync(metadataPath, 0o600);
  fs.chmodSync(keychainPath, 0o600);
  run("/usr/bin/security", ["unlock-keychain", "-p", metadata.password, keychainPath]);
  removeFromKeychainSearchList(keychainPath);
  return { identity: metadata.fingerprint, keychain: keychainPath };
}
