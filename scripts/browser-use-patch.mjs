import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const pinned = JSON.parse(fs.readFileSync(new URL("../patches/playwright-browser-use/upstream-lock.json", import.meta.url), "utf8"));
const PATCH = "DESKTOP_BROWSER_USE_PATCH_V2";
const reviewedCore = pinned.packages["playwright-core"];
export const browserUseUpstream = Object.freeze({
  patch: PATCH,
  core: reviewedCore.version,
  commit: pinned.coreGitHead,
  sourceSha256: pinned.coreBundleSha256,
  packages: pinned.packages,
  extension: pinned.extension
});

/** Private upstream bindings are reviewed against this exact stable release. */
export function supportedPlaywrightCore(version) {
  return /^\d+\.\d+\.\d+$/u.test(version) && version === reviewedCore.version;
}

/**
 * Appends Desktop's adapter to the installed playwright-core bundle. No upstream text is replaced,
 * while the exact reviewed version, original source digest and required bindings remain build gates.
 */
export function patchBrowserUseUpstream(rootDir) {
  const require = createRequire(path.join(rootDir, "package.json"));
  let packageDir;
  try { packageDir = path.dirname(require.resolve("playwright-core/package.json")); }
  catch { throw new Error("playwright-core is not installed; run npm install"); }
  const { name, version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (name !== "playwright-core" || !supportedPlaywrightCore(version))
    throw new Error(`Browser Use needs reviewed stable playwright-core ${reviewedCore.version}; found ${name ?? "unknown"}@${version}`);
  const filename = path.join(packageDir, "lib/coreBundle.js");
  const originalFile = filename + ".desktop-original";
  const adapter = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-use-upstream-adapter.cjs"), "utf8");
  let source = fs.readFileSync(filename, "utf8");
  // A previous adapter is removed by restoring the saved upstream file of the same installed version.
  if (source.startsWith("/* DESKTOP_BROWSER_USE_PATCH_")) {
    const saved = fs.existsSync(originalFile) ? fs.readFileSync(originalFile, "utf8") : "";
    if (!saved || saved.startsWith("/* DESKTOP_BROWSER_USE_PATCH_")) throw new Error("Browser Use adapter is applied without its original bundle; reinstall playwright-core");
    source = saved;
  }
  if (crypto.createHash("sha256").update(source).digest("hex") !== pinned.coreBundleSha256)
    throw new Error("Browser Use upstream source checksum differs; reinstall the reviewed playwright-core release");
  const fingerprint = crypto.createHash("sha256").update(version).update(source).update(adapter).digest("hex");
  const marker = `/* ${PATCH} ${version} ${fingerprint} */`;
  const candidate = `${marker}\n${source}\n${adapter}\n`;
  const current = fs.readFileSync(filename, "utf8");
  // Compare the entire adapter output, not only its marker: a changed installed suffix must not be trusted.
  if (current !== candidate) {
    fs.writeFileSync(originalFile, source);
    fs.writeFileSync(filename, candidate);
  }
  // Load the result in a separate module instance so a missing upstream binding fails the build.
  const probe = createRequire(filename);
  delete probe.cache[filename];
  try {
    const api = probe(filename).__desktopBrowserUse;
    const missing = api?.missing?.();
    if (!api || !Array.isArray(missing) || missing.length)
      throw new Error(`playwright-core ${version} lacks what Browser Use needs (${missing?.join(", ") ?? "adapter unavailable"}); keep the previous release or update the adapter`);
  } catch (error) {
    fs.writeFileSync(filename, source);
    delete probe.cache[filename];
    throw error;
  }
  return packageDir;
}

export function stageBrowserUseRuntime(rootDir, mainDir) {
  const packageDir = patchBrowserUseUpstream(rootDir);
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const target = path.join(mainDir, "browser-use-runtime/playwright-core");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(packageDir, target, { recursive: true, filter: source => !source.endsWith(".desktop-original") });
  fs.writeFileSync(path.join(mainDir, "browser-use-runtime/upstream.json"), JSON.stringify({ ...browserUseUpstream, core: version }, null, 2) + "\n");
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchBrowserUseUpstream(process.cwd());
}
