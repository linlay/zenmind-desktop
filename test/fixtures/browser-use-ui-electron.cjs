// Real rendered component + trusted Main IPC, using a test browser client only.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { BrowserUseRuntime } = require('../../dist-electron/main/modules/browser-use/runtime.js');
const { registerBrowserUseIpc } = require('../../dist-electron/main/modules/browser-use/ipc.js');
const { BROWSER_USE_CHANGED } = require('../../dist-electron/shared/browser-use.js');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'build', 'qa', 'browser-use');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ui-'));
app.setPath('userData', profile); app.setPath('sessionData', path.join(profile, 'session'));
// The fixture renders offscreen; it must not activate the user's running Desktop app.
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
const guard = setTimeout(() => { console.error('Browser Use UI fixture timed out'); app.exit(1); }, 60_000);

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const brand = JSON.parse(fs.readFileSync(process.env.DESKTOP_BRAND_JSON, 'utf8'));
  buildSync({ entryPoints: [path.join(__dirname, 'browser-use-ui-renderer.tsx')], outfile: path.join(output, 'renderer.js'),
    bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], jsx: 'automatic',
    define: { __DESKTOP_APP_BRAND__: JSON.stringify(brand), 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(output, 'fixture.html'), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  const win = new BrowserWindow({ show: false, width: 1100, height: 720, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  const errors = [], calls = [], stops = [], requestGenerationChecks = [], connectionGuideChecks = [], workspaceChecks = [], settingsChecks = [], settingsRequests = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' || /Error|Uncaught/.test(event.message)) errors.push(event.message); });
  let approve;
  let connectFailure;
  const runtime = new BrowserUseRuntime({
    onChanged: state => win.webContents.send(BROWSER_USE_CHANGED, state),
    stopRun: async runId => { stops.push(runId); return { ok: true }; },
    createClient() {
      let rejectConnect;
      return {
        async request(method, params, pageId) {
          calls.push({ method, params, pageId });
          if (method === 'connect') {
            if (connectFailure) throw connectFailure;
            return new Promise((resolve, reject) => { approve = () => resolve({ connected: true }); rejectConnect = reject; });
          }
          if (method === 'list') return [
            { pageId: 'shared-a', title: '产品工作台 · 已登录的网页与当前浏览器任务', url: 'https://workspace.example.test/', active: true },
            { pageId: 'shared-b', title: '文档 / Browser Use 接入说明', url: 'https://docs.example.test/' },
          ];
          return { done: true };
        },
        async disconnect() {},
        kill() { rejectConnect?.(Object.assign(new Error('Connection canceled'), { code: 'browser_disconnected' })); },
      };
    },
  });
  registerBrowserUseIpc({ ipcMain, runtime, getMainWindow: () => win, getActiveChatId: () => 'chat-a', openExternal: async url => { calls.push({ method: 'openExternal', url }); } });
  // Settings rendering uses synthetic authorization and a Main-owned stub. The
  // production settings store has separate persistence/encryption coverage.
  let settingsState = { defaultBackend: 'workpanel', rememberChromeConnection: false, hasSavedAuthorization: false,
    secureStorageAvailable: true, connectedChats: 1, activeRuns: 0 };
  let settingsError;
  let wroteSyntheticAuthorization = false;
  ipcMain.handle('fixture.browserSettings', async (_event, request) => {
    settingsRequests.push({ ...request, ...(request.extensionToken ? { extensionToken: '<redacted>' } : {}) });
    if (settingsError) return { ok: false, error: settingsError };
    if (request.action === 'save') {
      wroteSyntheticAuthorization ||= request.extensionToken === 'SYNTHETIC_SETTINGS_AUTHORIZATION';
      settingsState = { ...settingsState, defaultBackend: request.defaultBackend,
        rememberChromeConnection: request.rememberChromeConnection,
        hasSavedAuthorization: request.rememberChromeConnection && (Boolean(request.extensionToken) || settingsState.hasSavedAuthorization) };
    }
    if (request.action === 'forget') {
      if (settingsState.activeRuns) return { ok: false, error: { code: 'browser_busy', message: 'fixture task active' } };
      settingsState = { ...settingsState, rememberChromeConnection: false, hasSavedAuthorization: false, connectedChats: 0 };
    }
    win.webContents.send('fixture.browserSettingsChanged', settingsState);
    return { ok: true, state: settingsState };
  });
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { console.error('Fixture expression failed:', code); throw error; });
  const wait = async expression => {
    const until = Date.now() + 6000;
    while (Date.now() < until) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('UI condition timed out: ' + expression);
  };
  const clickButton = async text => {
    const clicked = await js(`(()=>{const text=${JSON.stringify(text)}; const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text || b.textContent.replace(/\\s/gu, '')===text.replace(/\\s/gu, ''));if(!b)return false;b.click();return true})()`);
    assert.equal(clicked, true, `Missing button ${text}`);
  };
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 130));
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const radioInputsDisabled = 'document.querySelector(".browser-use-controls")?.dataset.busy === "true"';
  const radioInputsEnabled = 'document.querySelector(".browser-use-controls")?.dataset.busy === "false"';
  const settleRenderer = () => new Promise(resolve => setTimeout(resolve, 90));
  const holdDelivery = (action, label) => js(`window.browserUseDeliveryFixture.hold(${JSON.stringify(action)}, ${JSON.stringify(label)})`);
  const releaseDelivery = (label, mode = 'result') => js(`window.browserUseDeliveryFixture.release(${JSON.stringify(label)}, ${JSON.stringify(mode)})`);
  const waitDeliveryReady = label => wait(`window.browserUseDeliveryFixture.held[${JSON.stringify(label)}]?.ready === true`);
  try {
    await win.loadFile(path.join(output, 'fixture.html'));
    await wait('!!window.browserUseUiFixture && !!document.querySelector(".browser-use-trigger")');
    await js('document.querySelector(".browser-use-trigger").click()');
    await wait('!!document.querySelector(".browser-use-controls")');
    assert.match(await js('document.querySelector(".browser-use-controls").innerText'), /网页在当前对话右侧/u);
    await capture('01-workpanel-light');
    // WorkPanel never offers Chrome connection controls or requires a manual backend choice.
    assert.equal(runtime.state('chat-a').backend, 'workpanel');
    assert.equal(await js('document.querySelectorAll(".ant-radio-button-wrapper input").length'), 0);
    assert.equal(await js('[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "连接 Chrome")'), false);
    win.webContents.send(BROWSER_USE_CHANGED, { ...runtime.state('chat-a'), activeRunIds: ['workpanel-run'],
      workspaceShared: true, workspaceOwner: { chatId: 'other-chat', runId: 'chrome-run', draining: false } });
    await wait(radioInputsDisabled);
    assert.equal(await js('[...document.querySelectorAll("button")].some(button => /连接 Chrome|接管工作区|手动选择标签页/u.test(button.textContent))'), false);
    workspaceChecks.push({ name: 'workpanel-never-displays-unrelated-chrome-connection-or-takeover', pass: true });
    runtime.select('chat-a', 'chrome');
    await wait('document.body.innerText.includes("Chrome 尚未连接")');
    await clickButton('连接 Chrome');
    await wait('document.body.innerText.includes("正在连接 Chrome")');
    assert.equal(runtime.state('chat-a').backend, 'chrome');
    connectionGuideChecks.push({ name: 'task-chrome-target-displays-recovery-without-backend-radio', pass: true });
    await capture('03-chrome-connecting-light');
    approve();
    await wait('document.body.innerText.includes("Chrome 已连接")');
    assert.equal(await js('document.querySelectorAll(".browser-use-page-button").length'), 2);
    await capture('04-chrome-connected-light');
    runtime.registerRun({ runId: 'fixture-run', chatId: 'chat-a', agentKey: 'cutej' });
    await wait('document.body.innerText.includes("接管并停止")');
    assert.equal(await js(radioInputsDisabled), true);
    await capture('05-chrome-running-light');
    await js('window.browserUseUiFixture.setTheme("dark")');
    await capture('06-chrome-running-dark');
    await js('window.browserUseUiFixture.setLocale("en-US")');
    await wait('document.body.innerText.includes("Take over and stop")');
    await capture('07-chrome-running-dark-english');
    await clickButton('Take over and stop');
    await wait('!document.body.innerText.includes("Taking over stops")');
    assert.deepEqual(stops, ['fixture-run']);
    assert.deepEqual(runtime.state('chat-a').activeRunIds, []);
    connectFailure = Object.assign(new Error('chrome-extension://fixture/connect.html?token=SYNTHETIC_UI_CREDENTIAL'), { code: 'chrome_connection_failed' });
    await clickButton('Connect Chrome');
    await wait('document.querySelector(".browser-use-error")?.textContent.includes("Chrome is not connected")');
    assert.equal(await js('document.body.innerText.includes("SYNTHETIC_UI_CREDENTIAL")'), false);
    assert.equal(await js('document.body.innerText.includes("chrome-extension://")'), false);
    await js('window.browserUseUiFixture.setLocale("zh-CN")');
    await wait('document.querySelector(".browser-use-error")?.textContent.includes("尚未建立 Chrome 连接")');
    connectFailure = Object.assign(new Error('Chrome operation timed out'), { code: 'browser_action_timeout' });
    await clickButton('连接 Chrome');
    await wait('document.querySelector(".browser-use-error")?.textContent.includes("连接 Chrome 超时")');
    await capture('09-chrome-connection-timeout-dark');
    await js('window.browserUseUiFixture.setLocale("en-US")');
    await wait('document.querySelector(".browser-use-error")?.textContent.includes("The Chrome connection timed out")');
    // Delay delivery of real IPC results at the renderer boundary. Main and React still
    // run normally, so these are real same-Chat UI races without any Chrome/profile.
    await js(`(() => {
      const original = window.electronAPI.browserUse.control;
      const fixture = window.browserUseDeliveryFixture = {
        plans: [], held: {},
        hold(action, label) { this.plans.push({ action, label }); },
        release(label, mode) {
          const held = this.held[label];
          if (!held?.ready || held.delivered) throw new Error('Invalid fixture delivery order');
          held.delivered = true;
          if (mode === 'reject') held.reject(new Error('Obsolete renderer IPC failure'));
          else if (held.error) held.reject(held.error);
          else held.resolve(held.result);
        }
      };
      window.electronAPI.browserUse.control = request => {
        const index = fixture.plans.findIndex(plan => plan.action === request.action);
        if (index < 0) return original(request);
        const { label } = fixture.plans.splice(index, 1)[0];
        const held = fixture.held[label] = { ready: false, delivered: false };
        const pending = new Promise((resolve, reject) => { held.resolve = resolve; held.reject = reject; });
        Promise.resolve(original(request)).then(result => { held.result = result; held.ready = true; }, error => { held.error = error; held.ready = true; });
        return pending;
      };
    })()`);
    connectFailure = undefined;
    await js('window.browserUseUiFixture.setLocale("zh-CN")');
    await runtime.disconnect('chat-a');
    await wait('document.body.innerText.includes("Chrome 尚未连接")');
    for (const mode of ['result', 'reject']) {
      const oldConnect = `old-connect-${mode}`;
      const currentQuiet = `quiet-during-connect-${mode}`;
      const retiredQuiet = `quiet-before-reconnect-${mode}`;
      await holdDelivery('connect', oldConnect);
      await clickButton('连接 Chrome');
      await wait('document.body.innerText.includes("正在连接 Chrome")');
      assert.equal(await js(radioInputsDisabled), true, 'Pending connection must lock connection controls');
      if (mode === 'result') {
        await js('window.browserUseUiFixture.setLocale("en-US")');
        await wait('document.body.innerText.includes("Connecting to Chrome")');
        assert.equal(await js(radioInputsDisabled), true, 'A locale change must not reset an in-flight connection operation');
        await js('window.browserUseUiFixture.setLocale("zh-CN")');
        await wait('document.body.innerText.includes("正在连接 Chrome")');
        assert.equal(await js(radioInputsDisabled), true);
        requestGenerationChecks.push({ name: 'locale-change-keeps-pending-connect-generation-and-lock', pass: true });
      }

      // This quiet refresh belongs to the active operation; its completion must not
      // clear that connection's busy state even though its generation is current.
      await js('document.querySelector(".browser-use-trigger").click()');
      await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "false"');
      await holdDelivery('state', currentQuiet);
      await js('document.querySelector(".browser-use-trigger").click()');
      await waitDeliveryReady(currentQuiet);
      await releaseDelivery(currentQuiet);
      await settleRenderer();
      assert.equal(await js(radioInputsDisabled), true, 'Quiet state response cannot unlock a pending connection');
      requestGenerationChecks.push({ name: 'quiet-state-keeps-pending-connect-busy', mode, pass: true });

      await clickButton('取消连接');
      await wait('document.body.innerText.includes("Chrome 尚未连接")');
      await wait(radioInputsEnabled);
      await waitDeliveryReady(oldConnect);
      assert.equal(await js(`window.browserUseDeliveryFixture.held[${JSON.stringify(oldConnect)}].result.ok`), false,
        'Canceled real IPC request must supply the old failed result');

      // Capture a disconnected quiet snapshot, then deliver it only after the new
      // same-Chat connection succeeds. Chat identity alone cannot reject this reply.
      await js('document.querySelector(".browser-use-trigger").click()');
      await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "false"');
      await holdDelivery('state', retiredQuiet);
      await js('document.querySelector(".browser-use-trigger").click()');
      await waitDeliveryReady(retiredQuiet);
      await clickButton('连接 Chrome');
      await wait('document.body.innerText.includes("正在连接 Chrome")');
      assert.equal(await js(radioInputsDisabled), true);
      if (mode === 'result') {
        await releaseDelivery(oldConnect);
        await settleRenderer();
        assert.equal(await js(radioInputsDisabled), true, 'Old connect finally must not unlock a replacement connection');
        assert.equal(await js('!!document.querySelector(".browser-use-error")'), false, 'Old connect result must not install an error');
        requestGenerationChecks.push({ name: 'late-canceled-connect-result-keeps-new-connect-busy', pass: true });
      }
      approve();
      await wait('document.body.innerText.includes("Chrome 已连接")');
      await wait(radioInputsEnabled);
      if (mode === 'reject') {
        await releaseDelivery(oldConnect, 'reject');
        await settleRenderer();
        assert.equal(await js('!!document.querySelector(".browser-use-error")'), false, 'Old rejected promise must not install an error after reconnection');
        requestGenerationChecks.push({ name: 'late-canceled-connect-rejection-cannot-poison-new-connection', pass: true });
      }
      await releaseDelivery(retiredQuiet);
      await settleRenderer();
      assert.match(await js('document.querySelector(".browser-use-status").textContent'), /Chrome 已连接/u);
      assert.equal(await js('!!document.querySelector(".browser-use-error")'), false);
      assert.equal(await js(radioInputsEnabled), true, 'New connection must finish without a stuck busy state');
      assert.equal(await js('document.querySelectorAll(".browser-use-page-button").length'), 2);
      assert.equal(runtime.state('chat-a').connection, 'connected');
      requestGenerationChecks.push({ name: 'late-quiet-state-cannot-replace-new-connected-state', mode, pass: true });
      if (mode === 'result') {
        await clickButton('断开 Chrome');
        await wait('document.body.innerText.includes("Chrome 尚未连接")');
        await wait(radioInputsEnabled);
      }
    }
    assert.equal(await js('window.browserUseDeliveryFixture.plans.length'), 0);
    assert.equal(await js('Object.values(window.browserUseDeliveryFixture.held).every(item => item.ready && item.delivered)'), true);
    await capture('10-request-generation-reconnected-dark');
    // Connection requests are routed by Chat, opened once per request identity,
    // and never create Chrome connections or replay the task by themselves.
    await js('document.querySelector(".browser-use-trigger").click()');
    await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "false"');
    const connectCallsBeforeGuide = calls.filter(call => call.method === 'connect').length;
    const realRuntimeState = runtime.state.bind(runtime);
    const guideRequests = new Map();
    runtime.state = chatId => ({ ...realRuntimeState(chatId), ...guideRequests.get(chatId) });
    const emitGuide = (chatId, id, reason = 'new_run', extra = {}) => {
      const connectionRequest = { id, runId: 'fixture-guide-run', reason };
      guideRequests.set(chatId, { ...extra, connectionRequest });
      win.webContents.send(BROWSER_USE_CHANGED, runtime.state(chatId));
    };
    emitGuide('chat-b', 'other-chat-request');
    await settleRenderer();
    assert.equal(await js('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded")'), 'false');
    connectionGuideChecks.push({ name: 'other-chat-request-does-not-open-controls', pass: true });
    emitGuide('chat-a', 'current-chat-request');
    await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "true"');
    await wait('document.body.innerText.includes("在当前对话发送“继续”")');
    assert.equal(await js('[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "连接 Chrome")'), false);
    assert.equal(calls.filter(call => call.method === 'connect').length, connectCallsBeforeGuide);
    connectionGuideChecks.push({ name: 'connected-new-run-request-only-explains-continue', pass: true });
    await capture('11-connected-continue-guide-dark');
    await js('document.querySelector(".browser-use-trigger").click()');
    await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "false"');
    emitGuide('chat-a', 'current-chat-request');
    await settleRenderer();
    assert.equal(await js('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded")'), 'false');
    emitGuide('chat-a', 'next-chat-request');
    await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "true"');
    await js('document.querySelector(".browser-use-trigger").click()');
    await wait('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded") === "false"');
    emitGuide('chat-a', 'current-chat-request');
    await settleRenderer();
    assert.equal(await js('document.querySelector(".browser-use-trigger").getAttribute("aria-expanded")'), 'false');
    connectionGuideChecks.push({ name: 'request-opens-once-and-new-id-opens-again', pass: true });
    emitGuide('chat-a', 'needs-connect-running', 'connect', { connection: 'disconnected', backend: 'workpanel', activeRunIds: ['fixture-guide-run'] });
    await wait('document.body.innerText.includes("此任务需要连接 Chrome")');
    assert.equal(await js('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "连接 Chrome").disabled'), true);
    assert.equal(await js('document.body.innerText.includes("任务运行期间不能更换连接")'), true);
    emitGuide('chat-a', 'needs-connect-running', 'connect', { connection: 'disconnected', backend: 'workpanel', activeRunIds: [] });
    await wait('![...document.querySelectorAll("button")].find(button => button.textContent.trim() === "连接 Chrome").disabled');
    assert.equal(calls.filter(call => call.method === 'connect').length, connectCallsBeforeGuide);
    connectionGuideChecks.push({ name: 'connect-request-waits-for-task-end-and-does-not-auto-connect', pass: true });

    // Shared workspace presentation is driven only by trusted state. An owner in
    // another Chat and a draining owner both lock actions that could change it.
    const sharedView = { backend: 'chrome', connection: 'connected', activeRunIds: [], workspaceId: 'fixture-workspace-id', workspaceShared: true };
    const buttonDisabled = label => js(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw new Error('Workspace control is missing'); return button.disabled; })()`);
    emitGuide('chat-a', 'shared-idle', 'new_run', { ...sharedView, workspaceOwner: undefined });
    await wait('document.body.innerText.includes("新建 Chrome 对话、新窗口和重问")');
    assert.equal(await buttonDisabled('断开共享 Chrome 工作区'), false);
    assert.equal(await js('document.body.innerText.includes("影响共用此连接的对话")'), true);
    assert.equal(await js('document.body.innerText.includes("fixture-workspace-id")'), false);
    workspaceChecks.push({ name: 'shared-idle-pages-reusable-and-disconnect-scope-visible', pass: true });
    emitGuide('chat-a', 'shared-other-chat-owner', 'new_run', { ...sharedView,
      workspaceOwner: { chatId: 'chat-b-private-id', runId: 'other-run-private-id', draining: false } });
    await wait('document.body.innerText.includes("另一个对话正在操作")');
    assert.equal(await js(radioInputsDisabled), true);
    assert.equal(await js('[...document.querySelectorAll(".browser-use-page-button")].every(button => button.disabled)'), true);
    assert.equal(await buttonDisabled('选择现有标签页'), true);
    assert.equal(await buttonDisabled('断开共享 Chrome 工作区'), true);
    assert.equal(await buttonDisabled('接管工作区并停止'), false);
    assert.equal(await buttonDisabled('浏览器设置'), false);
    assert.equal(await js('document.body.innerText.includes("chat-b-private-id") || document.body.innerText.includes("other-run-private-id")'), false);
    workspaceChecks.push({ name: 'other-chat-owner-locks-browser-changes-and-keeps-workspace-takeover', pass: true });
    await capture('14-shared-workspace-other-chat-dark');
    emitGuide('chat-a', 'shared-own-chat-owner', 'new_run', { ...sharedView,
      workspaceOwner: { chatId: 'chat-a', runId: 'own-run-not-yet-listed', draining: false } });
    await settleRenderer();
    assert.equal(await js(radioInputsDisabled), true);
    assert.equal(await buttonDisabled('选择现有标签页'), true);
    assert.equal(await buttonDisabled('断开共享 Chrome 工作区'), true);
    assert.equal(await buttonDisabled('接管工作区并停止'), false);
    workspaceChecks.push({ name: 'same-chat-owner-locks-before-active-run-list-arrives', pass: true });
    emitGuide('chat-a', 'shared-draining', 'new_run', { ...sharedView,
      workspaceOwner: { chatId: 'chat-a', runId: 'draining-removed-run', draining: true } });
    await wait('document.body.innerText.includes("上一任务的网页操作正在结束")');
    assert.equal(await js(radioInputsDisabled), true);
    assert.equal(await buttonDisabled('接管工作区并停止'), false);
    await js('window.browserUseUiFixture.setLocale("en-US")');
    await wait('document.body.innerText.includes("The previous webpage operation is finishing")');
    assert.equal(await buttonDisabled('Disconnect shared Chrome workspace'), true);
    workspaceChecks.push({ name: 'draining-owner-stays-locked-without-active-run-and-is-localized', pass: true });
    await capture('15-shared-workspace-draining-dark-english');
    await js('window.browserUseUiFixture.setLocale("zh-CN")');
    emitGuide('chat-a', 'shared-after-drain', 'new_run', { ...sharedView, workspaceOwner: undefined });
    await wait('[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "断开共享 Chrome 工作区" && !button.disabled)');
    assert.equal(await js(radioInputsEnabled), true);
    assert.equal(await js('[...document.querySelectorAll(".browser-use-page-button")].every(button => !button.disabled)'), true);
    assert.equal(calls.filter(call => call.method === 'connect').length, connectCallsBeforeGuide);
    workspaceChecks.push({ name: 'drain-completion-unlocks-existing-pages-without-reconnecting', pass: true });
    await clickButton('浏览器设置');
    await wait('!!document.querySelector(".browser-control-settings")');
    await wait('!!document.querySelector(".browser-use-default-select:not(.ant-select-disabled)")');
    assert.equal(await js('document.querySelector(".browser-use-authorization-input input").disabled'), true);
    await js('document.querySelector("[aria-labelledby=browser-remember-label]").click()');
    await wait('!document.querySelector(".browser-use-authorization-input input").disabled');
    await js(`(() => { const input = document.querySelector('.browser-use-authorization-input input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'SYNTHETIC_SETTINGS_AUTHORIZATION');
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickButton('保存');
    await wait('document.body.innerText.includes("浏览器设置已保存")');
    assert.equal(wroteSyntheticAuthorization, true);
    assert.equal(await js('document.querySelector(".browser-use-authorization-input input").value'), '');
    assert.equal(await js('document.body.innerText.includes("SYNTHETIC_SETTINGS_AUTHORIZATION")'), false);
    assert.equal(await js('document.body.innerText.includes("已保存 Chrome 授权")'), true);
    settingsChecks.push({ name: 'authorization-write-only-input-cleared-after-save', pass: true });
    await capture('12-browser-settings-authorized-dark');

    // A live settings broadcast refreshes status without discarding an edit.
    await js(`(() => { const input = document.querySelector('.browser-use-authorization-input input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'SYNTHETIC_REPLACEMENT');
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settleRenderer();
    settingsState = { ...settingsState, connectedChats: 2, activeRuns: 1 };
    win.webContents.send('fixture.browserSettingsChanged', settingsState);
    await wait('document.body.innerText.includes("2 个对话 · 1 个任务")');
    assert.equal(await js('document.querySelector(".browser-use-authorization-input input").value'), 'SYNTHETIC_REPLACEMENT');
    assert.equal(await js('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "忘记授权并断开连接").disabled'), true);
    settingsChecks.push({ name: 'live-status-keeps-draft-and-blocks-forget-while-running', pass: true });
    await js('document.querySelector("[aria-labelledby=browser-remember-label]").click()');
    await wait('document.querySelector(".browser-use-authorization-input input").value === ""');
    await clickButton('保存');
    await wait('document.body.innerText.includes("浏览器设置已保存")');
    assert.equal(settingsState.hasSavedAuthorization, false);
    assert.equal(settingsState.activeRuns, 1);
    settingsChecks.push({ name: 'turn-off-remember-clears-future-authorization-with-active-task', pass: true });
    settingsState = { ...settingsState, activeRuns: 0 };
    win.webContents.send('fixture.browserSettingsChanged', settingsState);
    await wait('![...document.querySelectorAll("button")].find(button => button.textContent.trim() === "忘记授权并断开连接").disabled');
    await clickButton('忘记授权并断开连接');
    await wait('document.body.innerText.includes("已清除 Chrome 授权并断开连接")');
    assert.equal(settingsState.connectedChats, 0);
    settingsChecks.push({ name: 'forget-clears-authorization-and-idle-connections', pass: true });
    settingsError = { code: 'storage_corrupt', message: 'SYNTHETIC_PRIVATE_PATH_OR_SECRET' };
    await clickButton('安装 Chrome 扩展');
    await wait('!!document.querySelector(".browser-use-settings-error")');
    assert.equal(await js('document.body.innerText.includes("SYNTHETIC_PRIVATE_PATH_OR_SECRET")'), false);
    settingsChecks.push({ name: 'unknown-settings-errors-never-display-main-message', pass: true });
    settingsError = undefined;
    await js('window.browserUseUiFixture.setLocale("en-US")');
    await wait('document.querySelector("h1")?.textContent === "Browser control"');
    settingsState = { ...settingsState, secureStorageAvailable: false };
    win.webContents.send('fixture.browserSettingsChanged', settingsState);
    await wait('document.body.innerText.includes("System encryption is unavailable")');
    assert.equal(await js('document.querySelector("[aria-labelledby=browser-remember-label]").disabled'), true);
    assert.equal(await js('document.querySelector(".browser-use-authorization-input input").disabled'), true);
    settingsChecks.push({ name: 'unavailable-secure-storage-disables-secret-persistence', pass: true });
    await capture('13-browser-settings-unavailable-dark-english');
    await js('window.browserUseUiFixture.navigate("/")');
    await wait('!!document.querySelector(".browser-use-trigger")');
    settingsError = { code: 'browser_settings_unavailable', message: 'SYNTHETIC_PRIVATE_PATH_OR_SECRET' };
    await js('window.browserUseUiFixture.navigate("/settings/browser")');
    await wait('document.body.innerText.includes("Clear the connection configuration")');
    assert.equal(await js('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Clear connection configuration").disabled'), false);
    assert.equal(await js('document.body.innerText.includes("SYNTHETIC_PRIVATE_PATH_OR_SECRET")'), false);
    settingsError = undefined;
    await clickButton('Clear connection configuration');
    await wait('document.body.innerText.includes("Chrome authorization cleared")');
    settingsChecks.push({ name: 'unreadable-configuration-keeps-main-recovery-action-available', pass: true });
    runtime.state = realRuntimeState;
    await js('window.browserUseUiFixture.navigate("/")');
    await wait('!!document.querySelector(".browser-use-trigger")');
    await js('document.querySelector(".browser-use-trigger").click()');
    await wait('!!document.querySelector(".browser-use-controls")');
    await js('window.browserUseUiFixture.setLocale("en-US")');
    await wait('document.body.innerText.includes("Chrome connected")');
    await js('window.browserUseUiFixture.setChatId(null)');
    await wait('document.body.innerText.includes("Specify Chrome or the right WorkPanel")');
    await capture('08-no-chat-dark-english');
    assert.deepEqual(errors, []);
    const viewport = await js('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
    fs.writeFileSync(path.join(output, 'visual-result.json'), JSON.stringify({ ok: true, viewport,
      screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')), calls, stops, errors, requestGenerationChecks, connectionGuideChecks, workspaceChecks, settingsChecks, settingsRequests,
      limitation: 'The real UI and IPC ran in Electron; the browser client is a test double, not a Chrome extension connection.' }, null, 2));
    console.log('Browser Use UI real Electron: PASS (Chrome states, settings and write-only authorization, Chat-scoped connection guides, themes/locales, task target status, takeover, request generations, no Chat); screenshots: ' + output);
  } finally { runtime.dispose(); win.destroy(); }
}).then(() => { clearTimeout(guard); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0); })
  .catch(error => { console.error(error); clearTimeout(guard); app.exit(1); });
