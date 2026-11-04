// Only this test entry accepts a CDP endpoint. Production chrome-worker.js always uses the user-approved extension.
const fs = require("node:fs");
const path = require("node:path");
const { ChromeWorkerEngine, startChromeWorker } = require("./chrome-worker.js");
const coreDir = path.join(__dirname, "browser-use-runtime/playwright-core");
const { chromium } = require(coreDir);
const api = require(path.join(coreDir, "lib/coreBundle.js")).__desktopBrowserUse;
const { endpoint } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-endpoint.json"), "utf8"));
startChromeWorker(new ChromeWorkerEngine(async options => {
  const browser = await chromium.connectOverCDP(endpoint);
  const controller = await api.create({ ...options, context: browser.contexts()[0] });
  const release = controller.disconnect.bind(controller);
  controller.disconnect = async () => { const closing = browser.close(); await release(); await closing; };
  return controller;
}));
