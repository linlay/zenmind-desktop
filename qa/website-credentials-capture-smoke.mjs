// Verifies login recognition against real pages in a real Chromium: the observer script runs in
// an isolated world of pages served for https://login.test, and the capture controller decides
// whether to offer saving. Run after `npm run build:main:prepared`:
//   node qa/website-credentials-capture-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'website-credentials-capture-'));
const modulePath = name => JSON.stringify(path.join(repo, 'dist-electron/main/modules/credentials', name));

fs.writeFileSync(path.join(temp, 'main.cjs'), `
const {app,BrowserWindow,protocol,session}=require('electron');const path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile')); app.on('window-all-closed',()=>{});
const {createWebsiteCredentialStore}=require(${modulePath('store.js')});
const {createLoginCapture}=require(${modulePath('capture/controller.js')});
const {createAgentCredentialAccess}=require(${modulePath('fill/agent-access.js')});
const queue=require(${modulePath('../web-surfaces/cdp/command-queue.js')});
const page=body=>new Response('<!doctype html><meta charset="utf-8"><body>'+body,{headers:{'content-type':'text/html'}});
const pages={
  // Classic form: a full-page POST that lands on a page without a password field.
  '/classic':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password"><button>Sign in</button></form>',
  '/home':'<h1>Welcome</h1>',
  // Rejected login: the server answers with the same form again.
  '/rejected':'<form method="post" action="/rejected"><input name="user"><input name="pw" type="password"><button>Sign in</button></form>',
  // Single-page app: no <form>, a script swaps the view after "signing in".
  '/spa':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><div role="button" id="go">Log in</div></div><script>go.onclick=()=>{setTimeout(()=>{view.innerHTML="<h1>Dashboard</h1>"},50)}</script>',
  // Two-step: identifier first, password on the next page.
  '/step1':'<form action="/step2"><input name="identifier" type="email"><button>Next</button></form>',
  '/step2':'<form method="post" action="/home"><input name="pw" type="password"><button>Sign in</button></form>',
  // Sign-up: the new password is typed twice; a hidden decoy password field must be ignored.
  '/signup':'<form method="post" action="/home"><input name="email" type="email"><input name="pw1" type="password"><input name="pw2" type="password"><input name="trap" type="password" style="display:none" value="decoy"><button>Create</button></form>',
  // A "show password" eye button switches the field to plain text without submitting anything.
  '/reveal':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password"><button type="button" id="eye">Show</button><button id="submit">Sign in</button></form><script>eye.onclick=()=>{const pw=document.querySelector("[name=pw]");pw.type=pw.type==="password"?"text":"password"}</script>',
  // A framework-style page: it only trusts values it received through input events.
  '/controlled':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><script>const state={u:"",p:""};account.addEventListener("input",e=>state.u=e.target.value);secret.addEventListener("input",e=>state.p=e.target.value);go.onclick=()=>{view.innerHTML="<h1 id=who>"+state.u+"/"+state.p.length+"</h1>"}</script>',
  // After "logging in" the page hides the password field, or turns it into plain text, but keeps the element and its value.
  '/hide':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><h1 id="done" hidden>Welcome</h1><script>window.keep=secret;go.onclick=()=>{setTimeout(()=>{secret.style.display="none";account.style.display="none";go.style.display="none";done.hidden=false},50)}</script>',
  '/totext':'<div id="view"><input id="account" autocomplete="username"><input id="secret" type="password"><button id="go">Log in</button></div><script>window.keep=secret;go.onclick=()=>{setTimeout(()=>{secret.type="text"},50)}</script>',
  // Sign-up and reset with a single password field: never filled.
  '/signup-single':'<form method="post" action="/home"><input name="email" type="email"><input name="pw" type="password" autocomplete="new-password"><button>Create account</button></form>',
  '/reset':'<form method="post" action="/reset-password"><input name="email" type="email"><input name="pw" type="password"><button>Reset password</button></form>',
  // Not a login: a search box must never produce anything.
  '/search':'<form action="/home"><input name="q" type="text"><button>Search</button></form>',
};
const timer=setTimeout(()=>{console.error('Capture smoke timed out');app.exit(1)},130000);
(async()=>{await app.whenReady();
const posts=[];
session.defaultSession.protocol.handle('https',request=>{const {pathname}=new URL(request.url);if(request.method==='POST')request.text().then(body=>posts.push(body),()=>{});return pages[pathname]?page(pages[pathname]):new Response('missing',{status:404})});
const store=createWebsiteCredentialStore({vaultDirectory:path.join(__dirname,'vault'),policyFile:path.join(__dirname,'policy.json'),hardenDirectory(){},
  protector:{available:()=>true,protect:key=>Buffer.from(key),unprotect:blob=>Buffer.from(blob)}});
store.setCaptureEnabled(true);
const shown=[];const capture=createLoginCapture({store,presentOffer:offer=>{shown.push(offer);return true},withdrawOffer(){}});
const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
capture.attach(win.webContents);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
// Types like a user: the page's own main world sets the values, then a real click is dispatched.
const fill=(selector,value)=>js('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.focus();input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()');
// A click that navigates may never resolve its executeJavaScript promise, so it is not awaited to completion.
const click=selector=>Promise.race([js('document.querySelector('+JSON.stringify(selector)+').click()').catch(()=>{}),wait(400)]);
const open=async route=>{await win.loadURL('https://login.test'+route);await wait(150)};
// The controller judges the outcome 2.5s after submission, re-probing a few times if the form is still there.
const outcome=async(expected,label)=>{const before=shown.length;for(let i=0;i<90&&shown.length===before;i++)await wait(100);
  if(expected===null){assert.equal(shown.length,before,label+': unexpected offer '+JSON.stringify(shown[shown.length-1]));console.log('  ok  '+label+' -> no offer');return}
  assert.equal(shown.length,before+1,label+': no offer');const {offerId,...offer}=shown[shown.length-1];assert.deepEqual(offer,expected,label);console.log('  ok  '+label+' -> '+offer.kind+' '+offer.username)};
const origin='https://login.test';

// SMOKE_ONLY=fill skips login recognition and seeds the accounts it would have saved.
if(process.env.SMOKE_ONLY==='fill'){store.add({origin,username:'alice@example.com',password:'hunter2!'});store.add({origin,username:'dave@example.com',password:'brand-new'})}else{
await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','hunter2!');await click('button');
await outcome({origin,username:'alice@example.com',kind:'save',verified:true},'classic form POST with navigation');
assert.equal(win.webContents.getURL(),origin+'/home');
// The page's own scripts cannot see the observer or its captured values.
assert.equal(await js('typeof globalThis.__desktopLoginObserver'),'undefined');
assert.equal(capture.resolveOffer(shown[shown.length-1].offerId,'save'),true);
assert.equal(store.resolveForOrigin(origin,{agentOnly:false}).password,'hunter2!');

await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','hunter2!');await click('button');
await outcome(null,'same login again');

await open('/rejected');await fill('[name=user]','mallory');await fill('[name=pw]','wrong');await click('button');
await outcome(null,'rejected login (form shown again)');

await open('/spa');await fill('#account','bob');await fill('#secret','spa-secret');await click('#go');
await outcome({origin,username:'bob',kind:'save',verified:true},'single-page app without a form');

await open('/step1');await fill('[name=identifier]','carol@example.com');await click('button');await wait(300);
assert.equal(new URL(win.webContents.getURL()).pathname,'/step2');
await fill('[name=pw]','two-step-secret');await click('button');
await outcome({origin,username:'carol@example.com',kind:'save',verified:true},'two-step login');

await open('/signup');await fill('[name=email]','dave@example.com');await fill('[name=pw1]','brand-new');await fill('[name=pw2]','brand-new');await click('button');
await outcome({origin,username:'dave@example.com',kind:'save',verified:true},'sign-up with a hidden decoy field');
capture.resolveOffer(shown[shown.length-1].offerId,'save');assert.equal(store.resolveForOrigin(origin,{agentOnly:false,id:store.state().credentials.find(item=>item.maskedUsername.startsWith('da')).id}).password,'brand-new');

await open('/classic');await fill('[name=email]','alice@example.com');await fill('[name=pw]','rotated');await js('document.querySelector("[name=pw]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));document.querySelector("form").requestSubmit()');
await outcome({origin,username:'alice@example.com',kind:'update',verified:true},'changed password submitted with Enter');

await open('/reveal');await fill('[name=email]','erin@example.com');await fill('[name=pw]','revealed-secret');await click('#eye');
assert.equal(await js('document.querySelector("[name=pw]").type'),'text');
await outcome(null,'show-password button without submitting');
await click('#submit');
await outcome({origin,username:'erin@example.com',kind:'save',verified:true},'submitting while the password is shown as text');

await open('/search');await fill('[name=q]','alice@example.com');await click('button');
await outcome(null,'search form');

}
// --- Agent fill: Desktop writes a saved login into the real page; only a status comes back. ---
store.add({origin,username:'bob',password:'spa-secret'});store.add({origin,username:'carol@example.com',password:'two-step-secret'});
const access=createAgentCredentialAccess(store);
const target={contents:win.webContents,holdAutomation:execute=>{const release=queue.holdPageAutomation(win.webContents.id);return queue.withCdpCommandQueue(win.webContents.id,()=>execute(release)).catch(error=>{release();throw error})}};
const accountId=prefix=>access.list(origin).find(item=>item.username.startsWith(prefix)).accountId;
const filled=(result,expected,label)=>{assert.deepEqual(result,expected,label);assert.ok(!JSON.stringify(result).includes('hunter2'));console.log('  ok  fill: '+label+' -> '+result.status)};
const offersBefore=shown.length;

await open('/classic');posts.length=0;
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'classic form, submitted');
assert.equal(win.webContents.getURL(),origin+'/home');
await wait(200);assert.equal(posts[0],'email=alice%40example.com&pw=hunter2%21');
assert.equal(queue.isPageAutomationHeld(win.webContents.id),false);

await open('/controlled');
filled(await access.fill(target,{origin,accountId:accountId('b'),submit:true}),{status:'submitted',loginFormVisible:false},'framework page that listens for input events');
assert.equal(await js('document.querySelector("#who").textContent'),'bob/10');

await open('/classic');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:false,sleep:()=>wait(10)}),{status:'filled'},'filled without submitting');
assert.equal(await js('document.querySelector("[name=pw]").value'),'hunter2!');
assert.equal(queue.isPageAutomationHeld(win.webContents.id),true);
for(let i=0;i<100&&queue.isPageAutomationHeld(win.webContents.id);i++)await wait(100);
assert.equal(queue.isPageAutomationHeld(win.webContents.id),false,'automation stays paused');
assert.equal(await js('document.querySelector("[name=pw]").value'),'','an unsubmitted password is erased before automation resumes');
console.log('  ok  fill: unsubmitted password erased when the pause ends');

await open('/rejected');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true,sleep:()=>wait(60)}),{status:'submitted',loginFormVisible:true},'rejected login keeps the form');
assert.equal(await js('document.querySelector("[name=pw]").value'),'');

await open('/step1');
filled(await access.fill(target,{origin,accountId:accountId('c'),submit:true}),{status:'username_only',submitted:true},'two-step, first page');
await wait(400);assert.equal(new URL(win.webContents.getURL()).pathname,'/step2');posts.length=0;
filled(await access.fill(target,{origin,accountId:accountId('c'),submit:true}),{status:'submitted',loginFormVisible:false},'two-step, password page');
await wait(200);assert.equal(posts[0],'pw=two-step-secret');

await open('/hide');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'submitted',loginFormVisible:false},'field hidden after login');
assert.equal(await js('window.keep.value'),'','a hidden field is erased before automation resumes');
await open('/totext');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true,sleep:()=>wait(60)}),{status:'submitted',loginFormVisible:false},'field switched to plain text');
assert.equal(await js('window.keep.type+":"+window.keep.value'),'text:','a plain-text field is erased before automation resumes');
for(const route of ['/signup-single','/reset']){await open(route);posts.length=0;
  filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'signup_or_reset'},route+' refused');
  assert.equal(await js('document.querySelector("[name=pw]").value+document.querySelector("[name=email]").value'),'');await wait(200);assert.equal(posts.length,0)}
await open('/signup');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'several_password_fields'},'sign-up form refused');
await open('/search');
filled(await access.fill(target,{origin,accountId:accountId('al'),submit:true}),{status:'no_login_form',reason:'no_password_field'},'search box refused');
assert.equal(await js('document.querySelector("[name=q]").value'),'');
await wait(4500);assert.equal(shown.length,offersBefore,'filling a saved login must not prompt to save it again');

clearTimeout(timer);console.log('Login capture smoke passed.');win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', timeout: 150000 });
if (result.status !== 0) process.exit(result.status ?? 1);
