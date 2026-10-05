import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
const file=path.resolve('dist-electron/main/modules/pet/import-ipc.js');
const realRequire=createRequire(file);
function harness({picker,install,trash,platform="darwin"}={}){
  const handlers=new Map(),calls=[];
  const win={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,mainFrame:{}}};
  const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
  let current=win;
  const module={exports:{}};
  class PetPackageError extends Error{constructor(code){super(code);this.code=code;}}
  const req=id=>id==='electron'?{shell:{trashItem:async target=>{calls.push('trash');if(trash)await trash(target);}},dialog:{showOpenDialog:async(...args)=>{calls.push('picker');return picker?picker(...args):{canceled:true,filePaths:[]};}}}:
    id==='./remove-package'?{resolveRemovablePetPath:(_app,id)=>{if(id!=='user:test')throw Error('protected');return '/tmp/test-pets/test';}}:
    id==='./pet-package'?{PetPackageError,installLocalPetPackage:async(...args)=>{calls.push('install');return install?install(...args):'user:test';}}:
    id.includes('user-paths')?{getDesktopPetsDataRoot:()=>'/tmp/test-pets'}:realRequire(id);
  vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{process})(req,module,module.exports);
  const state={enabled:false,appearanceId:'classic',appearanceOptions:[]};
  module.exports.registerPetImportIpcHandlers({handle:(key,fn)=>handlers.set(key,fn)},{app:{},platform,onRemoved:()=>calls.push('removed'),getMainWindow:()=>current,refreshState:()=>state});
  return {handlers,calls,event,state,close:()=>{current=null;}};
}
test('only the main window top frame can import',()=>{
  const h=harness(),run=h.handlers.get('desktopPet.importPackage');
  assert.throws(()=>run({...h.event,senderFrame:{}},null),/main window/);
  assert.throws(()=>run({...h.event,sender:{}},null),/main window/);
  assert.equal(h.calls.length,0);
});
test('cancelled picker leaves state and storage unchanged',async()=>{
  const h=harness();const r=await h.handlers.get('desktopPet.importPackage')(h.event);
  assert.equal(r.cancelled,true);assert.equal(r.state,h.state);assert.deepEqual(h.calls,['picker']);
});
test('invalid drop fails without opening a dialog',async()=>{
  const h=harness();const r=await h.handlers.get('desktopPet.importDroppedPackage')(h.event,'relative.zip');
  assert.equal(r.ok,false);assert.equal(r.error,'invalidPackage');assert.deepEqual(h.calls,[]);
});
test('owner is rechecked when the picker resolves',async()=>{
  let resolve;const h=harness({picker:()=>new Promise(r=>{resolve=r;})});
  const result=h.handlers.get('desktopPet.importPackage')(h.event);await new Promise(setImmediate);
  h.close();resolve({canceled:false,filePaths:['/tmp/pet.zip']});
  assert.equal((await result).ok,false);assert.deepEqual(h.calls,['picker']);
});
test('serial imports refresh without selecting or enabling a pet',async()=>{
  let finish;let count=0;const h=harness({install:async()=>{if(++count===1)await new Promise(r=>{finish=r;});return 'user:test';}});
  const run=h.handlers.get('desktopPet.importDroppedPackage');
  const a=run(h.event,'/tmp/one.zip'),b=run(h.event,'/tmp/two.zip');await new Promise(setImmediate);
  assert.equal(count,1);finish();const results=await Promise.all([a,b]);assert.equal(count,2);
  for(const r of results){assert.equal(r.ok,true);assert.equal(r.state.enabled,false);assert.equal(r.state.appearanceId,'classic');}
});

test('only package management IPC channels are registered',()=>{
  const h=harness();assert.deepEqual([...h.handlers.keys()],['desktopPet.removePackage','desktopPet.importPackage','desktopPet.importDroppedPackage']);
});

for (const platform of ['darwin','win32']) test('deletion uses recoverable platform trash: '+platform,async()=>{
 const h=harness({platform});const r=await h.handlers.get('desktopPet.removePackage')(h.event,'user:test');
 assert.equal(r.ok,true);assert.deepEqual(h.calls,['trash','removed']);assert.equal(r.state,h.state);
});
test('built-in deletion and foreign frame deletion are rejected before storage',async()=>{
 const h=harness(),run=h.handlers.get('desktopPet.removePackage');
 assert.throws(()=>run({...h.event,senderFrame:{}},'user:test'),/main window/);
 assert.equal((await run(h.event,'classic')).ok,false);assert.deepEqual(h.calls,[]);
});
test('trash failure does not reset selection',async()=>{
 const h=harness({trash:()=>{throw Error('busy');}});
 assert.equal((await h.handlers.get('desktopPet.removePackage')(h.event,'user:test')).ok,false);
 assert.deepEqual(h.calls,['trash']);
});
test('queued deletion rechecks owner before touching storage',async()=>{
 let finish;const h=harness({install:()=>new Promise(r=>{finish=r;})});
 const importing=h.handlers.get('desktopPet.importDroppedPackage')(h.event,'/tmp/pet.zip');
 const deleting=h.handlers.get('desktopPet.removePackage')(h.event,'user:test');
 await new Promise(setImmediate);h.close();finish('user:test');await importing;
 assert.equal((await deleting).ok,false);assert.deepEqual(h.calls,['install']);
});
