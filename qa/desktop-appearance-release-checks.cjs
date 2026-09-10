const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, nativeTheme, dialog, nativeImage } = require('electron');

module.exports = ({ repo, root, preloads, images }) => {
  const phase = process.argv.includes('--appearance-phase=restart') ? 'restart' : 'write';
  app.setPath('userData', path.join(root, 'chromium'));
  app.setPath('sessionData', path.join(root, 'chromium'));
  const fromMain = (file) => require(path.join(repo, 'dist-electron/main', file));
  const { registerAppearanceIpcHandlers } = fromMain('modules/settings/appearance-ipc.js');
  const { registerSettingsIpcHandlers } = fromMain('modules/settings/ipc.js');
  const { buildMainWindowOptions } = fromMain('modules/shell/window-manager.js');
  const { getDesktopConfigRoot, getRuntimeDataRoot } = fromMain('infrastructure/filesystem/user-paths.js');
  const { readDesktopProfileFromRoot, updateDesktopProfileInRoot } = fromMain('infrastructure/filesystem/profile-store.js');
  const fixtureApp = { getPath: (key) => path.join(root, 'data', key) };
  const configRoot = getDesktopConfigRoot(fixtureApp, process.platform);
  const assetsRoot = path.join(getRuntimeDataRoot(fixtureApp, process.platform), 'desktop', 'appearance');
  let win;
  registerAppearanceIpcHandlers(ipcMain, { app: fixtureApp, platform: process.platform, getMainWindow: () => win });
  const localeSettings = () => ({ locale: readDesktopProfileFromRoot(configRoot).appearance.locale, source: 'user' });
  registerSettingsIpcHandlers(ipcMain, {
    app: fixtureApp, platform: process.platform, nativeTheme, getDataRoot: () => root,
    initializeMainI18n: localeSettings, isSupportedLocale: (locale) => ['zh-CN', 'en-US'].includes(locale),
    setMainLocale: (_app, locale) => { updateDesktopProfileInRoot(configRoot, { appearance: { locale } }); return localeSettings(); },
    buildApplicationMenu() {}, refreshTrayContextMenu() {},
    emitLocaleChanged: (settings) => win.webContents.send('settings.localeChanged', settings)
  });
  (async () => {
    await app.whenReady();
    if (phase === 'write') updateDesktopProfileInRoot(configRoot, { appearance: { locale: 'zh-CN' } });
    const preload = preloads[phase === 'write' ? 0 : 1];
    const options = buildMainWindowOptions({ platform: process.platform, preloadPath: preload, initialLocaleSettings: localeSettings(), shouldUseDarkColors: true });
    win = new BrowserWindow(options);
    const failures = [];
    win.webContents.on('preload-error', (_event, _path, error) => failures.push(String(error)));
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) failures.push(message);
    });
    const js = (source) => win.webContents.executeJavaScript(source);
    const until = async (condition) => {
      for (let n = 0; n < 200; n++) {
        if (await js(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out: ${condition}; renderer errors: ${failures.join('; ')}`);
    };
    const settle = () => until('appearanceRelease.skinLoadState === "ready" && !appearanceRelease.skinSaving && appearanceRelease.themeMode === appearanceRelease.getAppearanceSnapshot().themeMode');
    const pictureReady = () => until('document.querySelector(".desktop-background-image")?.dataset.backgroundState === "ready"');
    const click = async (label) => {
      assert.equal(await js(`(()=>{const b=[...document.querySelectorAll('.desktop-skin-settings button')].find(b=>b.textContent.includes(${JSON.stringify(label)}));if(!b||b.disabled)return false;b.click();return true;})()`), true);
      await until('!appearanceRelease.getAppearanceSnapshot().skinSaving');
      await settle();
    };
    await win.loadFile(path.join(root, 'index.html'));
    await until('!!window.appearanceRelease && appearanceRelease.skinLoadState === "ready"');
    assert.deepEqual(failures, []);
    // Load exact URLs extracted from the production bundle under its CSP.
    assert.deepEqual(await js(`Promise.all(${JSON.stringify(images)}.map(src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve([i.naturalWidth,i.naturalHeight]);i.onerror=()=>reject(new Error('Built wallpaper failed'));i.src=src;})))`), [[1920,1200],[1920,1200]]);
    if (phase === 'write') {
      await js('appearanceRelease.setThemeMode("dark")');
      await settle();
      assert.equal(nativeTheme.themeSource, 'dark');
      // Use the native keyboard path to select the next skin card.
      if (process.platform === 'darwin') app.focus({ steal: true });
      win.show(); win.focus(); win.webContents.focus();
      await until('document.hasFocus()');
      await js('document.querySelector("[data-skin-option=default]").focus()');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await until('document.activeElement?.dataset.skinOption === "mist"');
      assert.equal(await js('getComputedStyle(document.activeElement).outlineStyle'), 'solid', JSON.stringify(await js('({focus:document.hasFocus(),visible:document.activeElement.matches(":focus-visible"),classes:document.activeElement.className,style:getComputedStyle(document.activeElement).cssText})')));
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await until('appearanceRelease.skin.id === "mist"'); await settle(); await pictureReady();
      win.hide();
      const file = path.join(root, '背景 空格 % # @2x.png');
      const pixels = Buffer.alloc(600 * 400 * 4, 128);
      const originalImage = nativeImage.createFromBitmap(pixels, { width: 600, height: 400 });
      fs.writeFileSync(file, originalImage.toPNG());
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      await click('选择图片'); await pictureReady();
      const asset = readDesktopProfileFromRoot(configRoot).appearance.background;
      assert.equal(asset.width, 600, 'Filename scale suffix must not change image dimensions');
      assert.equal(asset.height, 400);
      const saved = nativeImage.createFromBuffer(fs.readFileSync(path.join(assetsRoot, asset.id + '.png')));
      assert.equal(saved.toBitmap()[3], 128, 'Normalization must preserve alpha');
      fs.unlinkSync(file);
      // Intact PNG header with damaged payload exercises renderer fallback, not
      // only Main's missing-file/signature checks.
      const ownedFile = path.join(assetsRoot, asset.id + '.png');
      const valid = fs.readFileSync(ownedFile);
      fs.writeFileSync(ownedFile, valid.subarray(0, 33));
      await js('appearanceRelease.refreshAppearanceFromCanonical()');
      await until('document.querySelector(".desktop-skin-status").textContent.includes("不可用")');
      await pictureReady();
      assert.equal(await js('document.querySelector(".desktop-background-image").src === appearanceRelease.skin.backgrounds.dark.imageUrl'), true);
      await click('恢复皮肤背景'); await pictureReady();
      await until('!!document.querySelector(".desktop-background-sample img")');
      // Replace the same image after reset, then verify disk-write rollback in
      // the production settings flow and leave it selected for process restart.
      fs.writeFileSync(file, valid); await click('选择图片'); fs.unlinkSync(file); await pictureReady();
      const rename = fs.renameSync;
      fs.renameSync = () => { throw new Error('fixture write failure'); };
      try {
        await click('默认');
        await until('document.querySelector(".desktop-skin-error")?.textContent.includes("保存失败")');
        assert.equal(await js('appearanceRelease.skin.id'), 'mist');
        assert.equal(await js('appearanceRelease.setThemeMode("light").then(()=>false,()=>true)'), true);
        assert.equal(nativeTheme.themeSource, 'dark');
      } finally { fs.renameSync = rename; }
      await js('electronAPI.settings.setLocale("en-US")');
      await until('document.querySelector("#desktop-skin-label").textContent === "Desktop skin"');
      win.setSize(1180, 760);
      win.webContents.setZoomFactor(1.25);
      await until('document.documentElement.scrollWidth <= innerWidth');
      assert.equal(await js('document.querySelector("#preserved-draft").value'), 'Keep this draft');
      await js('appearanceRelease.setThemeMode("dark")');
      fs.writeFileSync(path.join(root, 'write.json'), JSON.stringify({ ok: true, nativePlatform: process.platform, preload, asset: readDesktopProfileFromRoot(configRoot).appearance.background }));
      fs.writeFileSync(path.join(root, 'english-125-percent.png'), (await win.webContents.capturePage()).toPNG());
    } else {
      const previous = JSON.parse(fs.readFileSync(path.join(root, 'write.json'), 'utf8'));
      await pictureReady(); await settle();
      assert.equal(await js('appearanceRelease.skin.id'), 'mist');
      assert.equal(await js('appearanceRelease.themeMode'), 'dark');
      assert.equal(await js('appearanceRelease.skinSettings.background.id'), previous.asset.id);
      assert.equal(nativeTheme.themeSource, 'dark');
      assert.equal(await js('document.querySelector("#desktop-skin-label").textContent'), 'Desktop skin');
      // A different window with the same preload still has no appearance access.
      const other = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } });
      await other.loadURL('about:blank');
      assert.equal(await other.webContents.executeJavaScript('electronAPI.settings.importDesktopBackground().then(()=>false,()=>true)'), true);
      other.destroy();
      fs.writeFileSync(path.join(root, 'restart.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(root, 'restart.json'), JSON.stringify({ ok: true, nativePlatform: process.platform, preload, restoredFromSeparateProcess: true, assetsLoadedUnderProductionCsp: images.length, foreignWindowRejected: true, windowsNativeVerified: process.platform === 'win32' }, null, 2));
    }
    win.destroy();
    app.exit(0);
  })().catch((error) => { console.error(error.stack); app.exit(1); });
};
