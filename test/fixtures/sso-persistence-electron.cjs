// Real Chromium storage with a synthetic upstream. No user profile or network is used.
const { app, session, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { initializeElectronProfile } = require("../../dist-electron/main/app/bootstrap/electron-profile.js");
const { createDesktopSsoController } = require("../../dist-electron/main/modules/identity/sso-controller.js");
const { clearDesktopSsoLocalSession, getDesktopSsoStatus, getDesktopSsoAccessToken, readDesktopSsoAccessToken, __testInternals } = require("../../dist-electron/main/modules/identity/oidc-sso.js");
const { getElectronUserDataRoot } = require("../../dist-electron/main/infrastructure/filesystem/user-paths.js");
const { APP_BRAND } = require("../../dist-electron/shared/brand.js");
const { DESKTOP_BROWSER_WEBVIEW_PARTITION } = require("../../dist-electron/shared/browser-surfaces.js");
const { DESKTOP_SSO_WEBVIEW_PARTITION } = require("../../dist-electron/shared/sso.js");

const root = process.env.SSO_PERSISTENCE_TEST_ROOT;
const phase = process.env.SSO_PERSISTENCE_TEST_PHASE;
const userInfoRequiresToken = process.env.SSO_PERSISTENCE_USERINFO_REQUIRES_TOKEN === "1";
const bearerRestore = process.env.SSO_PERSISTENCE_BEARER_RESTORE === "1";
const home = path.join(root, "home");
const lockRoot = path.join(root, "lock");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(lockRoot, { recursive: true });
app.setPath("home", home);
app.setPath("appData", lockRoot);
app.setPath("userData", lockRoot);
assert.equal(app.requestSingleInstanceLock(), true);
if (process.platform === "win32") {
  // Do not read the real installation's registry DataRoot during this fixture.
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = (_command, args) => {
    assert.ok(args.includes("-EncodedCommand"));
    return Buffer.from(Buffer.from(path.join(home, APP_BRAND.paths.runtimeRootDirName)).toString("base64"));
  };
  try { initializeElectronProfile(app); } finally { childProcess.execFileSync = originalExecFileSync; }
} else {
  initializeElectronProfile(app);
}
const profileRoot = app.getPath("sessionData");
const origin = "https://sso-persistence.example.test";

async function run() {
  await app.whenReady();
  if (process.platform === "darwin") app.dock.hide();
  if (process.env.SSO_PERSISTENCE_MIGRATE_ROOT === "1") {
    // macOS first-install migration happens after ready, before protocol/session use.
    const runtimeRoot = path.join(home, APP_BRAND.paths.runtimeRootDirName);
    fs.renameSync(runtimeRoot, `${runtimeRoot}.backup`);
    fs.mkdirSync(getElectronUserDataRoot(app), { recursive: true });
  }
  protocol.handle("sso-persistence-test", () => new Response("ok"));
  const ssoSession = session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
  assert.equal(session.defaultSession.storagePath, profileRoot);
  assert.equal(DESKTOP_SSO_WEBVIEW_PARTITION, "");
  assert.equal(ssoSession, session.defaultSession);
  assert.equal(ssoSession.storagePath, profileRoot);
  assert.equal(profileRoot, path.join(home, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir, "state", "chromium"));
  const isolatedBrowser = session.fromPartition(DESKTOP_BROWSER_WEBVIEW_PARTITION);
  assert.notEqual(isolatedBrowser, ssoSession);
  assert.deepEqual(await isolatedBrowser.cookies.get({ url: origin }), []);
  const configPath = __testInternals.resolveDesktopSsoConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true, browserMode: "embedded", browserOrigin: origin,
    loginUrl: `${origin}/login`, appendLoginState: false,
    claims: { audience: "desktop" },
    browserSession: { url: `${origin}/oauth2/auth`, successStatuses: [202], userInfoHeaders: { sub: "x-auth-request-user" } },
    ...(bearerRestore ? { sessionRestore: { authMode: "bearer" } } : {}),
    ...(userInfoRequiresToken || bearerRestore ? {
      userInfo: { url: `${origin}/api/oauth2/userinfo`, authMode: "cookie", required: false, subPath: "data.id" }
    } : {}),
    cookieAccessTokenExchange: { url: `${origin}/authorization`, method: "GET", accessTokenPath: "access_token" }
  }));
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "test-user", iss: origin, aud: "desktop", exp: Math.floor(Date.now() / 1000) + 86400, phase
  })}.synthetic-signature`;
  const savedToken = readDesktopSsoAccessToken(app);
  const restoringWithBearer = bearerRestore && phase === "restore";
  let fetchCount = 0;
  const controller = createDesktopSsoController({
    app, platform: process.platform,
    session: {
      defaultSession: {
        cookies: ssoSession.cookies,
        flushStorageData: () => ssoSession.flushStorageData(),
        async fetch(url, init) {
          fetchCount += 1;
          if (restoringWithBearer) {
            assert.equal(init.redirect, "manual", "saved credentials must not follow redirects");
            assert.equal(init.headers.Cookie || "", "", "Bearer recovery must work without any upstream Cookie");
            assert.equal(init.headers.Authorization, `Bearer ${url.endsWith("/authorization") ? savedToken : token}`);
          } else {
            assert.equal(init.headers.Authorization, undefined, "Cookie configuration must never automatically use a saved Bearer token");
            assert.match(init.headers.Cookie, /_oauth2_proxy=test-upstream-session/u);
          }
          if (url.endsWith("/oauth2/auth")) {
            assert.equal(restoringWithBearer, false, "Bearer recovery does not depend on a Cookie session probe");
            return new Response("", { status: 202,
              headers: userInfoRequiresToken ? {} : { "x-auth-request-user": "test-user" } });
          }
          if (url.endsWith("/api/oauth2/userinfo")) {
            assert.equal(getDesktopSsoAccessToken(), null, "identity must be confirmed before publishing canonical credentials");
            if (restoringWithBearer) {
              assert.equal((await ssoSession.cookies.get({ url: origin, name: "access_token" })).length, 0,
                "derived Cookie must wait for remote identity confirmation");
            } else if (!init.headers.Cookie.includes(`access_token=${token}`)) {
              return new Response("Fresh access-token Cookie required", { status: 401 });
            }
            return new Response(JSON.stringify({ data: { id: "test-user" } }), { headers: { "content-type": "application/json" } });
          }
          return new Response(JSON.stringify({ access_token: token }), { headers: { "content-type": "application/json" } });
        }
      },
      fromPartition: () => assert.fail("SSO must use the default Session")
    },
    getMainWindow: () => null, openBrowserUrl: async () => { throw new Error("Unexpected browser"); },
    openExternal: async () => { throw new Error("Unexpected external navigation"); }
  });
  if (phase === "write") {
    await ssoSession.cookies.set({ url: "https://unrelated.example.test", name: "keep-me", value: "unrelated-site",
      expirationDate: Date.now() / 1000 + 86400, httpOnly: true, secure: true });
    await ssoSession.cookies.set({ url: origin, name: "_oauth2_proxy", value: "test-upstream-session",
      expirationDate: Date.now() / 1000 + 86400, httpOnly: true, secure: true, sameSite: "lax" });
    await controller.validateBrowserSession();
    await controller.exchangeBrowserCookieAccessToken();
    await controller.syncBrowserCookies();
    assert.equal(getDesktopSsoStatus(app).authenticated, true);
    assert.equal(fs.existsSync(path.join(ssoSession.storagePath, "Cookies")), true);
  } else if (phase === "restore") {
    assert.ok((await ssoSession.cookies.get({ url: origin })).some((cookie) => cookie.name === "_oauth2_proxy" && cookie.httpOnly));
    if (bearerRestore) {
      assert.ok(savedToken);
      await ssoSession.cookies.remove(origin, "_oauth2_proxy");
    }
    const result = await controller.restoreDesktopSsoSession();
    assert.equal(result.state, "authenticated");
    assert.equal(result.status.user.sub, "test-user");
    assert.equal(result.accessToken, token);
    assert.equal(fetchCount, userInfoRequiresToken ? 3 : 2, "restart must use only the configured recovery flow");
    assert.equal((await ssoSession.cookies.get({ url: origin, name: "access_token" }))[0]?.value, token);
  } else if (phase === "logout") {
    clearDesktopSsoLocalSession(app);
    await controller.clearBrowserCookies();
    await controller.clearWebSessionCookies();
  } else if (phase === "signed-out") {
    assert.deepEqual(await ssoSession.cookies.get({ url: origin }), []);
    assert.deepEqual(await session.defaultSession.cookies.get({ url: origin }), []);
    assert.equal((await controller.restoreDesktopSsoSession()).state, "signed_out");
    assert.equal(fetchCount, 0);
    assert.equal((await ssoSession.cookies.get({ url: "https://unrelated.example.test" }))[0]?.name, "keep-me");
  } else {
    throw new Error("Unknown test phase");
  }
  fs.writeFileSync(path.join(root, `${phase}.json`), JSON.stringify({
    ok: true, profileRoot,
    legacySsoRoot: path.join(home, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir,
      "profiles", "electron", "Partitions", `${APP_BRAND.storageNamespace}-sso`)
  }));
  // Deliberately bypass graceful shutdown: production Cookie flushes must have
  // completed before success, without relying on Chromium's delayed disk writes.
  app.exit(0);
}

run().catch((error) => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 15000).unref();
