// Real Chromium + webview, isolated from Desktop's application profile and services.
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EmbeddedCdpGateway, createEmbeddedWebSurfaceId } = require('../../dist-electron/main/modules/web-surfaces/cdp/gateway.js');
const { createBrowserSurfaceRegistry } = require('../../dist-electron/main/modules/web-surfaces/browser-surface-registry.js');
const { acquireWorkPanelControlScope } = require('../../dist-electron/main/modules/web-surfaces/cdp/site-scope.js');
const { createChatChildSurfaceIdentity } = require('../../dist-electron/shared/surface-identity.js');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-observation-'));
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
const guard = setTimeout(() => { console.error('browser observation fixture timed out'); app.exit(1); }, 45_000);
process.on('uncaughtException', error => { console.error(error); clearTimeout(guard); app.exit(1); });
const page = `<!doctype html><title>Observation fixture</title><style>
body{font:16px sans-serif}button,input,select{margin:8px;padding:6px}iframe{width:440px;height:100px;display:block}
</style><h1>Visible fixture body</h1><p hidden>HIDDEN_BODY_SECRET</p>
<button id="submit">Submit</button><button id="replace">Replace me</button><button disabled>Disabled</button>
<label>Name <input id="name" value="initial"></label><label>Password <input id="password" type="password" value="PASSWORD_SECRET"></label>
<label>Count <input id="count" type="number" value="12"></label><div id="editor" contenteditable aria-label="Editor">initial editor</div>
<select id="choice" aria-label="Choose"><option value="a">Alpha</option><option value="b">Beta</option>
<optgroup disabled><option value="blocked">Disabled choice</option></optgroup><option hidden value="hidden">HIDDEN_OPTION_SECRET</option></select>
<select aria-label="Multiple" multiple><option selected value="m1">First</option><option selected value="m2">Second</option></select>
<select aria-label="Sensitive choices" autocomplete="one-time-code"><option value="PRIVATE_SELECT_VALUE">PRIVATE_SELECT_LABEL</option></select>
<select id="cost" aria-label="Cost center"><option value="old">Old</option><option value="DX-420">Design</option></select>
<textarea id="purpose" aria-label="Purpose"></textarea><button id="parallel" onclick="window.parallelClicks=(window.parallelClicks||0)+1">Parallel action</button>
<div id="shadow"></div><iframe src="/frame"></iframe><div id="ready" hidden>Ready</div>
<script>window.clicks=0;window.trusted=[];
document.querySelector('#submit').onclick=e=>{window.clicks++;window.trusted.push(e.isTrusted);document.querySelector('#ready').hidden=false};
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow action</button><input aria-label="Shadow input" value="initial shadow">';
document.querySelector('#shadow').shadowRoot.querySelector('button').onclick=e=>{window.shadowClicks=(window.shadowClicks||0)+1;window.trusted.push(e.isTrusted)};
</script>`;

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/foreground' ? '<input id="foreground" value="keep foreground">' : req.url.startsWith('/frame') ? '<button id="frame-button" onclick="parent.frameClicks=(parent.frameClicks||0)+1;parent.trusted.push(event.isTrusted)">Frame action</button><input aria-label="Frame input" value="initial frame">' : page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const host = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  let gateway;
  try {
    const attached = new Promise((resolve) => host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)));
    await host.loadURL('data:text/html,' + encodeURIComponent(`<style>html,body,webview{margin:0;width:100%;height:100%}</style><webview id="workpanel" src="${url}" style="width:100%;height:100%"></webview>`));
    const guest = await attached;
    if (guest.isLoading()) await new Promise((resolve) => guest.once('did-finish-load', resolve));
    await guest.executeJavaScript('new Promise(resolve=>setTimeout(resolve,80))');
    const attachForeground = new Promise(resolve => host.webContents.once('did-attach-webview', (_event, contents) => resolve(contents)));
    await host.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<webview id="foreground" src="${url}foreground" style="position:absolute;bottom:0;left:0;width:100%;height:45px"></webview>')`);
    const foreground = await attachForeground;
    if (foreground.isLoading()) await new Promise(resolve => foreground.once('did-finish-load', resolve));
    const focusGuest = async (id, contents) => {
      await host.webContents.executeJavaScript(`(()=>{const guest=document.getElementById(${JSON.stringify(id)});guest.focus();guest.shadowRoot.querySelector('iframe').focus({preventScroll:true})})()`);
      contents.focus();
    };
    await focusGuest('foreground', foreground);
    await foreground.executeJavaScript('document.querySelector("input").focus()');
    const registry = createBrowserSurfaceRegistry({ webContents, listWebEntries: () => ({ items: [] }), getCurrentPageSnapshot: () => null });
    const identity = createChatChildSurfaceIdentity('workpanel-web', 'web:fixture', 'fixture-chat', 'main-chat');
    const tab = { tabId: 'fixture-item', webContentsId: guest.id, currentUrl: url, title: 'Fixture', canGoBack: false, canGoForward: false, isLoading: false };
    const registration = { ...identity, registrationId: 'fixture-registration', surfaceIdentityKey: 'web:fixture', surfaceKind: 'chat-work-panel',
      ownerChatId: 'fixture-chat', label: 'Fixture', url, active: false, tabs: [tab], activeTabId: tab.tabId };
    assert.deepEqual(registry.registerSurfaceResult(registration, host.webContents.id), { ok: true });
    gateway = new EmbeddedCdpGateway({ getSurfaces: () => registry.listWorkPanelContainers(), resolveWebContents: (_surface, target) => webContents.fromId(target.webContentsId),
      acquireWorkPanelScope: (id, chatId) => acquireWorkPanelControlScope(registry, id, chatId),
      controlSiteFocus: async (_surface, _tab, _scope, phase) => {
        if (phase === 'input') await focusGuest('workpanel', guest);
        else if (phase === 'restore') await focusGuest('foreground', foreground);
      }, logger: { debug() {}, warn() {} } });
    const container = registry.listWorkPanelContainers()[0];
    const surfaceId = createEmbeddedWebSurfaceId(container, tab);
    const command = async (method, params, signal) => (await gateway.executeCommand({ method, params, surfaceId, source: { chatId: 'fixture-chat' } }, undefined, signal)).result;
    const observe = (params) => command('Surface.observe', params);
    const locate = (observation, name) => {
      const element = observation.elements.find((candidate) => candidate.name === name);
      assert.ok(element, `Missing observed element ${name}`);
      return { observationId: observation.observationId, ref: element.ref };
    };
    let observation = await observe();
    assert.equal(observation.provider, 'workpanel');
    assert.match(observation.text, /Visible fixture body/u);
    assert.equal(JSON.stringify(observation).includes('PASSWORD_SECRET'), false);
    assert.equal(JSON.stringify(observation).includes('HIDDEN_BODY_SECRET'), false);
    assert.equal(observation.elements.find((element) => element.name === 'Password').value, undefined);
    assert.deepEqual(observation.elements.find(element => element.name === 'Choose').options, [
      { label: 'Alpha', value: 'a', selected: true, disabled: false },
      { label: 'Beta', value: 'b', selected: false, disabled: false },
      { label: 'Disabled choice', value: 'blocked', selected: false, disabled: true },
    ]);
    assert.equal(observation.elements.find(element => element.name === 'Multiple').multiple, true);
    assert.deepEqual(observation.elements.find(element => element.name === 'Multiple').options.map(option => option.selected), [true, true]);
    assert.equal(observation.elements.find(element => element.name === 'Sensitive choices').options, undefined);
    for (const secret of ['PRIVATE_SELECT_VALUE', 'PRIVATE_SELECT_LABEL', 'HIDDEN_OPTION_SECRET']) assert.equal(JSON.stringify(observation).includes(secret), false);
    locate(observation, 'Shadow action'); locate(observation, 'Frame action');
    assert.equal(guest.debugger.isAttached(), false, 'host-owned attach is released after observation');
    const parallel = await Promise.allSettled([
      ['Name', 'fill', 'parallel project'], ['Count', 'fill', '6'], ['Choose', 'select', 'b'],
      ['Cost center', 'select', 'DX-420'], ['Purpose', 'fill', 'parallel purpose'],
    ].map(([name, action, value]) => command('Surface.interact', { ...locate(observation, name), action, value }))
      .concat(command('Surface.click', locate(observation, 'Parallel action'))));
    assert.ok(parallel.every(result => result.status === 'fulfilled'), JSON.stringify(parallel.map(result => result.status === 'fulfilled' ? result.value : result.reason.message)));
    assert.deepEqual(await guest.executeJavaScript('Object.fromEntries(["name","count","choice","cost","purpose"].map(id=>[id,document.getElementById(id).value]))'),
      { name: 'parallel project', count: '6', choice: 'b', cost: 'DX-420', purpose: 'parallel purpose' });
    assert.equal(await guest.executeJavaScript('window.parallelClicks'), 1);
    assert.equal(await foreground.executeJavaScript('document.querySelector("input").value'), 'keep foreground');
    const click = async (name, waitFor) => command('Surface.click', { ...locate(observation, name), ...(waitFor ? { waitFor } : {}) });
    let result = await click('Submit', { selector: '#[', state: 'visible' });
    assert.equal(result.error, 'invalid_wait_selector'); assert.equal(result.action.pressed, false);
    result = await click('Submit', { selector: '#ready', state: 'visible' });
    assert.equal(result.status, 'condition_met', JSON.stringify(result));
    result = await click('Shadow action'); assert.equal(result.status, 'clicked', JSON.stringify(result));
    result = await click('Frame action'); assert.equal(result.status, 'clicked', JSON.stringify(result));
    assert.equal(await guest.executeJavaScript('window.clicks + window.shadowClicks + window.frameClicks'), 3);
    assert.equal(await guest.executeJavaScript('window.trusted.every(Boolean)'), true);
    await command('Surface.interact', { ...locate(observation, 'Name'), action: 'fill', value: 'filled text' });
    assert.equal(await guest.executeJavaScript('document.querySelector("#name").value'), 'filled text');
    await command('Surface.interact', { ...locate(observation, 'Name'), action: 'fill', value: '' });
    assert.equal(await guest.executeJavaScript('document.querySelector("#name").value'), '');
    const choice = observation.elements.find(element => element.name === 'Choose').options.find(option => option.label === 'Beta' && !option.disabled);
    await command('Surface.interact', { ...locate(observation, 'Choose'), action: 'select', value: choice.value });
    assert.equal(await guest.executeJavaScript('document.querySelector("#choice").value'), 'b');
    observation = await observe();
    assert.equal(observation.elements.find(element => element.name === 'Choose').options.find(option => option.selected).label, 'Beta');
    for (const [name, value] of [['Count', '34'], ['Editor', 'edited content'], ['Shadow input', 'edited shadow'], ['Frame input', 'edited frame']]) {
      await command('Surface.interact', { ...locate(observation, name), action: 'fill', value });
    }
    assert.equal(await guest.executeJavaScript('document.querySelector("#count").value'), '34');
    assert.equal(await guest.executeJavaScript('document.querySelector("#editor").textContent'), 'edited content');
    assert.equal(await guest.executeJavaScript('document.querySelector("#shadow").shadowRoot.querySelector("input").value'), 'edited shadow');
    assert.equal(await guest.executeJavaScript('document.querySelector("iframe").contentDocument.querySelector("input").value'), 'edited frame');
    result = await click('Disabled'); assert.equal(result.error, 'element_disabled'); assert.equal(result.action.pressed, false);
    const replaced = locate(observation, 'Replace me');
    await guest.executeJavaScript('document.querySelector("#replace").outerHTML="<button id=replace data-ref=e2>Replace me</button>"');
    result = await command('Surface.click', replaced);
    assert.equal(result.error, 'element_ref_stale', JSON.stringify(result)); assert.equal(result.action.pressed, false);
    const previous = locate(observation, 'Submit');
    observation = await observe();
    const beforeFrameNavigation = locate(observation, 'Frame action');
    await guest.executeJavaScript('new Promise(resolve=>{const frame=document.querySelector("iframe");frame.onload=resolve;frame.src="/frame?renewed=1"})');
    await assert.rejects(command('Surface.click', beforeFrameNavigation), { code: 'observation_stale' });
    observation = await observe();
    const beforeDetach = locate(observation, 'Submit');
    guest.debugger.attach('1.3'); guest.debugger.detach();
    await assert.rejects(command('Surface.click', beforeDetach), { code: 'observation_stale' });
    observation = await observe();
    await assert.rejects(command('Surface.click', previous), { code: 'observation_stale' });
    await guest.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<div id="budget-fixture">' + Array.from({length:6},(_,s)=>'<select aria-label="Budget '+s+'">'+Array.from({length:120},(_,i)=>'<option value="'+s+'-'+i+'-'+ 'v'.repeat(900)+'">Option '+i+'</option>').join('')+'</select>').join('')+'</div>')`);
    const bounded = await observe();
    const options = bounded.elements.flatMap(element => element.options ?? []);
    assert.ok(options.length <= 500 && options.reduce((sum, option) => sum + option.label.length + option.value.length, 0) <= 24_000);
    assert.ok(bounded.elements.filter(element => element.options).every(element => element.options.length <= 100));
    assert.equal(bounded.truncated, true);
    await guest.executeJavaScript('document.querySelector("#budget-fixture").remove()');
    const limited = await observe({ maxTextLength: 12, maxElements: 2 });
    assert.ok(limited.text.length <= 12); assert.equal(limited.elements.length, 2); assert.equal(limited.truncated, true);
    observation = await observe();
    const beforeNavigation = locate(observation, 'Submit');
    await guest.executeJavaScript('history.pushState({}, "", "/changed")');
    await assert.rejects(command('Surface.click', beforeNavigation), { code: 'observation_stale' });
    observation = await observe();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(command('Surface.interact', { ...locate(observation, 'Name'), action: 'fill', value: 'must not run' }, controller.signal), /canceled/u);
    assert.equal(await guest.executeJavaScript('document.querySelector("#name").value'), '');
    await assert.rejects(gateway.executeCommand({ method: 'Surface.observe', surfaceId, source: { chatId: 'other-chat' } }), { code: 'target_not_owned_by_chat' });
    console.log('Browser observation real Electron: PASS (authorized webview, isolated refs, password exclusion, bounds, real click, same-origin iframe, open shadow, fill/clear/select, stale node/document, cancellation, Chat ownership)');
  } finally {
    // Mirrors application Quit: native guests can disappear before the gateway is stopped.
    host.destroy(); await new Promise(resolve => setImmediate(resolve));
    await gateway?.stop(); await new Promise((resolve) => server.close(resolve));
  }
}).then(() => {
  clearTimeout(guard); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(guard); app.exit(1); });
