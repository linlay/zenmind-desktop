import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDesktopSsoController } = require("../dist-electron/main/modules/identity/sso-controller.js");
const sso = require("../dist-electron/main/modules/identity/oidc-sso.js");
const { requestMarket } = require("../dist-electron/main/modules/marketplace/market-http.js");

function createWindow() {
  let minimized = true;
  const calls = { restore: 0, show: 0, focus: 0, appFocus: [], alwaysOnTop: [], events: [] };
  return {
    calls,
    window: {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => { calls.restore++; minimized = false; },
      show: () => { calls.show++; },
      focus: () => { calls.focus++; },
      setAlwaysOnTop: value => { calls.alwaysOnTop.push(value); },
      webContents: { send: (channel, status) => { calls.events.push({ channel, status }); } }
    }
  };
}

function fixture(t, platform = "darwin", fetch = async () => assert.fail("unexpected network request")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sso-background-focus-"));
  const view = createWindow();
  const app = Object.assign(new EventEmitter(), {
    focus: options => { view.calls.appFocus.push(options); },
    getPath: name => name === "home" ? root : path.join(root, name)
  });
  const controller = createDesktopSsoController({
    app, platform,
    getMainWindow: () => view.window,
    session: { defaultSession: {
      fetch,
      cookies: {
        get: async () => [{ name: "SESSION", value: "test-cookie", domain: "sso.example.test", path: "/" }],
        set: async () => {}, remove: async () => {}, flushStore: async () => {}
      },
      flushStorageData: async () => {}
    } },
    openBrowserUrl: async () => assert.fail("background renewal must not open a browser"),
    openExternal: async () => assert.fail("background renewal must not open a browser")
  });
  t.after(() => {
    app.emit("before-quit");
    sso.desktopSsoRuntimeState.callbackHooks = {};
    sso.clearDesktopSsoLocalSession(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...view, app, controller };
}

function status(authenticated, pending = false) {
  return {
    configured: true, authenticated, pending,
    user: authenticated ? { sub: "user", issuer: "https://sso.example.test", audience: "desktop" } : null,
    completedSteps: { session: authenticated, userInfo: authenticated, accessToken: authenticated },
    message: "test status", updatedAt: new Date().toISOString()
  };
}

function assertBackground(view) {
  assert.equal(view.window.isMinimized(), true);
  assert.equal(view.calls.restore, 0);
  assert.equal(view.calls.show, 0);
  assert.equal(view.calls.focus, 0);
  assert.deepEqual(view.calls.appFocus, []);
  assert.deepEqual(view.calls.alwaysOnTop, []);
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: status notifications never restore or focus a minimized window`, t => {
    const f = fixture(t, platform);
    const updates = [status(true, true), status(true), status(true), status(false)];
    for (const update of updates) f.controller.broadcastStatus(update);
    assertBackground(f);
    assert.deepEqual(f.calls.events.map(event => event.status), updates);
  });

  test(`${platform}: an explicit return-to-app still restores and focuses once`, t => {
    const f = fixture(t, platform);
    f.controller.returnToApp();
    assert.equal(f.window.isMinimized(), false);
    assert.equal(f.calls.restore, 1);
    assert.equal(f.calls.show, 1);
    assert.equal(f.calls.focus, 1);
    assert.deepEqual(f.calls.appFocus, platform === "darwin" ? [{ steal: true }] : []);
    assert.deepEqual(f.calls.alwaysOnTop, platform === "win32" ? [true, false] : []);
  });
}

const origin = "https://sso.example.test";
function jwt(sequence) {
  const now = Math.floor(Date.now() / 1000);
  return [{ alg: "RS256" }, { sub: "oidc-user", iss: origin, aud: "desktop", iat: now, exp: now + 3600, jti: String(sequence) }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".test-signature";
}
const response = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });

function writeGatewayConfig(app) {
  const configPath = sso.resolveDesktopSsoConfigPath(app, "darwin");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true, browserOrigin: origin, loginUrl: `${origin}/login`,
    tokenExchange: { url: `${origin}/authorization` }, tokenRefresh: { url: `${origin}/refresh` },
    userInfo: { url: `${origin}/userinfo`, authMode: "cookie", subPath: "user.id" },
    accessTokenCookie: { url: origin, name: "id_token" }
  }));
}

for (const marketStatus of [401, 502]) {
  test(`market HTTP ${marketStatus} after login cannot bring the window forward or publish an incomplete identity`, async t => {
    let tokenRequests = 0;
    const f = fixture(t, "darwin", async url => {
      if (url === `${origin}/userinfo`) return response(200, { user: { id: "user" } });
      tokenRequests++;
      return response(200, { id_token: jwt(tokenRequests), refresh_token: "test-refresh-token" });
    });
    writeGatewayConfig(f.app);
    await f.controller.exchangeBrowserCookieAccessToken();
    const initialIdentity = sso.getDesktopSsoStatus(f.app).user;
    // The completed interactive login leaves this status subscriber installed.
    sso.desktopSsoRuntimeState.callbackHooks = { onStatusChanged: f.controller.broadcastStatus };
    f.calls.events.length = 0;
    let marketRequests = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(requestMarket(f.app, "https://market.example.test/catalog", {}, {
        issueMarketAccessToken: (_app, reason) => reason === "missing"
          ? sso.getDesktopSsoBusinessToken()
          : f.controller.ensureBusinessToken(true),
        fetchImpl: async () => { marketRequests++; return response(marketStatus, {}); }
      }));
    }
    assert.equal(marketRequests, marketStatus === 401 ? 4 : 2);
    assert.equal(tokenRequests, marketStatus === 401 ? 3 : 1);
    assertBackground(f);
    if (marketStatus === 401) assert.ok(f.calls.events.length > 0);
    for (const event of f.calls.events) {
      assert.equal(event.channel, "sso.statusChanged");
      assert.equal(event.status.authenticated, true);
      assert.equal(event.status.pending, false);
      assert.deepEqual(event.status.user, initialIdentity);
      assert.deepEqual(event.status.completedSteps, { session: true, userInfo: true, accessToken: true });
    }
  });
}

test("a market retry cannot take over or close an in-progress interactive login", async t => {
  let tokenRequests = 0;
  const f = fixture(t, "darwin", async url => url === `${origin}/userinfo`
    ? response(200, { user: { id: "user" } })
    : response(200, { id_token: jwt(++tokenRequests), refresh_token: "test-refresh-token" }));
  writeGatewayConfig(f.app);
  await f.controller.exchangeBrowserCookieAccessToken();
  const previousToken = sso.getDesktopSsoBusinessToken();
  const login = await sso.startDesktopSsoLogin(f.app, { onStatusChanged: f.controller.broadcastStatus });
  assert.equal(login.ok, true, login.message);
  const attempt = sso.desktopSsoRuntimeState.pendingLogin;
  const servers = sso.desktopSsoRuntimeState.callbackServers;
  assert.ok(attempt);
  await assert.rejects(f.controller.ensureBusinessToken(true));
  assert.equal(tokenRequests, 1);
  assert.equal(sso.desktopSsoRuntimeState.pendingLogin, attempt);
  assert.ok(servers.length > 0 && servers.every(server => server.listening));
  assert.equal(sso.getDesktopSsoStatus(f.app).pending, true);
  assert.equal(sso.getDesktopSsoBusinessToken(), previousToken);
  assertBackground(f);
  // The interactive completion path is still allowed to exchange credentials.
  await f.controller.exchangeBrowserCookieAccessToken();
  assert.equal(tokenRequests, 2);
  assert.equal(sso.getDesktopSsoStatus(f.app).pending, false);
  assert.equal(sso.desktopSsoRuntimeState.pendingLogin, null);
  assert.ok(servers.every(server => !server.listening));
  assertBackground(f);
});
