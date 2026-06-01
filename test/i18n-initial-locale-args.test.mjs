import test from "node:test";
import assert from "node:assert/strict";

const {
  createInitialLocaleArguments,
  readInitialLocaleSettingsFromArgv
} = await import("../dist-electron/shared/i18n/initial-locale-args.js");

test("initial locale arguments round-trip renderer bootstrap settings", () => {
  const args = createInitialLocaleArguments({ locale: "en-US", source: "stored" });

  assert.deepEqual(args, [
    "--zenmind-initial-locale=en-US",
    "--zenmind-initial-locale-source=stored"
  ]);
  assert.deepEqual(readInitialLocaleSettingsFromArgv(["electron", ...args]), {
    locale: "en-US",
    source: "stored"
  });
});

test("initial locale parser rejects incomplete or unsupported arguments", () => {
  assert.equal(readInitialLocaleSettingsFromArgv(["--zenmind-initial-locale=fr-FR"]), null);
  assert.equal(readInitialLocaleSettingsFromArgv([
    "--zenmind-initial-locale=en-US",
    "--zenmind-initial-locale-source=unknown"
  ]), null);
});
