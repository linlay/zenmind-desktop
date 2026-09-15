import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/u;
const MACHINES = { amd64: 0x8664, arm64: 0xaa64 };

export function normalizeNodeLauncherArch(arch) {
  if (arch === "x64" || arch === "amd64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Unsupported Windows Node launcher architecture: ${arch}`);
}

/** Validate the PE target and GUI subsystem; never execute a foreign binary. */
export function verifyNodeLauncherPE(data, arch) {
  const expected = MACHINES[normalizeNodeLauncherArch(arch)];
  if (!Buffer.isBuffer(data) || data.length < 128 || data.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Node launcher is not a Windows PE executable");
  }
  const offset = data.readUInt32LE(0x3c);
  if (offset < 0x40 || offset + 96 > data.length || data.readUInt32LE(offset) !== 0x00004550) {
    throw new Error("Node launcher PE header is invalid");
  }
  if (data.readUInt16LE(offset + 4) !== expected) throw new Error("Node launcher PE architecture does not match target");
  if (data.readUInt16LE(offset + 24) !== 0x20b) throw new Error("Node launcher must be a 64-bit PE executable");
  if (data.readUInt16LE(offset + 24 + 68) !== 2) throw new Error("Node launcher must use the Windows GUI subsystem to avoid console flashes");
  return true;
}

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
function sourceFingerprint(moduleRoot) {
  const hash = createHash("sha256");
  for (const name of fs.readdirSync(moduleRoot).filter((name) => name === "go.mod" || name.endsWith(".go") && !name.endsWith("_test.go")).sort()) {
    hash.update(name); hash.update("\0"); hash.update(fs.readFileSync(path.join(moduleRoot, name))); hash.update("\0");
  }
  hash.update(fs.readFileSync(scriptPath));
  return hash.digest("hex");
}
function executeGo(args, cwd, arch) {
  return new Promise((resolve, reject) => {
    const executable = process.env.DESKTOP_GO_BIN?.trim() || "go";
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true,
      env: { ...process.env, GOOS: "windows", GOARCH: arch, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-32_768); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", (error) => reject(new Error(`Building Desktop's Windows Node launcher requires Go 1.23 or newer on the build host: ${error.message}`)));
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Windows Node launcher build failed (${signal ?? code}): ${output.trim()}`)));
  });
}

/**
 * Build-time only. The installed application consumes a PE and never needs Go.
 * A verified matching build can be reused inside the Docker packaging stage.
 */
export async function buildNodeLauncher(rootDir, target = { os: process.platform, arch: process.arch }) {
  if (target.os !== "win32" && target.os !== "windows") return null;
  const arch = normalizeNodeLauncherArch(target.arch);
  const root = path.resolve(rootDir);
  const moduleRoot = path.join(root, "native", "node-launcher");
  const outputDir = path.join(root, "build", "resources", "node-runtime", arch);
  const outputPath = path.join(outputDir, "node.exe");
  const metadataPath = path.join(outputDir, "node-launcher.build.json");
  const sourceSha256 = sourceFingerprint(moduleRoot);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const data = fs.readFileSync(outputPath);
    if (metadata.schemaVersion === 1 && metadata.arch === arch && metadata.sourceSha256 === sourceSha256 && SHA256.test(metadata.sha256) && metadata.sha256 === sha256(data)) {
      verifyNodeLauncherPE(data, arch);
      return { arch, path: outputPath, sha256: metadata.sha256, reused: true };
    }
  } catch { /* Missing/stale/unverifiable build input must be rebuilt. */ }
  fs.mkdirSync(outputDir, { recursive: true });
  const temporary = path.join(outputDir, `.node-${randomUUID()}.exe`);
  const temporaryMetadata = path.join(outputDir, `.node-${randomUUID()}.json`);
  try {
    await executeGo(["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -H=windowsgui -buildid=", "-o", temporary, "."], moduleRoot, arch);
    const data = fs.readFileSync(temporary);
    verifyNodeLauncherPE(data, arch);
    if (sourceFingerprint(moduleRoot) !== sourceSha256) throw new Error("Node launcher source changed while building; retry the build");
    const digest = sha256(data);
    fs.writeFileSync(temporaryMetadata, JSON.stringify({ schemaVersion: 1, arch, sourceSha256, sha256: digest }, null, 2) + "\n");
    fs.renameSync(temporary, outputPath);
    fs.renameSync(temporaryMetadata, metadataPath);
    return { arch, path: outputPath, sha256: digest, reused: false };
  } finally {
    fs.rmSync(temporary, { force: true }); fs.rmSync(temporaryMetadata, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(scriptPath), "..");
  const all = args.includes("--all");
  const os = args.find((arg) => arg.startsWith("--os="))?.slice(5) || "win32";
  const arch = args.find((arg) => arg.startsWith("--arch="))?.slice(7) || "amd64";
  const results = await Promise.allSettled((all ? ["amd64", "arm64"] : [arch]).map((arch) => buildNodeLauncher(root, { os, arch })));
  const failures = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) console.log(JSON.stringify(result.value));
    else if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Windows Node launcher build failed");
}
