import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizeMarketInstallOptions,readSkillPackageAdoption,clearSkillPackageAdoptionArchive}=require('../dist-electron/main/modules/marketplace/skill-package-adoption.js');
const {installSkillMarketItem,configureSkillMarketPlatformCaller}=require('../dist-electron/main/modules/marketplace/skill-market.js');
const {readInstalledRecords}=require('../dist-electron/main/modules/marketplace/installed-records.js');
const sha='a'.repeat(64),revision='b'.repeat(64);
test('only revision proof crosses IPC and only structured adoption conflicts open confirmation',()=>{
 const proof={archiveSha256:sha,expectedRevisions:{helper:revision}};
 assert.deepEqual(normalizeMarketInstallOptions({skillPackageAdoption:proof,apiBaseUrl:'https://evil.test',catalog:{}}),{skillPackageAdoption:proof});
 assert.throws(()=>normalizeMarketInstallOptions({skillPackageAdoption:{...proof,expectedRevisions:{helper:'bad'}}}));
 assert.equal(readSkillPackageAdoption(new Error('offline')),undefined);
 assert.equal(readSkillPackageAdoption(new Error(JSON.stringify({code:409,data:{error:{code:'conflict',adoption:{}}}}))),undefined);
});
test('confirmation uses original downloaded ZIP and scopes it to identity without a second download',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-adoption-test-'));
 t.after(()=>{configureSkillMarketPlatformCaller(null);clearSkillPackageAdoptionArchive();fs.rmSync(root,{recursive:true,force:true});});
 const app={isPackaged:false,getVersion:()=> '0.4.13',getPath:name=>path.join(root,name)};
 const item={id:'suite',name:'Suite',type:'skill',version:'1.0.0',description:'',tags:[],skill:{kind:'package',includedSkills:[{id:'helper'}]},assets:{}};
 let downloads=0,calls=0,viewer='first';
 const data=Buffer.from('original generatedAt ZIP bytes'),archiveSha256=createHash('sha256').update(data).digest('hex');
 const options={catalog:{schemaVersion:1,items:[item]},apiBaseUrl:'https://market.test/api/v1',issueMarketAccessToken:async()=> 'test-token',readMarketViewer:()=>viewer,fetchImpl:async input=>{
  const url=String(input);
  if(url.includes('/auth/me'))return new Response(JSON.stringify({user:{id:'u'}}));
  if(url.includes('/resolve'))return new Response(JSON.stringify({item:{id:'suite',type:'skill'},version:'1.0.0',platform:'universal'}));
  if(url.includes('/package/download')){downloads++;return new Response(data);}
  throw new Error('unexpected request '+url);
 }};
 configureSkillMarketPlatformCaller(async(url,request)=>{
  calls++; assert.deepEqual(Buffer.from(request.rawBody),data);
  if(calls===1)throw new Error(JSON.stringify({code:409,data:{error:{code:'skill_package_adoption_required',adoption:{archiveSha256,skills:[{id:'helper',revision,changedPaths:['SKILL.md']}]}}}}));
  const approval=JSON.parse(new URL(url,'http://local').searchParams.get('adopt'));
  assert.deepEqual(approval,{archiveSha256,expectedRevisions:{helper:revision}});
  return {id:'suite',version:'1.0.0',skills:[{id:'helper'}],backupPath:'/safe/backup'};
 });
 const pending=await installSkillMarketItem(app,'suite',options);
 assert.equal(pending.ok,false);assert.equal(readInstalledRecords(app).length,0);
 const confirmed={...options,skillPackageAdoption:{archiveSha256,expectedRevisions:{helper:revision}}};
 viewer='second';await assert.rejects(()=>installSkillMarketItem(app,'suite',confirmed));assert.equal(calls,1);
 viewer='first';const done=await installSkillMarketItem(app,'suite',confirmed);
 assert.equal(done.ok,true);assert.equal(done.skillPackageBackupPath,'/safe/backup');assert.equal(downloads,1);assert.equal(calls,2);assert.equal(readInstalledRecords(app).length,1);
});
