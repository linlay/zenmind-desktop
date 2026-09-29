// Run after build:main:prepared. Temporary profile and synthetic SSO only.
const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-auth-smoke-'));
app.setPath('userData', path.join(temp, 'profile'));
let revoke, active = true, win, server;
const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 600 })).toString('base64url') + '.synthetic';
const identity = { getDesktopSsoAccessToken: () => active ? token : '', getDesktopSsoStatus: () => ({ authenticated: active, user: { issuer: 'smoke', sub: 'alice' } }), subscribeDesktopSsoCredentialRevocation: fn => { revoke = fn; } };
const old = Module._load;
Module._load = function(name, parent, ...args) {
  if (parent?.filename.endsWith('/webs/auth-session.js')) {
    if (name === '../identity') return identity;
    if (name.includes('user-paths')) return { getDesktopStateRoot: () => temp };
  }
  return old.call(this, name, parent, ...args);
};
const { registerWebappAuth } = require('../dist-electron/main/modules/webs/auth-session.js');
Module._load = old;
dialog.showMessageBox = async () => ({ response: 1 });
const timeout = setTimeout(() => { console.error('Auth smoke timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const sdk = fs.readFileSync(path.join(root, 'contracts/webapp/bridge.mjs'), 'utf8');
  let exchanges = 0;
  server = http.createServer((req, res) => {
    if (req.url === '/bridge.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(sdk); }
    if (req.url === '/api/session') {
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      assert.equal(req.headers.cookie, undefined);
      exchanges++;
      res.writeHead(200, { 'Set-Cookie': 'auth_smoke=opaque-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=600', 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (req.url === '/api/me') { res.writeHead(req.headers.cookie?.includes('auth_smoke=opaque-cookie') ? 200 : 401, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><button id="login">Login</button><script type="module">import {auth} from "/bridge.js";window.ready=true;document.querySelector("button").onclick=async()=>{try{window.result=await auth.createSession({exchangePath:"/api/session"})}catch(e){window.result={error:e.code,message:e.message}}};</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'dist-electron/preload/webapp-auth.js'), partition: 'persist:desktop-browser', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('preload-error', (_e,_p,error)=>console.error(error));
  registerWebappAuth({ registry: { resolveWebviewSurfaceTarget: id => id === win.webContents.id ? { surfaceKind: 'webapp', registrationId: 'smoke', surfaceId: 'smoke' } : null }, webs: { webappWindowManager: { resolveAuthGuest: () => null } }, refreshToken: async () => token });
  await win.loadURL(origin);
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('window.ready === true'))break;await new Promise(r=>setTimeout(r,20));}
  await win.webContents.executeJavaScript('document.querySelector("button").click()');
  let result;
  for(let i=0;i<200;i++){result=await win.webContents.executeJavaScript('window.result');if(result)break;await new Promise(r=>setTimeout(r,20));}
  assert.deepEqual(result, {ok:true});assert.equal(exchanges,1);
  assert.equal(await win.webContents.executeJavaScript('fetch("/api/me").then(r=>r.status)'),200);
  assert.equal(await win.webContents.executeJavaScript('document.cookie'), '');
  const cookies=await win.webContents.session.cookies.get({url:origin});assert.equal(cookies[0].httpOnly,true);
  active=false;revoke();
  for(let i=0;i<100;i++){if(!(await win.webContents.session.cookies.get({url:origin})).length)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(await win.webContents.executeJavaScript('fetch("/api/me").then(r=>r.status)'),401);
  console.log('PASS: real sandbox preload → IPC → Bearer exchange → HttpOnly Cookie → logout cleanup');
  win.destroy();await new Promise(resolve=>server.close(resolve));clearTimeout(timeout);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
