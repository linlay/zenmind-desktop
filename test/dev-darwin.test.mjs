import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { prepareDarwinDevElectronApp } from "../scripts/platform/dev-darwin.mjs";
import { brandIconDir } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const { embeddedNodeExecutable } = require("../dist-electron/main/modules/services/manager/embedded-node-runtime.js");
const darwinOnly = { skip: process.platform !== "darwin" };

function fixture(t, { declaredName, binaryName = "Electron Helper", background = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-dev-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brand = { id: "cutej", productName: "CuteJ", appId: "cc.cutej.desktop" };
  const contents = path.join(root, "Electron.app", "Contents");
  const main = path.join(contents, "MacOS", "Electron");
  const helperContents = path.join(contents, "Frameworks", "Electron Helper.app", "Contents");
  const helper = path.join(helperContents, "MacOS", binaryName);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, "main", { mode: 0o755 });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "helper", { mode: 0o755 });
  const plist = path.join(helperContents, "Info.plist");
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>LSUIElement</key><${background ? "true" : "false"}/>
<key>CFBundleName</key><string>Electron Helper</string>
${declaredName === undefined ? "" : `<key>CFBundleExecutable</key><string>${declaredName}</string>`}
</dict></plist>`);
  fs.writeFileSync(path.join(contents, "Info.plist"), '<plist version="1.0"><dict></dict></plist>');
  // Renderer/GPU helpers must not be selected or modified.
  const renderer = path.join(contents, "Frameworks", "Electron Helper (Renderer).app", "Contents");
  fs.mkdirSync(renderer, { recursive: true });
  fs.copyFileSync(plist, path.join(renderer, "Info.plist"));
  const icons = brandIconDir(root, brand);
  fs.mkdirSync(icons, { recursive: true });
  for (const name of ["icon.icns", "icon.png"]) fs.writeFileSync(path.join(icons, name), "icon");
  fs.writeFileSync(path.join(root, "VERSION"), "v0.4.16\n");
  return { root, brand, main, helper, plist };
}

function readPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

test("macOS dev preparation fills stock Helper metadata and satisfies the runtime gate", darwinOnly, async t => {
  const input = fixture(t);
  const original = fs.readFileSync(input.plist, "utf8");
  await assert.rejects(embeddedNodeExecutable(input.main, "darwin"), /CFBundleExecutable/);
  const result = prepareDarwinDevElectronApp(input.main, input.root, input.brand);
  const helper = await embeddedNodeExecutable(result.binaryPath, "darwin");
  const info = readPlist(path.join(path.dirname(path.dirname(helper)), "Info.plist"));
  assert.equal(info.CFBundleExecutable, "Electron Helper");
  assert.equal(info.LSUIElement, true);
  assert.equal(fs.readFileSync(input.plist, "utf8"), original);
  const rendererPlist = path.join(result.appRoot, "Contents/Frameworks/Electron Helper (Renderer).app/Contents/Info.plist");
  assert.equal(fs.readFileSync(rendererPlist, "utf8"), original);
  // A second dev launch rebuilds from the unchanged dependency and remains valid.
  const rebuilt = prepareDarwinDevElectronApp(input.main, input.root, input.brand);
  assert.equal(await embeddedNodeExecutable(rebuilt.binaryPath, "darwin"), helper);
});

test("macOS dev preparation preserves an explicitly declared Helper executable", darwinOnly, async t => {
  const input = fixture(t, { declaredName: "Background Node", binaryName: "Background Node" });
  const result = prepareDarwinDevElectronApp(input.main, input.root, input.brand);
  const helper = await embeddedNodeExecutable(result.binaryPath, "darwin");
  assert.equal(path.basename(helper), "Background Node");
  assert.equal(fs.readFileSync(path.join(path.dirname(path.dirname(helper)), "Info.plist"), "utf8"), fs.readFileSync(input.plist, "utf8"));
});

test("macOS dev preparation rejects foreground, missing and non-executable Helpers", darwinOnly, t => {
  const foreground = fixture(t, { background: false });
  assert.throws(() => prepareDarwinDevElectronApp(foreground.main, foreground.root, foreground.brand), /LSUIElement/);
  const missing = fixture(t);
  fs.unlinkSync(missing.helper);
  assert.throws(() => prepareDarwinDevElectronApp(missing.main, missing.root, missing.brand), /ENOENT/);
  const nonExecutable = fixture(t);
  fs.chmodSync(nonExecutable.helper, 0o644);
  assert.throws(() => prepareDarwinDevElectronApp(nonExecutable.main, nonExecutable.root, nonExecutable.brand), /EACCES/);
});
