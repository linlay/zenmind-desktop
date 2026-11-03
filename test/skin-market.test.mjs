import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
const require=createRequire(import.meta.url);
const {createDesktopSkinStore}=require('../dist-electron/main/modules/settings/appearance-store.js');
const {createAppearanceRuntime}=require('../dist-electron/main/modules/settings/appearance-runtime.js');
const {createSkinMarketPort}=require('../dist-electron/main/modules/settings/index.js');
const {installSkinMarketItem,listSkinMarketItems}=require('../dist-electron/main/modules/marketplace/skin-market.js');
const {readInstalledRecords}=require('../dist-electron/main/modules/marketplace/installed-records.js');
const png=createCanvas(12,8).toBuffer('image/png');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skin-market-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=createDesktopSkinStore({configRoot:path.join(root,'config'),assetsRoot:path.join(root,'appearance'),normalizeImage:data=>({data,width:12,height:8})});
 const runtime=createAppearanceRuntime(()=>store),port=createSkinMarketPort(runtime),app={getVersion:()=> '999.0.0',getPath:name=>path.join(root,name)};
 async function archive(id,version='1.0.0',name='Same skin name'){
  const manifest={schemaVersion:'1.1',id,version,name,variants:{light:{tokens:{'--accent':'#197645'},background:{path:'light.png',position:'center'}},dark:{tokens:{'--accent':'#94d4ac'},background:{path:'dark.png',position:'center'}}}};
  const zip=new JSZip();zip.file('skin.json',JSON.stringify(manifest));zip.file('light.png',png);zip.file('dark.png',png);const file=path.join(root,id+'-'+version+'.zip');const bytes=await zip.generateAsync({type:'nodebuffer',platform:'UNIX'});fs.writeFileSync(file,bytes);return {file,bytes,manifest};
 }
 return {root,store,runtime,port,app,archive};
}
test('skin identity mapping is packageId/version, not names; installing does not apply and selection persists',async t=>{
 const h=setup(t),first=await h.archive('first.skin'),second=await h.archive('second.skin');h.store.setSkin('mist');
 const a=await h.port.installArchive(first.file,{id:'first.skin',version:'1.0.0'},()=>{},()=>{});
 const b=await h.port.installArchive(second.file,{id:'second.skin',version:'1.0.0'},()=>{},()=>{});
 assert.notEqual(a,b);assert.match(a,/^pack:[a-f0-9]{32}$/);assert.equal(h.store.read().skinId,'mist');
 const list=await h.port.listInstalled();assert.equal(list.find(s=>s.id===a).packageId,'first.skin');assert.equal(list.find(s=>s.id===b).packageId,'second.skin');
 assert.equal(JSON.stringify(list).includes(h.root),false);
 h.store.setSkin(a);assert.equal(h.store.read().installedSkin.tokens.light['--accent'],'#197645');h.store.setSkin(b);assert.equal(h.store.read().skinId,b);
 const recreated=createDesktopSkinStore({configRoot:path.join(h.root,'config'),assetsRoot:path.join(h.root,'appearance'),normalizeImage:data=>({data,width:12,height:8})});assert.equal(recreated.read().skinId,b);
 recreated.removePackage(b);assert.equal(recreated.read().skinId,'default');assert.equal(recreated.read().installedSkins.length,1);
});
test('updates are independent immutable versions and record-commit failure removes only the new inactive package',async t=>{
 const h=setup(t),old=await h.archive('first.skin'),newer=await h.archive('first.skin','1.1.0');
 const a=await h.port.installArchive(old.file,{id:'first.skin',version:'1.0.0'},()=>{},()=>{});h.store.setSkin(a);
 await assert.rejects(h.port.installArchive(newer.file,{id:'first.skin',version:'1.1.0'},()=>{},()=>{throw Error('record failed')}),/record failed/);
 assert.equal(h.store.read().skinId,a);assert.equal(h.store.read().installedSkins.length,1);
 const b=await h.port.installArchive(newer.file,{id:'first.skin',version:'1.1.0'},()=>{},()=>{});assert.notEqual(a,b);assert.equal(h.store.read().skinId,a);assert.equal(h.store.read().installedSkins.length,2);
});
test('market requires exact parsed package ID and version and rechecks owner before commit',async t=>{
 const h=setup(t),zip=await h.archive('first.skin');
 for(const expected of [{id:'wrong.skin',version:'1.0.0'},{id:'first.skin',version:'2.0.0'}])await assert.rejects(h.port.installArchive(zip.file,expected,()=>{},()=>{}),e=>e.code==='invalidPackage');
 let checks=0;await assert.rejects(h.port.installArchive(zip.file,{id:'first.skin',version:'1.0.0'},()=>{if(++checks===2)throw Error('owner disappeared')},()=>{}),/owner disappeared/);
 assert.equal(h.store.read().installedSkins?.length??0,0);
});
test('typed skin market install downloads the original ZIP and maps opaque record to actual installed package',async t=>{
 const h=setup(t),zip=await h.archive('first.skin');
 const item={id:'first.skin',name:'First',type:'skin',version:'1.0.0',description:'',tags:[],assets:{universal:{url:'https://market.example.test/first.zip',archiveType:'zip',sizeBytes:zip.bytes.length,sha256:createHash('sha256').update(zip.bytes).digest('hex')}}};
 const options={catalog:{schemaVersion:1,items:[{...item,type:'pet'},item]},skinPackages:h.port,fetchImpl:async()=>new Response(zip.bytes)};
 const result=await installSkinMarketItem(h.app,'first.skin',options);assert.equal(result.type,'skin');assert.equal(h.store.read().skinId,'default');assert.match(result.skinId,/^pack:/);
 const record=readInstalledRecords(h.app).find(r=>r.type==='skin');assert.equal(record.resourceKey,result.skinId);
 const list=await listSkinMarketItems(h.app,options);assert.equal(list.items.length,1);assert.equal(list.items[0].installedSkinId,result.skinId);assert.equal(list.items[0].state,'installed');
 h.store.removePackage(result.skinId);const after=await listSkinMarketItems(h.app,options);assert.equal(after.items[0].state,'not-installed');
});
test('generic uninstall cannot mistake a skin logical ID for a skill or remove an arbitrary skin version',async t=>{
 const h=setup(t),zip=await h.archive('first.skin');const item={id:'first.skin',type:'skin',name:'Skin',version:'1.0.0',description:'',tags:[],assets:{universal:{url:'https://market.example.test/a.zip',archiveType:'zip',sizeBytes:zip.bytes.length}}};
 const options={catalog:{schemaVersion:1,items:[item]},skinPackages:h.port,fetchImpl:async()=>new Response(zip.bytes)};await installSkinMarketItem(h.app,item.id,options);
 const {uninstallMarketItem}=require('../dist-electron/main/modules/marketplace/runtime.js');
 await assert.rejects(uninstallMarketItem(h.app,item.id,options));assert.equal((await h.port.listInstalled()).length,1);
});
