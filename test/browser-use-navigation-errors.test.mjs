import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-navigation-source-"));
require("esbuild").buildSync({ stdin: { contents:
  `export {ChromeWorkerEngine} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use/chrome-worker-engine.ts"))}; export {chromeWorkerResponseError} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use/chrome-worker.ts"))};`,
  resolveDir: root }, bundle: true, platform: "node", format: "cjs", packages: "external", outfile: path.join(directory, "host.cjs"), logLevel: "silent" });
const { ChromeWorkerEngine, chromeWorkerResponseError } = require(path.join(directory, "host.cjs"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const privateMarker = "SYNTHETIC_PRIVATE_QUERY_AND_AUTHORIZATION";
const privateUrl = `https://fixture-user:${privateMarker}@unavailable.invalid/private?token=${privateMarker}`;

test("page network failures preserve a safe, actionable category for every navigation method", () => {
  const cases = [
    ["net::ERR_CONNECTION_REFUSED", "page_connection_refused"],
    ["net::ERR_NAME_NOT_RESOLVED", "page_name_not_resolved"],
    ["net::ERR_NAME_RESOLUTION_FAILED", "page_name_not_resolved"],
    ["net::ERR_INTERNET_DISCONNECTED", "page_connection_interrupted"],
    ["net::ERR_NETWORK_CHANGED", "page_connection_interrupted"],
    ["net::ERR_CONNECTION_RESET", "page_connection_interrupted"],
    ["net::ERR_CONNECTION_ABORTED", "page_connection_interrupted"],
    ["net::ERR_CONNECTION_CLOSED", "page_connection_interrupted"],
    ["net::ERR_ADDRESS_UNREACHABLE", "page_connection_interrupted"],
    ["net::ERR_PROXY_CONNECTION_FAILED", "page_connection_interrupted"],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", "page_connection_interrupted"],
    ["net::ERR_CONNECTION_TIMED_OUT", "page_navigation_timeout"],
    ["net::ERR_TIMED_OUT", "page_navigation_timeout"],
    ["net::ERR_ABORTED", "page_navigation_interrupted"],
    ["net::ERR_BLOCKED_BY_CLIENT", "page_navigation_blocked"],
    ["net::ERR_BLOCKED_BY_ADMINISTRATOR", "page_navigation_blocked"],
    ["net::ERR_NETWORK_ACCESS_DENIED", "page_navigation_blocked"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "page_security_error"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "page_security_error"],
  ];
  for (const method of ["open", "navigate", "back", "reload"]) for (const [cause, code] of cases) {
    const error = chromeWorkerResponseError(new Error(`page navigation: ${cause} at ${privateUrl}`), method);
    assert.equal(error.code, code, `${method}: ${cause}`);
    assert.equal(JSON.stringify(error).includes(privateMarker), false);
    assert.equal(error.message.includes("https:"), false); assert.equal(error.message.includes("net::"), false);
    assert.equal(error.message.includes("observe"), false); assert.equal(error.message.includes("Allow & select"), false);
    assert.match(error.message, /no automatic retry/u);
  }
  assert.match(chromeWorkerResponseError(new Error("net::ERR_CONNECTION_REFUSED"), "open").message, /local website.*service is running/u);
});

test("navigation timeouts and unknown failures never expose raw details or require observing an absent Surface", () => {
  for (const method of ["open", "navigate", "back", "reload"]) {
    for (const cause of [Object.assign(new Error(privateUrl), { name: "TimeoutError" }), Object.assign(new Error(privateUrl), { code: "browser_action_timeout" })])
      assert.equal(chromeWorkerResponseError(cause, method).code, "page_navigation_timeout");
    const unknown = chromeWorkerResponseError(new Error(privateUrl), method);
    assert.equal(unknown.code, "page_navigation_failed"); assert.equal(JSON.stringify(unknown).includes(privateMarker), false);
  }
});

test("the same network text remains a connection error during the official extension handshake", () => {
  for (const detail of ["net::ERR_CONNECTION_REFUSED", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_TIMED_OUT", privateUrl]) {
    const result = chromeWorkerResponseError(new Error(detail), "connect");
    assert.equal(result.code, "chrome_connection_failed"); assert.equal(JSON.stringify(result).includes(privateMarker), false);
  }
  assert.equal(chromeWorkerResponseError(new Error(`Playwright extension did not connect within 30s ${privateUrl}`), "connect").code, "chrome_connection_timeout");
  assert.equal(chromeWorkerResponseError(new Error('"chrome" executable not found'), "connect").code, "chrome_unavailable");
  assert.equal(chromeWorkerResponseError(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }), "open").code, "cancelled");
});

test("failed dispatched navigate/back/reload operations execute once, preserve the page and keep the connection", async t => {
  for (const method of ["navigate", "back", "reload"]) {
    let dispatched = 0, pageCloses = 0, disconnects = 0;
    const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/original", isClosed: () => false, close: async () => { pageCloses++; },
      goto: async () => { dispatched++; throw new Error(`net::ERR_CONNECTION_REFUSED at ${privateUrl}`); },
      goBack: async () => { dispatched++; throw new Error(`net::ERR_CONNECTION_REFUSED at ${privateUrl}`); },
      reload: async () => { dispatched++; throw new Error(`net::ERR_CONNECTION_REFUSED at ${privateUrl}`); },
    });
    const tab = { desktopPageId: "owned-page", page, modalStates: () => [] };
    const controller = { browserContext: { once() {} }, list: async () => [{ pageId: "owned-page", url: page.url() }],
      run: async (_pageId, operation) => operation(tab), disconnect: async () => { disconnects++; } };
    const engine = new ChromeWorkerEngine(async () => controller); t.after(() => engine.disconnect());
    await engine.request({ id: "connect", method: "connect" });
    let error; try { await engine.request({ id: "navigation", method, pageId: "owned-page", params: { url: "https://fixture.test/destination" } }); }
    catch (failure) { error = chromeWorkerResponseError(failure, method); }
    assert.equal(error.code, "page_connection_refused"); assert.equal(dispatched, 1);
    assert.equal(pageCloses, 0); assert.equal(disconnects, 0);
    assert.equal((await engine.request({ id: "still-connected", method: "state" })).connected, true);
    assert.equal((await engine.request({ id: "still-owned", method: "list" }))[0].pageId, "owned-page");
  }
});

async function adapterFixture({ createFailure = false, registrationFailure = false, navigationFailure = true } = {}) {
  const counts = { create: 0, navigate: 0, close: 0 };
  const page = { goto: async () => { counts.navigate++; if (navigationFailure) throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${privateUrl}`); }, close: async () => { counts.close++; } };
  const tab = { page, desktopPageId: "created-owned-page" };
  const browserContext = { browser: () => ({}), newPage: async () => { counts.create++; if (createFailure) throw new Error(`browserContext.newPage: Protocol error private ${privateUrl}`); return page; } };
  const context = { tabs: () => registrationFailure ? [] : [tab], ensureBrowserContext: async () => {} };
  const sandbox = { module: { exports: {} }, process: { env: {} }, URL, init_mcp() {}, resolveConfig: async () => ({}), filteredTools: () => [],
    BrowserBackend: class { constructor() { this._context = context; } async initialize() {} async dispose() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "scripts/browser-use-upstream-adapter.cjs"), "utf8"), sandbox);
  const controller = await sandbox.module.exports.__desktopBrowserUse.create({ outputDir: "/fixture", context: browserContext });
  return { counts, controller };
}

test("open distinguishes failure to create or register a tab from a website navigation failure", async () => {
  for (const options of [{ createFailure: true }, { registrationFailure: true }]) {
    const fixture = await adapterFixture(options);
    let result; try { await fixture.controller.open("https://fixture.test/destination"); }
    catch (error) { result = chromeWorkerResponseError(error, "open"); }
    assert.equal(result.code, "browser_page_creation_failed"); assert.equal(JSON.stringify(result).includes(privateMarker), false);
    assert.equal(fixture.counts.create, 1); assert.equal(fixture.counts.navigate, 0); assert.equal(fixture.counts.close, 0);
    await fixture.controller.disconnect();
  }
});

test("an open navigation failure does not create a replacement tab or close a potentially executed page", async () => {
  const fixture = await adapterFixture();
  let result; try { await fixture.controller.open("https://fixture.test/destination"); }
  catch (error) { result = chromeWorkerResponseError(error, "open"); }
  assert.equal(result.code, "page_connection_refused"); assert.deepEqual(fixture.counts, { create: 1, navigate: 1, close: 0 });
  await fixture.controller.disconnect();
});
