import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";
import { loadBrandConfig } from "../scripts/lib/brand-model.mjs";

const require = createRequire(import.meta.url);
const { parseMacAppSignature, assertMacReleaseSignature, verifyMacReleaseApp } = require("../scripts/lib/mac-app-signing.js");
const { sign } = require("../scripts/sign-mac-app.js");
const { verifyAppServices } = require("../scripts/verify-mac-services-signing.js");
const bundleId = "cc.cutej.desktop";
const teamId = "ABCDE12345";
const options = { expectedBundleId: bundleId };
const requirement = `identifier "${bundleId}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}"`;

function details(overrides = {}) {
  return [
    `Identifier=${bundleId}`,
    "Authority=Developer ID Application: Example Publisher (ABCDE12345)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    `TeamIdentifier=${teamId}`,
    `designated => ${requirement}`,
    ...Object.entries(overrides).map(([key, value]) => key === "requirement" ? `# designated => ${value}` : `${key}=${value}`)
  ].join("\n");
}

test("macOS release signature accepts the standard stable Apple publisher and branded app requirement", () => {
  const signature = parseMacAppSignature(details());
  assert.equal(assertMacReleaseSignature(signature, options), signature);
  assert.deepEqual(signature.authorities, [
    "Developer ID Application: Example Publisher (ABCDE12345)",
    "Developer ID Certification Authority", "Apple Root CA"
  ]);
});

for (const [label, replace, expected] of [
  ["ad-hoc", (signature) => ({ ...signature, signature: "adhoc" }), /Developer ID/u],
  ["local certificate", (signature) => ({ ...signature, authorities: ["CuteJ Local Development"] }), /Developer ID/u],
  ["missing team", (signature) => ({ ...signature, teamIdentifier: "not set" }), /TeamIdentifier/u],
  ["different brand", (signature) => ({ ...signature, identifier: "cc.zenmind.desktop" }), /brand bundle/u],
  ["missing requirement", (signature) => ({ ...signature, designatedRequirement: "" }), /designated requirement/u],
  ["build-specific hash", (signature) => ({ ...signature, designatedRequirement: `${requirement} and cdhash H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"` }), /cdhash/u],
  ["different publisher in requirement", (signature) => ({ ...signature, designatedRequirement: requirement.replace(teamId, "ZZZZZ12345") }), /every alternative/u],
  ["weak alternate identity", (signature) => ({ ...signature, designatedRequirement: `(${requirement}) or anchor apple generic` }), /every alternative/u],
  ["negated publisher", (signature) => ({ ...signature, designatedRequirement: `identifier "${bundleId}" and anchor apple generic and not certificate leaf[subject.OU] = "${teamId}"` }), /every alternative/u],
  ["malformed requirement", (signature) => ({ ...signature, designatedRequirement: `(${requirement}` }), /Invalid/u]
]) {
  test(`macOS release signature rejects ${label}`, () => {
    assert.throws(() => assertMacReleaseSignature(replace(parseMacAppSignature(details())), options), expected);
  });
}

test("release requirements preserve publisher identity across every valid alternative", () => {
  const signature = parseMacAppSignature(details());
  signature.designatedRequirement = `(${requirement}) or (${requirement} and certificate leaf[subject.CN] = "Example and Company")`;
  assert.doesNotThrow(() => assertMacReleaseSignature(signature, options));
  assert.throws(() => assertMacReleaseSignature(signature, { expectedBundleId: bundleId, expectedTeamId: "ZZZZZ12345" }), /expected Apple publisher/u);
  assert.throws(() => assertMacReleaseSignature(signature), /brand bundle identifier/u);
});

test("final release verification checks sealed resources and the actual Apple Developer ID certificate chain", () => {
  const calls = [];
  const app = "/dist/CuteJ.app";
  verifyMacReleaseApp(app, {
    ...options,
    runCodesign: (args) => {
      calls.push(args);
      return args[0] === "--display" ? details() : "";
    }
  });
  assert.deepEqual(calls[0], ["--verify", "--deep", "--strict", app]);
  assert.deepEqual(calls[1], ["--display", "--verbose=4", "-r-", app]);
  assert.deepEqual(calls[2].slice(0, 3), ["--verify", "--strict", "-R"]);
  assert.match(calls[2][3], /^=identifier "cc\.cutej\.desktop" and anchor apple generic/u);
  assert.match(calls[2][3], /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\]/u);
  assert.match(calls[2][3], /certificate leaf\[subject\.OU\] = "ABCDE12345"/u);
  assert.equal(calls[2][4], app);
  assert.equal(calls.some((args) => args.includes("--sign")), false, "validation must not replace the production DR");
});

test("invalid signatures and forged publisher metadata fail before packaging can proceed", () => {
  const nativeFailure = new Error("invalid sealed resources");
  assert.throws(() => verifyMacReleaseApp("/dist/CuteJ.app", {
    ...options, runCodesign: () => { throw nativeFailure; }
  }), (error) => error === nativeFailure);
  assert.throws(() => verifyMacReleaseApp("/dist/CuteJ.app", {
    ...options,
    runCodesign: (args) => {
      if (args[0] === "--display") return details();
      if (args.includes("-R")) throw new Error("certificate chain does not satisfy Apple requirement");
      return "";
    }
  }), /Apple requirement/u);
});

test("custom release signer rejects missing and ad-hoc identities before modifying services", async () => {
  for (const identity of [undefined, "", "  ", "-", " - "]) {
    await assert.rejects(sign({ platform: "darwin", app: "Fixture.app", identity }, {
      appInfo: { id: bundleId },
      prepareServices: () => assert.fail("must not mutate services"),
      signAsync: () => assert.fail("must not sign")
    }), /Developer ID/u);
  }
  await assert.rejects(sign({ platform: "darwin", app: "Fixture.app", identity: "publisher" }, {
    prepareServices: () => assert.fail("must not mutate services")
  }), /brand bundle identifier/u);
});

test("a release signer rejects invalid outer identity even when its service checksum is valid", async () => {
  const calls = [];
  await assert.rejects(sign({ platform: "darwin", app: "Fixture.app", identity: "publisher" }, {
    appInfo: { id: bundleId },
    prepareServices: () => calls.push("prepare"),
    signAsync: () => calls.push("sign"),
    verifyAppSignature: () => { throw new Error("ad-hoc outer app"); },
    verifyServices: () => calls.push("verify services")
  }), /ad-hoc outer app/u);
  assert.deepEqual(calls, ["prepare", "sign"]);
});

test("service signature skip cannot bypass the production app identity gate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-release-gate-"));
  const app = path.join(root, "CuteJ.app");
  fs.mkdirSync(app);
  const previous = process.env.DESKTOP_SKIP_MAC_SERVICE_SIGNATURE_VERIFY;
  t.after(() => {
    if (previous === undefined) delete process.env.DESKTOP_SKIP_MAC_SERVICE_SIGNATURE_VERIFY;
    else process.env.DESKTOP_SKIP_MAC_SERVICE_SIGNATURE_VERIFY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.DESKTOP_SKIP_MAC_SERVICE_SIGNATURE_VERIFY = "1";
  let checked = false;
  assert.throws(() => verifyAppServices(app, {
    ...options,
    verifyAppSignature: (_app, received) => {
      checked = true;
      assert.equal(received.expectedBundleId, bundleId);
      throw new Error("invalid release app identity");
    }
  }), /invalid release app identity/u);
  assert.equal(checked, true);
});

test("macOS release config requires distribution signing and preserves Windows behavior", () => {
  const brand = loadBrandConfig(process.cwd(), "cutej");
  const config = electronBuilderConfig(brand, { os: "darwin", arch: "arm64" });
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.mac.type, "distribution");
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.forceCodeSigning, undefined);
  assert.equal(config.win.forceCodeSigning, undefined);
  assert.equal(config.win.signAndEditExecutable, true);
  const source = fs.readFileSync(new URL("../scripts/dist-mac.mjs", import.meta.url), "utf8");
  assert.match(source, /verifyMacReleaseApp\(updateAppPath, \{ expectedBundleId: brand\.appId \}\)/u);
  assert.ok(source.indexOf("verifyMacReleaseApp(updateAppPath") < source.indexOf('"/usr/bin/ditto"'));
});
