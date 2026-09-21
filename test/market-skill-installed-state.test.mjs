import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listSkillMarketItems, configureSkillMarketPlatformCaller } = require('../dist-electron/main/modules/marketplace/skill-market.js');
const { writeInstalledRecords, readInstalledRecords } = require('../dist-electron/main/modules/marketplace/common.js');
const { getSkillInstallDir } = require('../dist-electron/main/modules/marketplace/skill-installer.js');
function setup(t, kind='single') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-installed-state-'));
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});configureSkillMarketPlatformCaller(null)});
 const app={isPackaged:false,getVersion:()=> '0.4.6',getPath:name=>path.join(root,name)};
 const item={id:'test-skill',type:'skill',name:'Test',version:'2.0.0',description:'',tags:[],...(kind==='package'?{skill:{kind:'package'}}:{}),assets:{universal:{url:'https://example.test/test.zip',archiveType:'zip'}}};
 writeInstalledRecords(app,[{id:item.id,type:'skill',version:'1.0.0',source:'cloud',...(kind==='package'?{skillPackage:true}:{}),installedAt:new Date().toISOString()}]);
 const options={catalog:{schemaVersion:1,items:[item]}};
 return {app,options,dir:getSkillInstallDir(app,item.id),read:async()=> (await listSkillMarketItems(app,options)).items.find(x=>x.id===item.id)};
}
test('deleting in Skill Center overrides stale market records and keeps provenance',async t=>{
 const s=setup(t);fs.mkdirSync(s.dir,{recursive:true});fs.writeFileSync(path.join(s.dir,'SKILL.md'),'# Test');fs.writeFileSync(path.join(s.dir,'skill.json'),JSON.stringify({id:'test-skill',name:'Test',version:'2.0.0'}));
 assert.equal((await s.read()).state,'installed');assert.equal((await s.read()).installedVersion,'2.0.0');
 fs.rmSync(s.dir,{recursive:true}); // Same physical outcome as a completed Platform deletion.
 for(let i=0;i<2;i++) {const item=await s.read();assert.equal(item.state,'not-installed');assert.equal(item.installedVersion,undefined);assert.equal(item.installPath,undefined);}
 assert.equal(readInstalledRecords(s.app).length,1);
});
test('package deletion is decided by a successful Platform snapshot, not an unavailable service',async t=>{
 const s=setup(t,'package');configureSkillMarketPlatformCaller(async()=>[{id:'test-skill',version:'2.0.0',skills:[]}]);assert.equal((await s.read()).state,'installed');
 configureSkillMarketPlatformCaller(async()=>{throw new Error('offline')});assert.equal((await s.read()).state,'update-available');
 configureSkillMarketPlatformCaller(async()=>[]);assert.equal((await s.read()).state,'not-installed');
});
test('package child removed from Platform snapshot is no longer installed',async t=>{
 const s=setup(t);configureSkillMarketPlatformCaller(async()=>[{id:'bundle',version:'1.0.0',skills:[{id:'test-skill',version:'1.0.0'}]}]);
 assert.equal((await s.read()).state,'update-available');
 configureSkillMarketPlatformCaller(async()=>[{id:'bundle',version:'1.0.0',skills:[]}]);
 assert.equal((await s.read()).state,'not-installed');
});

test('Platform builtin skills are excluded without deleting their files or hiding ordinary local skills', async t=>{
 const s=setup(t);
 for(const id of ['builtin-dbx','builtin-httpx','builtin-personal-helper','my-local-skill']) {
  const dir=getSkillInstallDir(s.app,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),'# '+id);
 }
 const items=(await listSkillMarketItems(s.app,s.options)).items;
 assert.ok(!items.some(x=>['builtin-dbx','builtin-httpx'].includes(x.id)));
 assert.ok(items.some(x=>x.id==='my-local-skill'));
 assert.ok(items.some(x=>x.id==='builtin-personal-helper'));
 for(const id of ['builtin-dbx','builtin-httpx']) assert.ok(fs.existsSync(path.join(getSkillInstallDir(s.app,id),'SKILL.md')));
});
