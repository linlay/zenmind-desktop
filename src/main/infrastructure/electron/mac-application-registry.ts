import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const SHARE_EXTENSION = "Contents/PlugIns/DesktopShare.appex";

export type MacRegisteredApplication = {
  path: string;
  bundleId: string;
  version: string;
  runnable: boolean;
  shareExtensionPath?: string;
};

export type MacApplicationRegistry = {
  listApplicationPaths(bundleId: string): string[];
  inspectApplication(appPath: string): Promise<MacRegisteredApplication>;
  signingRequirement(appPath: string): Promise<string>;
  matchesSigningRequirement(appPath: string, requirement: string): Promise<boolean>;
  registerApplication(appPath: string): Promise<void>;
  unregisterApplication(appPath: string): Promise<void>;
  registerShareExtension(extensionPath: string): Promise<void>;
  unregisterShareExtension(extensionPath: string): Promise<void>;
};

async function command(program: string, args: string[]) {
  const result = await execFileAsync(program, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  return `${result.stdout}\n${result.stderr}`;
}

async function readInfo(appPath: string): Promise<Record<string, unknown>> {
  const result = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(appPath, "Contents", "Info.plist")], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024
  });
  return JSON.parse(result.stdout);
}

let systemInfo: Promise<{ version: string; architectures: string[] }> | undefined;

function macSystemInfo() {
  return systemInfo ??= (async () => {
    const version = (await command("/usr/bin/sw_vers", ["-productVersion"])).trim();
    const architectures = [process.arch];
    if (process.arch === "x64") {
      // An x64 process on Apple Silicon proves Rosetta is available. Do not
      // assume an arm64 process can launch Intel-only apps on a fresh Mac.
      try {
        if ((await command("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"])).trim() === "1") architectures.push("arm64");
      } catch { /* Intel Macs need only their running x64 architecture. */ }
    }
    return { version, architectures };
  })().catch(error => { systemInfo = undefined; throw error; });
}

export function isMacApplicationCompatible(
  info: Record<string, unknown>, executableArchitectures: string[], systemVersion: string, systemArchitectures: string[]
) {
  const numericVersion = (value: unknown) => typeof value === "string" && /^\d+(?:\.\d+){0,2}$/u.test(value) && value.length <= 128
    ? value.split(".").map(BigInt) : null;
  const current = numericVersion(systemVersion);
  const minimum = numericVersion(info.LSMinimumSystemVersion ?? "0");
  const atLeast = (required: bigint[]) => {
    for (let i = 0; i < 3; i++) {
      const a = current![i] ?? 0n, b = required[i] ?? 0n;
      if (a !== b) return a > b;
    }
    return true;
  };
  if (!current || !minimum || !atLeast(minimum)) return false;
  const byArchitecture = info.LSMinimumSystemVersionByArchitecture;
  if (byArchitecture !== undefined && (!byArchitecture || typeof byArchitecture !== "object" || Array.isArray(byArchitecture))) return false;
  return systemArchitectures.some(architecture => {
    if (!executableArchitectures.includes(architecture)) return false;
    const required = numericVersion((byArchitecture as Record<string, unknown> | undefined)?.[architecture === "x64" ? "x86_64" : architecture] ?? "0");
    return required !== null && atLeast(required);
  });
}

function executableArchitectures(executablePath: string) {
  const koffi = require("koffi") as typeof import("koffi");
  const core = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const createUrl = core.func("void *CFURLCreateFromFileSystemRepresentation(void *allocator, const uint8_t *bytes, long length, bool isDirectory)");
  const copyArchitectures = core.func("void *CFBundleCopyExecutableArchitecturesForURL(void *url)");
  const arrayCount = core.func("long CFArrayGetCount(void *array)");
  const arrayValue = core.func("void *CFArrayGetValueAtIndex(void *array, long index)");
  const numberValue = core.func("bool CFNumberGetValue(void *number, int type, _Out_ int32_t *value)");
  const release = core.func("void CFRelease(void *value)");
  const bytes = Buffer.from(executablePath, "utf8");
  const url = createUrl(null, bytes, bytes.length, false);
  if (!url) return [];
  let architectures;
  try {
    architectures = copyArchitectures(url);
    if (!architectures) return [];
    const count = Number(arrayCount(architectures));
    if (count < 0 || count > 32) throw new Error("Invalid macOS executable architectures");
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const value = [0];
      if (!numberValue(arrayValue(architectures, i), 3, value)) continue; // kCFNumberSInt32Type
      if (value[0] === 0x0100000c) result.push("arm64");
      if (value[0] === 0x01000007) result.push("x64");
    }
    return result;
  } finally {
    if (architectures) release(architectures);
    release(url);
  }
}

async function inspectApplication(appPath: string): Promise<MacRegisteredApplication> {
  const canonicalPath = await fs.realpath(appPath);
  const info = await readInfo(canonicalPath);
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || !executable || path.basename(executable) !== executable || executable === "." || executable === ".." ||
      typeof info.CFBundleIdentifier !== "string" || typeof info.CFBundleShortVersionString !== "string") {
    throw new Error("Invalid macOS application metadata");
  }
  const executablePath = path.join(canonicalPath, "Contents", "MacOS", executable);
  await fs.access(executablePath, fs.constants.X_OK);
  const system = await macSystemInfo();
  const runnable = isMacApplicationCompatible(info, executableArchitectures(executablePath), system.version, system.architectures);
  let shareExtensionPath: string | undefined;
  const extensionPath = path.join(canonicalPath, SHARE_EXTENSION);
  try {
    const extension = await readInfo(extensionPath);
    if (extension.CFBundleIdentifier === `${info.CFBundleIdentifier}.share` &&
        extension.CFBundleShortVersionString === info.CFBundleShortVersionString) {
      shareExtensionPath = extensionPath;
    }
  } catch {
    // Older releases may predate system sharing. They remain file-open candidates.
  }
  return { path: canonicalPath, bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, runnable, shareExtensionPath };
}

// Query only this product identity, rather than parsing the entire user's
// LaunchServices dump or scanning unrelated application directories.
export function listMacApplicationPaths(bundleId: string): string[] {
  const koffi = require("koffi") as typeof import("koffi");
  const core = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const services = koffi.load("/System/Library/Frameworks/CoreServices.framework/CoreServices");
  const createString = core.func("void *CFStringCreateWithCString(void *allocator, const char *value, uint32 encoding)");
  const stringLength = core.func("long CFStringGetLength(void *value)");
  const stringBytes = core.func("bool CFStringGetCString(void *value, _Out_ char *buffer, long capacity, uint32 encoding)");
  const arrayCount = core.func("long CFArrayGetCount(void *array)");
  const arrayValue = core.func("void *CFArrayGetValueAtIndex(void *array, long index)");
  const filePath = core.func("void *CFURLCopyFileSystemPath(void *url, int style)");
  const release = core.func("void CFRelease(void *value)");
  const applicationUrls = services.func("void *LSCopyApplicationURLsForBundleIdentifier(void *bundleId, void *error)");
  const utf8 = 0x08000100;
  const identifier = createString(null, bundleId, utf8);
  if (!identifier) throw new Error("Could not create the macOS application identifier");
  let urls;
  try {
    urls = applicationUrls(identifier, null);
    if (!urls) return [];
    const count = Number(arrayCount(urls));
    if (!Number.isSafeInteger(count) || count < 0 || count > 128) throw new Error("Too many registered copies of this macOS application");
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const value = filePath(arrayValue(urls, i), 0);
      if (!value) continue;
      try {
        const capacity = Number(stringLength(value)) * 4 + 1;
        if (capacity < 1 || capacity > 128 * 1024) throw new Error("Invalid registered application path length");
        const buffer = Buffer.alloc(capacity);
        if (!stringBytes(value, buffer, capacity, utf8)) throw new Error("Could not decode the registered application path");
        result.push(buffer.toString("utf8", 0, buffer.indexOf(0)));
      } finally { release(value); }
    }
    return [...new Set(result)];
  } finally {
    if (urls) release(urls);
    release(identifier);
  }
}

export const macApplicationRegistry: MacApplicationRegistry = {
  listApplicationPaths: listMacApplicationPaths,
  inspectApplication,
  async signingRequirement(appPath) {
    await command("/usr/bin/codesign", ["--verify", "--strict", appPath]);
    const output = await command("/usr/bin/codesign", ["--display", "-r-", appPath]);
    const requirement = output.match(/^(?:#\s*)?designated => (.+)$/mu)?.[1];
    if (!requirement) throw new Error("Missing macOS application signing requirement");
    return requirement;
  },
  async matchesSigningRequirement(appPath, requirement) {
    try {
      await command("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, appPath]);
      return true;
    } catch { return false; }
  },
  async registerApplication(appPath) { await command(LSREGISTER, ["-f", appPath]); },
  async unregisterApplication(appPath) { await command(LSREGISTER, ["-u", appPath]); },
  async registerShareExtension(extensionPath) { await command("/usr/bin/pluginkit", ["-a", extensionPath]); },
  async unregisterShareExtension(extensionPath) { await command("/usr/bin/pluginkit", ["-r", extensionPath]); }
};
