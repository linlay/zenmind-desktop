// Actual WebClient controls and hook, using the real product smoke HTTP endpoint.
// The surrounding application shell is intentionally outside this component acceptance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', process.env.ACP_UI_PROFILE);
app.whenReady().then(async () => {
  const base = process.env.ACP_UI_BASE;
  await session.defaultSession.cookies.set({ url: base, name: 'access_token', value: process.env.ACP_UI_TOKEN, httpOnly: true });
  const window = new BrowserWindow({ width: 1200, height: 760, show: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await window.loadURL(`${base}/qa/?agent=${encodeURIComponent(process.env.ACP_UI_AGENT)}&chat=${process.env.ACP_UI_CHAT}`);
  const js = source => window.webContents.executeJavaScript(source);
  async function wait(condition) {
    for (let i = 0; i < 900; i++) {
      if (await js(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(process.env.ACP_UI_OUTPUT, "failure.html"), await js("document.documentElement.outerHTML"));
    throw new Error(`UI condition timed out: ${condition}; ${await js('document.body.innerText')}`);
  }
  if (process.env.ACP_UI_PHASE === 'unauthenticated') {
    await wait('window.engineSession?.auth?.methods?.length > 0 && !window.engineSession.busy');
    assert.equal(await js('window.engineSession.error'), 'auth_required');
    assert.equal(await js('window.engineSession.auth.methods.filter(m=>m.available).map(m=>m.id).join()'), 'chat-gpt');
    assert.ok(await js('Array.from(document.querySelectorAll("button")).some(b=>!b.disabled && b.innerText.includes("ChatGPT"))'));
    console.log('PASS real WebClient auth_required and supported browser-login control; unsupported methods disabled');
  } else {
    await wait('window.engineSession?.prepared?.configOptions?.length > 0 && !window.engineSession.busy');
    assert.equal(await js('document.body.textContent.includes("Fast mode")'), false, 'unverified service tier must be hidden');
    const before = await js('window.engineSession.prepared.configRevision');
    const point = await js('(()=>{const r=document.querySelector("[aria-label=Model]").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait('document.querySelectorAll(".ant-select-item-option").length > 0');
    await js(`(()=>{const option=document.querySelector('.ant-select-item-option:not(.ant-select-item-option-selected)');if(!option)throw new Error('Alternative model missing');window.selectedModel=window.engineSession.prepared.configOptions.find(o=>o.category==='model').choices.find(c=>c.name===option.textContent).value;option.click()})()`);
    await wait(`!window.engineSession.busy && window.engineSession.prepared.configRevision !== ${JSON.stringify(before)}`);
    assert.equal(await js('window.engineSession.prepared.configOptions.find(o=>o.category==="model").currentValue'), await js('window.selectedModel'));
    console.log('PASS real WebClient model dropdown → configuration HTTP → refreshed revision');
  }
  fs.writeFileSync(path.join(process.env.ACP_UI_OUTPUT, `${process.env.ACP_UI_PHASE}.png`), (await window.webContents.capturePage()).toPNG());
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
