import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
const require=createRequire(import.meta.url);
const {readPetPackage,installLocalPetPackage}=require('../dist-electron/main/modules/pet/pet-package.js');
const {petImportDialogOptions}=require('../dist-electron/main/modules/pet/import-ipc.js');
const keys=['idle','jumping','moving-left','dragging','done','failed','running','awaiting','review'];
const png=createCanvas(16,4).toBuffer('image/png');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pet-import-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manifest={id:'test-pet',displayName:'Pet',version:'1.0.0',preview:'idle.png',states:Object.fromEntries(keys.map(k=>[k,{path:k+'.png',frameCount:4,durationMs:1000,loop:true}]))};
  const source=path.join(root,'宠物 包.zip');
  async function zip(edit=()=>{},prefix=''){
    const z=new JSZip();z.file(prefix+'pet.json',JSON.stringify(manifest));for(const k of keys)z.file(prefix+k+'.png',png);edit(z);
    fs.writeFileSync(source,await z.generateAsync({type:'nodebuffer',platform:'UNIX',compression:'DEFLATE'}));return source;
  }
  return {root,manifest,source,zip};
}
for(const prefix of ['', 'my-pet/'])test('install complete ZIP with '+(prefix||'root manifest'),async t=>{
  const h=fixture(t);await h.zip(()=>{},prefix);const dest=path.join(h.root,'installed');
  assert.equal(await installLocalPetPackage(h.source,dest),'user:test-pet');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'test-pet/pet.json'))).id,'test-pet');
  await assert.rejects(installLocalPetPackage(h.source,dest),e=>e.code==='packageExists');
  assert.deepEqual(fs.readdirSync(dest),['test-pet']);
});
test('imports a ZIP with nested signature assets',async t=>{
  const h=fixture(t);
  h.manifest.signature=[{id:'wave',label:'Wave',trigger:['manual'],variants:[{path:'signature/wave.png',frameCount:4,durationMs:1000}]}];
  await h.zip(z=>z.file('signature/wave.png',png));
  assert.equal(await installLocalPetPackage(h.source,path.join(h.root,'installed')),'user:test-pet');
});
test('rejects a directory even when its name ends in ZIP',async t=>{
  const h=fixture(t),directory=path.join(h.root,'package.zip');fs.mkdirSync(directory);
  await assert.rejects(readPetPackage(directory),e=>e.code==='invalidPackage');
});
for(const [name,edit] of [
  ['missing state',h=>delete h.manifest.states.review],
  ['fractional frame count',h=>h.manifest.states.idle.frameCount=4.5],
  ['escaping resource',h=>h.manifest.states.idle.path='../idle.png'],
  ['Windows reserved ID',h=>h.manifest.id='con'],
  ['invalid signature',h=>h.manifest.signature=[{id:'x',label:'x',trigger:['manual'],variants:[]}]],
])test('rejects '+name,async t=>{const h=fixture(t);edit(h);await h.zip();await assert.rejects(readPetPackage(h.source),e=>e.code==='invalidPackage');});
for(const [name,edit] of [
  ['ZIP traversal',z=>z.file('../escape.png',png)],
  ['symlink entry',z=>z.file('idle.png','outside',{unixPermissions:0o120777})],
  ['case collision',z=>z.file('IDLE.png',png)],
  ['extra executable',z=>z.file('evil.js','alert(1)')],
  ['corrupt image',z=>z.file('idle.png','not an image')],
  ['multiple manifests',z=>z.file('other/pet.json','{}')],
  ['pixel bomb',z=>{const b=Buffer.from(png);b.writeUInt32BE(100000,16);z.file('idle.png',b);}],
])test('rejects '+name,async t=>{const h=fixture(t);await h.zip(edit);await assert.rejects(readPetPackage(h.source),e=>e.code==='invalidPackage');});
test('rejects symlink archive and aborts before commit when owner disappears',async t=>{
  const h=fixture(t);await h.zip();const link=path.join(h.root,'linked.zip');fs.symlinkSync(h.source,link);
  await assert.rejects(readPetPackage(link),e=>e.code==='invalidPackage');
  const dest=path.join(h.root,'installed');let checks=0;
  await assert.rejects(installLocalPetPackage(h.source,dest,()=>{if(++checks===2)throw Error('owner gone');}),/owner gone/);
  assert.deepEqual(fs.readdirSync(dest),[]);
});
test('platform pickers only select ZIP files',()=>{
  for(const platform of ['darwin','win32']){
    const options=petImportDialogOptions(platform);
    assert.ok(options.properties.includes('openFile'));
    assert.equal(options.properties.includes('openDirectory'),false);
    assert.equal(options.properties.includes('dontAddToRecent'),platform==='win32');
    assert.deepEqual(options.filters[0].extensions,['zip']);
  }
});
test('rejects oversized decompressed files before decoding',async t=>{
  const h=fixture(t);await h.zip(z=>z.file('idle.png',Buffer.alloc(17*1024*1024)));
  await assert.rejects(readPetPackage(h.source),e=>e.code==='packageTooLarge');
});
test('temporary import folders never appear in installed pets',t=>{
  const h=fixture(t),app={getPath:()=>h.root};
  const {getDesktopPetsDataRoot}=require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
  const {listUserDesktopPets}=require('../dist-electron/main/modules/pet/pet-assets.js');
  const root=getDesktopPetsDataRoot(app);
  for(const name of ['visible','.pet-import-staging']){fs.mkdirSync(path.join(root,name),{recursive:true});fs.writeFileSync(path.join(root,name,'pet.json'),JSON.stringify({...h.manifest,id:name==='visible'?'visible':'hidden'}));}
  assert.deepEqual(listUserDesktopPets(app).map(p=>p.petId),['visible']);
});

test('removal resolves only catalog user IDs, refusing built-ins, traversal and symlinks',t=>{
 const h=fixture(t),app={getPath:()=>h.root};
 const {getDesktopPetsDataRoot}=require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
 const {resolveRemovablePetPath}=require('../dist-electron/main/modules/pet/remove-package.js');
 const root=getDesktopPetsDataRoot(app),pet=path.join(root,'test-pet');
 fs.mkdirSync(pet,{recursive:true});fs.writeFileSync(path.join(pet,'pet.json'),JSON.stringify(h.manifest));
 assert.equal(resolveRemovablePetPath(app,'user:test-pet'),pet);
 for(const id of ['classic','cutej','zenmi','../test-pet','user:../test-pet','user:missing',null])assert.throws(()=>resolveRemovablePetPath(app,id));
 const outside=path.join(h.root,'outside');fs.renameSync(pet,outside);fs.symlinkSync(outside,pet,'dir');
 assert.throws(()=>resolveRemovablePetPath(app,'user:test-pet'));
 assert.ok(fs.existsSync(path.join(outside,'pet.json')));
});
