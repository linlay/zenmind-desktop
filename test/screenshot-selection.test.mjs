import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

async function waitForOutput(child, expected, timeoutMs = 10_000) {
  let output = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expected}. Output: ${output}`));
    }, timeoutMs);
    const handleOutput = (chunk) => {
      output += chunk.toString();
      if (!output.includes(expected)) {
        return;
      }
      clearTimeout(timeout);
      resolve(output);
    };
    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Electron exited before ${expected}: code=${code} signal=${signal}. Output: ${output}`));
    });
  });
}

function readMacApplicationActivationPolicy(pid) {
  const script = [
    "ObjC.import('AppKit');",
    `const target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});`,
    "target ? ObjC.unwrap(target.activationPolicy) : -1;"
  ].join(" ");
  return Number(childProcess.execFileSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    script
  ], { encoding: "utf8" }).trim());
}

test("macOS region screenshot keeps the Desktop app visible in the Dock", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const electronPath = require("electron");
  const fixturePath = path.join(
    projectRoot,
    "test",
    "fixtures",
    "macos-screenshot-dock-app.cjs"
  );
  const child = childProcess.spawn(electronPath, [fixturePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });

  await waitForOutput(child, "SCREENSHOT_OVERLAY_READY");

  assert.equal(
    readMacApplicationActivationPolicy(child.pid),
    0,
    "opening the screenshot overlay must not turn the Desktop app into a UIElement"
  );
});

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
