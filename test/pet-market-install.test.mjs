import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
const require=createRequire(import.meta.url);
const {installPetPackage,installLocalPetPackage}=require('../dist-electron/main/modules/pet/pet-package.js');
const {createPetPackageService}=require('../dist-electron/main/modules/pet/package-service.js');
const {readDesktopPetStoredState,saveDesktopPetSettings}=require('../dist-electron/main/modules/pet/desktop-pet.js');
const {getDesktopPetsDataRoot}=require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
const keys=['idle','jumping','moving-left','dragging','done','failed','running','awaiting','review'];
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pet-market-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app={getPath:name=>path.join(root,name)};
 async function archive(id,version='1.0.0',edit=()=>{}){
  const z=new JSZip(),manifest={id,version,displayName:id,preview:'idle.png',states:Object.fromEntries(keys.map(key=>[key,{path:key+'.png',frameCount:4,durationMs:900}]))};
  edit(manifest);
  const canvas=createCanvas(16,4);const ctx=canvas.getContext('2d');ctx.fillStyle=version==='1.0.0'?'blue':'orange';ctx.fillRect(0,0,16,4);const png=canvas.toBuffer('image/png');
  z.file('pet.json',JSON.stringify(manifest));for(const key of keys)z.file(key+'.png',png);
  const source=path.join(root,`${id}-${version}.zip`);fs.writeFileSync(source,await z.generateAsync({type:'nodebuffer',platform:'UNIX'}));return source;
 }
 return {root,app,archive};
}
test('two market pets install without switching, can be switched and restored, and selected deletion falls back',async t=>{
 const h=fixture(t),trash=path.join(h.root,'trash');fs.mkdirSync(trash);
 const refresh=()=>readDesktopPetStoredState(h.app,'darwin');
 saveDesktopPetSettings(h.app,{appearanceId:'classic',enabled:false,boundAgentKey:'unchanged-agent'},'darwin');
 const baselineAgent=refresh().boundAgentKey;
 const service=createPetPackageService({app:h.app,platform:'darwin',refreshState:refresh,trashItem:async target=>fs.renameSync(target,path.join(trash,path.basename(target))),onRemoved:id=>{if(refresh().appearanceId===id)saveDesktopPetSettings(h.app,{appearanceId:'classic'},'darwin');}});
 for(const id of ['panda','fox'])await service.installMarketPackage(await h.archive(id),{id,version:'1.0.0'},()=>{});
 assert.equal(refresh().appearanceId,'classic');assert.equal(refresh().enabled,false);
 for(const id of ['panda','fox','panda']){
  saveDesktopPetSettings(h.app,{appearanceId:`user:${id}`},'darwin');
  assert.equal(readDesktopPetStoredState(h.app,'darwin').appearanceId,`user:${id}`);
  assert.equal(refresh().boundAgentKey,baselineAgent);
 }
 await service.removePackage('user:fox');assert.equal(refresh().appearanceId,'user:panda');
 await service.removePackage('user:panda');assert.equal(refresh().appearanceId,'classic');
 assert.deepEqual(fs.readdirSync(trash).sort(),['fox','panda']);
});
test('market upgrades are atomic and a failed record commit restores original package bytes',async t=>{
 const h=fixture(t),dest=path.join(h.root,'pets'),id='panda';
 await installPetPackage(await h.archive(id),dest,{market:{id,version:'1.0.0'}});
 const before=fs.readFileSync(path.join(dest,id,'idle.png'));
 const next=await h.archive(id,'1.1.0');
 await assert.rejects(installPetPackage(next,dest,{market:{id,version:'1.1.0'},onCommitted:()=>{throw Error('record failed');}}),/record failed/);
 assert.deepEqual(fs.readFileSync(path.join(dest,id,'idle.png')),before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dest,id,'pet.json'))).version,'1.0.0');
 await installPetPackage(next,dest,{market:{id,version:'1.1.0'}});
 assert.equal(JSON.parse(fs.readFileSync(path.join(dest,id,'pet.json'))).version,'1.1.0');
 assert.notDeepEqual(fs.readFileSync(path.join(dest,id,'idle.png')),before);
 assert.deepEqual(fs.readdirSync(dest),[id]);
});
test('identity, version and invalid animation failures leave installed pet intact',async t=>{
 const h=fixture(t),dest=path.join(h.root,'pets');
 await installPetPackage(await h.archive('panda'),dest,{market:{id:'panda',version:'1.0.0'}});
 const before=fs.readFileSync(path.join(dest,'panda/pet.json'));
 for(const [source,identity] of [
  [await h.archive('fox'),{id:'panda',version:'1.0.0'}],
  [await h.archive('panda','2.0.0'),{id:'panda',version:'3.0.0'}],
  [await h.archive('panda','1.2.0',manifest=>delete manifest.states.review),{id:'panda',version:'1.2.0'}]
 ])await assert.rejects(installPetPackage(source,dest,{market:identity}),error=>error.code==='invalidPackage');
 assert.deepEqual(fs.readFileSync(path.join(dest,'panda/pet.json')),before);
});
test('a same-ID local import is never replaced by Market, including a stale installation record',async t=>{
 const h=fixture(t),dest=getDesktopPetsDataRoot(h.app,'darwin');
 await installLocalPetPackage(await h.archive('panda'),dest);
 await assert.rejects(installPetPackage(await h.archive('panda','2.0.0'),dest,{market:{id:'panda',version:'2.0.0'}}),error=>error.code==='packageExists');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'panda/pet.json'))).version,'1.0.0');
});
test('symlink target cannot be overwritten by a Market upgrade',async t=>{
 const h=fixture(t),dest=path.join(h.root,'pets');fs.mkdirSync(dest);const outside=path.join(h.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(dest,'panda'));
 await assert.rejects(installPetPackage(await h.archive('panda'),dest,{market:{id:'panda',version:'1.0.0'}}),error=>error.code==='packageExists');
 assert.deepEqual(fs.readdirSync(outside),[]);
});
test('upgrading a selected pet changes asset revision URLs while keeping its identity and selection',async t=>{
 const h=fixture(t),dest=getDesktopPetsDataRoot(h.app,'darwin');
 const {listUserDesktopPetAppearanceOptions}=require('../dist-electron/main/modules/pet/pet-assets.js');
 const {versionedDesktopPetAssetUrl}=require('../dist-electron/shared/desktop-pet.js');
 const {resolveDesktopPetAssetRequest}=require('../dist-electron/main/modules/pet/pet-asset-protocol.js');
 await installPetPackage(await h.archive('panda'),dest,{market:{id:'panda',version:'1.0.0'}});
 saveDesktopPetSettings(h.app,{appearanceId:'user:panda'},'darwin');
 const before=listUserDesktopPetAppearanceOptions(h.app).find(item=>item.id==='user:panda');
 const oldURL=versionedDesktopPetAssetUrl(before.assetBasePath,before.states.idle.path,before.assetVersion);
 await installPetPackage(await h.archive('panda','1.1.0'),dest,{market:{id:'panda',version:'1.1.0'}});
 const after=listUserDesktopPetAppearanceOptions(h.app).find(item=>item.id==='user:panda');
 const newURL=versionedDesktopPetAssetUrl(after.assetBasePath,after.states.idle.path,after.assetVersion);
 assert.equal(before.id,after.id);assert.equal(readDesktopPetStoredState(h.app,'darwin').appearanceId,'user:panda');
 assert.notEqual(oldURL,newURL);assert.equal(new URL(newURL).searchParams.get('v'),'1.1.0');
 assert.equal(resolveDesktopPetAssetRequest(h.app,newURL,'darwin'),fs.realpathSync(path.join(dest,'panda/idle.png')));
});
test('asset revision helper encodes raw Unicode, spaces and hash filenames once',()=>{
 const {versionedDesktopPetAssetUrl}=require('../dist-electron/shared/desktop-pet.js');
 const url=new URL(versionedDesktopPetAssetUrl('cutej-pet://panda/','动作/待机 #1.png','1.1.0'));
 assert.equal(url.hash,'');assert.equal(decodeURIComponent(url.pathname),'/动作/待机 #1.png');
 assert.equal(url.searchParams.get('v'),'1.1.0');assert.equal(url.pathname.includes('%2523'),false);
});
