const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const output = process.env.BROWSER_SETTINGS_UI_ROOT;
if (!output) throw new Error("The settings fixture requires its own output directory");
const { BROWSER_USE_CHANNEL, BROWSER_USE_CHANGED } = require(path.join(output, "channels.cjs"));
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "session"));
app.disableHardwareAcceleration();
if (process.platform === "darwin") {
  app.setActivationPolicy("prohibited");
  app.commandLine.appendSwitch("use-mock-keychain");
} else if (process.platform === "linux") {
  app.commandLine.appendSwitch("password-store", "basic");
}

const state = {
  defaultBackend: "chrome", rememberChromeConnection: false, hasSavedAuthorization: false,
  secureStorageAvailable: false, connectedChats: 0, activeRuns: 0,
};
const calls = [], cases = [], errors = [], listenerCounts = [];
const TOKEN = "SYNTHETIC_SETTINGS_UI_AUTHORIZATION";
let win, holdAction, held;
ipcMain.handle(BROWSER_USE_CHANNEL, () => ({ ok: true, state: {
  chatId: "chat-a", backend: "workpanel", connection: "disconnected", pages: [], activeRunIds: [],
} }));
ipcMain.handle("fixture.browserSettings", async (_event, request) => {
  calls.push({ action: request.action, defaultBackend: request.defaultBackend,
    rememberChromeConnection: request.rememberChromeConnection, hasExpectedToken: request.extensionToken === TOKEN });
  if (request.action === "save") {
    assert.equal(request.extensionToken, TOKEN);
    Object.assign(state, { defaultBackend: request.defaultBackend, rememberChromeConnection: request.rememberChromeConnection,
      hasSavedAuthorization: request.rememberChromeConnection });
  } else if (request.action === "forget") {
    Object.assign(state, { rememberChromeConnection: false, hasSavedAuthorization: false, connectedChats: 0 });
  } else {
    assert.equal(request.action, "get");
  }
  const response = { ok: true, state: { ...state } };
  if (holdAction === request.action) {
    holdAction = undefined;
    return new Promise(resolve => { held = { release: () => resolve(response) }; });
  }
  if (request.action !== "get") win.webContents.send("fixture.browserSettingsChanged", { ...state });
  return response;
});

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 760,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|about):/u.test(details.url) });
  });
  win.webContents.on("console-message", event => {
    if (event.level === "error") errors.push(event.message);
  });
  const js = expression => win.webContents.executeJavaScript(expression, true);
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`Settings fixture timed out: ${label}`);
  };
  const wait = (expression, label = expression) => waitFor(() => js(expression), label);
  const navigate = async route => {
    await js(`window.browserUseUiFixture.navigate(${JSON.stringify(route)})`);
    await wait(`Boolean(document.querySelector('.browser-control-settings')) === ${route === "/settings/browser"}`);
  };
  const count = async expected => {
    await wait(`window.browserUseUiFixture.settingsListenerCount() === ${expected}`);
    listenerCounts.push(await js("window.browserUseUiFixture.settingsListenerCount()"));
  };
  const button = text => `Array.from(document.querySelectorAll('.browser-control-settings button')).find(button => button.textContent.replace(/\\s/gu, '') === ${JSON.stringify(text)})`;
  const click = async text => {
    assert.equal(await js(`Boolean(${button(text)} && !${button(text)}.disabled)`), true, `Button ${text} must be enabled`);
    await js(`${button(text)}.click()`);
  };
  const tokenInput = "document.querySelector('.browser-use-authorization-input input')";
  const fillToken = async () => {
    await js(`(() => { const input = ${tokenInput}; if (!input || input.disabled) throw new Error('Authorization input unavailable');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(TOKEN)});
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(`${tokenInput}.value === ${JSON.stringify(TOKEN)} && !${button("保存")}.disabled`);
  };

  try {
    await win.loadFile(path.join(output, "fixture.html"));
    await wait("Boolean(window.browserUseUiFixture)");
    assert.equal(await js('document.querySelector(".browser-use-trigger") === null'), true);
    assert.equal(await js('document.querySelector(".ant-modal") === null'), true);
    win.webContents.send(BROWSER_USE_CHANGED, { chatId: "chat-a", backend: "chrome", connection: "disconnected", pages: [], activeRunIds: [],
      connectionRequest: { id: "setup-request", runId: "run-a", reason: "connect" }, awaitingConnection: true });
    await wait('Boolean(document.querySelector(".ant-modal .browser-use-controls"))');
    await js('document.querySelector(".ant-modal-close").click()');
    await wait('document.querySelector(".ant-modal") === null');
    cases.push("no-toolbar-button-and-request-opens-dialog");
    // Track actual IPC reply delivery, so stale-response checks do not rely on
    // assuming that a fixed delay was long enough for the reply to arrive.
    await js(`(() => { const settings = window.electronAPI.browserUse.settings;
      window.settingsReplyCount = 0;
      window.electronAPI.browserUse.settings = request => settings(request).finally(() => { window.settingsReplyCount++; }); })()`);
    await count(0);
    for (let iteration = 0; iteration < 3; iteration++) {
      await navigate("/settings/browser");
      await count(1);
      await wait("document.querySelector('.browser-control-settings [role=switch]')?.disabled === false");
      if (iteration === 0) {
        const before = calls.length;
        const screenshot = async name => {
          if (!process.env.BROWSER_SETTINGS_UI_SHOTS) return;
          await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          await new Promise(resolve => setTimeout(resolve, 400));
          fs.mkdirSync(process.env.BROWSER_SETTINGS_UI_SHOTS, { recursive: true });
          fs.writeFileSync(path.join(process.env.BROWSER_SETTINGS_UI_SHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
        };
        await screenshot("settings");
        await click("如何连接Chrome");
        await wait('document.querySelector(".browser-connection-guide .ant-modal-body")?.textContent.includes("开发者模式")');
        await screenshot("guide-install");
        assert.equal(await js('document.querySelectorAll(".browser-connection-guide .ant-typography-copy").length'), 1);
        await js('Array.from(document.querySelectorAll(".browser-connection-guide button")).find(b => b.textContent.includes("已安装")).click()');
        await wait('document.querySelector(".browser-connection-guide .ant-modal-body")?.textContent.includes("PLAYWRIGHT_MCP_EXTENSION_TOKEN")');
        await screenshot("guide-code");
        await js('Array.from(document.querySelectorAll(".browser-connection-guide button")).find(b => b.textContent.includes("已复制")).click()');
        await wait('document.querySelector(".browser-connection-guide .ant-modal-body")?.textContent.includes("钥匙串")');
        await screenshot("guide-save");
        await js('Array.from(document.querySelectorAll(".browser-connection-guide button")).find(b => b.textContent.includes("去粘贴")).click()');
        await wait('!document.querySelector(".browser-connection-guide") || getComputedStyle(document.querySelector(".browser-connection-guide")).display === "none"');
        await wait(`${tokenInput} === document.activeElement`);
        assert.equal(calls.length, before, "reading the guide must not invoke settings or cryptography");
        assert.equal(await js(`${tokenInput}.disabled`), false, "unknown crypto availability must not block entering a code");
        await js('window.browserUseUiFixture.setPlatform("win32")');
        await click("如何连接Chrome");
        await wait('document.querySelector(".browser-connection-guide .ant-modal-body")?.textContent.includes("选择文件夹")');
        assert.equal(await js('document.querySelector(".browser-connection-guide .ant-modal-body").textContent.includes("⇧⌘G")'), false);
        await js('document.querySelector(".browser-connection-guide .ant-modal-close").click()');
        await wait('getComputedStyle(document.querySelector(".browser-connection-guide")).display === "none"');
        await js('window.browserUseUiFixture.setPlatform("darwin")');
        cases.push("clean-settings-and-three-step-guide-without-crypto");
      }
      await navigate("/idle");
      await count(0);
    }
    cases.push("repeated-mount-unmount");

    holdAction = "get";
    await navigate("/settings/browser");
    await count(1);
    await waitFor(() => Boolean(held), "held initial request");
    const oldGet = held;
    held = undefined;
    await navigate("/idle");
    await count(0);
    Object.assign(state, { rememberChromeConnection: true, hasSavedAuthorization: true });
    await navigate("/settings/browser");
    await count(1);
    await wait(`${tokenInput}?.disabled === false`);
    assert.equal(await js("document.querySelectorAll('.browser-control-settings [role=combobox], .browser-control-settings .ant-select').length"), 0);
    assert.match(await js("document.querySelector('.browser-control-settings').textContent"), /本机加密/u);
    cases.push("workpanel-default-without-selector");

    await fillToken();
    const repliesBeforeOldGet = await js("window.settingsReplyCount");
    oldGet.release();
    await wait(`window.settingsReplyCount === ${repliesBeforeOldGet + 1}`);
    await js("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await js(`${tokenInput}.value`), TOKEN);
    assert.equal(await js("document.querySelector('.browser-control-settings [role=switch]').getAttribute('aria-checked')"), "true");
    cases.push("late-get-does-not-replace-new-draft");

    await click("保存");
    await wait(`${tokenInput}.value === '' && !${tokenInput}.disabled`);
    assert.equal(await js(`${tokenInput}.type`), "password");
    assert.match(await js(`${tokenInput}.placeholder`), /已保存/u);
    assert.equal(await js("document.querySelector('.browser-control-settings').textContent.includes('SYNTHETIC_SETTINGS_UI_AUTHORIZATION')"), false);
    assert.equal(calls.find(call => call.action === "save").defaultBackend, "workpanel");
    cases.push("save-clears-write-only-authorization");

    holdAction = "save";
    await fillToken();
    await click("保存");
    await waitFor(() => Boolean(held), "held save response");
    const oldSave = held;
    held = undefined;
    await wait(`${button("保存")}.disabled === true`);
    await navigate("/idle");
    await wait("window.browserUseUiFixture.settingsListenerCount() === 0");
    await navigate("/settings/browser");
    await wait("window.browserUseUiFixture.settingsListenerCount() === 1");
    await wait(`${tokenInput}?.disabled === false`);
    await click("忘记授权并断开连接");
    await wait("document.querySelector('.browser-control-settings [role=switch]')?.getAttribute('aria-checked') === 'false'");
    const repliesBeforeOldSave = await js("window.settingsReplyCount");
    oldSave.release();
    await wait(`window.settingsReplyCount === ${repliesBeforeOldSave + 1}`);
    await js("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await js("document.querySelector('.browser-control-settings [role=switch]').getAttribute('aria-checked')"), "false");
    assert.equal(await js(`${tokenInput}.value`), "");
    assert.equal(await js(`${tokenInput}.disabled`), false);
    assert.match(await js("document.querySelector('.browser-use-settings-notice').textContent"), /清除|忘记/u);
    cases.push("late-save-does-not-replace-forget");
    await fillToken();
    assert.equal(await js("document.querySelector('.browser-control-settings [role=switch]').getAttribute('aria-checked')"), "true");
    cases.push("pasting-authorization-enables-remember");

    await navigate("/idle");
    await count(0);
    win.webContents.send("fixture.browserSettingsChanged", { ...state, hasSavedAuthorization: true });
    await js("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await js("window.browserUseUiFixture.settingsListenerCount()"), 0);
    cases.push("final-unsubscribe");
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: true, cases, listenerCounts,
      saveCalls: calls.filter(call => call.action === "save").length,
      forgetCalls: calls.filter(call => call.action === "forget").length, errors }, null, 2));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    win.destroy();
    app.exit(1);
  }
}).catch(error => { console.error(error.stack || error); app.exit(1); });
