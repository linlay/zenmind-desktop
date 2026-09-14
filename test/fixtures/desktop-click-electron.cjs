// Isolated real Chromium regression; no application profile or business pages.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeClick } = require('../../dist-electron/main/modules/web-surfaces/cdp/click.js');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-click-'));
app.setPath('userData', profile);
const guard = setTimeout(() => { console.error('click smoke timeout'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  const c = win.webContents;
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<style>button{width:120px;height:40px} #below{margin-top:1000px}</style><button id="open">Open</button><input id="check" type="checkbox"><button disabled id="disabled">Disabled</button><div id="dialog" hidden>Ready</div><button id="below">Below</button><script>window.clicks=0;window.trusted=[];document.addEventListener('click',e=>{window.trusted.push(e.isTrusted);if(e.target.id==='open'||e.target.id==='below'){window.clicks++;setTimeout(()=>document.querySelector('#dialog').hidden=false,80)}});</script>`));
    c.debugger.attach('1.3');
    await c.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const send = (method, params) => c.debugger.sendCommand(method, params);
    const click = (params) => executeClick(params, c, send, async () => {});
    let r = await click({ selector: '#open', waitFor: { selector: '#dialog', state: 'visible' } });
    assert.equal(r.status, 'condition_met', JSON.stringify(r));
    assert.equal(await c.executeJavaScript('window.clicks'), 1);
    await c.executeJavaScript("document.querySelector('#dialog').hidden=true");
    const pos = await c.executeJavaScript("(()=>{const r=document.querySelector('#open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    r = await click(pos); assert.equal(r.status, 'clicked', JSON.stringify(r)); assert.equal(r.conditionMatched, null);
    assert.equal(await c.executeJavaScript('window.clicks'), 2);
    r = await click({ selector: '#check', waitFor: { selector: '#check', state: 'checked', checked: true } });
    assert.equal(r.status, 'condition_met', JSON.stringify(r));
    r = await click({ selector: '#disabled' }); assert.equal(r.error, 'element_disabled'); assert.equal(r.action.outcome, 'not_started');
    r = await click({ selector: 'button' }); assert.equal(r.error, 'ambiguous_selector');
    r = await click({ x: 10000, y: 2 }); assert.equal(r.error, 'outside_viewport');
    await c.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<div id=overlay style=\"position:fixed;inset:0;z-index:999\"></div>')");
    r = await click({ selector: '#open' }); assert.equal(r.error, 'element_obscured');
    await c.executeJavaScript("document.querySelector('#overlay').remove()");
    c.setZoomFactor(1.25);
    r = await click({ selector: '#below' }); assert.equal(r.status, 'clicked', JSON.stringify(r));
    assert.equal(await c.executeJavaScript('window.clicks'), 3);
    assert.equal(await c.executeJavaScript('window.trusted.length >= 4 && window.trusted.every(Boolean)'), true);
    console.log('desktop-click real Chromium: PASS (coordinates, selector, optional wait, trusted events, checkbox, occlusion, scroll, zoom)');
  } finally { win.destroy(); }
}).then(() => { clearTimeout(guard); fs.rmSync(profile, {recursive:true,force:true}); app.exit(0); }).catch(error => { console.error(error); clearTimeout(guard); app.exit(1); });
