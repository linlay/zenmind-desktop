import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
const file=path.resolve('dist-electron/main/modules/pet/ipc.js'),realRequire=createRequire(file);
for(const current of ['user:removed','user:other','classic'])test('deletion persists fallback only for selected pet: '+current,()=>{
 let callback;let settings={appearanceId:current,enabled:false};const writes=[];
 const module={exports:{}};
 const req=id=>id==='./import-ipc'?{registerPetImportIpcHandlers:(_ipc,options)=>{callback=options.onRemoved;}}:
 id==='./desktop-pet'?{saveDesktopPetSettings:(_app,patch)=>{writes.push(patch);return {...settings,...patch};}}:realRequire(id);
 vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{})(req,module,module.exports);
 module.exports.registerDesktopPetIpcHandlers({handle:()=>{}},{app:{},platform:'darwin',getSettings:()=>settings,saveSettingsInState:value=>{settings=value;}});
 callback('user:removed');
 const {DEFAULT_DESKTOP_PET_APPEARANCE_ID}=realRequire('../../../shared/desktop-pet.js');
 assert.equal(settings.appearanceId,current==='user:removed'?DEFAULT_DESKTOP_PET_APPEARANCE_ID:current);
 assert.equal(settings.enabled,false);assert.equal(writes.length,current==='user:removed'?1:0);
});
