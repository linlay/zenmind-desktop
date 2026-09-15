import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { stageNpmRuntime, extractNpmArchive, readNpmRuntimeLock } from "../scripts/stage-npm-runtime.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";
import { loadBrandConfig } from "../scripts/lib/brand-config.mjs";

function archive(entries) {
  const blocks = [];
  for (const { name, content = "", type = "0" } of entries) {
    const data = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257);
    const sum = [...header].reduce((a, b) => a + b, 0); header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function validArchive(version = "10.9.4") {
  return archive([
    { name: "package/package.json", content: JSON.stringify({ name: "npm", version, bundleDependencies: ["example-dependency"] }) },
    { name: "package/bin/npm-cli.js", content: "console.log('npm fixture')" },
    { name: "package/bin/npx-cli.js", content: "console.log('npx fixture')" },
    { name: "package/lib/cli.js", content: "module.exports = {}" },
    { name: "package/LICENSE", content: "test license" },
    { name: "package/node_modules/example-dependency/package.json", content: '{"name":"example-dependency","version":"1.0.0"}' },
  ]);
}
function fixture(t, body = validArchive()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop npm resources "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  const lock = { name: "npm", version: "10.9.4", url: "https://registry.npmjs.org/npm/-/npm-10.9.4.tgz", integrity: `sha512-${createHash("sha512").update(body).digest("base64")}` };
  fs.writeFileSync(path.join(root, "scripts", "npm-runtime-lock.json"), JSON.stringify(lock));
  let downloads = 0;
  const fetchImpl = async (url, options) => { downloads++; assert.equal(url, lock.url); assert.equal(options.redirect, "error"); return new Response(body); };
  return { root, lock, fetchImpl, downloads: () => downloads };
}
for (const platform of ["darwin", "win32"]) {
  test(`stages npm plus bundled dependencies with no host package installation on ${platform}`, async t => {
    const f = fixture(t);
    const result = await stageNpmRuntime(f.root, { fetchImpl: f.fetchImpl, platform });
    assert.equal(result.version, "10.9.4");
    assert.equal(result.path, path.join(f.root, "build", "resources", "node-runtime", "npm"));
    assert.equal(fs.existsSync(path.join(result.path, "bin", "npm-cli.js")), true);
    assert.equal(fs.existsSync(path.join(result.path, "bin", "npx-cli.js")), true);
    assert.equal(fs.existsSync(path.join(result.path, "node_modules", "example-dependency", "package.json")), true);
    assert.equal(fs.existsSync(path.join(f.root, "node_modules")), false);
    assert.equal(f.downloads(), 1);
    await stageNpmRuntime(f.root, { platform, fetchImpl: async () => { throw new Error("offline"); } });
    fs.writeFileSync(path.join(result.path, "lib", "cli.js"), "damaged");
    await stageNpmRuntime(f.root, { platform, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(fs.readFileSync(path.join(result.path, "lib", "cli.js"), "utf8"), "module.exports = {}");
  });
}
test("invalid download integrity preserves previously staged resources", async t => {
  const f = fixture(t), previous = path.join(f.root, "build", "resources", "node-runtime", "npm");
  fs.mkdirSync(previous, { recursive: true }); fs.writeFileSync(path.join(previous, "previous"), "preserve me");
  await assert.rejects(stageNpmRuntime(f.root, { fetchImpl: async () => new Response("wrong archive") }), /integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(previous, "previous"), "utf8"), "preserve me");
});
test("valid archive digest cannot hide a wrong npm package version", async t => {
  const f = fixture(t, validArchive("99.0.0"));
  await assert.rejects(stageNpmRuntime(f.root, { fetchImpl: f.fetchImpl }), /identity mismatch/);
});
for (const entry of [
  { name: "package/../../outside" }, { name: "package/C:/outside" },
  { name: "package/link", type: "2" }, { name: "package/link", type: "1" },
]) {
  test(`rejects unsafe tar entry ${entry.name} (${entry.type || "file"})`, t => {
    const f = fixture(t), destination = path.join(f.root, "extracted"); fs.mkdirSync(destination);
    assert.throws(() => extractNpmArchive(archive([entry]), destination), /Unsupported npm tar entry/);
    assert.equal(fs.existsSync(path.join(f.root, "outside")), false);
  });
}
test("the repository pins one official npm source and packages node-runtime for both desktop platforms", () => {
  const root = process.cwd(), lock = readNpmRuntimeLock(root);
  assert.equal(lock.version, "10.9.4");
  assert.equal(lock.integrity, "sha512-OnUG836FwboQIbqtefDNlyR0gTHzIfwRfE3DuiNewBvnMnWEpB0VEXwBlFVgqpNzIgYo/MHh3d2Hel/pszapAA==");
  const brand = loadBrandConfig(root, "cutej");
  for (const target of [{ os: "darwin", arch: "arm64" }, { os: "win32", arch: "x64" }, { os: "win32", arch: "arm64" }]) {
    const resource = electronBuilderConfig(brand, target).extraResources.find(value => value.to === "node-runtime");
    assert.deepEqual(resource, { from: "build/resources/node-runtime", to: "node-runtime", filter: target.os === "win32" ? ["npm/**/*", `${target.arch === "x64" ? "amd64" : "arm64"}/node.exe`] : ["npm/**/*"] });
  }
});

test("electron-builder filters retain npm dotfiles and only the target Windows PE", t => {
  const f = fixture(t);
  const require = createRequire(import.meta.url);
  const { FileMatcher } = require("app-builder-lib/out/fileMatcher.js");
  const root = process.cwd(), brand = loadBrandConfig(root, "cutej");
  const source = path.join(f.root, "resources");
  const entries = ["npm/bin/npm-cli.js", "npm/node_modules/example/.keep", "npm/.desktop-resource.json", "amd64/node.exe", "arm64/node.exe", "amd64/node-launcher-build.json"];
  for (const entry of entries) { const file = path.join(source, entry); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); }
  for (const target of [{ os: "darwin", arch: "arm64" }, { os: "win32", arch: "x64" }, { os: "win32", arch: "arm64" }]) {
    const resource = electronBuilderConfig(brand, target).extraResources.find(value => value.to === "node-runtime");
    const matcher = new FileMatcher(source, path.join(f.root, "packaged"), value => value, resource.filter);
    const filter = matcher.createFilter();
    const accepted = entries.filter(entry => filter(path.join(source, entry), fs.statSync(path.join(source, entry))));
    const expected = entries.slice(0, 3);
    if (target.os === "win32") expected.push(target.arch === "x64" ? "amd64/node.exe" : "arm64/node.exe");
    assert.deepEqual(accepted, expected);
  }
});
