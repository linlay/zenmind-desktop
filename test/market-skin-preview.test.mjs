import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createCanvas} from '@napi-rs/canvas';
const require=createRequire(import.meta.url);
const {readMarketSkinAsset}=require('../dist-electron/main/modules/marketplace/skin-preview.js');
const base='https://market.example.test/api/v1';
const bytes=createCanvas(16,4).toBuffer('image/png');
const input={id:'panda',version:'1.0.0',path:'idle.png'};
test('public previews omit credentials and only use the configured skin resource endpoint',async()=>{
 const calls=[];
 const result=await readMarketSkinAsset({},input,{apiBaseUrl:base,readMarketViewer:()=>null,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(bytes);}});
 assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));assert.equal(calls.length,1);
 assert.equal(calls[0].url,base+'/skins/panda/versions/1.0.0/assets/idle.png');
 assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers,undefined);
});
test('private previews verify auth then load raster with same bearer without exposing token in renderer result',async()=>{
 const calls=[];
 const app={getPath:()=>'/tmp/skin-preview-tests'};
 const result=await readMarketSkinAsset(app,input,{apiBaseUrl:base,readMarketViewer:()=> 'viewer-1',issueMarketAccessToken:()=> 'private-credential',fetchImpl:async(url,init)=>{
  calls.push({url,init});return String(url).endsWith('/auth/me')?Response.json({user:{id:'viewer-1'}}):new Response(bytes);
 }});
 assert.equal(calls.length,2);assert.equal(calls[0].url,base+'/auth/me');
 for(const call of calls)assert.equal(new Headers(call.init.headers).get('Authorization'),'Bearer private-credential');
 assert.equal(JSON.stringify(result).includes('private-credential'),false);
});
test('invalid and escaping paths fail before requesting anything',async()=>{
 let calls=0;
 for(const value of [{...input,path:'../idle.png'},{...input,path:'https://other/idle.png'},{...input,id:'../panda'},{...input,path:'idle.svg'},{...input,path:'%2e%2e/idle.png'},{...input,version:'1/2'}])
  await assert.rejects(readMarketSkinAsset({},value,{apiBaseUrl:base,fetchImpl:async()=>{calls++;return new Response(bytes);}}),/invalid/);
 assert.equal(calls,0);
});
test('identity change discards in-flight image response',async()=>{
 let viewer='first';
 await assert.rejects(readMarketSkinAsset({},input,{apiBaseUrl:base,readMarketViewer:()=>viewer,issueMarketAccessToken:()=> 'credential',fetchImpl:async url=>{
  if(String(url).endsWith('/auth/me'))return Response.json({user:{id:'first'}});
  viewer='second';return new Response(bytes);
 }}),/identity changed/);
});
test('script data and oversized declared resources are rejected',async()=>{
 for(const response of [new Response('<svg><script>bad()</script></svg>'),new Response(bytes,{headers:{'Content-Length':String(17*1024*1024)}})])
  await assert.rejects(readMarketSkinAsset({},input,{apiBaseUrl:base,readMarketViewer:()=>null,fetchImpl:async()=>response}));
});
