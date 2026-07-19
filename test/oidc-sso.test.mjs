import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  failDesktopSsoFlow,
  getDesktopSsoStatus,
  logoutDesktopSso,
  startDesktopSsoLogin,
  startDesktopSsoSiteTokenBridge,
  __testInternals
} = require("../dist-electron/main/oidc-sso.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "Library", "Application Support");
      }
      if (name === "userData") {
        return path.join(homePath, "Library", "Application Support", "ZenMind");
      }
      return homePath;
    }
  };
}

function writeSsoConfig(app, config) {
  const configPath = __testInternals.resolveDesktopSsoConfigPath(app, "darwin");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function getDesktopStateRoot(app) {
  const configPath = __testInternals.resolveDesktopSsoConfigPath(app, "darwin");
  const desktopRoot = path.dirname(path.dirname(path.dirname(configPath)));
  return path.join(desktopRoot, "state", "desktop");
}

function getRuntimeRoot(app) {
  const configPath = __testInternals.resolveDesktopSsoConfigPath(app, "darwin");
  return path.dirname(path.dirname(path.dirname(path.dirname(configPath))));
}

const embeddedLoginHost = ["ai", ["q", "i", "u", "e", "r"].join(""), "net"].join(".");
const embeddedLoginOrigin = `https://${embeddedLoginHost}`;
const embeddedLoginUrl = `${embeddedLoginOrigin}/tologin.do?url=${encodeURIComponent(`${embeddedLoginOrigin}/`)}`;
const embeddedTokenExchangeUrl = `${embeddedLoginOrigin}/${["auth", "orization"].join("")}`;

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createUnsignedJwt(payload) {
  return [
    encodeJwtPart({ alg: "none", typ: "JWT" }),
    encodeJwtPart(payload),
    "signature"
  ].join(".");
}

function createSignedJwt(payload, privateKey) {
  const data = [
    encodeJwtPart({ alg: "RS256", kid: "test-key", typ: "JWT" }),
    encodeJwtPart(payload)
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(data)
    .end()
    .sign(privateKey)
    .toString("base64url");
  return `${data}.${signature}`;
}

function createJsonResponse(value, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status,
    statusText: options.statusText,
    json: async () => value,
    text: async () => typeof value === "string" ? value : JSON.stringify(value)
  };
}

function createOidcTokenTestFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://auth.example.test/application/o/desktop/";
  const tokenUrl = "https://auth.example.test/application/o/token/";
  const wellKnownUrl = "https://auth.example.test/application/o/desktop/.well-known/openid-configuration";
  const jwksUrl = "https://auth.example.test/application/o/desktop/jwks/";
  const userInfoUrl = "https://auth.example.test/application/o/userinfo/";
  const clientId = "desktop-client";
  const publicJwk = publicKey.export({ format: "jwk" });
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return {
    privateKey,
    publicJwk,
    tokenUrl,
    wellKnownUrl,
    jwksUrl,
    userInfoUrl,
    config: {
      ...__testInternals.DEFAULT_OIDC_CONFIG,
      issuer,
      authorizeUrl: "https://auth.example.test/o/authorize/",
      tokenUrl,
      clientId,
      redirectUri: "http://127.0.0.1:0/api/auth/oidc/callback",
      wellKnownUrl,
      logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
      logoutCallbackUri: "http://127.0.0.1:0/api/auth/oidc/logout-callback",
      usePkce: true,
      userInfo: {
        enabled: true,
        required: false,
        url: userInfoUrl,
        subPath: "sub",
        namePath: "name",
        emailPath: "email",
        avatarUrlPath: "picture"
      }
    }
  };
}

test("desktop sso parses provider-free system browser OIDC config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "system",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.authMode, "oidc");
  assert.equal(result.config.browserMode, "system");
  assert.equal(result.config.redirectUri, "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(result.config.logoutCallbackUri, "http://localhost:8080/api/auth/oidc/logout-callback");
  assert.equal(result.config.usePkce, true);
  assert.equal(__testInternals.shouldUseSystemBrowser(result.config), true);
});

test("desktop sso ignores retired config and session files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const runtimeRoot = getRuntimeRoot(app);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "desktop-sso.json"), JSON.stringify({
    enabled: true,
    ...__testInternals.DEFAULT_OIDC_CONFIG
  }), "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "sso.json"), JSON.stringify({
    enabled: true,
    ...__testInternals.DEFAULT_OIDC_CONFIG
  }), "utf8");

  const config = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(config.configured, false);

  writeSsoConfig(app, {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    enabled: true,
    browserMode: "system",
    redirectUri: "http://127.0.0.1:0/api/auth/oidc/callback",
    logoutCallbackUri: "http://127.0.0.1:0/api/auth/oidc/logout-callback",
    logoutUrl: ""
  });
  const stateRoot = getDesktopStateRoot(app);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "oidc-sso-session.json"), JSON.stringify({
    authenticated: true,
    user: { sub: "legacy-user" }
  }), "utf8");

  failDesktopSsoFlow("reset test state");
  const status = getDesktopSsoStatus(app);
  assert.equal(status.authenticated, false);
  assert.equal(status.user, null);
});

test("desktop SSO logout clears only canonical session and token files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const stateRoot = getDesktopStateRoot(app);
  fs.mkdirSync(stateRoot, { recursive: true });
  const canonicalSessionPath = path.join(stateRoot, "sso-session.json");
  const canonicalTokenPath = path.join(stateRoot, "sso-access-token.txt");
  const legacySessionPath = path.join(stateRoot, "oidc-sso-session.json");
  const legacyTokenPath = path.join(stateRoot, "desktop-sso-access-token.txt");
  fs.writeFileSync(canonicalSessionPath, JSON.stringify({
    authenticated: true,
    user: { sub: "canonical-user" }
  }), "utf8");
  fs.writeFileSync(canonicalTokenPath, "canonical-token\n", "utf8");
  fs.writeFileSync(legacySessionPath, JSON.stringify({
    authenticated: true,
    user: { sub: "legacy-user" }
  }), "utf8");
  fs.writeFileSync(legacyTokenPath, "legacy-token\n", "utf8");

  failDesktopSsoFlow("reset test state");
  const result = await logoutDesktopSso(app);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(canonicalSessionPath), false);
  assert.equal(fs.existsSync(canonicalTokenPath), false);
  assert.equal(fs.existsSync(legacySessionPath), true);
  assert.equal(fs.existsSync(legacyTokenPath), true);
});

test("desktop sso keeps embedded browser default for ordinary OIDC without browserMode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.equal(__testInternals.shouldUseSystemBrowser(result.config), false);
});

test("desktop sso reads explicit site token bridge config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "system",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "desktop-client",
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
    siteTokenBridge: {
      startUrl: "https://site.example.test/api/auth/desktop-sso/start",
      exchangeUrl: "/api/auth/desktop-sso/session"
    }
  });

  const bridge = __testInternals.getDesktopSsoSiteTokenBridgeConfig(app);
  assert.equal(bridge.startUrl, "https://site.example.test/api/auth/desktop-sso/start");
  assert.equal(bridge.exchangeUrl, "https://site.example.test/api/auth/desktop-sso/session");
  assert.equal(bridge.required, false);
  assert.deepEqual(bridge.cookieOrigins, ["https://site.example.test"]);

  const startUrl = new URL(__testInternals.buildSiteTokenBridgeStartUrl(
    bridge.startUrl,
    "http://localhost:8080/api/auth/oidc/callback",
    "state-1"
  ));
  assert.equal(startUrl.searchParams.get("callback"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(startUrl.searchParams.get("state"), "state-1");
});

test("desktop sso site token bridge open mode follows browserMode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-bridge-mode-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://app.example.test",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "desktop-client",
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
    siteTokenBridge: {
      startUrl: "https://site.example.test/api/auth/desktop-sso/start",
      exchangeUrl: "/api/auth/desktop-sso/session",
      required: true
    }
  });

  await startDesktopSsoLogin(app);
  const bridgeStart = startDesktopSsoSiteTokenBridge(app);

  assert.equal(bridgeStart.ok, true, bridgeStart.message);
  assert.equal(bridgeStart.openMode, "embedded");
  assert.equal(bridgeStart.browserOrigin, "https://app.example.test");
  assert.equal(bridgeStart.required, true);
  assert.match(bridgeStart.startUrl, /^https:\/\/site\.example\.test\/api\/auth\/desktop-sso\/start/u);
});

test("desktop sso writes user info state after local authentication completes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://app.example.test",
    loginUrl: "https://app.example.test/login",
    appendLoginState: false,
    logoutUrl: "https://app.example.test/logout"
  });

  const token = createUnsignedJwt({
    sub: "user-1",
    iss: "https://app.example.test",
    aud: "desktop-client",
    name: "Desktop User",
    email: "desktop.user@example.test"
  });
  const status = __testInternals.completeDesktopSsoCookieLogin(app, token);

  assert.equal(status.authenticated, true);
  const userInfoPath = __testInternals.getDesktopSsoUserInfoFilePath(app);
  const stored = JSON.parse(fs.readFileSync(userInfoPath, "utf8"));
  assert.equal(stored.sub, "user-1");
  assert.equal(stored.name, "Desktop User");
  assert.equal(stored.email, "desktop.user@example.test");
  assert.equal(stored.source, "sso");
});

test("desktop sso stores site token bridge response in secrets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const saved = __testInternals.saveDesktopSsoSiteTokenFile(app, {
    accessToken: "site-token-1",
    tokenType: "Bearer",
    expiresAt: "2026-06-18T12:00:00Z",
    issuer: "https://site.example.test"
  });

  assert.equal(saved, true);
  const tokenPath = __testInternals.getDesktopSsoSiteTokenFilePath(app);
  const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  assert.equal(stored.accessToken, "site-token-1");
  assert.equal(stored.tokenType, "Bearer");
  assert.equal(stored.issuer, "https://site.example.test");
});

test("desktop sso strips a Bearer scheme from cookie token responses", () => {
  const token = createUnsignedJwt({
    sub: "cookie-user",
    iss: embeddedLoginOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  assert.equal(
    __testInternals.readCookieAccessTokenFromResponse(`Bearer ${token}`),
    token
  );
  assert.equal(
    __testInternals.readCookieAccessTokenFromResponse({ access_token: `bearer ${token}` }),
    token
  );
});

test("desktop sso does not infer cookie token exchange from ai browser origin", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: embeddedLoginOrigin,
    loginUrl: embeddedLoginUrl,
    appendLoginState: false,
    loginCompletionUrls: [`${embeddedLoginOrigin}/`]
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.equal(result.config.cookieAccessTokenExchange, undefined);
  assert.equal(__testInternals.getDesktopSsoCookieAccessTokenExchangeUrl(app), null);
  assert.deepEqual(__testInternals.getDesktopSsoAccessTokenCookieLookups(app), []);
});

test("desktop sso reads explicit embedded cookie token exchange config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: embeddedLoginOrigin,
    loginUrl: embeddedLoginUrl,
    appendLoginState: false,
    loginCompletionUrls: [`${embeddedLoginOrigin}/`],
    cookieAccessTokenExchange: {
      url: embeddedTokenExchangeUrl,
      method: "GET"
    },
    accessTokenCookie: {
      url: `${embeddedLoginOrigin}/`,
      name: "access_token",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    }
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.deepEqual(result.config.loginCompletionUrls, [`${embeddedLoginOrigin}/`]);
  assert.deepEqual(result.config.cookieAccessTokenExchange, {
    url: embeddedTokenExchangeUrl,
    method: "GET",
    headers: {},
    accessTokenPath: "access_token"
  });
  assert.deepEqual(__testInternals.getDesktopSsoAccessTokenCookieLookup(app), {
    url: `${embeddedLoginOrigin}/`,
    name: "access_token"
  });
  assert.equal(__testInternals.getDesktopSsoSiteTokenBridgeConfig(app), null);
});

test("desktop sso cookie completion preserves jwt user name and email claims", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: embeddedLoginOrigin,
    loginUrl: embeddedLoginUrl,
    appendLoginState: false,
    loginCompletionUrls: [`${embeddedLoginOrigin}/`],
    cookieAccessTokenExchange: {
      url: embeddedTokenExchangeUrl,
      method: "GET",
      accessTokenPath: "access_token"
    }
  });

  const status = __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "user-1",
    iss: embeddedLoginOrigin,
    aud: "desktop",
    name: "张倩",
    email: "zhangqian@example.test",
    picture: "https://assets.example.test/avatar.png"
  }));

  assert.equal(status.authenticated, true);
  assert.equal(status.user.name, "张倩");
  assert.equal(status.user.email, "zhangqian@example.test");
  assert.equal(status.user.avatarUrl, "https://assets.example.test/avatar.png");
});

test("desktop sso system browser login uses localhost callback for explicit browserMode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "system",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    providerLabel: "ZenMind",
    redirectUri: "http://127.0.0.1:0/api/auth/oidc/callback",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  return startDesktopSsoLogin(app).then((result) => {
    assert.equal(result.ok, true, result.message);
    assert.equal(result.openMode, "system");
    assert.equal(result.browserLabel, "ZenMind 登录");
    assert.equal(result.browserUrl, undefined);
    const authorizeUrl = new URL(result.authorizeUrl);
    const redirectUri = new URL(authorizeUrl.searchParams.get("redirect_uri"));
    assert.equal(redirectUri.hostname, "127.0.0.1");
    assert.equal(redirectUri.pathname, "/api/auth/oidc/callback");
    assert.notEqual(redirectUri.port, "");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  });
});

test("desktop sso authorize and logout URLs use standard OIDC defaults", () => {
  const config = {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    clientSecret: undefined,
    clientId: "zenmind-desktop",
    usePkce: true,
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  };
  const authorizeUrl = new URL(__testInternals.buildAuthorizeUrl("state-1", config, {
    codeChallenge: "challenge-1"
  }));
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(authorizeUrl.searchParams.get("scope"), "openid email profile");
  assert.equal(authorizeUrl.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(authorizeUrl.searchParams.has("prompt"), false);

  const logoutUrlWithoutHint = new URL(__testInternals.buildLogoutUrl(config));
  assert.equal(logoutUrlWithoutHint.searchParams.has("id_token_hint"), false);
  assert.equal(logoutUrlWithoutHint.searchParams.has("post_logout_redirect_uri"), false);

  const logoutUrl = new URL(__testInternals.buildLogoutUrl(config, { idTokenHint: "id-token-1" }));
  assert.equal(logoutUrl.searchParams.get("id_token_hint"), "id-token-1");
  assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), "http://localhost:8080/api/auth/oidc/logout-callback");
  assert.equal(logoutUrl.searchParams.has("callback"), false);
});

test("desktop sso logout proxy failure renders signed-out page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    issuer: "http://127.0.0.1:65530/application/o/desktop/",
    authorizeUrl: "http://127.0.0.1:65530/o/authorize/",
    tokenUrl: "http://127.0.0.1:65530/application/o/token/",
    clientId: "desktop-client",
    browserOrigin: "http://127.0.0.1:65530",
    loginUrl: "http://127.0.0.1:65530/login",
    logoutUrl: "http://127.0.0.1:65530/auth/ssoLogout"
  });
  __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "user-1",
    iss: "http://127.0.0.1:65530",
    aud: "desktop-client",
    name: "Desktop User"
  }));

  const result = await logoutDesktopSso(app);
  assert.equal(result.ok, true, result.message);
  assert.match(result.browserUrl, /^http:\/\/localhost:8080\/auth\/ssoLogout/u);

  const response = await fetch(result.browserUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/u);
  assert.match(html, /已退出本地登录/u);
  assert.match(html, /本地登录状态已清除/u);
  assert.doesNotMatch(html, /Desktop SSO proxy failed/u);
  assert.doesNotMatch(html, /fetch failed/u);
});

test("desktop sso authorize URL keeps explicit OIDC prompt", () => {
  const config = {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    prompt: "login"
  };
  const authorizeUrl = new URL(__testInternals.buildAuthorizeUrl("state-1", config));
  assert.equal(authorizeUrl.searchParams.get("prompt"), "login");
});

test("desktop sso enriches OIDC token claims from configured userinfo endpoint", async () => {
  const fixture = createOidcTokenTestFixture();
  const idToken = createSignedJwt({
    sub: "user-1",
    iss: fixture.config.issuer,
    aud: fixture.config.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Token Name",
    email: "token@example.test"
  }, fixture.privateKey);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === fixture.tokenUrl) {
      return createJsonResponse({ id_token: idToken, access_token: "access-token-1" });
    }
    if (url === fixture.wellKnownUrl) {
      return createJsonResponse({ jwks_uri: fixture.jwksUrl });
    }
    if (url === fixture.jwksUrl) {
      return createJsonResponse({ keys: [fixture.publicJwk] });
    }
    if (url === fixture.userInfoUrl) {
      return createJsonResponse({
        sub: "user-1",
        name: "Userinfo Name",
        email: "userinfo@example.test",
        picture: "https://assets.example.test/avatar.png"
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await __testInternals.exchangeCodeForTokenClaims("code-1", fetchImpl, fixture.config);

  assert.equal(result.accessToken, "access-token-1");
  assert.equal(result.claims.sub, "user-1");
  assert.equal(result.claims.name, "Userinfo Name");
  assert.equal(result.claims.email, "userinfo@example.test");
  assert.equal(result.claims.avatarUrl, "https://assets.example.test/avatar.png");
  const userInfoCall = calls.find((call) => call.url === fixture.userInfoUrl);
  assert.equal(userInfoCall.init.headers.Authorization, "Bearer access-token-1");
});

test("desktop sso falls back to id_token claims when optional userinfo fails", async () => {
  const fixture = createOidcTokenTestFixture();
  const idToken = createSignedJwt({
    sub: "user-1",
    iss: fixture.config.issuer,
    aud: fixture.config.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Token Name",
    email: "token@example.test"
  }, fixture.privateKey);
  const fetchImpl = async (url) => {
    if (url === fixture.tokenUrl) {
      return createJsonResponse({ id_token: idToken, access_token: "access-token-1" });
    }
    if (url === fixture.wellKnownUrl) {
      return createJsonResponse({ jwks_uri: fixture.jwksUrl });
    }
    if (url === fixture.jwksUrl) {
      return createJsonResponse({ keys: [fixture.publicJwk] });
    }
    if (url === fixture.userInfoUrl) {
      return createJsonResponse("temporarily unavailable", { ok: false, status: 503, statusText: "Unavailable" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await __testInternals.exchangeCodeForTokenClaims("code-1", fetchImpl, fixture.config);

  assert.equal(result.claims.sub, "user-1");
  assert.equal(result.claims.name, "Token Name");
  assert.equal(result.claims.email, "token@example.test");
});

test("desktop sso skips userinfo when userInfo is not configured", async () => {
  const fixture = createOidcTokenTestFixture();
  const config = {
    ...fixture.config,
    userInfo: undefined
  };
  const idToken = createSignedJwt({
    sub: "user-1",
    iss: config.issuer,
    aud: config.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Token Name",
    email: "token@example.test"
  }, fixture.privateKey);
  const fetchImpl = async (url) => {
    if (url === fixture.tokenUrl) {
      return createJsonResponse({ id_token: idToken, access_token: "access-token-1" });
    }
    if (url === fixture.wellKnownUrl) {
      return createJsonResponse({ jwks_uri: fixture.jwksUrl });
    }
    if (url === fixture.jwksUrl) {
      return createJsonResponse({ keys: [fixture.publicJwk] });
    }
    if (url === fixture.userInfoUrl) {
      assert.fail("userinfo should not be fetched without userInfo config");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await __testInternals.exchangeCodeForTokenClaims("code-1", fetchImpl, config);

  assert.equal(result.claims.name, "Token Name");
  assert.equal(result.claims.email, "token@example.test");
});

test("desktop sso validates id_token with explicit jwksUrl without wellKnownUrl", async () => {
  const fixture = createOidcTokenTestFixture();
  const config = {
    ...fixture.config,
    wellKnownUrl: undefined,
    jwksUrl: fixture.jwksUrl,
    userInfo: undefined
  };
  const idToken = createSignedJwt({
    sub: "user-1",
    iss: config.issuer,
    aud: config.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Token Name"
  }, fixture.privateKey);
  const fetchImpl = async (url) => {
    if (url === fixture.tokenUrl) {
      return createJsonResponse({ id_token: idToken, access_token: "access-token-1" });
    }
    if (url === fixture.wellKnownUrl) {
      assert.fail("wellKnownUrl should not be fetched when only jwksUrl is configured");
    }
    if (url === fixture.jwksUrl) {
      return createJsonResponse({ keys: [fixture.publicJwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await __testInternals.exchangeCodeForTokenClaims("code-1", fetchImpl, config);

  assert.equal(result.claims.sub, "user-1");
  assert.equal(result.claims.name, "Token Name");
});

test("desktop sso accepts mode alias and embeded spelling", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    mode: "embeded",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");

  assert.equal(result.configured, true);
  assert.equal(result.config.browserMode, "embedded");
});

test("desktop sso uses configured claims fallback values", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: embeddedLoginOrigin,
    loginUrl: embeddedLoginUrl,
    appendLoginState: false,
    claims: {
      audience: "configured-desktop",
      cookieFallbackSub: "configured-cookie"
    }
  });

  const status = __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    iss: embeddedLoginOrigin,
    name: "Cookie User"
  }));

  assert.equal(status.authenticated, true);
  assert.equal(status.user.sub, "configured-cookie");
  assert.equal(status.user.audience, "configured-desktop");
  assert.equal(status.user.name, "Cookie User");
});
