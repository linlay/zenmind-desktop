import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { signDarwinServiceDirectory, signMachOFile, computeAssetSignature } from "../scripts/lib/builtin-assets.mjs";

const require = createRequire(import.meta.url);
const { sign, prepareDarwinAppServices } = require("../scripts/sign-mac-app.js");
const { runPlatformBuiltinsManifest } = require("../scripts/lib/platform-builtins.js");
const { copyDarwinServiceResources } = require("../scripts/lib/mac-service-resources.js");

test("timestamp errors retry with a bound; other signing and verification errors fail immediately", (t) => {
  const saved = [process.env.SKIP_NOTARIZE, process.env.DESKTOP_SKIP_MAC_TIMESTAMP];
  process.env.SKIP_NOTARIZE = "false";
  process.env.DESKTOP_SKIP_MAC_TIMESTAMP = "false";
  t.after(() => {
    for (const [index, key] of ["SKIP_NOTARIZE", "DESKTOP_SKIP_MAC_TIMESTAMP"].entries()) {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    }
  });
  for (const scenario of ["recover", "exhaust", "certificate", "verify"]) {
    let attempts = 0;
    let verified = 0;
    const waits = [];
    const invoke = () => signMachOFile("binary", "identity", {
      wait: (ms) => waits.push(ms),
      run: (_cmd, args) => {
        if (args.includes("--verify")) {
          verified++;
          if (scenario === "verify") throw new Error("verification failed");
          return "";
        }
        assert.ok(args.includes("--timestamp"));
        attempts++;
        if (scenario === "certificate") throw new Error("invalid certificate");
        if (scenario === "exhaust" || (scenario === "recover" && attempts < 3)) {
          throw new Error("A timestamp was expected but was not found.");
        }
        return "";
      }
    });
    if (scenario === "recover") invoke();
    else assert.throws(invoke, /timestamp|certificate|verification/);
    assert.equal(attempts, ["recover", "exhaust"].includes(scenario) ? 3 : 1);
    assert.equal(verified, ["recover", "verify"].includes(scenario) ? 1 : 0);
    assert.deepEqual(waits, attempts === 3 ? [1000, 2000] : []);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-builtin-signing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ["bin/rg", "connectors/builtin.dbx/bin/dbx"]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  return root;
}

test("Darwin packaging preserves empty directories and modes before signing", (t) => {
  const root = fixture(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "packaged");
  const empty = "agent-platform/v1/connectors/builtin.dbx/bin/libs";
  fs.mkdirSync(path.join(source, empty), { recursive: true });
  const file = path.join(source, "agent-platform/v1/helper");
  fs.writeFileSync(file, "signed payload");
  fs.chmodSync(file, 0o750);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "obsolete"), "old");
  const verified = [];
  copyDarwinServiceResources(source, destination, (dir) => {
    assert.equal(fs.statSync(path.join(dir, empty)).isDirectory(), true);
    verified.push(dir);
  });
  assert.deepEqual(verified, [source, destination]);
  assert.equal(fs.existsSync(path.join(destination, "obsolete")), false);
  assert.equal(computeAssetSignature(source), computeAssetSignature(destination));
  assert.throws(() => copyDarwinServiceResources(source, path.join(source, "nested")), /must not overlap/u);
});

test("service signing verifies input, signs every Mach-O, then delegates refresh and verification", (t) => {
  const root = fixture(t);
  const events = [];
  let signingRoot;
  signDarwinServiceDirectory(root, { id: "agent-platform" }, "identity", {
    keychain: "keychain",
    runManifest: (dir, action, expected) => {
      if (events.length === 0) assert.equal(dir, root);
      else {
        assert.notEqual(dir, root);
        signingRoot = dir;
      }
      events.push(action);
      if (action === "refresh-after-signing") assert.equal(expected, "receipt");
      return { manifestSha256: "receipt" };
    },
    signFile: (file, identity, options) => {
      assert.equal(identity, "identity");
      assert.equal(options.keychain, "keychain");
      events.push(`sign:${path.relative(signingRoot, file).split(path.sep).join("/")}`);
    }
  });
  assert.equal(events[0], "verify");
  assert.equal(events[1], "verify");
  assert.deepEqual(events.slice(2, -2).sort(), ["sign:bin/rg", "sign:connectors/builtin.dbx/bin/dbx"]);
  assert.deepEqual(events.slice(-2), ["refresh-after-signing", "verify"]);
});

test("invalid input or signing failure never gets a refreshed manifest", (t) => {
  for (const failure of ["verify", "sign"]) {
    const events = [];
    assert.throws(() => signDarwinServiceDirectory(fixture(t), { id: "agent-platform" }, "identity", {
      runManifest: (_dir, action) => {
        events.push(action);
        if (failure === "verify") throw new Error("corrupt original");
        return { manifestSha256: "receipt" };
      },
      signFile: () => { events.push("sign"); throw new Error("codesign failed"); }
    }), /corrupt original|codesign failed/u);
    assert.deepEqual(events, failure === "verify" ? ["verify"] : ["verify", "verify", "sign"]);
  }
});

test("failed signing, manifest refresh or final verification preserves original bytes for retry", (t) => {
  for (const failure of ["sign", "refresh-after-signing", "final-verify"]) {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, "builtins.manifest.json"), "original");
    fs.mkdirSync(path.join(root, "empty"));
    fs.symlinkSync("bin/rg", path.join(root, "rg-link"));
    fs.chmodSync(path.join(root, "bin/rg"), 0o755);
    const before = computeAssetSignature(root);
    let refreshed = false;
    const runManifest = (dir, action) => {
      if (action === "refresh-after-signing") {
        refreshed = true;
        fs.writeFileSync(path.join(dir, "builtins.manifest.json"), "signed");
      }
      if (action === failure || (failure === "final-verify" && refreshed && action === "verify")) {
        throw new Error("injected failure");
      }
      return { manifestSha256: "receipt" };
    };
    assert.throws(() => signDarwinServiceDirectory(root, { id: "agent-platform" }, "identity", {
      runManifest,
      signFile: (file) => {
        fs.appendFileSync(file, "changed before failure");
        if (failure === "sign") throw new Error("injected failure");
      }
    }), /injected failure/u);
    assert.equal(computeAssetSignature(root), before);
    signDarwinServiceDirectory(root, { id: "agent-platform" }, "identity", {
      runManifest: () => ({ manifestSha256: "receipt" }),
      signFile: (file) => fs.appendFileSync(file, "signed")
    });
    assert.notEqual(computeAssetSignature(root), before);
    assert.equal(fs.readlinkSync(path.join(root, "rg-link")), "bin/rg");
    assert.equal(fs.statSync(path.join(root, "empty")).isDirectory(), true);
    assert.equal(fs.statSync(path.join(root, "bin/rg")).mode & 0o777, 0o755);
  }
});

test("non-Platform services retain ordinary signing without invoking Platform tools", (t) => {
  let count = 0;
  signDarwinServiceDirectory(fixture(t), { id: "identity-center" }, "identity", {
    runManifest: () => assert.fail("unexpected Platform command"),
    signFile: () => count++
  });
  assert.equal(count, 2);
});

test("final app signing skips already finalized services and preserves other signing options", async () => {
  const app = path.resolve("Test.app");
  const root = path.join(app, "Contents", "Resources", "services");
  const events = [];
  const oldIgnore = (file) => file === "existing-ignore";
  await sign({ app: "Test.app", platform: "darwin", identity: "identity", keychain: "keychain", ignore: oldIgnore }, {
    prepareServices: async (dir, identity, options) => {
      assert.equal(dir, root);
      assert.equal(identity, "identity");
      assert.equal(options.keychain, "keychain");
      events.push("prepare");
    },
    signAsync: async (options) => {
      events.push("outer sign");
      assert.equal(options.app, app);
      assert.equal(typeof options.ignore, "function");
      const ignore = options.ignore;
      assert.equal(ignore("existing-ignore"), true);
      assert.equal(ignore(path.join(root, "agent-platform/bin/rg")), true);
      assert.equal(ignore(root), true);
      assert.equal(ignore(`${root}-other/bin/rg`), false);
      assert.equal(ignore(app), false);
      assert.equal(ignore(path.join(app, "Contents/MacOS/Electron")), false);
    },
    verifyServices: (dir) => { assert.equal(dir, root); events.push("final verify"); }
  });
  assert.deepEqual(events, ["prepare", "outer sign", "final verify"]);
});

test("final packaging fails on bad inputs and on post-sign integrity failures", async () => {
  let signed = false;
  const options = { app: path.resolve("Test.app"), platform: "darwin", identity: "identity" };
  await assert.rejects(sign(options, {
    prepareServices: async () => { throw new Error("bad input"); },
    signAsync: async () => { signed = true; }
  }), /bad input/u);
  assert.equal(signed, false);
  await assert.rejects(sign(options, {
    prepareServices: async () => {}, signAsync: async () => {},
    verifyServices: () => { throw new Error("final checksum mismatch"); }
  }), /final checksum mismatch/u);
});

test("packaged asset index tracks signed bytes and the refreshed manifest", async (t) => {
  const root = fixture(t);
  const services = path.join(root, "services");
  const bundle = path.join(services, "agent-platform", "v1");
  fs.mkdirSync(bundle, { recursive: true });
  fs.cpSync(path.join(root, "bin"), path.join(bundle, "bin"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ id: "agent-platform", version: "v1", platform: { os: "darwin" } }));
  fs.writeFileSync(path.join(bundle, "builtins.manifest.json"), "original");
  const before = computeAssetSignature(bundle);
  const entry = { id: "agent-platform", version: "v1", assetType: "directory", assetFileName: "v1", assetSignature: before };
  fs.writeFileSync(path.join(services, "manifest.json"), JSON.stringify({ services: [entry] }));
  await prepareDarwinAppServices(services, "identity", {
    signFile: (file) => fs.appendFileSync(file, "signed"),
    runManifest: (dir, action) => {
      if (action === "refresh-after-signing") fs.writeFileSync(path.join(dir, "builtins.manifest.json"), "final");
      return { manifestSha256: "receipt" };
    }
  });
  const after = JSON.parse(fs.readFileSync(path.join(services, "manifest.json")));
  assert.notEqual(after.services[0].assetSignature, before);
  assert.equal(after.services[0].assetSignature, computeAssetSignature(bundle));
});

test("Platform CLI receives only packaging arguments and a verified opaque receipt", (t) => {
  const root = fixture(t);
  const hostOS = process.platform === "win32" ? "windows" : process.platform;
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ id: "agent-platform", platform: { os: hostOS, arch: hostArch } }));
  const raw = "{}\n";
  fs.writeFileSync(path.join(root, "builtins.manifest.json"), raw);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  const receipt = runPlatformBuiltinsManifest(root, "verify", undefined, (binary, args) => {
    assert.equal(path.basename(binary), process.platform === "win32" ? "agent-platform.exe" : "agent-platform");
    assert.deepEqual(args, ["builtins-manifest", "verify", "--bundle-root", root]);
    return JSON.stringify({ schemaVersion: 1, manifestSha256 });
  });
  assert.equal(receipt.manifestSha256, manifestSha256);
  assert.throws(() => runPlatformBuiltinsManifest(root, "verify", undefined, () => "{}"), /Invalid Platform builtin verification receipt/u);
});
