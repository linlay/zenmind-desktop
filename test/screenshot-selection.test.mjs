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
