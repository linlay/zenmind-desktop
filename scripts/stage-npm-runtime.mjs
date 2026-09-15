import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { desktopNodeRuntimeDir } from "./lib/desktop-resources.mjs";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const STAMP = ".desktop-resource.json";

export function readNpmRuntimeLock(rootDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, "scripts", "npm-runtime-lock.json"), "utf8"));
  const expectedUrl = `https://registry.npmjs.org/npm/-/npm-${lock.version}.tgz`;
  if (lock.name !== "npm" || !/^\d+\.\d+\.\d+$/.test(lock.version) || lock.url !== expectedUrl || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(lock.integrity)) {
    throw new Error("Invalid pinned npm runtime lock");
  }
  return lock;
}
export function verifyNpmArchive(archive, lock) {
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES || `sha512-${createHash("sha512").update(archive).digest("base64")}` !== lock.integrity) {
    throw new Error(`npm ${lock.version} archive integrity mismatch`);
  }
}
function tarText(header, start, end) {
  return header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
}
function tarNumber(header, start, end) {
  const text = tarText(header, start, end).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("Invalid npm tar numeric field");
  return Number.parseInt(text, 8);
}

// The pinned npm distribution contains regular files only. Reject links and
// extended metadata instead of requiring system tar or following archive paths.
export function extractNpmArchive(archive, destination, platform = process.platform) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  let offset = 0, count = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== tarNumber(header, 148, 156)) throw new Error("Invalid npm tar header checksum");
    const prefix = tarText(header, 345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
    const size = tarNumber(header, 124, 136);
    const type = tarText(header, 156, 157) || "0";
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || ++count > 10_000) throw new Error("Invalid npm tar entry size");
    const segments = name.replace(/\/$/, "").split("/");
    if (segments.shift() !== "package" || !segments.length || segments.some(segment => !segment || segment === "." || segment === ".." || /[\\:\u0000]/.test(segment)) || !["0", "5"].includes(type)) {
      throw new Error(`Unsupported npm tar entry: ${name}`);
    }
    const target = path.join(destination, ...segments);
    if (type === "5") fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size), { flag: "wx" });
      // Windows uses Desktop's Node launcher rather than POSIX executable bits.
      if (platform !== "win32") fs.chmodSync(target, tarNumber(header, 100, 108) & 0o777);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!count) throw new Error("Empty npm runtime archive");
  return count;
}

function validatePackage(directory, lock) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  if (pkg.name !== "npm" || pkg.version !== lock.version) throw new Error("Staged npm package identity mismatch");
  for (const entry of ["bin/npm-cli.js", "bin/npx-cli.js", "lib/cli.js", "LICENSE"]) {
    if (!fs.statSync(path.join(directory, entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`Incomplete npm runtime: ${entry}`);
  }
  if (!Array.isArray(pkg.bundleDependencies) || !pkg.bundleDependencies.length) throw new Error("npm bundled dependency declarations are missing");
  for (const dependency of pkg.bundleDependencies) {
    if (typeof dependency !== "string" || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dependency) || !fs.statSync(path.join(directory, "node_modules", dependency, "package.json"), { throwIfNoEntry: false })?.isFile()) throw new Error(`Incomplete npm bundled dependency: ${dependency}`);
  }
}
function treeDigest(directory) {
  const hash = createHash("sha256");
  const visit = (relative = "") => {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      if (!relative && name === STAMP) continue;
      const child = path.join(relative, name), full = path.join(directory, child), stat = fs.lstatSync(full);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) { hash.update(child.split(path.sep).join("/")); hash.update("\0"); hash.update(fs.readFileSync(full)); hash.update("\0"); }
      else throw new Error("npm runtime must not contain links or special files");
    }
  };
  visit(); return hash.digest("hex");
}
async function readArchive(rootDir, lock, fetchImpl) {
  const cacheDir = path.join(rootDir, ".cache", "npm-runtime");
  const archivePath = path.join(cacheDir, `npm-${lock.version}.tgz`);
  if (fs.existsSync(archivePath)) {
    const archive = fs.readFileSync(archivePath); verifyNpmArchive(archive, lock); return archive;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchImpl(lock.url, { redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`npm runtime download failed: HTTP ${response.status}`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) { controller.abort(); throw new Error("npm runtime archive exceeds size limit"); }
      chunks.push(Buffer.from(chunk));
    }
    const archive = Buffer.concat(chunks); verifyNpmArchive(archive, lock);
    fs.mkdirSync(cacheDir, { recursive: true });
    const temporary = `${archivePath}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, archive, { flag: "wx" }); fs.renameSync(temporary, archivePath); }
    finally { fs.rmSync(temporary, { force: true }); }
    return archive;
  } finally { clearTimeout(timeout); }
}
export async function stageNpmRuntime(rootDir = process.cwd(), { fetchImpl = globalThis.fetch, platform = process.platform } = {}) {
  const lock = readNpmRuntimeLock(rootDir);
  const runtimeDir = desktopNodeRuntimeDir(rootDir), destination = path.join(runtimeDir, "npm");
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(destination, STAMP), "utf8"));
    if (stamp.version === lock.version && stamp.integrity === lock.integrity && stamp.treeSha256 === treeDigest(destination)) {
      validatePackage(destination, lock); return { path: destination, version: lock.version, integrity: lock.integrity };
    }
  } catch { /* Rebuild incomplete generated resources from the verified archive. */ }
  const archive = await readArchive(rootDir, lock, fetchImpl);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(runtimeDir, ".npm-stage-"));
  const backup = path.join(runtimeDir, `.npm-backup-${randomUUID()}`);
  let movedOld = false;
  try {
    extractNpmArchive(archive, temporary, platform); validatePackage(temporary, lock);
    fs.writeFileSync(path.join(temporary, STAMP), `${JSON.stringify({ version: lock.version, integrity: lock.integrity, treeSha256: treeDigest(temporary) }, null, 2)}\n`);
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); movedOld = true; }
    try { fs.renameSync(temporary, destination); }
    catch (error) { if (movedOld) fs.renameSync(backup, destination); throw error; }
    if (movedOld) fs.rmSync(backup, { recursive: true });
    return { path: destination, version: lock.version, integrity: lock.integrity };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await stageNpmRuntime();
  console.log(`Staged pinned npm ${result.version} at ${result.path}`);
}
