const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkSkins(win, previewDir) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let n = 0; n < 120; n++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Skin preview timed out: ' + code);
  };
  const style = (selector, prop) => js('getComputedStyle(document.querySelector(' + JSON.stringify(selector) + '))[' + JSON.stringify(prop) + ']');
  const equal = async (selector, prop, expected) => assert.equal(await style(selector, prop), expected, selector + ' ' + prop);
  const save = async (name) => fs.writeFileSync(path.join(previewDir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const ready = () => until('document.querySelector(".desktop-background-image")?.dataset.backgroundState === "ready"');
  const rect = (selector) => js('JSON.stringify(document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect().toJSON())');
  const setSkin = (id) => js('void skinPreview.api.setSkinId(' + JSON.stringify(id) + ')');
  const setTheme = (mode) => js('skinPreview.api.setThemeMode(' + JSON.stringify(mode) + ')');
  // Main Desktop supports a minimum window width of 1180px.
  win.setSize(1280, 900);
  await win.loadFile(path.join(previewDir, 'index.html'));
  await until('!!window.skinPreview?.api');
  await js('skinPreview.setEmbedded(true)');
  await until('(()=>{try{return !!document.querySelector("#preview-guest").getWebContentsId()}catch{return false}})()');
  await until('document.querySelector("#preview-guest").executeJavaScript("!!window.guestInstance")');
  const guestIdentity = await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")');
  const guestId = await js('document.querySelector("#preview-guest").getWebContentsId()');
  const mounts = await js('skinPreview.mounts');
  await js('skinPreview.setEmbedded(false)');
  await setTheme('light');
  const defaultSidebar = await style('.app-sidebar', 'backgroundColor');
  const baselineRect = await rect('#preview-shell');
  for (const platform of ['mac', 'windows']) {
    await js('skinPreview.setPlatform(' + JSON.stringify(platform) + ')');
    for (const [mode, primary] of [['light', 'rgb(40, 118, 83)'], ['dark', 'rgb(131, 199, 154)']]) {
      await setSkin('mist');
      await setTheme(mode);
      await ready();
      await until('getComputedStyle(document.querySelector("#preview-ant-primary")).backgroundColor === ' + JSON.stringify(primary));
      await equal('#preview-primary', 'backgroundColor', primary);
      await equal('.desktop-background', 'pointerEvents', 'none');
      await equal('.desktop-background', 'position', 'absolute');
      await equal('.desktop-background', 'zIndex', '0');
      await equal('.desktop-background-image', 'objectFit', 'cover');
      assert.equal(await rect('#preview-shell'), baselineRect, 'Skin changes must not resize the shell');
      const containsImage = await js('(()=>{const a=document.querySelector(".desktop-background").getBoundingClientRect(),b=document.querySelector(".desktop-background-image").getBoundingClientRect();return a.width===b.width&&a.height===b.height})()');
      assert.equal(containsImage, true);
      await equal('.app-sidebar', 'backgroundColor', mode === 'light' ? 'rgba(231, 241, 230, 0.42)' : 'rgba(17, 38, 28, 0.4)');
      if (platform === 'windows') {
        await equal('.app-system-bar', 'backgroundColor', mode === 'light' ? 'rgba(231, 241, 230, 0.84)' : 'rgba(20, 39, 29, 0.88)');
        assert.equal(await js('document.querySelector(".app-content").getBoundingClientRect().top >= document.querySelector(".app-system-bar").getBoundingClientRect().bottom'), true);
      } else {
        await equal('.app-system-bar', 'display', 'none');
      }
      assert.equal(await js('(()=>{const b=document.querySelector("#preview-primary"),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()'), true, 'Background must not intercept clicks');
      await save('mist-' + platform + '-' + mode);
    }
  }
  await js('skinPreview.setPlatform("mac")');
  await setTheme('light');
  await setSkin('default');
  await equal('.desktop-background', 'display', 'none');
  await equal('.app-sidebar', 'backgroundColor', defaultSidebar);
  await equal('#preview-primary', 'backgroundColor', 'rgb(38, 99, 235)');
  assert.equal(await js('document.documentElement.style.getPropertyValue("--shell-sidebar-bg")'), '');
  assert.equal(await js('document.documentElement.style.getPropertyValue("--accent")'), '');
  await save('default-mac-light');
  await js('skinPreview.api.setSkinId("mist");skinPreview.api.setSkinId("default");skinPreview.api.setSkinId("mist");');
  await ready();
  await js('skinPreview.setBrokenBackground(true)');
  await until('document.querySelector(".desktop-background-image")?.dataset.backgroundState === "fallback"');
  await equal('.desktop-background-image', 'visibility', 'hidden');
  await equal('.desktop-background', 'backgroundColor', 'rgb(237, 243, 237)');
  await equal('#preview-primary', 'backgroundColor', 'rgb(40, 118, 83)');
  await js('skinPreview.setBrokenBackground(false)');
  await ready();
  win.setSize(1180, 760);
  await js('skinPreview.setCollapsed(true)');
  await until('document.querySelector(".app-sidebar").classList.contains("is-collapsed")');
  assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, 'No horizontal overflow at narrow widths');
  await save('mist-mac-narrow');
  await js('document.querySelector(".skin-preview-native").style.minHeight="1200px"');
  const beforeScroll = await rect('.desktop-background');
  await js('document.querySelector(".app-main").scrollTop=200');
  assert.equal(await js('document.querySelector(".app-main").scrollTop'), 200);
  assert.equal(await rect('.desktop-background'), beforeScroll, 'Wallpaper must stay fixed as content scrolls');
  await js('document.querySelector(".skin-preview-native").style.minHeight="";document.querySelector(".app-main").scrollTop=0');
  await js('skinPreview.setEmbedded(true)');
  await until('!document.querySelector(".skin-preview-guest").hidden');
  assert.equal(await js('document.querySelector("#preview-guest").getWebContentsId()'), guestId, 'Skin changes must retain the guest');
  assert.equal(await js('document.querySelector("#preview-guest").executeJavaScript("window.guestInstance")'), guestIdentity, 'Skin changes must not reload the guest');
  assert.equal(await js('document.querySelector("#preview-guest").executeJavaScript("getComputedStyle(document.body).backgroundColor")'), 'rgb(242, 244, 247)');
  await save('mist-embedded');
  assert.equal(await js('skinPreview.mounts'), mounts, 'Skin changes must retain shell content');
  console.log(JSON.stringify({ skins: true, imageFallback: true, nativeControls: true, platformLayers: true, resizeAndScroll: true, guestPreserved: true, defaultRestored: true }));
};
