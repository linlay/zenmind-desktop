import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  getDesktopLogRoot,
  readDesktopLog,
  __testInternals
} = await import("../dist-electron/main/logs/desktop.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "Library", "Application Support");
      }
      return homePath;
    }
  };
}

test("desktop console tee writes main log and preserves original writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-logs-"));
  const app = createApp(root);
  const originalCalls = [];
  const writer = __testInternals.createConsoleTee(
    app,
    (...args) => originalCalls.push(args),
    "warn"
  );

  writer("hello", { route: "debug" });

  const logRoot = getDesktopLogRoot(app);
  const mainLog = fs.readFileSync(path.join(logRoot, "main.log"), "utf8");
  assert.equal(originalCalls.length, 1);
  assert.equal(originalCalls[0][0], "hello");
  assert.match(mainLog, /WARN hello/);
  assert.match(mainLog, /route/);
  assert.equal(fs.existsSync(path.join(logRoot, "error.log")), false);
});

test("desktop console error tee also writes error log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-error-logs-"));
  const app = createApp(root);
  const writer = __testInternals.createConsoleTee(app, () => undefined, "error");

  writer("boom");

  const logRoot = getDesktopLogRoot(app);
  assert.match(fs.readFileSync(path.join(logRoot, "main.log"), "utf8"), /ERROR boom/);
  assert.match(fs.readFileSync(path.join(logRoot, "error.log"), "utf8"), /ERROR boom/);
  const result = readDesktopLog(app, "error");
  assert.equal(result.exists, true);
  assert.match(result.content, /ERROR boom/);
});
