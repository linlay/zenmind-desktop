import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plist from "plist";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { loadBrandConfig, brandIconDir } from "../scripts/lib/brand-config.mjs";
import { resolveDarwinDevSigningIdentity } from "../scripts/lib/mac-dev-signing.mjs";
import {
  buildMacShareExtension, macShareExtensionInfo, macShareExtensionPath,
  macShareExtensionSourceRoot, macShareExtensionModuleCachePath, signMacShareExtension, verifyMacShareExtension
} from "../scripts/lib/mac-share-extension.mjs";

const require = createRequire(import.meta.url);
const afterPack = require("../scripts/after-pack.js").default;
const brand = loadBrandConfig(process.cwd(), "cutej");
const onlyDarwin = { skip: process.platform !== "darwin" };
const entitlements = {
  "com.apple.security.app-sandbox": true,
  "com.apple.security.files.user-selected.read-only": true,
  "com.apple.security.network.server": true
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-share-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "VERSION"), "v0.4.45\n");
  const icons = brandIconDir(root, brand);
  fs.mkdirSync(icons, { recursive: true });
  fs.copyFileSync(path.join(brandIconDir(process.cwd(), brand), "icon.icns"), path.join(icons, "icon.icns"));
  return { root, app: path.join(root, "CuteJ.app") };
}

function writeMetadataFixture(app, hostBundleId = brand.appId) {
  const extension = macShareExtensionPath(app);
  const contents = path.join(extension, "Contents");
  const info = macShareExtensionInfo({ hostBundleId, productName: brand.productName, scheme: brand.protocols.open.scheme, version: "0.4.45" });
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(info));
  fs.writeFileSync(path.join(contents, "MacOS", info.CFBundleExecutable), "fixture", { mode: 0o755 });
  return extension;
}

test("sharing metadata derives dev/release identities, name and URL protocol from the containing brand", () => {
  for (const hostBundleId of [brand.appId, `${brand.appId}.dev`]) {
    const info = macShareExtensionInfo({ hostBundleId, productName: brand.productName, scheme: "cutej", version: "v0.4.45" });
    assert.equal(info.CFBundleIdentifier, `${hostBundleId}.share`);
    assert.equal(info.DesktopShareHostBundleIdentifier, hostBundleId);
    assert.equal(info.DesktopShareURLScheme, "cutej");
    assert.equal(info.CFBundleDisplayName, "CuteJ");
    assert.equal(info.NSExtension.NSExtensionPointIdentifier, "com.apple.share-services");
    assert.equal(info.NSExtension.NSExtensionActivationRule, undefined);
    assert.equal(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule.NSExtensionActivationSupportsFileWithMaxCount, 16);
  }
  assert.throws(() => macShareExtensionInfo({ hostBundleId: brand.appId, productName: "CuteJ", version: "0.4.45" }), /explicit open URL scheme/u);
});

test("Windows packaging never invokes the native macOS sharing build", async () => {
  await afterPack({ electronPlatformName: "win32", appOutDir: "missing Windows output" });
  assert.throws(() => buildMacShareExtension({ projectRoot: "missing Windows project", brand, appPath: "output", platform: "win32", version: "0.4.45",
    run: () => assert.fail("Windows must not execute xcrun or swiftc")
  }), /only be built on macOS/u);
});

test("native build failure preserves an existing installed extension", onlyDarwin, t => {
  const { root, app } = fixture(t);
  const extension = writeMetadataFixture(app);
  const sentinel = path.join(extension, "prior-build.txt");
  fs.writeFileSync(sentinel, "prior extension");
  const failed = new Error("fixture compiler failure");
  assert.throws(() => buildMacShareExtension({ projectRoot: root, brand, appPath: app,
    run: (_program, args) => {
      if (args.includes("--show-sdk-path")) return "/fixture/SDK";
      if (args.includes("--find")) return "/fixture/swiftc";
      if (args.includes("--version")) return "fixture swift";
      throw failed;
    }
  }), error => error === failed);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "prior extension");
});

test("extension signing uses sandbox entitlements and never inherits Electron JIT", t => {
  const { app } = fixture(t);
  const extension = writeMetadataFixture(app);
  const commands = [];
  const run = (program, args) => {
    commands.push({ program, args });
    if (args.includes("--display")) return plist.build(entitlements);
    return "";
  };
  assert.equal(signMacShareExtension({ appPath: app, hostBundleId: brand.appId, identity: "Developer ID Application: Fixture", keychain: "fixture.keychain", run }), extension);
  const sign = commands[0].args;
  assert.equal(sign.at(-1), extension);
  assert.ok(sign.includes("--timestamp"));
  assert.ok(sign.includes("runtime"));
  assert.ok(sign.includes("fixture.keychain"));
  const file = sign[sign.indexOf("--entitlements") + 1];
  assert.deepEqual(plist.parse(fs.readFileSync(file, "utf8")), entitlements);
  assert.ok(commands.some(command => command.args.includes("--verify") && command.args.includes("--strict")));
  for (const extra of ["com.apple.security.cs.allow-jit", "com.apple.security.network.client"]) {
    assert.throws(() => verifyMacShareExtension(app, { hostBundleId: brand.appId, development: true,
      run: () => plist.build({ ...entitlements, [extra]: true })
    }), /Electron JIT/u);
  }
});

test("release verification requires the sharing extension to have the containing app's Apple publisher", t => {
  const { app } = fixture(t);
  const extension = writeMetadataFixture(app);
  const verified = [];
  verifyMacShareExtension(app, { hostBundleId: brand.appId, run: () => plist.build(entitlements),
    verifyRelease: (file, options) => {
      verified.push({ file, options });
      return { teamIdentifier: "FIXTURETEAM" };
    }
  });
  assert.deepEqual(verified, [
    { file: app, options: { expectedBundleId: brand.appId } },
    { file: extension, options: { expectedBundleId: `${brand.appId}.share`, expectedTeamId: "FIXTURETEAM" } }
  ]);
  assert.throws(() => verifyMacShareExtension(app, { hostBundleId: `${brand.appId}.dev`, run: () => plist.build(entitlements) }), /does not match/u);
});

test("actual Swift extension compiles with extension-safe APIs, is cacheable and verifies with its own sandbox signature", onlyDarwin, t => {
  const { root, app } = fixture(t);
  const hostBundleId = `${brand.appId}.dev`;
  const commands = [];
  const run = (program, args, options) => {
    commands.push({ program, args });
    return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  };
  const extension = buildMacShareExtension({ projectRoot: root, brand, appPath: app, hostBundleId, run });
  const compile = commands.filter(command => command.args.includes("-application-extension"));
  assert.equal(compile.length, 1);
  assert.ok(compile[0].args.includes("_NSExtensionMain"));
  const info = plist.parse(fs.readFileSync(path.join(extension, "Contents", "Info.plist"), "utf8"));
  const executable = path.join(extension, "Contents", "MacOS", info.CFBundleExecutable);
  assert.match(execFileSync("/usr/bin/file", [executable], { encoding: "utf8" }), /Mach-O.*executable/u);
  const executableBytes = fs.readFileSync(executable);
  buildMacShareExtension({ projectRoot: root, brand, appPath: app, hostBundleId, run });
  assert.equal(commands.filter(command => command.args.includes("-application-extension")).length, 1, "unchanged source must reuse native output");
  assert.deepEqual(fs.readFileSync(executable), executableBytes);
  const signingRoot = path.join(root, "signing");
  const signing = resolveDarwinDevSigningIdentity(hostBundleId, { signingRoot, env: {} });
  t.after(() => spawnSync("/usr/bin/security", ["delete-keychain", path.join(signingRoot, "development.keychain-db")]));
  signMacShareExtension({ appPath: app, hostBundleId, ...signing, development: true });
  assert.equal(verifyMacShareExtension(app, { hostBundleId, development: true }), extension);
});

test("actual Swift inbox preserves ZIP bytes and enforces atomic, private, bounded and cancellable transfer", onlyDarwin, t => {
  const { root } = fixture(t);
  const output = path.join(root, "share-inbox-acceptance");
  const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos12.0`, "-sdk", sdk,
    "-module-cache-path", macShareExtensionModuleCachePath(),
    path.join(macShareExtensionSourceRoot, "ShareInbox.swift"),
    path.join(process.cwd(), "test", "fixtures", "mac-share-inbox.swift"), "-o", output
  ], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(execFileSync(output, [], { encoding: "utf8", timeout: 10_000 }), /MAC_SHARE_INBOX_ACCEPTANCE_OK/u);
});
