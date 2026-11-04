import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stageBrowserUseRuntime } from "../scripts/browser-use-patch.mjs";

const root = path.resolve(import.meta.dirname, "..");
const suffix = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
const electron = process.env.BROWSER_USE_TEST_ELECTRON ?? [root, path.resolve(root, "../zenmind-desktop")].map(base => path.join(base, "node_modules/electron/dist", suffix)).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
const chrome = process.env.BROWSER_USE_TEST_CHROME_FOR_TESTING;
const extension = process.env.BROWSER_USE_TEST_EXTENSION ?? path.join(root, "build/browser-use-fixture/extension");

for (const productionDiscovery of [false, true]) test(productionDiscovery
  ? "production default discovery false negative: official approval UI, real relay and no browser/profile override"
  : "official Extension 0.4.0: approval UI, real relay, selected-tab isolation, operations and cancellation", { skip: !electron || !chrome || !fs.existsSync(path.join(extension, "manifest.json")), timeout: 60_000 }, async t => {
  const fixtureApp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-browser-extension-app-"));
  const mainDir = path.join(fixtureApp, "dist-electron/main");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureApp, "package.json"), JSON.stringify({ name: "desktop-extension-fixture", version: "1.0.0", main: path.join(root, "test/fixtures/browser-use-chrome-extension.cjs") }));
  fs.copyFileSync(path.join(root, "dist-electron/main/chrome-worker.js"), path.join(mainDir, "chrome-worker.js"));
  fs.copyFileSync(path.join(root, "test/fixtures/browser-use-chrome-extension-worker.cjs"), path.join(mainDir, "chrome-extension-worker.cjs"));
  fs.copyFileSync(path.join(root, 'test/fixtures/browser-use-chrome-discovery-worker.cjs'), path.join(mainDir, 'chrome-discovery-worker.cjs'));
  stageBrowserUseRuntime(root, mainDir);
  const reportFile = path.join(fixtureApp, "report.json");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fixtureApp, `--report=${reportFile}`, `--source=${root}`, `--chrome=${chrome}`, `--extension=${extension}`, `--production-discovery=${productionDiscovery}`, `--headless=${process.env.BROWSER_USE_TEST_HEADLESS_EXTENSION === '1'}`], { env, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-4000); });
  t.after(() => { child.kill(); fs.rmSync(fixtureApp, { recursive: true, force: true }); });
  const [code] = await once(child, "exit");
  const result = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : {};
  assert.equal(code, 0, diagnostic + JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.approvedInOfficialUI, true);
  if (productionDiscovery) assert.deepEqual(result.productionDiscovery, {
    defaultRootListed: true, defaultProfileProbed: true, customUserDataDirArg: false, profileDirectoryArg: false, tokenAbsent: true,
  });
  assert.equal(result.visiblePages.length, 1, "only the selected tab is visible through the actual extension relay");
  assert.equal(result.visiblePages[0].title, "Official relay fixture");
  assert.equal(result.localSessionObserved, true);
  assert.equal(result.viewportObserved, true);
  assert.equal(result.scrollViewportObserved, true);
  assert.equal(result.passwordMasked, true);
  assert.equal(result.title, "Official relay clicked");
  assert.equal(result.png, true);
  assert.notEqual(result.pendingCancelled, "unexpected_success");
  assert.ok(result.stopMs < 3000);
  assert.equal(result.chromePreserved, true);
  assert.equal(result.unsharedPreserved, "Unshared neighbour");
  assert.equal(result.value, "Official extension relay");
  assert.equal(result.pagesPreserved, 2);
});
