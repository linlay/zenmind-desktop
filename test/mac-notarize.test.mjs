import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMacNotarizationHost,
  buildNotaryToolAuthArgs,
  resolveMacDmgArtifactPath
} from "../scripts/lib/mac-notarize.mjs";

test("notarytool auth args prefer keychain profile credentials", () => {
  assert.deepEqual(
    buildNotaryToolAuthArgs({
      APPLE_KEYCHAIN_PROFILE: "zenmind-notary"
    }),
    ["--keychain-profile", "zenmind-notary"]
  );
  assert.deepEqual(
    buildNotaryToolAuthArgs({
      APPLE_KEYCHAIN: "/Users/me/Library/Keychains/login.keychain-db",
      APPLE_KEYCHAIN_PROFILE: "zenmind-notary"
    }),
    ["--keychain", "/Users/me/Library/Keychains/login.keychain-db", "--keychain-profile", "zenmind-notary"]
  );
});

test("notarytool auth args validate partial credential groups", () => {
  assert.equal(buildNotaryToolAuthArgs({}), null);
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_ID: "dev@example.com" }),
    /APPLE_APP_SPECIFIC_PASSWORD/u
  );
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_API_KEY: "/tmp/AuthKey_TEST.p8", APPLE_API_KEY_ID: "KEYID" }),
    /APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER/u
  );
  assert.throws(
    () => buildNotaryToolAuthArgs({ APPLE_KEYCHAIN: "/tmp/login.keychain-db" }),
    /APPLE_KEYCHAIN_PROFILE/u
  );
});

test("mac DMG artifact resolves from latest-mac metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mac-dmg-artifact-"));
  const outputDir = path.join(root, "dist", "zenmind");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "latest-mac.yml"), "path: ZenMind-0.3.5-arm64.dmg\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "ZenMind-0.3.5-arm64.dmg"), "fake dmg\n", "utf8");

  assert.equal(
    resolveMacDmgArtifactPath(root, { id: "zenmind" }),
    path.join(outputDir, "ZenMind-0.3.5-arm64.dmg")
  );
});

test("mac notarization host check branches explicitly by platform", () => {
  assert.doesNotThrow(() => assertMacNotarizationHost("darwin"));
  assert.throws(() => assertMacNotarizationHost("win32"), /Windows cannot run xcrun notarytool/u);
  assert.throws(() => assertMacNotarizationHost("linux"), /linux cannot run xcrun notarytool/u);
});
