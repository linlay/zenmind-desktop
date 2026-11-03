import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let activeRoot = "";
const app = { getPath: name => name === "home" ? activeRoot : path.join(activeRoot, name) };
const electronId = require.resolve("electron");
const previousElectron = require.cache[electronId];
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { app, session: {}, shell: {} } };
let handleDesktopSsoWebviewNavigation;
try {
  ({ handleDesktopSsoWebviewNavigation } = require("../dist-electron/main/app/assembly/identity.js"));
} finally {
  if (previousElectron) require.cache[electronId] = previousElectron;
  else delete require.cache[electronId];
}
const sso = require("../dist-electron/main/modules/identity/oidc-sso.js");
const origin = "https://completion.example.test";
const completeUrl = `${origin}/done`;
const token = [{ alg: "none" }, { sub: "user", iss: origin, aud: "desktop", exp: Math.floor(Date.now() / 1000) + 3600 }]
  .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".test-signature";

async function fixture(t, browserSession = true) {
  activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sso-webview-completion-"));
  const root = activeRoot;
  sso.desktopSsoRuntimeState.callbackHooks = {};
  sso.clearDesktopSsoLocalSession(app);
  const configPath = sso.resolveDesktopSsoConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true, browserOrigin: origin, loginUrl: `${origin}/login`, loginCompletionUrl: completeUrl,
    browserSession: { url: `${origin}/session` },
    cookieAccessTokenExchange: { url: `${origin}/token`, validationMode: "remote" }
  }));
  const login = await sso.startDesktopSsoLogin(app);
  assert.equal(login.ok, true, login.message);
  let returns = 0;
  const dependencies = {
    appState: { desktopSsoWebviewCompletionInFlight: false },
    desktopSsoController: {
      syncBrowserCookies: async () => {},
      validateBrowserSession: async () => browserSession ? sso.completeDesktopSsoBrowserSession(app) : null,
      fetchBrowserUserInfo: async () => sso.completeDesktopSsoBrowserSessionUserInfo(app, { sub: "user", name: "User" }),
      exchangeBrowserCookieAccessToken: async () => { if (browserSession) sso.persistDesktopSsoAccessToken(app, token); return token; },
      returnToApp: () => { returns++; }
    }
  };
  t.after(() => {
    sso.desktopSsoRuntimeState.callbackHooks = {};
    sso.clearDesktopSsoLocalSession(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { dependencies, get returns() { return returns; } };
}

for (const browserSession of [true, false]) {
  test(`explicit webview completion returns once (${browserSession ? "verified browser session" : "cookie token"})`, async t => {
    const f = await fixture(t, browserSession);
    await handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
    assert.equal(f.returns, 1);
    assert.equal(sso.getDesktopSsoStatus(app).authenticated, true);
    assert.equal(sso.getDesktopSsoStatus(app).pending, false);
    await handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
    assert.equal(f.returns, 1);
  });
}

test("unrelated navigation, partial failure and cancelled login never return to the foreground", async t => {
  const f = await fixture(t);
  await handleDesktopSsoWebviewNavigation(f.dependencies, `${origin}/another-page`);
  assert.equal(f.returns, 0);
  f.dependencies.desktopSsoController.exchangeBrowserCookieAccessToken = async () => "";
  await handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
  assert.equal(f.returns, 0);
  await sso.startDesktopSsoLogin(app);
  sso.cancelDesktopSsoLogin(app);
  await handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
  assert.equal(f.returns, 0);
});

for (const action of ["cancel", "replace"]) {
  test(`a late webview completion cannot return after ${action} of its login attempt`, async t => {
    const f = await fixture(t);
    let release;
    f.dependencies.desktopSsoController.syncBrowserCookies = () => new Promise(resolve => { release = resolve; });
    const completion = handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
    if (action === "cancel") sso.cancelDesktopSsoLogin(app);
    else await sso.startDesktopSsoLogin(app);
    const state = sso.getDesktopSsoStatus(app);
    const pending = sso.desktopSsoRuntimeState.pendingLogin;
    release();
    await completion;
    assert.equal(f.returns, 0);
    assert.deepEqual(sso.getDesktopSsoStatus(app), state);
    assert.equal(sso.desktopSsoRuntimeState.pendingLogin, pending);
  });
}

test("duplicate navigation leaves the active completion guard in place", async t => {
  const f = await fixture(t);
  let release;
  f.dependencies.desktopSsoController.syncBrowserCookies = () => new Promise(resolve => { release = resolve; });
  const completion = handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
  await handleDesktopSsoWebviewNavigation(f.dependencies, completeUrl);
  assert.equal(f.dependencies.appState.desktopSsoWebviewCompletionInFlight, true);
  release();
  await completion;
  assert.equal(f.returns, 1);
  assert.equal(f.dependencies.appState.desktopSsoWebviewCompletionInFlight, false);
});
