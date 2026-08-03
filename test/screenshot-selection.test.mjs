import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("screenshot selection supports right-click cancellation", () => {
  const screenshotSource = readSourceFile(
    "src",
    "main",
    "assistant",
    "copilot",
    "screenshot.ts"
  );
  const zhCN = readSourceFile("src", "shared", "i18n", "dictionaries", "zhCN.ts");
  const enUS = readSourceFile("src", "shared", "i18n", "dictionaries", "enUS.ts");

  assert.match(
    screenshotSource,
    /window\.addEventListener\('contextmenu',\(event\)=>\{event\.preventDefault\(\);finish\('cancel'\);\}\);/
  );
  assert.match(zhCN, /"screenshot\.selectionHint": "[^"]*右键[^"]*Esc[^"]*"/);
  assert.match(enUS, /"screenshot\.selectionHint": "[^"]*Right-click[^"]*Esc[^"]*"/);
});

test("bridge screenshot capture supports region, app window, and full desktop modes", () => {
  const screenshotSource = readSourceFile(
    "src",
    "main",
    "assistant",
    "copilot",
    "screenshot.ts"
  );

  assert.match(
    screenshotSource,
    /BridgeScreenshotCaptureMode = "region" \| "window" \| "desktop"/
  );
  assert.match(screenshotSource, /mode === "window"[\s\S]*captureMainWindowImage\(options\)/);
  assert.match(screenshotSource, /mode === "desktop"[\s\S]*captureDisplayImage\(display\)/);
  assert.match(screenshotSource, /targetWindow\.webContents\.capturePage\(\)/);
});
