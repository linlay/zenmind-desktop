import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import JSZip from 'jszip';
import {loadImage} from '@napi-rs/canvas';
const root=path.resolve('output/skin-collection');
const hash=b=>createHash('sha256').update(b).digest('hex');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skin-refresh-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/shared/desktop-skin-package';export * from './src/shared/contracts/agent-webclient-bridge';export * from './src/main/modules/settings/skin-package-archive';export * from './src/main/modules/settings/appearance-images';`},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'validator.cjs')});
const api=createRequire(import.meta.url)(path.join(temp,'validator.cjs'));
let reports=JSON.parse(fs.readFileSync(path.join(root,'validation.json')));
async function decode(b){const a=[b.subarray(0,8)];for(let i=8;i<b.length;){const e=i+b.readUInt32BE(i)+12;if(b.toString('ascii',i+4,i+8)!=='caBX')a.push(b.subarray(i,e));i=e;}return loadImage(Buffer.concat(a));}
const selected=process.argv.slice(2);
assert(selected.every(key=>['tahiti','gold-saints'].includes(key)));
for(const key of (selected.length?selected:['tahiti','gold-saints'])){
 const source=path.join(root,'sources',key),m=JSON.parse(fs.readFileSync(path.join(source,'skin.json')));
 m.version=key==='gold-saints'?'1.5.0':'1.4.0';
 m.variants.dark.background.path='assets/background-dark.png';
 for(const mode of ['light','dark']){
  delete m.variants[mode].visuals.images['chat.attach'];
  delete m.variants[mode].visuals.images['chat.screenshot'];
  m.variants[mode].background.position='right center';
  for(const [slot,name] of Object.entries(m.variants[mode].visuals.images))if(slot.startsWith('heading.'))fs.copyFileSync(path.join(root,key+'-artwork',path.basename(name)),path.join(source,name));
 }
 if(key==='tahiti')for(const v of Object.values(m.variants))v.visuals.images['entry.website']=v.visuals.images['entry.project'];
 if(key==='gold-saints')m.variants.dark.visuals.images['chat.stop']='visuals/dark-stop.png';
 api.parseSkinPackageManifest(m);
 const zip=new JSZip(),resources=api.skinPackageResources(m);
 zip.file('skin.json',JSON.stringify(m,null,2)+'\n');
 for(const name of resources)zip.file(name,fs.readFileSync(path.join(source,name)),{createFolders:false,date:new Date('2026-01-01T00:00:00Z')});
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),dest=path.join(temp,key+'.skin.zip');fs.writeFileSync(dest,bytes);
 const parsed=await api.readSkinPackageArchive(dest);let visualBytes=0;
 for(const [name,b] of parsed.images){const dim=api.inspectBackgroundImage(b),img=await decode(b);assert.equal(img.width,dim.width);assert.equal(img.height,dim.height);if(name.startsWith('visuals/')){visualBytes+=b.length;assert(api.isSkinVisualDataUrl('data:image/png;base64,'+b.toString('base64')));}}
 assert(visualBytes<=api.SKIN_VISUAL_LIMITS.totalBytes);
 for(const v of Object.values(m.variants))assert.deepEqual(Object.keys(v.visuals.images).sort(),api.SKIN_VISUAL_SLOTS.filter(slot=>slot!=='chat.attach').sort());
 const report={file:key+'.skin.zip',name:m.name,version:m.version,schemaVersion:m.schemaVersion,bytes:bytes.length,zipEntries:Object.keys(zip.files).length,visualBytes,slotsPerVariant:api.SKIN_VISUAL_SLOTS.length-1,backgrounds:Object.fromEntries(['light','dark'].map(mode=>[mode,{path:m.variants[mode].background.path,sha256:hash(parsed.images.get(m.variants[mode].background.path))}])),sha256:hash(bytes),validation:'PASS canonical manifest, ZIP paths/CRC/limits, all PNG decoding/dimensions, all semantic slots'};
 fs.writeFileSync(path.join(source,'skin.json'),JSON.stringify(m,null,2)+'\n');fs.copyFileSync(dest,path.join(root,key+'.skin.zip'));reports=reports.map(r=>r.file===report.file?report:r);
}
fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify(reports,null,2)+'\n');
// Refresh the collection index from the actual sources, preserving unrelated assets.
const keys=['pink-kitty','tahiti','gold-saints','walnut-song','wanyao-tulu-zhuan'];
let html=fs.readFileSync(path.join(root,'preview.html'),'utf8');
const data=keys.map(key=>({key,manifest:JSON.parse(fs.readFileSync(path.join(root,'sources',key,'skin.json'))),style:key==='tahiti'?'海岛 · 独木舟 · 银河 · 手绘艺术字':key==='gold-saints'?'雅典娜 · 圣域 · 射手座':key}));
html=html.replace(/const skins=.*?;\nlet selected=/s,'const skins='+JSON.stringify(data)+';\nlet selected=');
html=html.replace('五套原有背景与配色，新增功能图标、栏目艺术字和未读标记。','五套主题，包含昼夜背景、功能图标与栏目艺术字。');
if(!html.includes('stage.style.backgroundPosition'))html=html.replace("stage.style.color=t['--ink'];","stage.style.color=t['--ink'];stage.style.backgroundPosition=v.background.position;");
html=html.replace("'.zh-CN'","'.'+locale");
html=html.replace("let selected=0,mode='light';","let selected=0,mode='light',locale='zh-CN';");
if(!html.includes('中文 / English'))html=html.replace('<nav id="tabs">','<button onclick="locale=locale===\'zh-CN\'?\'en-US\':\'zh-CN\';render()">中文 / English</button><nav id="tabs">');
html=html.replace('justify-content:space-between','justify-content:center;gap:30px');
if(!html.includes('整理思路'))html=html.replace('</div></section></div><details>','</div><div style="display:flex;gap:14px"><div style="flex:1;padding:18px;background:var(--surface,#ffffff22);border:1px solid #8884;border-radius:12px">整理思路</div><div style="flex:1;padding:18px;background:#ffffff22;border:1px solid #8884;border-radius:12px">开始创作</div></div></section></div><details>');
html=html.replace('图片解码与原始背景/配色一致性校验','图片解码校验');
fs.writeFileSync(path.join(root,'preview.html'),html);
console.log(JSON.stringify(reports.filter(r=>['tahiti.skin.zip','gold-saints.skin.zip'].includes(r.file)),null,2));
fs.rmSync(temp,{recursive:true,force:true});
