import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket, { WebSocketServer } from "ws";
const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/support/manifest/manifest-utils.js");
const { startAgentWebclientHost, stopAgentWebclientHost } = require("../dist-electron/main/modules/services/agent-webclient-host.js");
const { createBrowserWebclientHost } = require("../dist-electron/main/modules/services/browser-webclient-host.js");
const { hosts } = require("../dist-electron/main/modules/services/webclient-host-runtime.js");
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));

test("both hosts route dictation independently, preserve identity, and reject URL credentials", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-host-"));
  fs.mkdirSync(path.join(root,"frontend/dist"),{recursive:true}); fs.writeFileSync(path.join(root,"frontend/dist/index.html"),"fixture");
  const seen = [], sockets = new Set();
  const dictation = http.createServer((req,res) => { seen.push({ url:req.url,headers:req.headers });res.setHeader("Content-Type","application/json");res.end('{"code":0,"data":{"enabled":true}}'); });
  const wss = new WebSocketServer({server:dictation});
  wss.on("connection",(socket,req) => { sockets.add(socket); socket.on("close",()=>sockets.delete(socket));seen.push({url:req.url,headers:req.headers}); });
  let browser;
  t.after(async () => {
    if (browser) await browser.stop();
    await stopAgentWebclientHost();
    for (const socket of sockets) socket.terminate();
    wss.close();
    if (dictation.listening) await close(dictation);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = await listen(dictation);
  // A stopped Platform must not affect either dictation route.
  const platform = http.createServer(); const platformPort = await listen(platform); await close(platform);
  const token = `header.${Buffer.from(JSON.stringify({iss:"fixture",sub:"user",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url")}.signature`;
  const service = normalizeManifest({id:"agent-webclient",version:"2",lifecycle:{start:"start.sh",stop:"stop.sh"},frontend:{mode:"standalone",hostManaged:true,dist:"frontend/dist"}},{defaultKind:"builtin"});
  const probe = http.createServer();const hostPort = await listen(probe);await close(probe);
  const host = await startAgentWebclientHost({service,layout:{programDir:root,envPath:path.join(root,".env")},env:new Map([["BASE_URL",`http://127.0.0.1:${platformPort}`],["DICTATION_BASE_URL",`http://127.0.0.1:${port}`],["DICTATION_ENABLED","true"]]),port:hostPort,logger:{log(){},warn(){},error(){}},issueAccessToken:async()=>({ok:true,token})});
  browser = await createBrowserWebclientHost(hosts.get("agent-webclient"),0);
  const launch = new URL(await browser.launchUrl());
  const login = await fetch(`${browser.url}/__desktop/session`,{method:"POST",headers:{Origin:browser.url},body:launch.hash.slice(1)});
  assert.equal(login.status,204);const cookie=login.headers.get("set-cookie").split(";")[0];
  for (const [origin,headers] of [[new URL(host.webUrl).origin,{}],[browser.url,{Cookie:cookie}]]) {
    const config=await (await fetch(`${origin}/runtime-config.js`,{headers})).text();
    assert.match(config,/"DICTATION_ENABLED":"true"/);assert.doesNotMatch(config,/DICTATION_BASE_URL|signature/);
    assert.equal((await fetch(`${origin}/api/dictation/capabilities`,{headers})).status,200);
    assert.equal(seen.at(-1).headers.authorization,`Bearer ${token}`);
    assert.equal((await fetch(`${origin}/api/dictation/capabilities?token=bad`,{headers})).status,403);
    assert.equal((await fetch(`${origin}/api/dictation/capabilities`,{headers:{...headers,Origin:"https://evil.test"}})).status,403);
    const socket = new WebSocket(`${origin.replace("http:","ws:")}/api/dictation/ws`,{headers:{...headers,Origin:origin}});
    await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
    assert.equal(seen.at(-1).url,"/api/dictation/ws");
    assert.ok(seen.at(-1).headers.authorization===`Bearer ${token}` || seen.at(-1).headers["sec-websocket-protocol"]===`bearer.${token}`);
    assert.equal(socket.protocol,"");socket.terminate();
    for(const [route,source] of [["/api/dictation/ws?token=bad",origin],["/api/dictation/ws","https://evil.test"]]) {
      const before = seen.length;
      const status = await new Promise((resolve,reject) => {
        const req=http.request(`${origin}${route}`,{headers:{...headers,Origin:source,Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==","Sec-WebSocket-Version":"13"}});
        req.on("response",res=>{res.resume();resolve(res.statusCode);});
        req.on("upgrade",(_res,socket)=>{socket.destroy();resolve(101);}); req.on("error",error=>error.code==="ECONNRESET"?resolve(0):reject(error)); req.end();
      });
      assert.notEqual(status,101);assert.equal(seen.length,before);
    }
  }
  hosts.get("agent-webclient").env.delete("DICTATION_BASE_URL");
  for (const [origin, headers] of [[new URL(host.webUrl).origin, {}], [browser.url, { Cookie: cookie }]]) {
    assert.equal((await fetch(`${origin}/api/dictation/capabilities`, { headers })).status, 503);
    assert.equal((await fetch(`${origin}/runtime-config.js`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/`, { headers })).status, 200);
  }
});
