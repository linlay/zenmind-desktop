import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { patchBrowserUseUpstream } from '../scripts/browser-use-patch.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
patchBrowserUseUpstream(root);
const { chromium } = require('playwright-core');
const upstream = require(path.join(root, 'node_modules/playwright-core/lib/coreBundle.js')).__desktopBrowserUse;
const { ChromeWorkerEngine } = require('../dist-electron/main/modules/browser-use/chrome-worker-engine.js');
const executablePath = process.env.BROWSER_USE_TEST_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : '/usr/bin/google-chrome');
const available = fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile();

async function fixture(t, contextOptions = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/download') { response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' }); response.end('alpha,beta\n1,2\n'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/frame') response.end('<title>Frame fixture</title><button onclick="window.clicks=(window.clicks||0)+1;setTimeout(()=>{document.querySelector(\'#saved\').hidden=false},80)">Save frame</button><div id="saved" hidden>FRAME_DONE</div>');
    else response.end('<title>Business fixture</title><h1>Business fixture</h1><input aria-label="Name"><button>Other action</button>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, url = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP frame.fixture.test 127.0.0.1'] });
  t.after(() => browser.close());
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage(); await page.goto(url + '/one');
  const neighbour = await context.newPage(); await neighbour.goto(url + '/two');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-scenarios-'));
  t.after(() => fs.rmSync(outputDir, { force: true, recursive: true }));
  let controller;
  const engine = new ChromeWorkerEngine(async options => { controller = await upstream.create({ ...options, context, outputDir }); return controller; });
  const connected = await engine.request({ id: 'connect', method: 'connect' });
  t.after(() => engine.disconnect());
  const pageId = connected.pages.find(item => item.url === url + '/one').pageId;
  const otherId = connected.pages.find(item => item.url === url + '/two').pageId;
  const call = (method, params = {}, target = pageId) => engine.request({ id: 'fixture-' + method, method, params, pageId: target });
  const observed = async () => call('observe');
  const target = (observation, name) => {
    const element = observation.elements.find(item => item.name === name);
    assert.ok(element, 'Missing observed element ' + name);
    return { ref: element.ref, observationId: observation.observationId };
  };
  return { server, url, port, browser, context, page, neighbour, engine, controller, pageId, otherId, outputDir, call, observed, target };
}

test('Chrome typed form actions return usable nested observations, multi-select and idempotent checked state', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<p>价格：<strong>999</strong>元/件（含税）</p><input aria-label="Name" required><label><input type="checkbox" id="check">Reviewed</label><button disabled>Disabled action</button><select multiple aria-label="Choices"><option value="a">A</option><option value="b" disabled>B</option><option value="c">C</option></select><div id="menu" role="combobox" aria-label="Custom menu" aria-expanded="false" onmouseenter="this.setAttribute(\'aria-expanded\',\'true\')">Menu</div><div style="height:4000px">Scrollable</div>');
  let observation = await f.observed();
  for (const text of ['价格：', '999', '元/件（含税）']) assert.ok(observation.text.includes(text));
  assert.equal(observation.elements.find(item => item.name === 'Disabled action').disabled, true);
  let result = await f.call('interact', { ...f.target(observation, 'Name'), action: 'fill', value: 'initial' });
  assert.equal(result.action.outcome, 'complete'); assert.ok(result.observation);
  observation = result.observation;
  assert.equal(observation.elements.find(item => item.name === 'Name').value, 'initial');
  result = await f.call('interact', { ...f.target(observation, 'Name'), action: 'press', key: 'ControlOrMeta+A' });
  result = await f.call('interact', { ...f.target(result.observation, 'Name'), action: 'type', value: 'typed' });
  assert.equal(await f.page.locator('input[aria-label=Name]').inputValue(), 'typed');
  await assert.rejects(f.call('interact', { ...f.target(result.observation, 'Name'), action: 'press', key: 'ControlOrMeta+W' }), { code: 'invalid_params' });
  result = await f.call('interact', { ...f.target(result.observation, 'Reviewed'), action: 'check' });
  assert.equal(result.observation.elements.find(item => item.name === 'Reviewed').checked, true);
  result = await f.call('interact', { ...f.target(result.observation, 'Reviewed'), action: 'check' });
  assert.equal(await f.page.locator('#check').isChecked(), true);
  result = await f.call('interact', { ...f.target(result.observation, 'Reviewed'), action: 'uncheck' });
  assert.equal(await f.page.locator('#check').isChecked(), false);
  result = await f.call('interact', { ...f.target(result.observation, 'Choices'), action: 'select', values: ['a', 'c'] });
  assert.deepEqual(result.observation.elements.find(item => item.name === 'Choices').options.filter(item => item.selected).map(item => item.value), ['a', 'c']);
  await assert.rejects(f.call('interact', { ...f.target(result.observation, 'Choices'), action: 'select', value: 'a', values: ['c'] }), { code: 'invalid_params' });
  result = await f.call('interact', { ...f.target(result.observation, 'Choices'), action: 'select', values: [] });
  assert.deepEqual(result.observation.elements.find(item => item.name === 'Choices').options.filter(item => item.selected), []);
  result = await f.call('interact', { ...f.target(result.observation, 'Custom menu'), action: 'hover' });
  assert.equal(result.observation.elements.find(item => item.name === 'Custom menu').expanded, true);
  result = await f.call('interact', { action: 'scroll', deltaY: 500, deltaX: 0 });
  assert.ok(result.observation);
  await f.page.waitForFunction(() => scrollY > 0);
  await assert.rejects(f.call('interact', { action: 'scroll', deltaY: 2001 }), { code: 'invalid_params' });
  assert.equal(await f.neighbour.title(), 'Business fixture');
});

test('Chrome mutation observation failures preserve the completed action and never replay it', { skip: !available }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<input id="name" aria-label="Name" oninput="window.inputs=(window.inputs||0)+1">');
  await f.controller.run(f.pageId, async tab => { tab.captureSnapshot = async () => { throw new Error('PRIVATE_UPSTREAM_URL_AND_CREDENTIAL'); }; });
  const result = await f.call('interact', { selector: '#name', action: 'fill', value: 'once' });
  assert.equal(result.action.outcome, 'complete'); assert.equal(result.status, 'done');
  assert.equal(result.observation, undefined); assert.equal(result.observationError.code, 'observation_snapshot_failed');
  assert.equal(JSON.stringify(result).includes('PRIVATE_UPSTREAM'), false);
  assert.equal(await f.page.locator('#name').inputValue(), 'once');
  assert.equal(await f.page.evaluate(() => window.inputs), 1);
});

test('Chrome rechecks an observed target after asynchronous resolution before dispatching input into a replaced document', { skip: !available }, async t => {
  const f = await fixture(t);
  const observation = await f.observed();
  await f.controller.run(f.pageId, async tab => {
    const original = tab.targetLocator.bind(tab); let changed = false;
    tab.targetLocator = async params => {
      const result = await original(params);
      if (!changed) { changed = true; await tab.page.goto(f.url + '/replacement'); }
      return result;
    };
  });
  await assert.rejects(f.call('interact', { ...f.target(observation, 'Name'), action: 'fill', value: 'must not land' }), { code: 'stale_observation' });
  assert.equal(await f.page.locator('input').inputValue(), '');
  assert.equal(await f.neighbour.locator('input').inputValue(), '');
});

test('Chrome open/navigation/back/reload return fresh nested observations for the same exact page', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const initial = await f.observed();
  const navigated = await f.call('navigate', { url: f.url + '/three' });
  assert.equal(navigated.action.outcome, 'complete'); assert.equal(navigated.observation.url, f.url + '/three');
  assert.notEqual(navigated.observation.observationId, initial.observationId);
  const back = await f.call('back'); assert.equal(back.observation.url, f.url + '/one');
  const reloaded = await f.call('reload'); assert.equal(reloaded.observation.url, f.url + '/one');
  const opened = await f.engine.request({ id: 'open-business-page', method: 'open', params: { url: f.url + '/new' } });
  assert.equal(opened.status, 'done'); assert.ok(opened.observation); assert.notEqual(opened.pageId, f.pageId);
  assert.equal(opened.observation.url, f.url + '/new');
  assert.equal(await f.neighbour.url(), f.url + '/two');
});

test('Chrome native confirm/prompt/alert have observation-bound opaque IDs; handling them never repeats the originating click', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<button id="confirm" onclick="window.clicks=(window.clicks||0)+1;window.answer=confirm(\'Proceed?\')">Confirm</button><button id="prompt" onclick="window.promptClicks=(window.promptClicks||0)+1;window.promptAnswer=prompt(\'Name?\',\'PROMPT_DEFAULT_SECRET\')">Prompt</button><button id="alert" onclick="alert(\'Message\')">Alert</button>');
  const clicked = await f.call('click', { selector: '#confirm' });
  assert.equal(clicked.error, 'dialog_pending'); assert.equal(clicked.action.outcome, 'unknown');
  const observation = clicked.observation, dialog = observation.dialogs[0];
  assert.equal(dialog.type, 'confirm'); assert.equal(dialog.message, 'Proceed?');
  const started = Date.now(); const state = await f.engine.request({ id: 'connection-state', method: 'state' });
  assert.ok(Date.now() - started < 1000, 'state must use cached metadata while a JS dialog blocks the page');
  assert.ok(state.connected); assert.ok((await f.call('list')).some(item => item.pageId === f.pageId));
  await assert.rejects(f.call('dialog', { observationId: observation.observationId, dialogId: dialog.dialogId, action: 'accept' }, f.otherId), { code: 'stale_observation' });
  await assert.rejects(f.call('dialog', { observationId: 'wrong-observation', dialogId: dialog.dialogId, action: 'accept' }), { code: 'stale_observation' });
  let handled = await f.call('dialog', { observationId: observation.observationId, dialogId: dialog.dialogId, action: 'dismiss' });
  assert.deepEqual(handled.observation.dialogs, []);
  await delay(100); assert.equal(await f.page.evaluate(() => window.clicks), 1);
  assert.equal(await f.page.evaluate(() => window.answer), false);
  await assert.rejects(f.call('dialog', { observationId: observation.observationId, dialogId: dialog.dialogId, action: 'accept' }), { code: 'stale_observation' });
  const prompt = await f.call('click', { selector: '#prompt' });
  assert.equal(JSON.stringify(prompt).includes('PROMPT_DEFAULT_SECRET'), false);
  const promptDialog = prompt.observation.dialogs[0];
  handled = await f.call('dialog', { observationId: prompt.observation.observationId, dialogId: promptDialog.dialogId, action: 'accept', promptText: 'Controlled answer' });
  assert.ok(handled.observation); assert.equal(await f.page.evaluate(() => window.promptAnswer), 'Controlled answer');
  assert.equal(await f.page.evaluate(() => window.promptClicks), 1);
  const alert = await f.call('click', { selector: '#alert' });
  const alertDialog = alert.observation.dialogs[0];
  await assert.rejects(f.call('dialog', { observationId: alert.observation.observationId, dialogId: alertDialog.dialogId, action: 'accept', promptText: 'invalid' }), { code: 'invalid_params' });
  handled = await f.call('dialog', { observationId: alert.observation.observationId, dialogId: alertDialog.dialogId, action: 'accept' });
  assert.deepEqual(handled.observation.dialogs, []);
});

test('Chrome iframe wait conditions use the target owning frame and cannot match a same-ID top-document element', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<div id="saved">TOP_ALREADY_VISIBLE</div><iframe title="Cross-origin frame" src="http://frame.fixture.test:' + f.port + '/frame"></iframe>');
  await f.page.frames().find(frame => frame !== f.page.mainFrame()).waitForLoadState('domcontentloaded');
  const observation = await f.observed();
  const target = f.target(observation, 'Save frame');
  const started = Date.now();
  const result = await f.call('click', { ...target, waitFor: { selector: '#saved', state: 'visible' }, timeoutMs: 1000 });
  assert.equal(result.status, 'condition_met'); assert.ok(Date.now() - started >= 60);
  assert.ok(result.observation);
  const frame = f.page.frames().find(frame => frame.url().includes('frame.fixture.test'));
  assert.equal(await frame.evaluate(() => window.clicks), 1);
  assert.equal(await frame.locator('#saved').isVisible(), true);
});

test('Chrome beforeunload is observed and dismissing it cancels the original navigation without replay', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<button id="activate">Activate</button>');
  await f.call('click', { selector: '#activate' });
  await f.page.evaluate(() => { onbeforeunload = event => { window.prompts = (window.prompts || 0) + 1; event.preventDefault(); event.returnValue = ''; }; });
  const navigated = await f.call('navigate', { url: f.url + '/three' });
  assert.equal(navigated.error, 'dialog_pending'); assert.equal(navigated.action.outcome, 'unknown');
  const dialog = navigated.observation.dialogs[0]; assert.equal(dialog.type, 'beforeunload');
  const handled = await f.call('dialog', { observationId: navigated.observation.observationId, dialogId: dialog.dialogId, action: 'dismiss' });
  assert.ok(handled.observation); assert.equal(f.page.url(), f.url + '/one');
  await delay(100); assert.equal(await f.page.evaluate(() => window.prompts), 1);
});

test('Chrome cancellation interrupts a pending native handler and discards late completion', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<button onclick="confirm(\'Pending?\')">Confirm</button>');
  const clicked = await f.call('click', { selector: 'button' });
  const observation = clicked.observation, dialog = observation.dialogs[0];
  let resolveNative, called = 0;
  await f.controller.run(f.pageId, async tab => {
    const pending = tab.modalStates().find(state => state.type === 'dialog');
    pending.dialog.accept = () => { called++; return new Promise(resolve => { resolveNative = resolve; }); };
  });
  const handling = f.call('dialog', { observationId: observation.observationId, dialogId: dialog.dialogId, action: 'accept' });
  const rejected = assert.rejects(handling, { code: 'cancelled' });
  await delay(20); await f.engine.disconnect(); await rejected;
  assert.equal(called, 1); resolveNative(); await delay(20);
  const state = await f.engine.request({ id: 'released-state', method: 'state' });
  assert.deepEqual(state, { connected: false, pages: [] });
  assert.equal(f.context.pages().length, 2, 'the owned Chrome pages remain after releasing automation');
});

test('Chrome file chooser and observed file input accept only scoped bytes; downloads have one bounded host consumer', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.page.setContent('<input id="file" type="file" multiple aria-label="Attachment" onchange="document.querySelector(\'#status\').textContent=[...this.files].map(file=>file.name).join(\',\')"><button id="choose" onclick="document.querySelector(\'#file\').click()">Choose attachment</button><div id="status"></div><a href="/download" download>Export report</a><input aria-label="Not a file">');
  const clicked = await f.call('click', { selector: '#choose' });
  assert.ok(clicked.error === 'file_chooser_pending' || clicked.action.outcome === 'complete');
  const chooser = clicked.observation.fileChoosers[0]; assert.equal(chooser.multiple, true);
  const files = [{ name: 'input.csv', mimeType: 'text/csv', data: Buffer.from('name\nfixture\n').toString('base64') }];
  await assert.rejects(f.call('upload', { observationId: clicked.observation.observationId, chooserId: chooser.chooserId, files }, f.otherId), { code: 'stale_observation' });
  const uploaded = await f.call('upload', { observationId: clicked.observation.observationId, chooserId: chooser.chooserId, files });
  assert.ok(uploaded.observation); assert.deepEqual(uploaded.observation.fileChoosers, []);
  assert.equal(uploaded.observation.elements.find(element => element.name === 'Attachment').fileCount, 1);
  assert.equal(await f.page.locator('#status').textContent(), 'input.csv');
  const observation = uploaded.observation;
  await assert.rejects(f.call('upload', { ...f.target(observation, 'Not a file'), files }), { code: 'invalid_params' });
  const exported = await f.call('click', { selector: 'a' }); assert.ok(exported.observation);
  let download;
  for (let i = 0; i < 100; i++) { download = (await f.call('downloads', { action: 'list' })).downloads[0]; if (download?.status === 'complete') break; await delay(20); }
  assert.equal(download.status, 'complete'); assert.equal(download.fileName, 'report.csv');
  const saved = await f.call('downloads', { action: 'read', downloadId: download.downloadId });
  assert.deepEqual(Object.keys(saved).sort(), ['data', 'downloadId', 'fileName', 'mimeType', 'sha256', 'sizeBytes']);
  assert.equal(Buffer.from(saved.data, 'base64').toString(), 'alpha,beta\n1,2\n');
  await assert.rejects(f.call('downloads', { action: 'read', downloadId: download.downloadId }, f.otherId), { code: 'download_not_found' });
  const artifacts = fs.readdirSync(f.outputDir, { recursive: true }).filter(name => fs.statSync(path.join(f.outputDir, name)).isFile());
  for (const name of artifacts) assert.equal(fs.readFileSync(path.join(f.outputDir, name), 'utf8').includes('alpha,beta'), false, 'the upstream must not write a duplicate unbounded download artifact');
});

test('Chrome viewport observations expose the long-page tail after typed scrolling, using real upstream CSS viewport boxes', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 650 }, (_, i) => '<button style="display:block;height:40px" aria-label="Row ' + i + ' ' + 'long-name-'.repeat(120) + '">Row ' + i + '</button>').join('');
  await f.page.setContent(rows + '<button id="tail" style="display:block;height:40px">Tail operation</button>');
  const raw = await f.controller.run(f.pageId, tab => tab.captureSnapshot(undefined, 20, true, undefined, 'json', false));
  const all = [], visit = nodes => { for (const node of nodes ?? []) { if (!node || typeof node !== 'object') continue; all.push(node); visit(node.children); } }; visit(raw.ariaSnapshotJSON);
  const tailBox = all.find(node => node.name === 'Tail operation').box;
  assert.deepEqual(Object.keys(tailBox).sort(), ['height', 'width', 'x', 'y']);
  const actual = await f.page.locator('#tail').boundingBox(); assert.ok(Math.abs(actual.y - tailBox.y) <= 1);
  const first = await f.call('observe', { viewportOnly: true });
  assert.equal(first.elements.some(element => element.name === 'Tail operation'), false);
  // Fixture setup puts the viewport one public wheel step from the tail; the final movement uses the real typed action.
  await f.page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight - innerHeight - 1500));
  const scrolled = await f.call('interact', { action: 'scroll', deltaY: 2000 });
  assert.equal(scrolled.observation.viewportOnly, true);
  const tail = scrolled.observation.elements.find(element => element.name === 'Tail operation');
  assert.ok(tail, 'offscreen long names must not exhaust the budget before the visible tail operation');
  assert.ok(Buffer.byteLength(JSON.stringify(scrolled.observation)) <= 128 * 1024);
  assert.ok(scrolled.observation.elements.length < 100);
  const clicked = await f.call('click', { ref: tail.ref, observationId: scrolled.observation.observationId });
  assert.equal(clicked.status, 'clicked');
});

test('Chrome viewport observation uses the main Frame with no default viewport and shadow-injected html', { skip: !available, timeout: 30000 }, async t => {
  const f = await fixture(t, { viewport: null });
  assert.equal(f.page.viewportSize(), null);
  await f.page.setContent('<h1>Native viewport</h1><button>Viewport action</button><div id="extension-root"></div><div style="height:2000px"></div>');
  await f.page.locator('#extension-root').evaluate(host => {
    const html = host.ownerDocument.createElement('html');
    html.textContent = 'Synthetic extension panel';
    host.attachShadow({ mode: 'open' }).append(html);
  });
  assert.equal(await f.page.locator('html').count(), 2);
  await assert.rejects(f.page.locator('html').evaluate(element => element.ownerDocument.defaultView.innerWidth), /strict mode violation/u,
    'the old locator-based viewport probe must fail for this owned fixture');
  assert.ok((await f.call('observe')).elements.some(element => element.name === 'Viewport action'));
  const result = await f.call('observe', { viewportOnly: true });
  assert.equal(result.viewportOnly, true);
  assert.ok(result.elements.some(element => element.name === 'Viewport action'));
  const scrolled = await f.call('interact', { action: 'scroll', deltaY: 400 });
  assert.equal(scrolled.action.outcome, 'complete');
  assert.equal(scrolled.observation.viewportOnly, true);
  assert.equal(scrolled.observationError, undefined);
});
