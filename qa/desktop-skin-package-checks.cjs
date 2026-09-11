const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { dialog, BrowserWindow } = require('electron');

module.exports = async (win, output) => {
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let n = 0; n < 180; n++) { if (await js(code)) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error('Skin package UI timed out: ' + code);
  };
  const click = async (selector) => {
    assert.equal(await js(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)return false;button.click();return true;})()`), true, selector);
    await until('!skinPreview.api.getAppearanceSnapshot().skinSaving && !skinPreview.api.skinSaving');
  };
  const clickText = async (text) => {
    assert.equal(await js(`(()=>{const button=[...document.querySelectorAll('.desktop-skin-settings button')].find(x=>x.textContent.replaceAll(' ','')===${JSON.stringify(text)});if(!button||button.disabled)return false;button.click();return true;})()`), true, text);
    await until('!skinPreview.api.getAppearanceSnapshot().skinSaving && !skinPreview.api.skinSaving');
  };
  await js('skinPreview.setSelected("设置");skinPreview.setPlatform("mac");skinPreview.api.setThemeMode("light")');
  await until('skinPreview.api.skinPackagesAvailable');
  const before = await js('skinPreview.api.skinSettings.skinId');
  const guestId = await js('document.querySelector("#preview-guest").getWebContentsId()');
  const nonce = await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")');
  const fixture = path.join(output, '山湖 皮肤.zip');
  const zip = new JSZip();
  zip.file('skin.json', fs.readFileSync(path.join(__dirname, 'skin-packages/alpine-lake/skin.json')));
  zip.file('assets/background.png', fs.readFileSync(path.join(__dirname, 'assets/alpine-lake.png')));
  fs.writeFileSync(fixture, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const originalPicker = dialog.showOpenDialog;
  let canceled = true;
  dialog.showOpenDialog = async (_owner, options) => {
    assert.deepEqual(options.filters[0].extensions, ['zip']);
    return { canceled, filePaths: [fixture] };
  };
  try {
    await clickText('导入皮肤');
    assert.equal(await js('skinPreview.api.skinSettings.installedSkins?.length || 0'), 0);
    canceled = false;
    await clickText('导入皮肤');
    await until('skinPreview.api.skinSettings.installedSkins?.length === 1');
    const id = await js('skinPreview.api.skinSettings.installedSkins[0].id');
    assert.equal(await js('skinPreview.api.skinSettings.skinId'), before, 'Import does not implicitly apply');
    const choice = '[data-skin-option="' + id + '"]';
    // Reproduce the reported failure and actually use the visible retry path.
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to.endsWith('profile.json')) throw new Error('fixture appearance save failed'); return rename(from, to); };
    try { await click(choice); await until('!!document.querySelector(".desktop-skin-error")'); }
    finally { fs.renameSync = rename; }
    assert.equal(await js('skinPreview.api.skinSettings.skinId'), before);
    await clickText('重试');
    await until('skinPreview.api.skinSettings.skinId === ' + JSON.stringify(id));
    assert.equal(await js('!!document.querySelector(".desktop-skin-error")'), false);
    for (const theme of ['light', 'dark']) {
      await js('skinPreview.api.setThemeMode(' + JSON.stringify(theme) + ')');
      await until('document.querySelector(".desktop-background-image")?.dataset.backgroundState === "ready"');
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(output, 'zip-settings-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.equal(await js('document.querySelector("#preview-guest").getWebContentsId()'), guestId);
    assert.equal(await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")'), nonce);
    await clickText('导入皮肤');
    await until('document.querySelector(".desktop-skin-error")?.textContent.includes("已经导入")');
    await clickText('重新读取外观');
    assert.equal(await js('!!document.querySelector(".desktop-skin-error")'), false);
    fs.unlinkSync(fixture);
    await win.loadFile(path.join(output, 'index.html'));
    await until('skinPreview.api?.skinSettings.skinId === ' + JSON.stringify(id));
    await js('skinPreview.setSelected("设置")');
    await until('!document.querySelector(".skin-preview-settings").hidden');
    await clickText('删除皮肤');
    assert.equal(await js('skinPreview.api.skinSettings.skinId'), 'default');
    assert.equal(await js('skinPreview.api.skinSettings.installedSkins?.length || 0'), 0);
  } finally { dialog.showOpenDialog = originalPicker; }

  // A live old preload can outlast a renderer hot update. The new import
  // button must be disabled with a restart explanation, never a write error.
  const oldPreload = path.join(output, 'old-appearance-preload.cjs');
  fs.writeFileSync(oldPreload, `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{settings:{getThemePreference:async()=>"light",setNativeThemeSource:async(themeSource)=>({ok:true,themeSource}),getDesktopSkin:async()=>({ok:true,settings:{skinId:"default",background:null,backgroundDataUrl:null}})}});`);
  const oldWindow = new BrowserWindow({ show: false, webPreferences: { preload: oldPreload, contextIsolation: true, webviewTag: true } });
  try {
    await oldWindow.loadFile(path.join(output, 'index.html'));
    for (let n = 0; n < 100; n++) {
      if (await oldWindow.webContents.executeJavaScript('skinPreview.api?.skinLoadState === "ready"')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const oldState = await oldWindow.webContents.executeJavaScript(`({available:skinPreview.api.skinPackagesAvailable,disabled:document.querySelector('.desktop-skin-import button').disabled,notice:document.querySelector('.desktop-skin-settings').textContent.includes('重新启动'),error:!!document.querySelector('.desktop-skin-error')})`);
    assert.deepEqual(oldState, { available: false, disabled: true, notice: true, error: false });
  } finally { oldWindow.destroy(); }
  console.log(JSON.stringify({ skinZipImport: true, previewBeforeApply: true, retryAfterSaveFailure: true, reloadClearsError: true, restartRetainsPackage: true, removeActivePackage: true, stalePreloadExplained: true }));
};
