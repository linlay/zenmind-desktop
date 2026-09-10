// Exercises the actual settings component, preload and Main appearance IPC in
// temporary data roots. Native picker responses are supplied by this fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { dialog, nativeImage } = require('electron');
module.exports = async (win, output, fixtureApp) => {
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let n = 0; n < 150; n++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out: ' + code);
  };
  const click = async (text) => {
    assert.equal(await js('(()=>{const button=[...document.querySelectorAll(".desktop-skin-settings button")].find(x=>x.textContent.replaceAll(" ","").includes('+JSON.stringify(text)+'));if(!button||button.disabled)return false;button.click();return true;})()'), true, text);
    await until('!skinPreview.api.getAppearanceSnapshot().skinSaving');
    await until('!skinPreview.api.skinSaving');
  };
  const readyImage = () => until('document.querySelector(".desktop-background-image")?.dataset.backgroundState === "ready"');
  const save = async (name) => {
    // Capture after the real controls and sidebar have settled, rather than a
    // midway frame from their color/width transitions.
    await until('skinPreview.api.resolvedTheme === skinPreview.api.getAppearanceSnapshot().resolvedTheme && !skinPreview.api.skinSaving');
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const mounts = await js('skinPreview.mounts');
  const guestId = await js('document.querySelector("#preview-guest").getWebContentsId()');
  const guestNonce = await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")');
  win.setSize(1280, 860);
  await js('skinPreview.setEmbedded(false);skinPreview.setCollapsed(false);skinPreview.setSelected("设置");skinPreview.api.setThemeMode("light")');
  await until('skinPreview.api.skinLoadState === "ready" && !skinPreview.api.skinSaving');
  await click('默认');
  assert.equal(await js('skinPreview.api.skin.id'), 'default');
  await click('雾林');
  await readyImage();
  await save('settings-mist-light');
  await js('skinPreview.api.setThemeMode("dark")');
  await readyImage();
  await save('settings-mist-dark');
  await js('skinPreview.api.setThemeMode("light")');
  // Valid images are produced by Electron itself; test both decoders plus
  // oversized dimensions, invalid data and the stored PNG conversion.
  const source = path.join(output, 'picked-wallpaper.png');
  const bitmap = Buffer.alloc(4000 * 40 * 4);
  for (let n = 0; n < bitmap.length; n += 4) { bitmap[n] = 180; bitmap[n+1] = 110; bitmap[n+2] = 45; bitmap[n+3] = 255; }
  const input = nativeImage.createFromBitmap(bitmap, { width: 4000, height: 40 });
  fs.writeFileSync(source, input.toPNG());
  let canceled = true;
  const originalPicker = dialog.showOpenDialog;
  dialog.showOpenDialog = async (owner) => { assert.equal(owner, win); return { canceled, filePaths: [source] }; };
  try {
    await click('选择图片');
    assert.equal(await js('skinPreview.api.skinSettings.background'), null);
    canceled = false;
    await click('选择图片');
    await readyImage();
    assert.equal(await js('skinPreview.api.skinSettings.background.width'), 3840);
    const assetId = await js('skinPreview.api.skinSettings.background.id');
    assert.equal(await js('skinPreview.api.background.imageUrl.startsWith("data:image/png;base64,")'), true);
    await save('settings-custom-background');
    // A new skin keeps the override; reset returns to the selected bundled skin.
    await click('默认');
    assert.equal(await js('skinPreview.api.skinSettings.background.id'), assetId);
    await readyImage();
    assert.equal(await js('document.documentElement.dataset.desktopBackground'), 'image');
    await click('雾林');
    fs.writeFileSync(source, '<svg><script>alert(1)</script></svg>');
    await click('更换图片');
    await until('document.querySelector(".desktop-skin-error")?.textContent.includes("PNG")');
    assert.equal(await js('skinPreview.api.skinSettings.background.id'), assetId);
    // Real JPEG, normalized to the same owned PNG format.
    fs.writeFileSync(source, input.toJPEG(85));
    await click('更换图片');
    await readyImage();
    assert.notEqual(await js('skinPreview.api.skinSettings.background.id'), assetId);
    assert.equal(await js('document.querySelector("#preview-guest").getWebContentsId()'), guestId);
    assert.equal(await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")'), guestNonce);
    assert.equal(await js('skinPreview.mounts'), mounts);
    const savedId = await js('skinPreview.api.skinSettings.background.id');
    fs.unlinkSync(source);
    await win.loadFile(path.join(output, 'index.html'));
    await until('window.skinPreview?.api?.skinLoadState === "ready"');
    await readyImage();
    assert.equal(await js('skinPreview.api.skin.id'), 'mist');
    assert.equal(await js('skinPreview.api.skinSettings.background.id'), savedId);
    await js('skinPreview.setSelected("设置")');
    await until('!document.querySelector(".skin-preview-settings").hidden');
    // Lost asset is recoverable and cannot erase the chosen skin/profile.
    const userPaths = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
    const stored = path.join(userPaths.getRuntimeDataRoot(fixtureApp, process.platform), 'desktop', 'appearance', savedId + '.png');
    fs.unlinkSync(stored);
    await js('skinPreview.api.refreshAppearanceFromCanonical()');
    await until('document.querySelector(".desktop-skin-status").textContent.includes("不可用")');
    await readyImage();
    await save('settings-missing-background');
    await click('恢复皮肤背景');
    assert.equal(await js('skinPreview.api.skinSettings.background'), null);
    await click('默认');
    assert.equal(await js('document.documentElement.dataset.desktopBackground'), 'none');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    // Import a full photograph through the same Main picker/normalizer path.
    // This catches a visually hidden wallpaper that flat-color fixtures miss.
    fs.copyFileSync(path.join(__dirname, 'assets', 'alpine-lake.png'), source);
    await click('选择图片');
    await readyImage();
    assert.equal(await js('document.documentElement.dataset.desktopBackgroundSource'), 'custom');
    await click('雾林');
    await js('skinPreview.setSelected("工作台")');
    for (const platform of ['mac', 'windows']) {
      await js('skinPreview.setPlatform(' + JSON.stringify(platform) + ')');
      for (const theme of ['light', 'dark']) {
        await js('skinPreview.api.setThemeMode(' + JSON.stringify(theme) + ')');
        await readyImage();
        await save('photo-' + platform + '-' + theme);
      }
    }
    await js('skinPreview.api.resetBackground()');
    assert.equal(await js('document.documentElement.dataset.desktopBackgroundSource'), 'skin');
    console.log(JSON.stringify({ appearanceSettings: true, pngAndJpegImport: true, cancelAndInvalidImport: true, resizeBeforeStorage: true, persistedAcrossReload: true, missingAssetRecovery: true, guestPreservedDuringImport: true, photographicWallpaper: true }));
  } finally { dialog.showOpenDialog = originalPicker; }
};
