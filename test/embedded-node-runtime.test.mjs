import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {prepareEmbeddedNodeRuntime,embeddedNodeLaunchers}=require('../dist-electron/main/modules/services/manager/embedded-node-runtime.js');

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"desktop-node space's-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const resources=path.join(root,'resources');const npm=path.join(resources,'npm');fs.mkdirSync(path.join(npm,'bin'),{recursive:true});
 fs.writeFileSync(path.join(npm,'package.json'),JSON.stringify({name:'npm',version:'10.9.4'}));
 const cli='console.log(JSON.stringify({node:process.versions.node,arch:process.arch,mode:process.env.ELECTRON_RUN_AS_NODE,args:process.argv.slice(2),cwd:process.cwd()}))';
 for(const name of ['npm-cli.js','npx-cli.js'])fs.writeFileSync(path.join(npm,'bin',name),cli);
 return {root,options:{stateRoot:path.join(root,'state'),binDir:path.join(root,'.desktop','bin'),resourcesRoot:resources,executable:process.execPath,nodeVersion:process.versions.node,platform:process.platform,arch:process.arch}};
}

test('POSIX launchers bypass a conflicting nvm Node and preserve arguments and cwd',{skip:process.platform==='win32'},t=>{
 const {root,options}=fixture(t);const badBin=path.join(root,'nvm16/bin');fs.mkdirSync(badBin,{recursive:true});
 fs.writeFileSync(path.join(badBin,'node'),'#!/bin/sh\necho WRONG_NODE_16 >&2\nexit 91\n',{mode:0o755});
 const runtime=prepareEmbeddedNodeRuntime(options);const env={...process.env,PATH:[runtime.binDir,badBin,'/usr/bin','/bin'].join(':')};delete env.ELECTRON_RUN_AS_NODE;
 const args=['argument with spaces',"quote's",'$() `literal`','中文'];
 const result=spawnSync(path.join(runtime.binDir,'npm'),args,{env,cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);
 assert.equal(data.node,process.versions.node);assert.equal(data.arch,process.arch);assert.equal(data.mode,'1');assert.deepEqual(data.args,args);assert.equal(fs.realpathSync(data.cwd),fs.realpathSync(root));
 assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);
 const script=path.join(root,'cli.js');fs.writeFileSync(script,'#!/usr/bin/env node\nconsole.log(process.versions.node)\n',{mode:0o755});
 assert.equal(spawnSync(script,[],{env,encoding:'utf8'}).stdout.trim(),process.versions.node);
 assert.equal(spawnSync(runtime.node,['-e','process.exit(17)'],{env}).status,17);
 const piped=spawnSync(runtime.node,['-e',"process.stdin.pipe(process.stdout);process.stderr.write('err')"],{env,input:'stdin中文',encoding:'utf8'});
 assert.equal(piped.stdout,'stdin中文');assert.equal(piped.stderr,'err');
});

test('stable bin is reused and updated while retired runtime files remain available',t=>{
 const {root,options}=fixture(t);if(process.platform==='win32'){fs.mkdirSync(path.join(options.resourcesRoot,'amd64'),{recursive:true});fs.writeFileSync(path.join(options.resourcesRoot,'amd64/node.exe'),'test executable');options.arch='x64';options.probe=()=>({node:options.nodeVersion,arch:'x64'});}
 const first=prepareEmbeddedNodeRuntime(options),second=prepareEmbeddedNodeRuntime(options);assert.equal(first.binDir,second.binDir);
 fs.writeFileSync(path.join(options.resourcesRoot,'npm/package.json'),JSON.stringify({name:'npm',version:'10.9.5'}));
 const changed=prepareEmbeddedNodeRuntime(options);assert.equal(first.binDir,changed.binDir);
 assert.equal(changed.binDir,options.binDir);
 assert.equal(JSON.parse(fs.readFileSync(path.join(changed.binDir,'node_modules/npm/package.json'))).version,'10.9.5');
 const retired=fs.readdirSync(options.stateRoot).filter(name=>name.startsWith('.node-retired-'));
 assert.equal(retired.length,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(options.stateRoot,retired[0],'bin/node_modules/npm/package.json'))).version,'10.9.4');
 assert.ok(fs.existsSync(path.join(first.binDir,'node_modules/npm/bin/npm-cli.js')));
});

test('Windows uses a native node.exe and standard npm layout without setting a global Electron mode',t=>{
 const {options}=fixture(t);fs.mkdirSync(path.join(options.resourcesRoot,'amd64'),{recursive:true});fs.writeFileSync(path.join(options.resourcesRoot,'amd64/node.exe'),'PE-fixture');
 const runtime=prepareEmbeddedNodeRuntime({...options,platform:'win32',arch:'x64',probe:executable=>{assert.equal(path.basename(executable),'node.exe');return {node:options.nodeVersion,arch:'x64'};}});
 assert.equal(path.basename(runtime.node),'node.exe');assert.equal(fs.readFileSync(runtime.node,'utf8'),'PE-fixture');
 assert.equal(fs.existsSync(path.join(runtime.binDir,'node.cmd')),false);
 const config=JSON.parse(fs.readFileSync(path.join(runtime.binDir,'.desktop-node-runtime.json'),'utf8'));assert.equal(config.electronPath,process.execPath);
 const npm=fs.readFileSync(path.join(runtime.binDir,'npm.cmd'),'utf8');assert.match(npm,/%~dp0node\.exe/);assert.match(npm,/node_modules\\npm\\bin\\npm-cli\.js/);assert.doesNotMatch(npm,/ELECTRON_RUN_AS_NODE|\bcall\b/i);
 const npx=embeddedNodeLaunchers('win32','C:\\Program Files\\CuteJ\\CuteJ.exe','C:\\data\\bin')['npx.cmd'];assert.match(npx,/npx-cli\.js/);
});

test('missing bundled npm fails before a partial runtime is published',t=>{
 const {options}=fixture(t);fs.rmSync(path.join(options.resourcesRoot,'npm/bin/npm-cli.js'));
 assert.throws(()=>prepareEmbeddedNodeRuntime(options));assert.equal(fs.existsSync(options.stateRoot),false);
});

test('an executable that fails to enter the expected Node mode is never published',t=>{
 const {options}=fixture(t);
 assert.throws(()=>prepareEmbeddedNodeRuntime({...options,probe:()=>({node:'16.0.0',arch:options.arch})}),/mismatch/);
 assert.deepEqual(fs.readdirSync(options.stateRoot),[]);
});

test('branded macOS dev shells use build resources even when Electron reports packaged',()=>{
 const {embeddedNodeResourcesRoot}=require('../dist-electron/main/modules/services/manager/embedded-node-runtime.js');
 const {APP_ID,BRAND_ID}=require('../dist-electron/shared/brand.js');
 const root=path.resolve('/fixture/desktop-project');const resources=path.join(root,'build','brands',BRAND_ID,'resources');
 const app={isPackaged:true,getAppPath:()=>root};
 const context={platform:'darwin',argv:['CuteJ',root],execPath:path.join(root,'build','brands',BRAND_ID,'dev','App.app/Contents/MacOS/App'),env:{__CFBundleIdentifier:`${APP_ID}.dev`,VITE_DEV_SERVER_URL:'http://127.0.0.1:5173',DESKTOP_DEV_RESOURCES_ROOT:resources}};
 assert.equal(embeddedNodeResourcesRoot(app,context,'/packaged/resources'),path.join(root,'build/resources/node-runtime'));
 assert.equal(embeddedNodeResourcesRoot(app,{...context,platform:'win32'},'/packaged/resources'),'/packaged/resources/node-runtime');
 assert.equal(embeddedNodeResourcesRoot({...app,isPackaged:false},{platform:'win32'},'/packaged/resources'),path.join(root,'build/resources/node-runtime'));
});

test('failed runtime update leaves the published bin usable', {skip:process.platform==='win32'}, t=>{
 const {options}=fixture(t);const first=prepareEmbeddedNodeRuntime(options);
 const before=fs.readFileSync(path.join(first.binDir,'runtime.json'),'utf8');
 fs.writeFileSync(path.join(options.resourcesRoot,'npm/package.json'),JSON.stringify({name:'npm',version:'10.9.5'}));
 assert.throws(()=>prepareEmbeddedNodeRuntime({...options,probe:()=>({node:'16.0.0',arch:options.arch})}),/mismatch/);
 assert.equal(fs.readFileSync(path.join(first.binDir,'runtime.json'),'utf8'),before);
 assert.equal(spawnSync(first.node,['--version'],{encoding:'utf8'}).stdout.trim(),'v'+options.nodeVersion);
});

test('failed publication restores the previous bin', {skip:process.platform==='win32'}, t=>{
 const {options}=fixture(t);prepareEmbeddedNodeRuntime(options);
 const before=fs.readFileSync(path.join(options.binDir,'runtime.json'),'utf8');
 fs.writeFileSync(path.join(options.resourcesRoot,'npm/package.json'),JSON.stringify({name:'npm',version:'10.9.5'}));
 const rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(String(from).includes('.node-stage-') && to===options.binDir) throw new Error('publication failed');
  return rename(from,to);
 });
 assert.throws(()=>prepareEmbeddedNodeRuntime(options),/publication failed/);
 assert.equal(fs.readFileSync(path.join(options.binDir,'runtime.json'),'utf8'),before);
});

test('Windows locked executable fails without replacing the existing runtime',t=>{
 const {options}=fixture(t);fs.mkdirSync(path.join(options.resourcesRoot,'amd64'),{recursive:true});fs.writeFileSync(path.join(options.resourcesRoot,'amd64/node.exe'),'PE-fixture');
 const win={...options,platform:'win32',arch:'x64',probe:()=>({node:options.nodeVersion,arch:'x64'})};
 prepareEmbeddedNodeRuntime(win);
 const before=fs.readFileSync(path.join(options.binDir,'runtime.json'),'utf8');
 fs.writeFileSync(path.join(options.resourcesRoot,'npm/package.json'),JSON.stringify({name:'npm',version:'10.9.5'}));
 const rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(from===options.binDir) throw Object.assign(new Error('locked'),{code:'EPERM'});
  return rename(from,to);
 });
 assert.throws(()=>prepareEmbeddedNodeRuntime(win),/runtime is in use/);
 assert.equal(fs.readFileSync(path.join(options.binDir,'runtime.json'),'utf8'),before);
});
