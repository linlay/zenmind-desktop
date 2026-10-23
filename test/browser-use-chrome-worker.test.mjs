import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { patchBrowserUseUpstream, stageBrowserUseRuntime } from "../scripts/browser-use-patch.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
patchBrowserUseUpstream(root);
const { chromium } = require("playwright-core");
const { ChromeWorkerEngine, browserUseUrl } = require("../dist-electron/main/modules/browser-use/chrome-worker-engine.js");
const coreDir = path.dirname(require.resolve("playwright-core/package.json"));
const upstream = require(path.join(coreDir, "lib/coreBundle.js")).__desktopBrowserUse;

function chromeExecutable() {
  if (process.env.BROWSER_USE_TEST_CHROME) return process.env.BROWSER_USE_TEST_CHROME;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") return path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe");
  return "/usr/bin/google-chrome";
}
const executablePath = chromeExecutable();
const chromeAvailable = fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile();
const pageHtml = `<!doctype html><title>Fixture</title><h1>Chrome worker fixture</h1>
<button id="increment" onclick="this.textContent='Clicked';document.title='Clicked'">Increment</button>
<button id="disabled" disabled>Disabled</button><input id="name" aria-label="Name"><input type="checkbox" id="check">
<input type="password" aria-label="Password" value="PASSWORD-SECRET-42"><input autocomplete="one-time-code" aria-label="Code" value="654321">
<select id="choice"><option value="one">One</option><option value="two">Two</option></select>`;

async function fixture(t) {
  const server = http.createServer((_request, response) => response.end(pageHtml));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const first = await context.newPage(); await first.goto(`${url}/one`);
  const second = await context.newPage(); await second.goto(`${url}/two`);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-fixture-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  let controller;
  const engine = new ChromeWorkerEngine(async options => { controller = await upstream.create({ ...options, context, outputDir }); return controller; });
  const connected = await engine.request({ id: "connect", method: "connect" });
  t.after(() => engine.disconnect());
  return { url, browser, context, controller, engine, first, second, pages: connected.pages, outputDir };
}

test("reviewed upstream patch is deterministic and packaged with its own runtime and notices", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-stage-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  assert.equal(patchBrowserUseUpstream(root), coreDir);
  const staged = stageBrowserUseRuntime(root, temp);
  assert.ok(fs.existsSync(path.join(staged, "LICENSE")));
  assert.ok(fs.existsSync(path.join(staged, "NOTICE")));
  const stagedApi = require(path.join(staged, "lib/coreBundle.js")).__desktopBrowserUse;
  assert.equal(stagedApi.patchVersion, 1);
  assert.equal(typeof stagedApi.create, "function");
  const manifest = JSON.parse(fs.readFileSync(path.join(temp, "browser-use-runtime/upstream.json"), "utf8"));
  assert.equal(manifest.mcp, "0.0.83");
  assert.equal(manifest.commit, "e8149b8257d32dcf8f72573ecc43e72439da7080");
});

test("worker accepts only the private IPC protocol; production connect cannot accept arbitrary CDP endpoints", async t => {
  const entry = path.join(root, "dist-electron/main/chrome-worker.js");
  const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => child.kill());
  const reply = async message => {
    const received = once(child, "message"); child.send(message); return (await received)[0];
  };
  assert.deepEqual(await reply({ id: "state", method: "state" }), { id: "state", result: { connected: false, pages: [] } });
  assert.equal((await reply({ id: "bad", method: "evaluate", params: { expression: "process.exit()" } })).error.code, "invalid_params");
  assert.equal((await reply({ id: "endpoint", method: "connect", params: { cdpEndpoint: "http://127.0.0.1:9222" } })).error.code, "invalid_params");
  assert.equal((await reply({ id: "invalid", method: "connect", params: { profileDirName: "../Default" } })).error.code, "invalid_params");
  assert.equal((await reply({ id: "disconnect", method: "disconnect" })).result.connected, false);
});

test("URL policy refuses local files, debugger pages, credentials and malformed input", () => {
  for (const url of ["file:///etc/passwd", "chrome://settings", "chrome-extension://fixture/connect.html", "about:blank", "javascript:alert(1)", "http://user:pass@example.test/", "not a url"]) {
    assert.throws(() => browserUseUrl(url), /URL|HTTP/);
  }
  assert.equal(browserUseUrl("https://example.test/"), "https://example.test/");
});

test('real Chrome: internal pages never appear in worker lists or state, and a business page entering an internal protocol rejects its old ID', { skip: !chromeAvailable }, async t => {
  const f = await fixture(t);
  const blank = await f.context.newPage();
  const internal = await f.context.newPage();
  await internal.goto('data:text/html,<title>SYNTHETIC_PRIVATE_INTERNAL_TITLE</title><p>Internal content</p>');
  const list = await f.engine.request({ id: 'list-business-only', method: 'list' });
  assert.equal(list.length, 2);
  assert.equal(JSON.stringify(list).includes('SYNTHETIC_PRIVATE_INTERNAL_TITLE'), false);
  assert.equal((await f.engine.request({ id: 'state-business-only', method: 'state' })).pages.length, 2);
  const pageId = f.pages[0].pageId;
  await f.first.goto('about:blank');
  for (const [method, params] of [
    ['observe', {}], ['state', {}], ['screenshot', {}], ['activate', {}], ['click', { selector: 'body' }],
    ['navigate', { url: `${f.url}/recovered` }], ['close', {}],
  ]) await assert.rejects(f.engine.request({ id: `internal-${method}`, method, pageId, params }), { code: 'surface_not_found' });
  assert.equal((await f.engine.request({ id: 'remaining-business-page', method: 'list' })).length, 1);
  assert.equal(await f.second.locator('#increment').textContent(), 'Increment');
  assert.equal(blank.isClosed(), false);
});

test('real Chrome: an operation navigating to an internal protocol cannot return its result', { skip: !chromeAvailable }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.controller.run(f.pages[0].pageId, async tab => {
    await tab.page.goto('data:text/html,<title>Private internal document</title>');
    return { content: 'SYNTHETIC_PRIVATE_RESULT' };
  }), { code: 'surface_not_found' });
  assert.equal(await f.second.locator('#increment').textContent(), 'Increment');
});

test("real Chrome: observations, refs, form interaction, click and screenshot stay on the selected stable page", { skip: !chromeAvailable }, async t => {
  const f = await fixture(t);
  const pageId = f.pages[0].pageId;
  const observation = await f.engine.request({ id: "observe", method: "observe", pageId });
  const textbox = observation.elements.find(element => element.role === "textbox");
  const button = observation.elements.find(element => element.name === "Increment");
  assert.ok(textbox?.ref);
  assert.ok(button?.ref);
  assert.equal(observation.truncated, false);
  assert.equal(textbox.tag, "input");
  assert.ok(!JSON.stringify(observation).includes("PASSWORD-SECRET-42"), "AX password values must not leave the Worker");
  assert.ok(!JSON.stringify(observation).includes("654321"), "one-time-code values must not leave the Worker");
  assert.ok(observation.text.includes("[redacted]"));
  await f.engine.request({ id: "fill", method: "interact", pageId, params: { action: "fill", ref: textbox.ref, observationId: observation.observationId, text: "小君" } });
  assert.equal(await f.first.locator("#name").inputValue(), "小君");
  assert.equal(await f.second.locator("#name").inputValue(), "");
  await assert.rejects(f.engine.request({ id: "stale", method: "click", pageId, params: { ref: button.ref, observationId: observation.observationId } }), { code: "stale_observation" });
  // Simulate an upstream current-tab change. Authorization must still pin the requested Page through serialization.
  await f.controller.run(f.pages[1].pageId, async tab => { tab.context._setCurrentTab(tab); });
  const clicked = await f.engine.request({ id: "click", method: "click", pageId, params: { selector: "#increment" } });
  assert.equal(clicked.status, "clicked");
  assert.deepEqual(clicked.action, { pressed: true, released: true, outcome: "complete" });
  const state = await f.engine.request({ id: "page-state", method: "state", pageId });
  assert.equal(state.url, `${f.url}/one`);
  assert.equal(state.title, "Clicked");
  assert.equal(await f.second.title(), "Fixture");
  const screenshot = await f.engine.request({ id: "shot", method: "screenshot", pageId });
  assert.equal(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(screenshot.mimeType, "image/png");
});

test("real Chrome: closing a page invalidates its ID; pending and future actions never fall back to a neighbour", { skip: !chromeAvailable }, async t => {
  const f = await fixture(t);
  const oldId = f.pages[0].pageId;
  await f.first.close();
  await assert.rejects(f.engine.request({ id: "closed-state", method: "state", pageId: oldId }), { code: "surface_not_found" });
  await assert.rejects(f.engine.request({ id: "old", method: "navigate", pageId: oldId, params: { url: `${f.url}/wrong` } }), { code: "surface_not_found" });
  assert.equal(f.second.url(), `${f.url}/two`);
  const added = await f.engine.request({ id: "new", method: "open", params: { url: `${f.url}/new` } });
  assert.notEqual(added.pageId, oldId);
  const pending = f.engine.request({ id: "pending", method: "click", pageId: added.pageId, params: { selector: "#disabled" } });
  const rejected = assert.rejects(pending, { code: "surface_not_found" });
  await delay(150);
  const newPage = f.context.pages().find(page => page.url() === `${f.url}/new`);
  await newPage.close();
  await rejected;
  assert.equal(await f.second.locator("#increment").textContent(), "Increment");
});

test('real Chrome: select observation exposes exact choices for a label-to-value selection round trip', { skip: !chromeAvailable }, async t => {
  const f = await fixture(t), pageId = f.pages[0].pageId;
  await f.first.setContent(`<select id="payment" aria-label="付款条件">
    <option value="advance" selected>预付货款</option><option value=" net 30 " label="验收后30天">备用正文</option>
    <optgroup label="不可用" disabled><option value="blocked">停用账期</option></optgroup>
    <option value="hidden" hidden>HIDDEN_OPTION_SECRET</option><option value="${'x'.repeat(1001)}">Too long</option>
    </select><select aria-label="多选分类" multiple><option value="a" selected>甲</option><option value="b" selected>乙</option></select>
    <select aria-label="敏感验证选项" autocomplete="one-time-code"><option value="PRIVATE_SELECT_VALUE">PRIVATE_SELECT_LABEL</option></select>`);
  let observation = await f.engine.request({ id: 'observe-choices', method: 'observe', pageId });
  const payment = observation.elements.find(element => element.name === '付款条件');
  assert.ok(payment?.ref);
  assert.deepEqual(payment.options, [
    { label: '预付货款', value: 'advance', selected: true, disabled: false },
    { label: '验收后30天', value: ' net 30 ', selected: false, disabled: false },
    { label: '停用账期', value: 'blocked', selected: false, disabled: true },
  ]);
  assert.equal(payment.multiple, false);
  assert.equal(payment.optionsTruncated, true, 'oversized values are omitted instead of being silently changed');
  const multiple = observation.elements.find(element => element.name === '多选分类');
  assert.equal(multiple.multiple, true);
  assert.deepEqual(multiple.options.map(option => option.selected), [true, true]);
  assert.equal(observation.elements.find(element => element.name === '敏感验证选项').options, undefined);
  for (const secret of ['PRIVATE_SELECT_VALUE', 'PRIVATE_SELECT_LABEL', 'HIDDEN_OPTION_SECRET']) assert.equal(JSON.stringify(observation).includes(secret), false);
  const chosen = payment.options.find(option => option.label === '验收后30天' && !option.disabled);
  await f.engine.request({ id: 'select-observed-choice', method: 'interact', pageId,
    params: { action: 'select', ref: payment.ref, observationId: observation.observationId, value: chosen.value } });
  assert.equal(await f.first.locator('#payment').inputValue(), chosen.value);
  observation = await f.engine.request({ id: 'verify-chosen-option', method: 'observe', pageId });
  const selected = observation.elements.find(element => element.name === '付款条件').options.find(option => option.selected);
  assert.equal(selected.label, '验收后30天');
  assert.equal(selected.value, ' net 30 ');
});

test('real Chrome: select choices share a bounded observation budget and report truncation', { skip: !chromeAvailable }, async t => {
  const f = await fixture(t), pageId = f.pages[0].pageId;
  await f.first.setContent(Array.from({ length: 6 }, (_, select) => `<select aria-label="Choice ${select}">${
    Array.from({ length: 120 }, (_, option) => `<option value="${select}-${option}-${'v'.repeat(900)}">Option ${option}</option>`).join('')
  }</select>`).join(''));
  const observation = await f.engine.request({ id: 'observe-bounded-choices', method: 'observe', pageId });
  const selects = observation.elements.filter(element => element.options);
  const choices = selects.flatMap(element => element.options);
  assert.ok(choices.length > 0 && choices.length <= 500);
  assert.ok(selects.every(element => element.options.length <= 100));
  assert.ok(choices.reduce((sum, option) => sum + option.label.length + option.value.length, 0) <= 24_000);
  assert.ok(selects.some(element => element.optionsTruncated));
  assert.equal(observation.truncated, true);
});

test("real Chrome: click wait conditions share one deadline, timeout never clicks again, and focus/element scroll are supported", { skip: !chromeAvailable }, async t => {
  const f = await fixture(t);
  const pageId = f.pages[0].pageId;
  const content = `<button id="go" onclick="window.clicks=(window.clicks||0)+1;setTimeout(()=>{document.querySelector('#appears').hidden=false;document.querySelector('#gone').hidden=true;document.querySelector('#value').value='ready';document.querySelector('#check').checked=true;history.pushState({},'', '/done')},30)">Go</button>
    <div id="appears" hidden>Appeared</div><div id="gone">Will disappear</div><input id="value"><input type="checkbox" id="check"><input id="bottom" aria-label="Bottom" style="display:block;margin-top:1800px">`;
  const conditions = [
    { selector: "#appears", state: "visible" }, { selector: "#gone", state: "hidden" },
    { selector: "#value", state: "value", value: "ready" }, { selector: "#check", state: "checked", checked: true },
    { state: "url", value: `${f.url}/done` }
  ];
  for (const waitFor of conditions) {
    await f.first.goto(`${f.url}/one`); await f.first.setContent(content);
    const result = await f.engine.request({ id: `wait-${waitFor.state}`, method: "click", pageId, params: { selector: "#go", waitFor, timeoutMs: 1000 } });
    assert.equal(result.status, "condition_met", JSON.stringify(result));
    assert.equal(result.conditionMatched, true);
    assert.equal(result.action.outcome, "complete");
    assert.equal(await f.first.evaluate(() => window.clicks), 1, "a wait condition must never repeat the click");
  }
  await f.first.goto(`${f.url}/one`); await f.first.setContent(content);
  const timedOut = await f.engine.request({ id: "wait-timeout", method: "click", pageId, params: { selector: "#go", waitFor: { selector: "#never", state: "visible" }, timeoutMs: 200 } });
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.action.outcome, "complete");
  assert.equal(timedOut.conditionMatched, false);
  assert.ok(timedOut.timingsMs.total >= 190 && timedOut.timingsMs.total < 800, JSON.stringify(timedOut));
  assert.equal(await f.first.evaluate(() => window.clicks), 1);
  await f.first.goto(`${f.url}/one`); await f.first.setContent(content);
  const invalidWait = await f.engine.request({ id: "invalid-wait", method: "click", pageId, params: { selector: "#go", waitFor: { selector: "[", state: "visible" }, timeoutMs: 200 } });
  assert.equal(invalidWait.status, "failed");
  assert.equal(invalidWait.action.outcome, "not_started");
  assert.equal(await f.first.evaluate(() => window.clicks ?? 0), 0);
  await f.engine.request({ id: "scroll-target", method: "interact", pageId, params: { action: "scroll", selector: "#bottom" } });
  assert.ok(await f.first.evaluate(() => window.scrollY > 0));
  await f.engine.request({ id: "focus", method: "interact", pageId, params: { action: "focus", selector: "#bottom" } });
  assert.equal(await f.first.locator("#bottom").evaluate(element => element === element.ownerDocument.activeElement), true);
});

test("real Chrome: cancellation disconnects the owned CDP client, keeps Chrome and its pages, and rejects queued actions", { skip: !chromeAvailable }, async t => {
  const server = http.createServer((_request, response) => response.end(pageHtml));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-owned-chrome-"));
  const child = spawn(executablePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  t.after(async () => { child.kill(); await once(child, "exit").catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); });
  const endpointFile = path.join(profile, "DevToolsActivePort");
  for (let count = 0; !fs.existsSync(endpointFile) && count < 100; count++) await delay(50);
  const port = fs.readFileSync(endpointFile, "utf8").split("\n")[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0]; await page.goto(`http://127.0.0.1:${server.address().port}/cancel`);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-cancel-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const controller = await upstream.create({ context, outputDir });
  const disconnect = controller.disconnect.bind(controller);
  controller.disconnect = async () => { const closing = browser.close(); await disconnect(); await closing; };
  const engine = new ChromeWorkerEngine(async () => controller);
  await engine.request({ id: "connect", method: "connect" });
  const pageId = (await controller.list())[0].pageId;
  const pending = engine.request({ id: "click", method: "click", pageId, params: { selector: "#disabled" } });
  const rejected = assert.rejects(pending);
  const queued = engine.request({ id: "later", method: "navigate", pageId, params: { url: "https://example.invalid/" } });
  const queuedRejected = assert.rejects(queued, { code: "cancelled" });
  await delay(150);
  const started = Date.now();
  await engine.request({ id: "stop", method: "cancel" });
  await Promise.all([rejected, queuedRejected]);
  await assert.rejects(engine.request({ id: "released-list", method: "list" }), { code: "browser_disconnected" });
  assert.deepEqual(await engine.request({ id: "released-state", method: "state" }), { connected: false, pages: [] });
  assert.ok(Date.now() - started < 3000, "releasing the CDP transport should interrupt auto-waiting");
  assert.equal(child.exitCode, null, "Chrome process survives disconnect");
  const reconnected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  assert.equal(reconnected.contexts()[0].pages().length, 1);
  assert.equal(await reconnected.contexts()[0].pages()[0].locator("#increment").textContent(), "Increment");
  await reconnected.close();
});
