import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({entryPoints:[new URL("../src/renderer/services/serviceWebviewBridgeHost.ts",import.meta.url).pathname],bundle:true,write:false,platform:"node",format:"cjs"});
const module={exports:{}};
new Function("module","exports",compiled.outputFiles[0].text)(module,module.exports);
const {handleServiceWebviewBridgeMessage}=module.exports;
test("only the WebClient surface receives host creation options",async()=>{
 const options={types:[],groups:[{key:"company-office"}],models:[]};
 let calls=0;
 global.window={electronAPI:{assistant:{getProjectCreationOptions:async()=>{calls++;return {ok:true,message:"",options};}}}};
 const replies=[];
 const context={serviceId:"other-site",sendBridgeMessageToWebview:r=>replies.push(r),setBridgeError:()=>{}};
 const request={type:"desktop:agent-webclient:creation:options",requestId:"r1"};
 try {
  assert.equal(handleServiceWebviewBridgeMessage(request,context),true);
  assert.equal(calls,0);assert.equal(replies[0].ok,false);
  handleServiceWebviewBridgeMessage(request,{...context,serviceId:"agent-webclient"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.deepEqual(replies[1].options,options);
  assert.equal(replies[1].type,"desktop:agent-webclient:creation:options:response");
 } finally {delete global.window;}
});
