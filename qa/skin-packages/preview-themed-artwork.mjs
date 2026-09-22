import fs from 'node:fs';
import path from 'node:path';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {registerCollectionFonts} from './collection-artwork.mjs';
registerCollectionFonts();
const root=path.resolve('output/skin-collection');
const keys=['gold-saints','tahiti','walnut-song'];
const names=['射手座 · 黄金圣斗士','大溪地 · 山海与海龟','宋式 · 榫卯与书卷'];
for(const mode of ['light','dark']){
 const canvas=createCanvas(1440,1080),ctx=canvas.getContext('2d');
 for(let i=0;i<keys.length;i++){
  const key=keys[i],source=path.join(root,'sources',key),v=JSON.parse(fs.readFileSync(path.join(source,'skin.json'))).variants[mode];
  const x=i%2*720,y=Math.floor(i/2)*540;
  ctx.fillStyle=v.tokens['--bg-base'];ctx.fillRect(x,y,720,540);
  ctx.fillStyle=v.tokens['--ink'];ctx.font='bold 24px CollectionSans';ctx.fillText(names[i],x+28,y+38);
  const slots=['navigation.search','navigation.back','navigation.forward','navigation.sidebar_left','navigation.sidebar_right','navigation.refresh','navigation.more_actions','entry.kanban','entry.automation','entry.new_chat','entry.project','entry.chat','entry.website','chat.send','chat.stop','chat.attach','chat.expand','chat.collapse','chat.screenshot','chat.voice','agent.terminal','agent.database','agent.library'];
  for(let j=0;j<slots.length;j++){
   const xx=x+28+j%8*85, yy=y+66+Math.floor(j/8)*100;
   if(slots[j]==='chat.send'){ctx.fillStyle=v.tokens['--control-primary-bg'];ctx.fillRect(xx,yy,52,52);}
   if(v.visuals.images[slots[j]])ctx.drawImage(await loadImage(path.join(source,v.visuals.images[slots[j]])),xx,yy,52,52);
   else {ctx.strokeStyle=v.tokens['--control-icon-color'];ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(xx+26,yy+12);ctx.lineTo(xx+26,yy+40);ctx.moveTo(xx+12,yy+26);ctx.lineTo(xx+40,yy+26);ctx.stroke();}
   ctx.font='11px system-ui';ctx.fillStyle=v.tokens['--ink-soft'];ctx.fillText(slots[j].split('.')[1],xx-4,yy+70);
  }
  for(let j=0;j<4;j++){
   const group=['pinned','chats','projects','websites'][j];
   const img=await loadImage(path.join(source,v.visuals.images[`heading.${group}.zh-CN`]));
   ctx.drawImage(img,x+28+j*170,y+385,img.width*.7,img.height*.7);
   const en=await loadImage(path.join(source,v.visuals.images[`heading.${group}.en-US`]));ctx.drawImage(en,x+28+j*170,y+460,en.width*.4,en.height*.4);
  }
 }
 fs.writeFileSync(path.join(root,`theme-details-${mode}.png`),canvas.toBuffer('image/png'));
}
