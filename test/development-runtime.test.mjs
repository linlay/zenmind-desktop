import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  isDesktopDevelopmentRuntime,
  resolveEffectiveAppId
} = require(path.join(__dirname, "..", "dist-electron", "main", "infrastructure", "electron", "development-runtime.js"));
const { APP_ID, BRAND_ID } = require(path.join(__dirname, "..", "dist-electron", "shared", "brand.js"));

test("effective app IDs stay brand-specific and add a stable development suffix", () => {
  assert.equal(resolveEffectiveAppId("cc.zenmind.desktop", false), "cc.zenmind.desktop");
  assert.equal(resolveEffectiveAppId("cc.zenmind.desktop", true), "cc.zenmind.desktop.dev");
  assert.equal(resolveEffectiveAppId("cc.cutej.desktop", false), "cc.cutej.desktop");
  assert.equal(resolveEffectiveAppId("cc.cutej.desktop", true), "cc.cutej.desktop.dev");
});

function createDarwinDevelopmentContext(root) {
  return {
    platform: "darwin",
    env: {
      __CFBundleIdentifier: `${APP_ID}.dev`,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      DESKTOP_DEV_RESOURCES_ROOT: path.join(root, "build", "brands", BRAND_ID, "resources")
    },
    argv: ["ZenMind", root],
    execPath: path.join(root, "build", "brands", BRAND_ID, "dev", "ZenMind.app", "Contents", "MacOS", "ZenMind")
  };
}

test("renamed macOS development app is recognized even when Electron reports packaged", () => {
  const root = "/Users/test/zenmind-desktop";
  assert.equal(
    isDesktopDevelopmentRuntime({ isPackaged: true }, createDarwinDevelopmentContext(root)),
    true
  );
});

test("packaged app cannot enable development resources with an environment override alone", () => {
  const root = "/Users/test/zenmind-desktop";
  const context = createDarwinDevelopmentContext(root);
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: true }, {
    ...context,
    env: {
      ...context.env,
      __CFBundleIdentifier: APP_ID
    }
  }), false);
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: true }, {
    ...context,
    execPath: "/Applications/ZenMind.app/Contents/MacOS/ZenMind"
  }), false);
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: true }, {
    ...context,
    platform: "win32"
  }), false);
});

test("ordinary nonpackaged Electron development remains supported", () => {
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: false }, { platform: "darwin" }), true);
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: false }, { platform: "win32" }), true);
  assert.equal(isDesktopDevelopmentRuntime({ isPackaged: false }, { platform: "linux" }), true);
});
