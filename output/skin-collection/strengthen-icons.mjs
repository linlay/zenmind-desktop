import fs from 'node:fs';
import path from 'node:path';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {paths} from '../../qa/skin-packages/collection-artwork.mjs';
import {themedGeometry} from '../../qa/skin-packages/themed-artwork.mjs';
const root='output/skin-collection';
const sheet=createCanvas(1120,960),ctx=sheet.getContext('2d');
// Use vector masters: wider strokes and fewer tiny details survive native 22–24 px rendering.
const bow='<path d="M7 3C5 6 12 6 14 10Q15 12 14 14C12 18 5 18 7 21" stroke-width="2.8"/><path d="M7 3 3 12 7 21" stroke-width="1.8"/><path d="M3 12h18" stroke-width="2.3"/><path d="m17 8 5 4-5 4" stroke-width="2.3"/>';
const turtle='<path d="M10 6V4a2 2 0 0 1 4 0v2M7 8 3 6 2 8l4 4m11-4 4-2 1 2-4 4M8 17l-4 3m12-3 4 3M11 20l1 2 1-2"/><ellipse cx="12" cy="13" rx="6" ry="7"/><path d="m12 9-3 3v3l3 3 3-3v-3Z" stroke-width="1.5"/>';
for(const [ki,key] of ['gold-saints','tahiti'].entries())for(const [mi,mode]of ['light','dark'].entries()){
 const source=path.join(root,'sources',key),m=JSON.parse(fs.readFileSync(path.join(source,'skin.json'))),v=m.variants[mode],t=v.tokens,x=mi*560,y=ki*480;
 ctx.fillStyle=t['--bg-base'];ctx.fillRect(x,y,560,480);ctx.fillStyle=t['--ink'];ctx.font='17px sans-serif';ctx.fillText(`${key} ${mode} · before / after 24px`,x+20,y+30);
 const names=Object.keys(paths).filter(n=>n!=='attach');
 for(const [i,name]of names.entries()){
  const filename=path.join(source,`visuals/${mode}-${name}.png`),old=await loadImage(filename);
  let g=themedGeometry(key,name,paths[name]??paths.expand);
  // Drop the scaled ornamental wrapper from generic controls.
  if(g.startsWith('<g transform="translate(2 2)'))g=paths[name]??paths.expand;
  g=g.replace(/stroke-width="([.\d]+)"/g,(_,n)=>`stroke-width="${Math.max(1.5,Number(n)*1.45)}"`);
  if(name==='send')g=key==='gold-saints'?bow:turtle;
  if(key==='tahiti'&&name==='stop')g=turtle.replace('<path d="m12 9-3 3v3l3 3 3-3v-3Z" stroke-width="1.5"/>','<rect x="9" y="10" width="6" height="6" fill="currentColor" stroke="none"/>');
  const color=name==='send'?t['--accent-on']:name==='stop'?(mode==='light'?'#BA3452':'#FF9BAF'):t['--control-icon-color'];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-2 -2 28 28" color="${color}"><g fill="none" stroke="${color}" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">${g}</g></svg>`;
  const c=createCanvas(96,96);c.getContext('2d').drawImage(await loadImage(Buffer.from(svg)),0,0);fs.writeFileSync(filename,c.toBuffer('image/png'));
  const xx=x+20+i%5*108,yy=y+55+Math.floor(i/5)*80;
  if(name==='send'){ctx.fillStyle=t['--accent'];ctx.fillRect(xx-2,yy-2,64,30);}
  ctx.drawImage(old,xx,yy,24,24);ctx.drawImage(c,xx+34,yy,24,24);ctx.fillStyle=t['--ink'];ctx.font='10px sans-serif';ctx.fillText(name,xx,yy+43);
 }
}
fs.writeFileSync(path.join(root,'icons-weight-preview.png'),sheet.toBuffer('image/png'));
