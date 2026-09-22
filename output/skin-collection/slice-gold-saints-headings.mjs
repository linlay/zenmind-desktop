import fs from 'node:fs';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const root='output/skin-collection';
async function decode(b){let parts=[b.subarray(0,8)];for(let i=8;i<b.length;){let end=i+b.readUInt32BE(i)+12;if(b.toString('ascii',i+4,i+8)!=='caBX')parts.push(b.subarray(i,end));i=end;}return loadImage(Buffer.concat(parts));}
const preview=createCanvas(1120,560),pc=preview.getContext('2d');
for(const [m,mode] of ['light','dark'].entries()){
 const im=await decode(fs.readFileSync(`${root}/gold-saints-artwork/headings-${mode}.png`));
 pc.fillStyle=mode==='light'?'#FBF4E3':'#292010';pc.fillRect(m*560,0,560,560);
 const rows=[0,350,650,950,1280].map(y=>Math.round(y*im.height/1280));
 for(const [r,group] of ['pinned','chats','projects','websites'].entries())for(const [col,locale] of ['zh-CN','en-US'].entries()){
  const split=Math.round(im.width*600/1280),sx=col?split:0;
  const c=createCanvas(col?im.width-split:split,rows[r+1]-rows[r]),ctx=c.getContext('2d');
  ctx.drawImage(im,sx,rows[r],c.width,c.height,0,0,c.width,c.height);
  const data=ctx.getImageData(0,0,c.width,c.height).data;let minX=c.width,minY=c.height,maxX=0,maxY=0,empty=0;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const a=data[(y*c.width+x)*4+3];if(a===0)empty++;if(a>20){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
  if(empty<c.width*c.height*.15)throw Error('Missing transparent background');
  minX=Math.max(0,minX-5);minY=Math.max(0,minY-3);maxX=Math.min(c.width-1,maxX+5);maxY=Math.min(c.height-1,maxY+3);
  const w=maxX-minX+1,h=maxY-minY+1,scale=Math.min(1,120/h,420/w),out=createCanvas(Math.round(w*scale),Math.round(h*scale));
  out.getContext('2d').drawImage(c,minX,minY,w,h,0,0,out.width,out.height);
  fs.writeFileSync(`${root}/gold-saints-artwork/${mode}-${group}-${locale}.png`,out.toBuffer('image/png'));
  pc.drawImage(out,m*560+30+col*245,r*130+20,out.width*.7,out.height*.7);
  pc.drawImage(out,m*560+30+col*245,r*130+104,out.width*28/out.height,28);
 }
}
fs.writeFileSync(`${root}/gold-saints-headings-preview.png`,preview.toBuffer('image/png'));
