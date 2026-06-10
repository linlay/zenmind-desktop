import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readDesktopLocaleSettings, saveDesktopLocale, __testInternals } = await import("../dist-electron/main/i18n/desktop-locale-store.js");

function createApp(root, locale = "fr-FR") {
  return {
    getLocale: () => locale,
    getPath: (name) => {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "desktop") return path.join(root, "Desktop");
      if (name === "temp") return path.join(root, "tmp");
      return root;
    }
  };
}

test("desktop locale store falls back to supported system locale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-locale-store-"));
  const settings = readDesktopLocaleSettings(createApp(root, "en-US"));
  assert.deepEqual(settings, { locale: "en-US", source: "system" });
});

test("desktop locale store defaults first installs to English", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-locale-store-first-install-"));
  const settings = readDesktopLocaleSettings(createApp(root, "zh-CN"), { isFirstInstall: true });
  assert.deepEqual(settings, { locale: "en-US", source: "default" });
});

test("desktop locale store falls back to default for unsupported locale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-locale-store-"));
  const settings = readDesktopLocaleSettings(createApp(root, "fr-FR"));
  assert.deepEqual(settings, { locale: "zh-CN", source: "default" });
});

test("desktop locale store saves preferences under desktop config root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-locale-store-"));
  const app = createApp(root, "fr-FR");
  const saved = saveDesktopLocale(app, "en-US");
  assert.deepEqual(saved, { locale: "en-US", source: "stored" });
  assert.deepEqual(readDesktopLocaleSettings(app, { isFirstInstall: true }), { locale: "en-US", source: "stored" });
  assert.equal(
    __testInternals.getPreferencesPath(app),
    path.join(root, "home", ".zenmind", ".desktop", "config", "desktop", "profile.json")
  );
});

test("desktop locale store migrates legacy preferences.json into profile.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-locale-store-legacy-"));
  const app = createApp(root, "zh-CN");
  const configRoot = path.join(root, "home", ".zenmind", ".desktop", "config", "desktop");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, "preferences.json"), JSON.stringify({ locale: "en-US" }), "utf8");

  const settings = readDesktopLocaleSettings(app);
  const profile = JSON.parse(fs.readFileSync(path.join(configRoot, "profile.json"), "utf8"));

  assert.deepEqual(settings, { locale: "en-US", source: "stored" });
  assert.equal(profile.appearance.locale, "en-US");
});
