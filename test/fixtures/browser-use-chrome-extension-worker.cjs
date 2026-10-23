// This launcher/profile configuration exists only in the isolated extension fixture, never in the production protocol.
const fs = require("node:fs");
const path = require("node:path");
const { ChromeWorkerEngine, startChromeWorker } = require("./chrome-worker.js");
const api = require(path.join(__dirname, "browser-use-runtime/playwright-core/lib/coreBundle.js")).__desktopBrowserUse;
const extensionBrowser = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-extension-browser.json"), "utf8"));
if (extensionBrowser.headlessEndpoint) {
  // Headless Chrome does not forward a second command-line open URL to its existing process.
  // Only the fixture's browser-open boundary is redirected; the real official approval UI and relay remain intact.
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    const connect = args.find(value => String(value).startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?'));
    if (!connect) return originalSpawn(executable, args, options);
    void fetch(extensionBrowser.headlessEndpoint + '/json/new?' + encodeURIComponent(connect), { method: 'PUT' })
      .catch(() => fs.writeFileSync(path.join(__dirname, 'fixture-worker-error.json'), JSON.stringify({ name: 'FixtureOpenError', message: 'The isolated headless browser could not open its approval target.' })));
    return { unref() {} };
  };
}
const engine = new ChromeWorkerEngine(options => api.create({ ...options, extensionBrowser }));
const request = engine.request.bind(engine);
engine.request = async message => {
  try { return await request(message); }
  catch (error) {
    // This process owns only the isolated fixture profile. Never log production browser data.
    const safeMessage = String(error.message).replace(/(?:chrome-extension|https?|wss?):\/\/[^\s"'<>]+/gu, '[fixture-url]').slice(0, 1000);
    fs.writeFileSync(path.join(__dirname, 'fixture-worker-error.json'), JSON.stringify({ method: message.method, name: error.name, message: safeMessage }));
    throw error;
  }
};
startChromeWorker(engine);
