import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { installWorkPanelPageDialogWrappers: install }=require('../dist-electron/preload/work-panel-page-dialog.js');

function fixture(invoke) {
  const calls=[], microtasks=[];
  const window={alert:(...args)=>{calls.push(['alert',...args]);},confirm:(...args)=>{calls.push(['confirm',...args]);return true;},prompt:(...args)=>{calls.push(['prompt',...args]);return 'manual';}};
  vm.runInNewContext(`(${install.toString()})(invoke)`,{window,invoke,queueMicrotask:fn=>microtasks.push(fn)});
  return {window,calls,microtasks};
}

test('manual native fallback preserves one string conversion for each argument',()=>{
  const f=fixture(()=>({handled:false})); let converted=0;
  const value={toString:()=>String(++converted)};
  assert.equal(f.window.confirm(value),true);
  assert.equal(converted,1); assert.deepEqual(f.calls[0],['confirm','1']);
  assert.equal(f.window.prompt(value,value),'manual');
  assert.equal(converted,3); assert.deepEqual(f.calls[1],['prompt','2','3']);
  f.window.alert(); assert.deepEqual(f.calls[2],['alert','']);
});

test('a cancelled synchronous continuation cannot fall back to native until its task ends',()=>{
  let count=0;
  const f=fixture(()=>{count++;return {handled:true,accepted:false,cancelled:true};});
  assert.equal(f.window.confirm('first'),false);
  assert.equal(f.window.prompt('second'),null);
  f.window.alert('third');
  assert.equal(count,1); assert.equal(f.calls.length,0);
  f.microtasks.forEach(run=>run());
  f.window.confirm('new task'); assert.equal(count,2);
});

test('a bridge error dismisses synchronously without opening a new native dialog',()=>{
  const f=fixture(()=>{throw Error('transport failure')});
  assert.equal(f.window.prompt('prompt'),null);
  assert.equal(f.window.confirm('confirm'),false);
  assert.equal(f.calls.length,0);
});
