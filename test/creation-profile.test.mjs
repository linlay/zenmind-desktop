import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {parseCreationProfile, applyCreationProfile, selectedCreationDefinition} = require("../dist-electron/shared/creation-profile.js");
const {readCreationProfileUpgradeInput, applyCreationProfileUpgradeInput} = require("../dist-electron/main/infrastructure/filesystem/runtime-environment-creation.js");
const {resolveRuntimeRoot} = require("../dist-electron/main/infrastructure/filesystem/runtime-env-paths.js");
const JSZip = require("jszip");
const profile = {version:1, types:{coder:{defaultGroups:["code","missing"]}}, groups:[
 {key:"code",name:{"zh-CN":"编程","en-US":"Programming"},tools:["bash"],skills:["docs"],connectors:["db"]},
 {key:"extra",name:"Extra",tools:["bash"],skills:["docs"],connectors:["db"]},
 {key:"missing",name:"Missing",skills:["ghost"]},
]};
const runtime = {types:[{key:"coder",engine:"native",baseTools:["file_read","bash"]},{key:"acp",engine:"acp",baseTools:[]}],models:[]};
const catalog = {skills:[{id:"docs"}],connectors:[{id:"db"}],tools:[{name:"bash"}]};
test("profile expansion preserves base tools, deduplicates members and rejects stale selections", () => {
 const options = applyCreationProfile(runtime,parseCreationProfile(profile),catalog,"zh-CN");
 assert.deepEqual(options.types[0].defaultGroups,["code"]);
 assert.equal(options.groups[0].name,"编程");
 assert.equal(options.groups[2].available,false);
 assert.deepEqual(selectedCreationDefinition(options,"coder",["code","extra","code"]),{
  toolConfig:{tools:["file_read","bash"]},skillConfig:{skills:["docs"]},connectorConfig:{connectors:["db"]}
 });
 assert.throws(()=>selectedCreationDefinition(options,"coder",["missing"]),/Unavailable/);
 assert.deepEqual(selectedCreationDefinition(options,"acp",["code"]),{});
});
test("invalid brand keys and defaults are rejected", () => {
 assert.throws(()=>parseCreationProfile({...profile,version:2}));
 assert.throws(()=>parseCreationProfile({...profile,groups:[profile.groups[0],profile.groups[0]]}));
 assert.throws(()=>parseCreationProfile({...profile,types:{coder:{defaultGroups:["unknown"]}}}));
});

test("environment ZIP validates profile before installation", async () => {
 const zip = new JSZip();
 assert.equal(await readCreationProfileUpgradeInput(zip),undefined);
 zip.file("env/agent-creation.json",JSON.stringify(profile));
 assert.deepEqual(JSON.parse(await readCreationProfileUpgradeInput(zip)),profile);
 zip.file("env/agent-creation.json",'{"version":2}');
 await assert.rejects(readCreationProfileUpgradeInput(zip));
});
for (const platform of ["darwin","win32"]) test(`profile upgrade replaces, backs up once and removes on ${platform}`, () => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"creation-profile-"));
 try {
  const app={getPath:()=>home};
  const root=resolveRuntimeRoot(app,platform);
  const target=path.join(root,"agent-creation.json");
  const backup=path.join(home,"backup");
  fs.mkdirSync(root,{recursive:true});fs.writeFileSync(target,JSON.stringify(profile));
  const next={version:1,types:{},groups:[]};
  applyCreationProfileUpgradeInput(app,JSON.stringify(next),backup,platform);
  assert.deepEqual(JSON.parse(fs.readFileSync(target,"utf8")),next);
  applyCreationProfileUpgradeInput(app,JSON.stringify(next),backup,platform);
  assert.deepEqual(JSON.parse(JSON.parse(fs.readFileSync(path.join(backup,"agent-creation.backup.json"),"utf8")).content),profile);
  applyCreationProfileUpgradeInput(app,undefined,backup,platform);
  assert.equal(fs.existsSync(target),false);
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
