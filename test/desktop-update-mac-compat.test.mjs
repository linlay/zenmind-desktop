import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { loadPlatformUpdateTrust } from '../scripts/lib/update-release.mjs';
const require=createRequire(import.meta.url);
const {createUpdateRuntime}=require('../dist-electron/main/modules/updates/runtime.js');
const {fetchUpdateManifest}=require('../dist-electron/main/modules/updates/download.js');
const {parseUpdateManifest}=require('../dist-electron/main/modules/updates/manifest.js');
const bytes=Buffer.from('signed app zip fixture');
const legacy={schemaVersion:1,productId:'other-brand',version:'0.5.0',publishedAt:'2025-01-01T00:00:00Z',releaseNotes:{},artifacts:{'darwin-arm64':{url:'https://example.com/app.zip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}};
test('Mac builds ignore Windows Ed25519 environment; Windows targets still validate it on any host',()=>{
 const env={DESKTOP_UPDATE_TRUST_FILE:'missing-update-trust.json'};
 assert.deepEqual(loadPlatformUpdateTrust(process.cwd(),'other-brand','darwin',env),{channel:'production',keys:[]});
 assert.throws(()=>loadPlatformUpdateTrust(process.cwd(),'other-brand','win32',env));
});
function setup(t, overrides={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-update-compat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[];
 const runtime=createUpdateRuntime({platform:'darwin',arch:'arm64',productId:'other-brand',currentVersion:'0.4.10',packaged:true,trust:{channel:'production',keys:[]},cacheRoot:path.join(root,'cache'),preferencesPath:path.join(root,'preferences.json'),securityStateRoot:path.join(root,'security'),readConfig:()=>({enabled:true,feedUrl:'https://example.com/latest.json'}),emit(){},fetchManifest:async()=>({manifest:JSON.stringify(legacy),signature:''}),downloadFile:async(_a,file)=>fs.promises.writeFile(file,bytes),verifyPublisher:async()=>{calls.push('Apple host check')},prepareInstall:async()=>true,install:async()=>{calls.push('native install')},...overrides});
 t.after(()=>runtime.dispose());return {root,runtime,calls};
}
test('macOS accepts existing v1 feed without Ed25519 keys and retains native checks',async t=>{
 const {root,runtime,calls}=setup(t);
 assert.equal((await runtime.check()).phase,'available');
 assert.equal((await runtime.download()).phase,'ready');
 await runtime.install();
 assert.deepEqual(calls,['Apple host check','Apple host check','native install']);
 assert.equal(fs.existsSync(path.join(root,'security')),false);
});
test('macOS native signature rejection still prevents installation',async t=>{
 const {runtime,calls}=setup(t,{verifyPublisher:async()=>{throw new Error('invalid Apple signature')}});
 await runtime.check();assert.equal((await runtime.download()).phase,'error');await runtime.install();assert.equal(calls.length,0);
});
test('macOS original feed does not request a detached signature',async t=>{
 const requests=[];const original=https.get;t.after(()=>{https.get=original});
 https.get=(url,_options,cb)=>{requests.push(url);const req=new EventEmitter();req.setTimeout=()=>{};process.nextTick(()=>{const response=Readable.from([JSON.stringify(legacy)]);response.statusCode=200;response.headers={};cb(response)});return req};
 const result=await fetchUpdateManifest('https://example.com/latest.json',new AbortController().signal,'darwin');
 assert.equal(result.signature,'');assert.equal(requests.length,1);
 assert.equal(parseUpdateManifest(JSON.parse(result.manifest),'other-brand','darwin').schemaVersion,1);
 assert.throws(()=>parseUpdateManifest(legacy,'other-brand','win32'));
});
test('macOS debug accepts original manifest but still uses native signature verification',async t=>{
 const {runtime,calls}=setup(t);await runtime.loadTest({manifest:JSON.stringify(legacy),signature:''});await runtime.download();await runtime.install();assert.equal(calls.at(-1),'native install');
});
test('existing macOS manifest CLI still writes v1 JSON without any signing environment',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-manifest-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const artifact=path.join(root,'app.zip');fs.writeFileSync(artifact,bytes);
 const input=path.join(root,'input.json');fs.writeFileSync(input,JSON.stringify({...legacy,artifacts:{'darwin-arm64':{file:artifact,url:'https://example.com/app.zip'}}}));
 const output=path.join(root,'latest.json');const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DESKTOP_UPDATE_'))delete env[key];
 const result=spawnSync(process.execPath,['scripts/create-update-manifest.mjs',input,output],{env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).schemaVersion,1);assert.equal(fs.existsSync(output+'.sig'),false);
});
