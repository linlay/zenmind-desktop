import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WorkPanelPageDialogs, ensureWorkPanelPageDialogIpc } = require('../dist-electron/main/modules/web-surfaces/cdp/page-dialogs.js');
const { WORK_PANEL_PAGE_DIALOG_CHANNEL: channel } = require('../dist-electron/shared/work-panel-page-dialog.js');

function fixture(timeoutMs) {
  const port = new EventEmitter(), contents = new EventEmitter(), events = [];
  const frame = { url: 'https://fixture.invalid/page' };
  Object.assign(contents, { id: 42, mainFrame: frame, isDestroyed: () => false });
  let released = 0, valid = true;
  let onRelease=()=>{};
  const scope = { readContainer: () => { if (!valid) throw Error('scope_revoked'); }, validateTab: () => {}, release: () => { released++; onRelease(); }, onRelease: listener => { onRelease=listener; return ()=>{onRelease=()=>{}}; } };
  const bridge = new WorkPanelPageDialogs(port, {
    opened: (_contents, id, type, message) => events.push({ op:'open', id, type, message }),
    closed: (_contents, id, accepted, reason) => events.push({ op:'close', id, accepted, reason }),
  }, timeoutMs);
  const request = (value, senderFrame = frame) => {
    const event = { sender: contents, senderFrame };
    port.emit(channel, event, value);
    return event;
  };
  const ready = () => request({ op:'ready' });
  const dialog = (type = 'confirm', defaultValue) => request({ op:'dialog', type, message:'Synthetic page message', ...(defaultValue !== undefined ? { defaultValue } : {}) });
  const begin = signal => { ready(); const lease = bridge.begin(contents, scope, { tabId:'tab', webContentsId:42 }, signal, true); let resolve; const work = new Promise(r => resolve = r); lease.track(work); return { lease, settle: async () => { resolve(); await Promise.resolve(); } }; };
  return { port, contents, scope, bridge, events, request, ready, dialog, begin, released: () => released, revoke: () => { valid = false; onRelease(); } };
}

test('manual dialogs take the native sentinel before an input and after gateway disposal', () => {
  const f=fixture();
  assert.deepEqual(f.dialog().returnValue, {handled:false});
  f.bridge.dispose();
  assert.deepEqual(f.dialog().returnValue, {handled:false});
  ensureWorkPanelPageDialogIpc(f.port);
  assert.equal(f.port.listenerCount(channel),1);
});

for (const [type, accepted, promptText, expected] of [
  ['alert',true,undefined,{handled:true,accepted:true}],
  ['confirm',false,undefined,{handled:true,accepted:false}],
  ['confirm',true,undefined,{handled:true,accepted:true}],
  ['prompt',true,'Ada',{handled:true,accepted:true,promptText:'Ada'}],
  ['prompt',false,undefined,{handled:true,accepted:false}],
]) test(`scoped ${type} resolves synchronously only after its explicit answer (${accepted})`, async t => {
  const f=fixture(); t.after(()=>f.bridge.dispose());
  const input=f.begin(), event=f.dialog(type,'default'); input.lease.end();
  assert.equal(event.returnValue,undefined);
  assert.equal(f.released(),0,'retain the input scope while its real CDP promise is pending');
  assert.equal(f.bridge.handle(f.contents,f.events[0].id,accepted,promptText),true);
  assert.deepEqual(event.returnValue,expected);
  assert.equal(f.released(),0);
  await input.settle(); assert.equal(f.released(),1);
  assert.deepEqual(f.dialog().returnValue,{handled:false});
});

for (const cancel of ['abort','navigation','destroyed','revoked','timeout']) test(`a ${cancel} after dialog_pending dismisses the original waiter without falling back to native`, async t=>{
  const f=fixture(cancel==='timeout'?15:120000); t.after(()=>f.bridge.dispose());
  const abort=new AbortController(), input=f.begin(abort.signal), event=f.dialog(); input.lease.end();
  if(cancel==='abort') abort.abort();
  if(cancel==='navigation') f.contents.emit('did-start-navigation',{},'https://fixture.invalid/next',false,true);
  if(cancel==='destroyed') f.contents.emit('destroyed');
  if(cancel==='revoked') f.revoke();
  if(cancel==='timeout') await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(event.returnValue,{handled:true,accepted:false,cancelled:true});
  if(cancel!=='destroyed') assert.deepEqual(f.dialog().returnValue,{handled:true,accepted:false,cancelled:true});
  await input.settle();
  assert.equal(f.released(),1);
  assert.equal(f.events.filter(e=>e.op==='close').every(e=>!e.accepted),true);
});

test('an input continuation can open a second dialog while the original dispatch is still running', async t=>{
  const f=fixture(); t.after(()=>f.bridge.dispose()); const input=f.begin();
  const first=f.dialog(); input.lease.end();
  f.bridge.handle(f.contents,f.events[0].id,false);
  const second=f.dialog('prompt','next');
  assert.equal(second.returnValue,undefined);
  f.bridge.handle(f.contents,f.events.findLast(e=>e.op==='open').id,true);
  assert.deepEqual(second.returnValue,{handled:true,accepted:true,promptText:'next'});
  assert.equal(first.returnValue.accepted,false);
  await input.settle();
});

test('the bridge refuses a foreign frame, invalid input and a guest without its fixed preload', async t=>{
  const f=fixture(); t.after(()=>f.bridge.dispose());
  assert.throws(()=>f.bridge.begin(f.contents,f.scope,{tabId:'tab',webContentsId:42}),{code:'workpanel_dialog_bridge_required'});
  const input=f.begin();
  assert.deepEqual(f.request({op:'dialog',type:'confirm',message:'x'},{url:'https://other.invalid'}).returnValue,{handled:true,accepted:false,cancelled:true});
  assert.deepEqual(f.request({op:'dialog',type:'script',message:'x'}).returnValue,{handled:true,accepted:false,cancelled:true});
  assert.equal(f.events.length,0);
  input.lease.end(); await input.settle();
});
