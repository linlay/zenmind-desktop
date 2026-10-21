import path from "node:path";
import { macApplicationRegistry, type MacApplicationRegistry, type MacRegisteredApplication } from "./mac-application-registry";

type RegistrationOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  bundleId: string;
  executablePath: string;
  homePath: string;
};

export type MacSystemIntegrationResult = {
  selectedPath?: string;
  selectedVersion?: string;
  shareRegistered: boolean;
  unregisteredPaths: string[];
  failures: { path: string; operation: string }[];
};

function versionParts(value: string): bigint[] | null {
  // CFBundleShortVersionString is a numeric release version. Do not guess the
  // ordering of malformed or prerelease bundle metadata during automatic cleanup.
  return /^\d+\.\d+\.\d+$/u.test(value) && value.length <= 128 ? value.split(".").map(BigInt) : null;
}

function compareVersions(left: string, right: string) {
  const a = versionParts(left)!, b = versionParts(right)!;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function isTemporaryApplication(appPath: string) {
  return appPath.startsWith("/Volumes/") || appPath.split("/").some(part => [".Trash", ".Trashes", "AppTranslocation"].includes(part));
}

function applicationPath(executablePath: string) {
  const macOs = path.posix.dirname(executablePath);
  const contents = path.posix.dirname(macOs);
  const appPath = path.posix.dirname(contents);
  return path.posix.isAbsolute(executablePath) && path.posix.basename(macOs) === "MacOS" &&
    path.posix.basename(contents) === "Contents" && appPath.endsWith(".app") ? appPath : null;
}

function locationRank(appPath: string, currentPath: string, homePath: string) {
  if (path.posix.dirname(appPath) === "/Applications") return 0;
  if (path.posix.dirname(appPath) === path.posix.join(homePath, "Applications")) return 1;
  return appPath === currentPath ? 2 : 3;
}

/** Reconcile this brand's signed release copies without deleting apps or changing defaults/elections. */
export async function refreshMacSystemIntegration(
  options: RegistrationOptions,
  registry: MacApplicationRegistry = macApplicationRegistry
): Promise<MacSystemIntegrationResult> {
  const result: MacSystemIntegrationResult = { shareRegistered: false, unregisteredPaths: [], failures: [] };
  // Development shells have a different identity, even when Electron calls the
  // copied shell "packaged". Windows retains its NSIS-owned association flow.
  if (options.platform === "win32") return result;
  if (options.platform !== "darwin" || !options.isPackaged || options.bundleId.endsWith(".dev")) return result;
  const deadline = Date.now() + 30_000;
  const currentPath = applicationPath(options.executablePath);
  if (!currentPath || isTemporaryApplication(currentPath)) return result;
  const current = await registry.inspectApplication(currentPath);
  if (current.bundleId !== options.bundleId || !current.runnable || !versionParts(current.version) || isTemporaryApplication(current.path)) return result;
  const requirement = await registry.signingRequirement(current.path);
  const registeredPaths = registry.listApplicationPaths(options.bundleId);
  const candidates = new Map<string, MacRegisteredApplication>([[current.path, current]]);
  const missingPaths: string[] = [];
  for (const registeredPath of new Set(registeredPaths)) {
    if (Date.now() >= deadline) throw new Error("macOS application registration inspection timed out");
    if (!path.posix.isAbsolute(registeredPath) || !registeredPath.endsWith(".app") || registeredPath === current.path) continue;
    try {
      const candidate = await registry.inspectApplication(registeredPath);
      if (candidate.bundleId !== options.bundleId || !versionParts(candidate.version) ||
          !await registry.matchesSigningRequirement(candidate.path, requirement)) continue;
      candidates.set(candidate.path, candidate);
    } catch (error) {
      // Only a vanished bundle can be removed without checking its signature.
      // Permission errors and corrupt/unknown bundles are left for diagnosis.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && (error as NodeJS.ErrnoException).path === registeredPath) missingPaths.push(registeredPath);
      else result.failures.push({ path: registeredPath, operation: "inspect" });
    }
  }
  const selected = [...candidates.values()].filter(candidate => candidate.runnable && !isTemporaryApplication(candidate.path)).sort((a, b) =>
    compareVersions(b.version, a.version) ||
    locationRank(a.path, current.path, options.homePath) - locationRank(b.path, current.path, options.homePath) || a.path.localeCompare(b.path)
  )[0];
  if (Date.now() >= deadline) throw new Error("macOS application registration inspection timed out");
  // Register the selected version before removing alternatives. A failed
  // registration must never leave the user without an existing file handler.
  await registry.registerApplication(selected.path);
  result.selectedPath = selected.path;
  result.selectedVersion = selected.version;
  // Keep existing working sharing entries until the selected extension has
  // actually registered. Removing the old containing app can also remove its
  // extension, so a partial/missing release must not enter cleanup at all.
  if (!selected.shareExtensionPath) {
    result.failures.push({ path: selected.path, operation: "missing-share-extension" });
    return result;
  }
  try {
    await registry.registerShareExtension(selected.shareExtensionPath);
    result.shareRegistered = true;
  } catch {
    result.failures.push({ path: selected.path, operation: "register-share" });
    return result;
  }
  const obsolete = [...candidates.values()].filter(candidate => candidate.path !== selected.path);
  for (const candidate of obsolete) {
    if (Date.now() >= deadline) { result.failures.push({ path: candidate.path, operation: "cleanup-timeout" }); break; }
    if (candidate.shareExtensionPath) {
      try { await registry.unregisterShareExtension(candidate.shareExtensionPath); }
      catch { result.failures.push({ path: candidate.path, operation: "unregister-share" }); }
    }
  }
  for (const obsoletePath of [...obsolete.map(candidate => candidate.path), ...missingPaths]) {
    if (Date.now() >= deadline) { result.failures.push({ path: obsoletePath, operation: "cleanup-timeout" }); break; }
    try {
      await registry.unregisterApplication(obsoletePath);
      result.unregisteredPaths.push(obsoletePath);
    } catch { result.failures.push({ path: obsoletePath, operation: "unregister" }); }
  }
  // Force a fresh registration even for an overwrite at the exact same path.
  // Re-add the extension after cleanup without overriding the user's election.
  await registry.registerApplication(selected.path);
  try { await registry.registerShareExtension(selected.shareExtensionPath); }
  catch { result.failures.push({ path: selected.path, operation: "register-share" }); }
  return result;
}
