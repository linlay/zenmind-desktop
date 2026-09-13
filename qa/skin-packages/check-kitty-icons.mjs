import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { kittyPaths } from './kitty-artwork.mjs';
const root=path.resolve('output/skin-collection');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kitty-icons-'));
const source=path.join(root,'sources/pink-kitty');
const images={};
for(const mode of ['light','dark']) for(const name of Object.keys(kittyPaths)) {
 const bytes=fs.readFileSync(path.join(source,`visuals/${mode}-${name}.png`));
 const img=await loadImage(bytes), canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
 const pixels=ctx.getImageData(0,0,img.width,img.height).data;
 let minX=img.width,minY=img.height,maxX=-1,maxY=-1;
 for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++)if(pixels[(y*img.width+x)*4+3]>24){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
 assert((maxX-minX+1)/img.width>.8,`${mode}/${name}: excessive horizontal padding`);
 images[`${mode}-${name}`]='data:image/png;base64,'+bytes.toString('base64');
}
await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SkinVisual,SkinVisualContext} from '../agent-webclient/src/shared/ui/SkinVisual';
const images=${JSON.stringify(images)};
createRoot(document.getElementById('root')).render(<>{['light','dark'].map(mode=><section style={{background:mode==='light'?'#fff0f5':'#2c1924',color:mode==='light'?'#502b3c':'#ffe7f1',padding:24}}><h2>{mode} · 实际 16×16 / 放大对照</h2><div className="grid">{Object.keys(images).filter(k=>k.startsWith(mode)).map(k=><SkinVisualContext.Provider value={{identity:k,getAsset:async()=>images[k]}}><div className="cell"><span className="small" style={{fontSize:11,display:'flex',width:16,background:k.endsWith('-send')?(mode==='light'?'#B73970':'#F29AC1'):undefined,borderRadius:3}}><SkinVisual slot="chat.send"><i/></SkinVisual></span><img width="40" height="40" style={{background:k.endsWith('-send')?(mode==='light'?'#B73970':'#F29AC1'):undefined,borderRadius:6}} src={images[k]}/><label>{k.slice(mode.length+1)}</label></div></SkinVisualContext.Provider>)}</div></section>)}</>);`},bundle:true,platform:'browser',outfile:path.join(temp,'preview.js'),alias:{react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}});
fs.writeFileSync(path.join(temp,'index.html'),'<meta charset="utf-8"><style>body{margin:0;font:14px system-ui}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}.cell{height:86px;display:flex;align-items:center;justify-content:center;gap:14px;position:relative;padding-bottom:20px}label{position:absolute;bottom:0;font-size:12px}h2{margin:0 0 12px;font-size:18px}</style><div id="root"></div><script src="preview.js"></script>');
fs.writeFileSync(path.join(temp,'check.cjs'),`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1040,height:1000});await w.loadFile(${JSON.stringify(path.join(temp,'index.html'))});for(let i=0;i<100;i++){if(await w.webContents.executeJavaScript('document.querySelectorAll(".small img").length===44'))break;await new Promise(r=>setTimeout(r,30));}const sizes=await w.webContents.executeJavaScript('[...document.querySelectorAll(".small img")].map(i=>[i.getBoundingClientRect().width,i.getBoundingClientRect().height])');assert.equal(sizes.length,44);sizes.forEach(size=>assert.deepEqual(size,[16,16]));await w.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode()))');w.webContents.setZoomFactor(.7);await new Promise(r=>setTimeout(r,100));fs.writeFileSync(${JSON.stringify(path.join(root,'previews/pink-kitty-icons.png'))},(await w.webContents.capturePage()).toPNG());console.log('PASS: 44 real WebClient SkinVisual instances remain 16x16 inside 11px parents; all artwork fills >80% width.');w.destroy();app.quit();}).catch(e=>{console.error(e);app.exit(1)});`);
console.log(path.join(temp,'check.cjs'));
