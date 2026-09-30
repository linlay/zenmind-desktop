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

for (const action of ["escape", "right-click", "drag"]) {
  test(`macOS region screenshot covers every display, keeps the Dock icon, and handles ${action}`, {
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
      stdio: ["pipe", "pipe", "pipe"]
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    });

    const output = await waitForOutput(child, "SCREENSHOT_OVERLAY_READY");
    const probe = JSON.parse(output.match(/SCREENSHOT_OVERLAY_READY (\{[^\n]+\})/u)[1]);
    t.diagnostic(`Native macOS probe: ${probe.displayCount} display(s); ${action}; ${JSON.stringify(probe.overlays.map(({ displayId, bounds, viewport }) => ({ displayId, bounds, viewport })))}`);
    assert.equal(probe.overlays.length, probe.displayCount);
    assert.equal(new Set(probe.overlays.map((overlay) => overlay.displayId)).size, probe.displayCount);
    for (const overlay of probe.overlays) {
      assert.deepEqual(overlay.bounds, overlay.displayBounds);
      assert.deepEqual(overlay.viewport, {
        width: overlay.displayBounds.width,
        height: overlay.displayBounds.height
      });
    }
    assert.deepEqual(probe.overlays.filter((overlay) => overlay.focused).map((overlay) => overlay.displayId), [probe.preferredDisplayId]);

    assert.equal(
      readMacApplicationActivationPolicy(child.pid),
      0,
      "opening the screenshot overlay must not turn the Desktop app into a UIElement"
    );
    const resultOutput = waitForOutput(child, "SCREENSHOT_SELECTION_RESULT");
    child.stdin.write(`${action}\n`);
    const result = JSON.parse((await resultOutput).match(/SCREENSHOT_SELECTION_RESULT (\{[^\n]+\})/u)[1]);
    assert.equal(result.action, action);
    assert.equal(result.remainingOverlays, 0);
    if (action === "drag") {
      assert.equal(result.ok, true);
      assert.deepEqual([result.width, result.height], [result.expectedWidth, result.expectedHeight]);
    } else {
      assert.equal(result.cancelled, true);
      assert.equal(result.ok, false);
    }
  });
}

test("screenshot selection supports right-click cancellation", () => {
  const screenshotSource = readSourceFile(
    "src",
    "main",
    "modules",
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
    "modules",
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
