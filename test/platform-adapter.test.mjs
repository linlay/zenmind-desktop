import test from "node:test";
import assert from "node:assert/strict";

const {
  getArchiveExtensions,
  getDesktopSsoBrowserUserAgent,
  isDevToolsShortcut
} = await import("../dist-electron/main/platform-adapter.js");

test("platform adapter resolves desktop DevTools shortcuts per platform", () => {
  assert.equal(isDevToolsShortcut("darwin", {
    type: "keyDown",
    key: "i",
    meta: true,
    alt: true,
    control: false,
    shift: false,
    isAutoRepeat: false
  }), true);
  assert.equal(isDevToolsShortcut("win32", {
    type: "keyDown",
    key: "I",
    meta: false,
    alt: false,
    control: true,
    shift: true,
    isAutoRepeat: false
  }), true);
  assert.equal(isDevToolsShortcut("linux", {
    type: "keyDown",
    key: "i",
    meta: true,
    alt: true,
    control: false,
    shift: false,
    isAutoRepeat: false
  }), false);
});

test("platform adapter hides Electron from Desktop SSO user agents", () => {
  const userAgent = getDesktopSsoBrowserUserAgent("win32", {
    chromeVersion: "126.0.0.0",
    electronVersion: "36.2.1"
  });

  assert.match(userAgent, /Windows NT 10\.0/u);
  assert.match(userAgent, /Chrome\/126\.0\.0\.0/u);
  assert.doesNotMatch(userAgent, /Electron/u);
});

test("platform adapter chooses archive extensions by host platform", () => {
  assert.deepEqual(getArchiveExtensions("win32"), ["zip"]);
  assert.deepEqual(getArchiveExtensions("darwin"), ["gz", "tgz"]);
  assert.deepEqual(getArchiveExtensions("linux"), ["gz", "tgz"]);
});
