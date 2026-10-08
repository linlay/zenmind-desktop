import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildDarwinDevOpenArgs, prepareDarwinDevElectronApp } from "../scripts/platform/dev-darwin.mjs";
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
  fs.writeFileSync(path.join(contents, "Info.plist"), '<plist version="1.0"><dict><key>LSEnvironment</key><dict><key>PATH</key><string>/previous/dev/session/bin</string></dict></dict></plist>');
  // Renderer/GPU helpers must not be selected or modified.
  const renderer = path.join(contents, "Frameworks", "Electron Helper (Renderer).app", "Contents");
  fs.mkdirSync(renderer, { recursive: true });
  fs.copyFileSync(plist, path.join(renderer, "Info.plist"));
  const icons = brandIconDir(root, brand);
  fs.mkdirSync(icons, { recursive: true });
  for (const name of ["icon.icns", "icon.png"]) fs.writeFileSync(path.join(icons, name), "icon");
  fs.writeFileSync(path.join(root, "VERSION"), "v0.4.16\n");
  const signingCalls = [];
  const input = { root, brand, main, helper, plist, icons, signingCalls };
  // These plain-text binaries exercise metadata validation, not native signing.
  input.signApp = appRoot => {
    signingCalls.push(appRoot);
    assertPreparedMetadata(appRoot, input);
  };
  return input;
}

function readPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

function withLaunchEnvironment(values, run) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readSignatureIdentity(appRoot) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot], {
    timeout: 60000, stdio: ["ignore", "pipe", "pipe"]
  });
  const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", "-r-", appRoot], {
    encoding: "utf8", timeout: 10000
  });
  assert.ifError(signature.error);
  assert.equal(signature.status, 0, signature.stderr);
  const output = `${signature.stdout}\n${signature.stderr}`;
  const identity = {
    identifier: output.match(/^Identifier=(.+)$/mu)?.[1],
    codeDirectory: output.match(/^CodeDirectory (.+)$/mu)?.[1],
    cdhash: output.match(/^CDHash=([a-f0-9]+)$/mu)?.[1],
    designatedRequirement: output.match(/^(?:# )?designated => (.+)$/mu)?.[1]
  };
  assert.equal(identity.identifier, "cc.cutej.desktop.dev");
  assert.ok(identity.codeDirectory);
  assert.match(identity.cdhash, /^[a-f0-9]{40}$/u);
  assert.ok(identity.designatedRequirement);
  assert.match(output, /^Signature=adhoc$/mu);
  return identity;
}

function assertPreparedMetadata(appRoot, input) {
  assert.ok(appRoot.startsWith(`${input.root}${path.sep}`));
  assert.equal(path.basename(appRoot), `${input.brand.productName}.app`);
  const contents = path.join(appRoot, "Contents");
  const info = readPlist(path.join(contents, "Info.plist"));
  assert.equal(info.CFBundleName, input.brand.productName);
  assert.equal(info.CFBundleDisplayName, input.brand.productName);
  assert.equal(info.CFBundleIdentifier, `${input.brand.appId}.dev`);
  assert.equal(info.CFBundleExecutable, input.brand.productName);
  assert.equal(info.CFBundleShortVersionString, "0.4.16");
  assert.equal(info.CFBundleVersion, "0.4.16");
  assert.ok(info.CFBundleDevelopmentRegion);
  assert.ok(info.CFBundleLocalizations.length > 0);
  assert.equal(Object.hasOwn(info, "LSEnvironment"), false);
  fs.accessSync(path.join(contents, "MacOS", info.CFBundleExecutable), fs.constants.X_OK);
  assert.equal(fs.existsSync(path.join(contents, "MacOS", "Electron")), false);
  assert.deepEqual(fs.readFileSync(path.join(contents, "Resources", info.CFBundleIconFile)), fs.readFileSync(path.join(input.icons, "icon.icns")));
  assert.deepEqual(fs.readFileSync(path.join(contents, "Resources", "icon.png")), fs.readFileSync(path.join(input.icons, "icon.png")));
  const helperContents = path.join(contents, "Frameworks", "Electron Helper.app", "Contents");
  const helperInfo = readPlist(path.join(helperContents, "Info.plist"));
  assert.equal(helperInfo.LSUIElement, true);
  assert.equal(helperInfo.CFBundleExecutable, path.basename(input.helper));
  fs.accessSync(path.join(helperContents, "MacOS", helperInfo.CFBundleExecutable), fs.constants.X_OK);
}

test("macOS dev preparation fills stock Helper metadata and satisfies the runtime gate", darwinOnly, async t => {
  const input = fixture(t);
  const original = fs.readFileSync(input.plist, "utf8");
  await assert.rejects(embeddedNodeExecutable(input.main, "darwin"), /CFBundleExecutable/);
  const result = prepareDarwinDevElectronApp(input.main, input.root, input.brand, input.signApp);
  assert.deepEqual(input.signingCalls, [result.appRoot]);
  const helper = await embeddedNodeExecutable(result.binaryPath, "darwin");
  const info = readPlist(path.join(path.dirname(path.dirname(helper)), "Info.plist"));
  assert.equal(info.CFBundleExecutable, "Electron Helper");
  assert.equal(info.LSUIElement, true);
  assert.equal(fs.readFileSync(input.plist, "utf8"), original);
  const rendererPlist = path.join(result.appRoot, "Contents/Frameworks/Electron Helper (Renderer).app/Contents/Info.plist");
  assert.equal(fs.readFileSync(rendererPlist, "utf8"), original);
  // A second dev launch rebuilds from the unchanged dependency and remains valid.
  const rebuilt = prepareDarwinDevElectronApp(input.main, input.root, input.brand, input.signApp);
  assert.deepEqual(input.signingCalls, [result.appRoot, rebuilt.appRoot]);
  assert.equal(await embeddedNodeExecutable(rebuilt.binaryPath, "darwin"), helper);
});

test("macOS dev preparation preserves an explicitly declared Helper executable", darwinOnly, async t => {
  const input = fixture(t, { declaredName: "Background Node", binaryName: "Background Node" });
  const result = prepareDarwinDevElectronApp(input.main, input.root, input.brand, input.signApp);
  assert.deepEqual(input.signingCalls, [result.appRoot]);
  const helper = await embeddedNodeExecutable(result.binaryPath, "darwin");
  assert.equal(path.basename(helper), "Background Node");
  assert.equal(fs.readFileSync(path.join(path.dirname(path.dirname(helper)), "Info.plist"), "utf8"), fs.readFileSync(input.plist, "utf8"));
});

test("macOS dev preparation rejects foreground, missing and non-executable Helpers", darwinOnly, t => {
  const foreground = fixture(t, { background: false });
  assert.throws(() => prepareDarwinDevElectronApp(foreground.main, foreground.root, foreground.brand, foreground.signApp), /LSUIElement/);
  assert.deepEqual(foreground.signingCalls, []);
  const missing = fixture(t);
  fs.unlinkSync(missing.helper);
  assert.throws(() => prepareDarwinDevElectronApp(missing.main, missing.root, missing.brand, missing.signApp), /ENOENT/);
  assert.deepEqual(missing.signingCalls, []);
  const nonExecutable = fixture(t);
  fs.chmodSync(nonExecutable.helper, 0o644);
  assert.throws(() => prepareDarwinDevElectronApp(nonExecutable.main, nonExecutable.root, nonExecutable.brand, nonExecutable.signApp), /EACCES/);
  assert.deepEqual(nonExecutable.signingCalls, []);
});

test("macOS dev preparation propagates signing failure without returning a prepared app", darwinOnly, t => {
  const input = fixture(t);
  const signingFailure = new Error("fixture codesign failed");
  let preparedApp;
  assert.throws(() => {
    preparedApp = prepareDarwinDevElectronApp(input.main, input.root, input.brand, appRoot => {
      input.signApp(appRoot);
      throw signingFailure;
    });
  }, error => error === signingFailure);
  assert.equal(preparedApp, undefined);
  assert.equal(input.signingCalls.length, 1);
});

test("macOS dev open arguments pass runtime environment separately from the signed bundle", darwinOnly, t => {
  const input = fixture(t);
  const preparedApp = { appRoot: path.join(input.root, "dev apps", "CuteJ.app") };
  const launchValues = {
    PATH: `${path.join(input.root, "codex-session-a", "bin")}:${process.env.PATH ?? ""}`,
    DESKTOP_NODE_BIN: path.join(input.root, "node runtime", "node"),
    MallocNanoZone: "0"
  };
  const args = withLaunchEnvironment(launchValues, () => buildDarwinDevOpenArgs(preparedApp, input.root, input.brand));
  assert.deepEqual(args.slice(0, 2), ["-n", "-W"]);
  const appIndex = args.indexOf(preparedApp.appRoot);
  assert.ok(appIndex > 2);
  assert.deepEqual(args.slice(appIndex), [preparedApp.appRoot, "--args", input.root]);
  const launchEnvironment = {};
  for (let index = 2; index < appIndex; index += 2) {
    assert.equal(args[index], "--env");
    const separator = args[index + 1].indexOf("=");
    assert.ok(separator > 0);
    const key = args[index + 1].slice(0, separator);
    assert.equal(Object.hasOwn(launchEnvironment, key), false);
    launchEnvironment[key] = args[index + 1].slice(separator + 1);
  }
  assert.deepEqual(launchEnvironment, {
    MallocNanoZone: "0",
    PATH: launchValues.PATH,
    BRAND: input.brand.id,
    DESKTOP_BRAND_JSON: path.join(input.root, "build", "brands", input.brand.id, "generated", "brand.json"),
    DESKTOP_BUILTIN_ASSETS_ROOT: path.join(input.root, "build", "resources", "services"),
    DESKTOP_DEV_RESOURCES_ROOT: path.join(input.root, "build", "brands", input.brand.id, "resources"),
    DESKTOP_NODE_BIN: launchValues.DESKTOP_NODE_BIN,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  });
  for (const emptyPath of [undefined, ""]) {
    const defaults = withLaunchEnvironment({ PATH: emptyPath, DESKTOP_NODE_BIN: undefined, MallocNanoZone: undefined },
      () => buildDarwinDevOpenArgs(preparedApp, input.root, input.brand));
    assert.equal(defaults.some(value => value.startsWith("PATH=")), false, "omit an unset or empty PATH override");
    assert.ok(defaults.includes(`DESKTOP_NODE_BIN=${process.execPath}`));
    assert.ok(defaults.includes("MallocNanoZone=0"));
  }
});

test("macOS dev signing identity is stable across runtime PATH and Node changes", darwinOnly, t => {
  const input = fixture(t);
  const electronBinary = require("electron");
  const sourceAppRoot = path.dirname(path.dirname(path.dirname(electronBinary)));
  const sourceContents = path.join(sourceAppRoot, "Contents");
  const sourcePlistPath = path.join(sourceContents, "Info.plist");
  const sourceHelperPlistPath = path.join(sourceContents, "Frameworks", "Electron Helper.app", "Contents", "Info.plist");
  const sourcePlist = fs.readFileSync(sourcePlistPath);
  const sourceHelperPlist = fs.readFileSync(sourceHelperPlistPath);
  const sourceBinaryHash = createHash("sha256").update(fs.readFileSync(electronBinary)).digest("hex");
  fs.copyFileSync(path.join(sourceContents, "Resources", "electron.icns"), path.join(input.icons, "icon.icns"));
  fs.writeFileSync(path.join(input.icons, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64"));

  const hostPath = process.env.PATH ?? "";
  const launchEnvironments = [
    { PATH: `${path.join(input.root, "codex-session-a", "bin")}:${hostPath}`, DESKTOP_NODE_BIN: undefined },
    { PATH: `${path.join(input.root, "npm-session-b", "bin")}:${hostPath}`, DESKTOP_NODE_BIN: path.join(input.root, "node runtime b", "node") }
  ];
  let firstIdentity;
  let firstPlist;
  for (const launchEnvironment of launchEnvironments) {
    // Each preparation copies and re-signs the same dependency in the temp root.
    // Runtime paths must not alter its sealed contents or saved-permission identity.
    const result = withLaunchEnvironment(launchEnvironment,
      () => prepareDarwinDevElectronApp(electronBinary, input.root, input.brand));
    assertPreparedMetadata(result.appRoot, input);
    const identity = readSignatureIdentity(result.appRoot);
    const plistPath = path.join(result.appRoot, "Contents", "Info.plist");
    assert.equal(identity.identifier, readPlist(plistPath).CFBundleIdentifier);
    assert.equal(identity.identifier, result.bundleId);
    if (firstIdentity) {
      assert.deepEqual(identity, firstIdentity);
      assert.deepEqual(fs.readFileSync(plistPath), firstPlist);
    } else {
      firstIdentity = identity;
      firstPlist = fs.readFileSync(plistPath);
    }
  }
  t.diagnostic(`stable signing identity: ${JSON.stringify(firstIdentity)}`);
  assert.deepEqual(fs.readFileSync(sourcePlistPath), sourcePlist);
  assert.deepEqual(fs.readFileSync(sourceHelperPlistPath), sourceHelperPlist);
  assert.equal(createHash("sha256").update(fs.readFileSync(electronBinary)).digest("hex"), sourceBinaryHash);
});
