import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {desktopPlatformSubject} = require('../dist-electron/main/modules/identity/platform-subject.js');
const {issueAgentAccessToken} = require('../dist-electron/main/modules/identity/agent-auth.js');
const token = (iss, sub, extra = {}) => `header.${Buffer.from(JSON.stringify({iss,sub,exp:Math.floor(Date.now()/1000)+3600,...extra})).toString('base64url')}.signature`;

test('verified canonical issuer and subject define the private connector owner', () => {
 const alice = desktopPlatformSubject(true, token('https://identity.example','alice'));
 assert.match(alice,/^desktop-user:[0-9a-f]{64}$/);
 assert.equal(alice,desktopPlatformSubject(true,token('https://identity.example','alice',{nonce:'refreshed'})));
 assert.notEqual(alice,desktopPlatformSubject(true,token('https://other.example','alice')));
 assert.notEqual(alice,desktopPlatformSubject(true,token('https://identity.example','bob')));
 assert.equal(desktopPlatformSubject(false,token('https://identity.example','alice')),'');
 assert.throws(()=>desktopPlatformSubject(true,'opaque'));
 assert.throws(()=>desktopPlatformSubject(true,token('','alice')));
});

test('tokens and concurrent capability requests are isolated by verified user subject', async () => {
 const app={getPath:name=>`/fixture/subject-cache/${name}`};
 const alice=desktopPlatformSubject(true,token('https://identity.example','alice'));
 const bob=desktopPlatformSubject(true,token('https://identity.example','bob'));
 const calls=[];
 const issue=async (_app,id,options)=>{calls.push(options.authSubject);await new Promise(r=>setImmediate(r));return {token:token('local',options.authSubject)};};
 const [a,b]=await Promise.all([issueAgentAccessToken(app,'missing',issue,alice),issueAgentAccessToken(app,'missing',issue,bob)]);
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.notEqual(a.token,b.token);
 assert.deepEqual(calls.sort(),[alice,bob].sort());
 assert.equal((await issueAgentAccessToken(app,'missing',issue,alice)).token,a.token);
 assert.equal(calls.length,2);
});

test('an issuer ignoring the scoped subject cannot return the old app identity', async () => {
 const app={getPath:name=>`/fixture/wrong-scope/${name}`};
 const subject=desktopPlatformSubject(true,token('https://identity.example','alice'));
 const result=await issueAgentAccessToken(app,'missing',async()=>({token:token('local','app')}),subject);
 assert.equal(result.ok,false);assert.equal(result.token,'');
 await assert.rejects(issueAgentAccessToken(app,'missing',async()=>({}),'alice'),/Invalid Desktop identity/);
});
