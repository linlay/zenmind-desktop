import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stageBrowserUseRuntime } from "../scripts/browser-use-patch.mjs";

const root = path.resolve(import.meta.dirname, "..");
function electronExecutable() {
  if (process.env.BROWSER_USE_TEST_ELECTRON) return process.env.BROWSER_USE_TEST_ELECTRON;
  const suffix = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  return [root, path.resolve(root, "../zenmind-desktop")].map(base => path.join(base, "node_modules/electron/dist", suffix)).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}
function chromeExecutable() {
  if (process.env.BROWSER_USE_TEST_CHROME) return process.env.BROWSER_USE_TEST_CHROME;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") return path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe");
  return "/usr/bin/google-chrome";
}
const electron = electronExecutable();
const chrome = chromeExecutable();

test("Electron utilityProcess: application-relative packaged Worker, actual parentPort, Chrome actions and release", { skip: !electron || !fs.statSync(chrome, { throwIfNoEntry: false })?.isFile(), timeout: 60_000 }, async t => {
  const fixtureApp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-browser-use-app-"));
  const mainDir = path.join(fixtureApp, "dist-electron/main");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureApp, "package.json"), JSON.stringify({ name: "desktop-browser-use-fixture", version: "1.0.0", main: path.join(root, "test/fixtures/browser-use-chrome-utility.cjs") }));
  fs.copyFileSync(path.join(root, "dist-electron/main/chrome-worker.js"), path.join(mainDir, "chrome-worker.js"));
  fs.copyFileSync(path.join(root, "test/fixtures/browser-use-chrome-utility-worker.cjs"), path.join(mainDir, "chrome-fixture-worker.cjs"));
  stageBrowserUseRuntime(root, mainDir);
  const reportFile = path.join(fixtureApp, "report.json");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fixtureApp, `--report=${reportFile}`, `--source=${root}`, `--chrome=${chrome}`], { env, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-4000); });
  t.after(() => { child.kill(); fs.rmSync(fixtureApp, { recursive: true, force: true }); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, diagnostic + (fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : " no fixture report"));
  const result = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.appPath, fixtureApp);
  assert.deepEqual(result.productionWorkerState, { connected: false, pages: [] });
  assert.equal(result.invalidProfileCode, "invalid_params");
  assert.equal(result.pages.length, 2);
  assert.ok(result.observationElements > 0);
  assert.equal(result.passwordMasked, true);
  assert.equal(result.value, "小君 UtilityProcess");
  assert.equal(result.title, "Clicked in UtilityProcess");
  assert.equal(result.neighbour, "Neighbour");
  assert.equal(result.png, true);
  assert.equal(result.chromePreserved, true);
  assert.equal(result.pagesPreserved, true);
});
