import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  cancelDesktopSsoLogin,
  desktopSsoAccessTokenNeedsRefresh,
  exchangeConfiguredDesktopSsoCookieForAccessToken,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  logoutDesktopSso,
  prepareDesktopSsoSessionRestore,
  startDesktopSsoLogin,
  __testInternals
} = require("../dist-electron/main/oidc-sso.js");
const {
  DESKTOP_SSO_AVATAR_PROTOCOL
} = require("../dist-electron/shared/sso-avatar.js");

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

function writeSsoSession(app, session) {
  const stateRoot = getDesktopStateRoot(app);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-session.json"), `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
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

test("desktop sso access-token Cookie uses JWT exp and falls back to a session Cookie", () => {
  const expirationDate = Math.floor(Date.now() / 1000) + 3_600;
  const cookieConfig = {
    accessTokenCookie: {
      url: "https://ai.example.test",
      name: "access_token",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    }
  };
  const persistent = __testInternals.buildDesktopSsoAccessTokenCookieDetails(
    createUnsignedJwt({ sub: "user-1", exp: expirationDate }),
    cookieConfig
  );
  const sessionOnly = __testInternals.buildDesktopSsoAccessTokenCookieDetails(
    createUnsignedJwt({ sub: "user-1" }),
    cookieConfig
  );

  assert.equal(persistent[0].expirationDate, expirationDate);
  assert.equal("expirationDate" in sessionOnly[0], false);
});

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
        authMode: "bearer",
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

test("desktop sso server config does not inherit a browser logout URL", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-server-sso-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const config = {
    enabled: true,
    authMode: "server",
    browserMode: "system",
    issuer: "https://www.zenmind.cc",
    authorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    serverAuthorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    tokenUrl: "https://www.zenmind.cc/api/auth/desktop-sso/token",
    clientId: "zenmind-desktop",
    webSessionExchange: {
      url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
      provider: "zenmind"
    }
  };

  for (const logoutUrl of [undefined, ""]) {
    writeSsoConfig(app, {
      ...config,
      ...(logoutUrl === undefined ? {} : { logoutUrl })
    });
    const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
    assert.equal(result.configured, true);
    assert.equal(result.error, undefined);
    assert.equal(result.config.logoutUrl, "");
  }
});

test("desktop sso avatar cache exposes only the configured local protocol URL", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-avatar-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    authMode: "server",
    browserMode: "system",
    issuer: "https://www.zenmind.cc",
    authorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    serverAuthorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    tokenUrl: "https://www.zenmind.cc/api/auth/desktop-sso/token",
    clientId: "zenmind-desktop",
    avatarCache: {
      enabled: true,
      trustedOrigin: "https://www.zenmind.cc"
    },
    webSessionExchange: {
      url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
      provider: "zenmind"
    }
  });

  const sourceUrl = "https://www.zenmind.cc/api/auth/avatar/abc123";
  const status = __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "zenmind-user:6",
    iss: "https://www.zenmind.cc",
    aud: "zenmind-desktop",
    name: "Frank Linlay",
    picture: sourceUrl
  }));

  assert.equal(status.authenticated, true);
  assert.match(
    status.user.avatarUrl,
    new RegExp(`^${DESKTOP_SSO_AVATAR_PROTOCOL}://[a-f0-9]{24}/avatar$`, "u")
  );
  const stored = JSON.parse(
    fs.readFileSync(path.join(getDesktopStateRoot(app), "sso-user-info.json"), "utf8")
  );
  assert.equal(stored.avatarUrl, sourceUrl);
  const version = new URL(status.user.avatarUrl).hostname;
  assert.deepEqual(__testInternals.resolveDesktopSsoAvatarRequest(app, version), {
    sourceUrl,
    trustedOrigin: "https://www.zenmind.cc",
    version
  });

  const untrustedStatus = __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "zenmind-user:6",
    iss: "https://www.zenmind.cc",
    aud: "zenmind-desktop",
    name: "Frank Linlay",
    picture: "https://lh3.googleusercontent.com/avatar.png"
  }));
  assert.equal(untrustedStatus.user.avatarUrl, undefined);

  const emailStatus = __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "zenmind-user:9",
    iss: "https://www.zenmind.cc",
    aud: "zenmind-desktop",
    name: "Email User",
    email: "email-user@example.com"
  }));
  assert.equal(emailStatus.user.avatarUrl, undefined);
});

test("desktop sso server session logout never returns a browser URL", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-server-sso-logout-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    authMode: "server",
    browserMode: "system",
    issuer: "https://www.zenmind.cc",
    authorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    serverAuthorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    tokenUrl: "https://www.zenmind.cc/api/auth/desktop-sso/token",
    clientId: "zenmind-desktop",
    logoutUrl: "https://www.zenmind.cc/api/auth/logout",
    webSessionExchange: {
      url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
      provider: "zenmind"
    }
  });
  writeSsoSession(app, {
    schemaVersion: 2,
    authenticated: true,
    issuer: "https://www.zenmind.cc",
    audience: "zenmind-desktop",
    authMode: "server",
    updatedAt: "2026-07-30T15:31:26.402Z"
  });

  cancelDesktopSsoLogin(app, "simulate restart");
  const result = await logoutDesktopSso(app);

  assert.equal(result.ok, true);
  assert.equal(result.logoutUrl, undefined);
  assert.equal(result.browserUrl, undefined);
  assert.equal(result.openMode, undefined);
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

test("desktop sso exposes interactive login when config appears after runtime initialization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-late-config-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  const initial = prepareDesktopSsoSessionRestore(app);
  assert.equal(initial.status.configured, false);

  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://sso.example.test",
    loginUrl: "https://sso.example.test/api/login/oidc/start",
    loginCompletionUrls: ["https://sso.example.test/"],
    browserSession: {
      url: "https://sso.example.test/oauth2/auth",
      method: "GET",
      successStatuses: [200, 202],
      userInfoHeaders: { sub: "x-auth-request-user" }
    },
    cookieAccessTokenExchange: {
      url: "https://sso.example.test/authorization",
      method: "GET"
    }
  });

  const status = getDesktopSsoStatus(app);
  assert.equal(status.configured, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.pending, false);
  assert.equal(status.user, null);
  assert.deepEqual(status.completedSteps, {
    session: false,
    userInfo: false,
    accessToken: false
  });
  assert.equal(status.error, undefined);
});

test("desktop sso late config status refresh does not revive persisted credential candidates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-late-config-candidate-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  const stateRoot = getDesktopStateRoot(app);
  fs.mkdirSync(stateRoot, { recursive: true });
  writeSsoSession(app, {
    schemaVersion: 2,
    authenticated: true,
    issuer: "https://sso.example.test",
    audience: "desktop",
    authMode: "browser-cookie",
    updatedAt: "2026-08-03T00:00:00.000Z"
  });
  const userInfoPath = path.join(stateRoot, "sso-user-info.json");
  const accessTokenPath = path.join(stateRoot, "sso-access-token.txt");
  fs.writeFileSync(userInfoPath, `${JSON.stringify({
    schemaVersion: 2,
    source: "browser_session",
    sub: "persisted-user",
    issuer: "https://sso.example.test",
    audience: "desktop"
  })}\n`, "utf8");
  fs.writeFileSync(accessTokenPath, "persisted-access-token\n", "utf8");

  const initial = prepareDesktopSsoSessionRestore(app);
  assert.equal(initial.status.configured, false);

  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://sso.example.test",
    loginUrl: "https://sso.example.test/api/login/oidc/start",
    loginCompletionUrls: ["https://sso.example.test/"],
    browserSession: {
      url: "https://sso.example.test/oauth2/auth",
      method: "GET",
      successStatuses: [200],
      userInfoHeaders: { sub: "x-auth-request-user" }
    },
    cookieAccessTokenExchange: {
      url: "https://sso.example.test/authorization",
      method: "GET"
    }
  });

  const status = getDesktopSsoStatus(app);
  assert.equal(status.configured, true);
  assert.equal(status.authenticated, false);
  assert.deepEqual(status.completedSteps, {
    session: false,
    userInfo: false,
    accessToken: false
  });
  assert.equal(getDesktopSsoAccessToken(), null);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(userInfoPath), true);
  assert.equal(fs.existsSync(accessTokenPath), true);
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

test("desktop SSO publishes the canonical access token with an atomic rename", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-token-atomic-"));
  const app = createApp(path.join(root, "home"));
  const accessTokenPath = __testInternals.getDesktopSsoAccessTokenFilePath(app);
  const originalRenameSync = fs.renameSync;
  let temporaryPath = "";
  t.after(() => {
    fs.renameSync = originalRenameSync;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.renameSync = (from, to) => {
    if (to === accessTokenPath) {
      temporaryPath = from;
    }
    return originalRenameSync(from, to);
  };

  __testInternals.saveAccessTokenFile(app, "atomic-token");

  assert.equal(fs.readFileSync(accessTokenPath, "utf8"), "atomic-token\n");
  assert.equal(path.dirname(temporaryPath), path.dirname(accessTokenPath));
  assert.match(path.basename(temporaryPath), /^\.sso-access-token\.txt\..+\.tmp$/u);
  assert.equal(fs.existsSync(temporaryPath), false);
});

test("desktop SSO logout reports canonical access-token revocation failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-token-revoke-"));
  const app = createApp(path.join(root, "home"));
  const accessTokenPath = __testInternals.getDesktopSsoAccessTokenFilePath(app);
  fs.mkdirSync(path.dirname(accessTokenPath), { recursive: true });
  fs.writeFileSync(accessTokenPath, "stale-token\n", "utf8");
  const originalRmSync = fs.rmSync;
  t.after(() => {
    fs.rmSync = originalRmSync;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.rmSync = (target, options) => {
    if (target === accessTokenPath) {
      throw new Error("simulated access-token removal failure");
    }
    return originalRmSync(target, options);
  };

  const result = await logoutDesktopSso(app);

  assert.equal(result.ok, false);
  assert.match(result.message, /simulated access-token removal failure/u);
  assert.equal(fs.existsSync(accessTokenPath), true);
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
  assert.deepEqual(status.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: true
  });
  const sessionPath = path.join(getDesktopStateRoot(app), "sso-session.json");
  const accessTokenPath = __testInternals.getDesktopSsoAccessTokenFilePath(app);
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  assert.equal(session.schemaVersion, 2);
  assert.equal(session.authenticated, true);
  assert.equal("user" in session, false);
  assert.equal("accessToken" in session, false);
  const userInfoPath = __testInternals.getDesktopSsoUserInfoFilePath(app);
  const stored = JSON.parse(fs.readFileSync(userInfoPath, "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.sub, "user-1");
  assert.equal(stored.name, "Desktop User");
  assert.equal(stored.email, "desktop.user@example.test");
  assert.equal(stored.source, "sso");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(userInfoPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(accessTokenPath).mode & 0o777, 0o600);
  }
});

test("desktop sso persists verified browser-session user id before access token", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-stepwise-cookie-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: embeddedLoginOrigin,
    loginUrl: embeddedLoginUrl,
    appendLoginState: false,
    browserSession: {
      url: `${embeddedLoginOrigin}/oauth2/auth`,
      successStatuses: [200, 202],
      userInfoHeaders: {
        sub: "x-auth-request-user",
        name: "x-auth-request-preferred-username",
        email: "x-auth-request-email"
      }
    },
    userInfo: {
      url: `${embeddedLoginOrigin}/oauth2/userinfo`,
      authMode: "cookie",
      required: false,
      subPath: "user",
      namePath: "preferredUsername",
      emailPath: "email"
    },
    cookieAccessTokenExchange: {
      url: embeddedTokenExchangeUrl,
      method: "GET"
    }
  });

  const sessionStatus = __testInternals.completeDesktopSsoBrowserSession(app);
  const stateRoot = getDesktopStateRoot(app);
  const sessionPath = path.join(stateRoot, "sso-session.json");
  const userInfoPath = path.join(stateRoot, "sso-user-info.json");
  const accessTokenPath = path.join(stateRoot, "sso-access-token.txt");

  assert.equal(sessionStatus.authenticated, true);
  assert.equal(sessionStatus.user, null);
  assert.deepEqual(sessionStatus.completedSteps, {
    session: true,
    userInfo: false,
    accessToken: false
  });
  assert.equal(fs.existsSync(sessionPath), true);
  assert.equal(fs.existsSync(userInfoPath), false);
  assert.equal(fs.existsSync(accessTokenPath), false);

  const userStatus = __testInternals.completeDesktopSsoBrowserSessionUserInfo(app, {
    sub: "107078"
  });
  assert.equal(userStatus.authenticated, true);
  assert.equal(userStatus.user.sub, "107078");
  assert.equal(userStatus.user.name, "107078");
  assert.equal(userStatus.user.email, undefined);
  assert.deepEqual(userStatus.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: false
  });
  assert.equal(fs.existsSync(userInfoPath), true);
  assert.equal(fs.existsSync(accessTokenPath), false);

  const failedStatus = failDesktopSsoStep("token exchange returned 401");
  assert.equal(failedStatus.authenticated, true);
  assert.equal(failedStatus.user.sub, "107078");
  assert.equal(failedStatus.completedSteps.accessToken, false);
  assert.equal(fs.existsSync(sessionPath), true);
  assert.equal(fs.existsSync(userInfoPath), true);
  assert.equal(fs.existsSync(accessTokenPath), false);

  failDesktopSsoFlow("simulate restart");
  const restoredStatus = getDesktopSsoStatus(app);
  assert.equal(restoredStatus.authenticated, true);
  assert.equal(restoredStatus.user.sub, "107078");
  assert.equal(restoredStatus.user.name, "107078");
  assert.deepEqual(restoredStatus.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: false
  });
});

test("desktop sso preserves the current login while a replacement session is pending or fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-relogin-preserve-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fixture = createOidcTokenTestFixture();
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    ...fixture.config,
    enabled: true,
    browserMode: "system",
    redirectUri: "http://127.0.0.1:0/api/auth/oidc/callback",
    logoutCallbackUri: "http://127.0.0.1:0/api/auth/oidc/logout-callback",
    logoutUrl: ""
  });
  __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "current-user",
    iss: fixture.config.issuer,
    aud: fixture.config.clientId,
    name: "Current User"
  }));
  const stateRoot = getDesktopStateRoot(app);
  const credentialPaths = [
    path.join(stateRoot, "sso-session.json"),
    path.join(stateRoot, "sso-user-info.json"),
    path.join(stateRoot, "sso-access-token.txt")
  ];

  const started = await startDesktopSsoLogin(app);
  assert.equal(started.ok, true, started.message);
  assert.equal(started.status.authenticated, true);
  assert.equal(started.status.pending, true);
  assert.equal(started.status.user.sub, "current-user");
  assert.deepEqual(started.status.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: true
  });

  const failed = failDesktopSsoFlow("replacement session returned 401");
  assert.equal(failed.authenticated, true);
  assert.equal(failed.pending, false);
  assert.equal(failed.user.sub, "current-user");
  assert.equal(failed.completedSteps.accessToken, true);
  assert.equal(credentialPaths.every((filePath) => fs.existsSync(filePath)), true);
});

test("desktop sso restores legacy session user while new writes remain separated", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-legacy-session-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    enabled: true,
    browserMode: "system",
    logoutUrl: ""
  });
  const stateRoot = getDesktopStateRoot(app);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-session.json"), JSON.stringify({
    authenticated: true,
    user: {
      sub: "legacy-user",
      issuer: "https://legacy.example.test",
      audience: "desktop"
    },
    updatedAt: "2026-07-20T00:00:00.000Z"
  }), "utf8");

  failDesktopSsoFlow("load legacy session");
  const status = getDesktopSsoStatus(app);
  assert.equal(status.authenticated, true);
  assert.equal(status.user.sub, "legacy-user");
  assert.equal(status.completedSteps.session, true);
  assert.equal(status.completedSteps.userInfo, true);
  assert.equal(status.completedSteps.accessToken, false);
});

test("desktop sso keeps validated OIDC session, base userinfo, and access token when enrichment fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-stepwise-oidc-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fixture = createOidcTokenTestFixture();
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    ...fixture.config,
    enabled: true,
    browserMode: "system"
  });
  const claims = {
    sub: "oidc-user",
    issuer: fixture.config.issuer,
    audience: fixture.config.clientId,
    name: "OIDC User",
    email: "oidc.user@example.test"
  };

  const status = await __testInternals.completeValidatedOidcLogin(app, {
    claims,
    idToken: "validated-id-token",
    accessToken: "validated-access-token"
  }, async () => createJsonResponse("temporarily unavailable", {
    ok: false,
    status: 503,
    statusText: "Unavailable"
  }), fixture.config);

  assert.equal(status.authenticated, true);
  assert.deepEqual(status.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: true
  });
  const stateRoot = getDesktopStateRoot(app);
  const session = JSON.parse(fs.readFileSync(path.join(stateRoot, "sso-session.json"), "utf8"));
  const userInfo = JSON.parse(fs.readFileSync(path.join(stateRoot, "sso-user-info.json"), "utf8"));
  assert.equal(session.schemaVersion, 2);
  assert.equal("user" in session, false);
  assert.equal("idToken" in session, false);
  assert.equal(userInfo.source, "id_token");
  assert.equal(userInfo.sub, "oidc-user");
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), "validated-access-token");

  failDesktopSsoFlow("simulate restart");
  const restoredStatus = getDesktopSsoStatus(app);
  assert.equal(restoredStatus.authenticated, true);
  assert.equal(restoredStatus.completedSteps.accessToken, true);
  assert.equal(getDesktopSsoAccessToken(), "validated-access-token");
});

test("desktop sso restore removes the retired duplicate site token", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  const legacyTokenPath = path.join(path.dirname(path.dirname(getDesktopStateRoot(app))), "secrets", "sso-site-token.json");
  fs.mkdirSync(path.dirname(legacyTokenPath), { recursive: true });
  fs.writeFileSync(legacyTokenPath, `${JSON.stringify({ accessToken: "retired-token" })}\n`, "utf8");

  prepareDesktopSsoSessionRestore(app);

  assert.equal(fs.existsSync(legacyTokenPath), false);
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

test("desktop sso exchanges Cookie plus CSRF into the canonical token file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-cookie-token-exchange-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  const issuer = "https://www.zenmind.cc";
  const csrfUrl = `${issuer}/api/auth/csrf`;
  const tokenUrl = `${issuer}/api/auth/desktop-sso/token`;
  writeSsoConfig(app, {
    enabled: true,
    authMode: "server",
    browserMode: "system",
    issuer,
    authorizeUrl: `${issuer}/api/auth/desktop-sso/start`,
    serverAuthorizeUrl: `${issuer}/api/auth/desktop-sso/start`,
    tokenUrl,
    clientId: "zenmind-desktop",
    logoutUrl: `${issuer}/api/auth/logout`,
    webSessionExchange: {
      url: `${issuer}/api/auth/desktop-sso/session`,
      provider: "zenmind",
      cookieOrigins: [issuer]
    },
    cookieAccessTokenExchange: {
      url: tokenUrl,
      csrfUrl,
      method: "POST",
      body: {},
      accessTokenPath: "accessToken"
    }
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = createUnsignedJwt({
    sub: "desktop-user",
    iss: issuer,
    aud: ["market", "tunnel", "kanban", "zenmind-im-server"],
    scope: "profile market tunnel kanban im",
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 12 * 60 * 60
  });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url === csrfUrl) {
      return {
        ...createJsonResponse({ csrfToken: "csrf-token-1" }),
        headers: { get: () => "application/json" }
      };
    }
    assert.equal(url, tokenUrl);
    return {
      ...createJsonResponse({ accessToken: token }),
      headers: { get: () => "application/json" }
    };
  };

  const exchanged = await exchangeConfiguredDesktopSsoCookieForAccessToken(
    app,
    "zenmind_session=session-secret",
    fetchImpl
  );

  assert.equal(exchanged, token);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.Cookie, "zenmind_session=session-secret");
  assert.equal(requests[1].init.headers.Cookie, "zenmind_session=session-secret");
  assert.equal(requests[1].init.headers["X-CSRF-Token"], "csrf-token-1");
  assert.equal(
    fs.readFileSync(__testInternals.getDesktopSsoAccessTokenFilePath(app), "utf8").trim(),
    token
  );
  const legacyTokenPath = path.join(path.dirname(path.dirname(getDesktopStateRoot(app))), "secrets", "sso-site-token.json");
  assert.equal(fs.existsSync(legacyTokenPath), false);
  assert.equal(desktopSsoAccessTokenNeedsRefresh(app), false);
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
    browserSession: {
      url: `${embeddedLoginOrigin}/oauth2/auth`,
      successStatuses: [200, 202],
      userInfoHeaders: {
        sub: "x-auth-request-user",
        name: "x-auth-request-preferred-username",
        email: "x-auth-request-email"
      }
    },
    userInfo: {
      url: `${embeddedLoginOrigin}/oauth2/userinfo`,
      authMode: "cookie",
      required: false,
      subPath: "user",
      namePath: "preferredUsername",
      emailPath: "email"
    },
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
  assert.deepEqual(result.config.browserSession, {
    url: `${embeddedLoginOrigin}/oauth2/auth`,
    method: "GET",
    headers: {},
    successStatuses: [200, 202],
    userInfoHeaders: {
      sub: "x-auth-request-user",
      name: "x-auth-request-preferred-username",
      email: "x-auth-request-email"
    }
  });
  assert.deepEqual(result.config.userInfo, {
    enabled: true,
    required: false,
    authMode: "cookie",
    url: `${embeddedLoginOrigin}/oauth2/userinfo`,
    subPath: "user",
    namePath: "preferredUsername",
    emailPath: "email",
    avatarUrlPath: "picture"
  });
  assert.deepEqual(__testInternals.getDesktopSsoAccessTokenCookieLookup(app), {
    url: `${embeddedLoginOrigin}/`,
    name: "access_token"
  });
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

test("desktop sso OIDC session logout keeps the front-channel end-session flow", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-front-channel-logout-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const [name, session] of [
    ["current", { authMode: "oidc", idToken: "id-token-current" }],
    ["legacy", { idToken: "id-token-legacy" }]
  ]) {
    const app = createApp(path.join(root, name));
    writeSsoConfig(app, {
      enabled: true,
      authMode: "oidc",
      browserMode: "system",
      issuer: "https://auth.example.test/application/o/desktop/",
      authorizeUrl: "https://auth.example.test/o/authorize/",
      tokenUrl: "https://auth.example.test/application/o/token/",
      clientId: "zenmind-desktop",
      usePkce: true,
      wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
      logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
      logoutCallbackUri: "http://127.0.0.1:0/api/auth/oidc/logout-callback"
    });
    writeSsoSession(app, {
      schemaVersion: 2,
      authenticated: true,
      issuer: "https://auth.example.test/application/o/desktop/",
      audience: "zenmind-desktop",
      ...session,
      updatedAt: "2026-07-30T15:31:26.402Z"
    });

    cancelDesktopSsoLogin(app, `simulate ${name} restart`);
    const result = await logoutDesktopSso(app);
    const logoutUrl = new URL(result.logoutUrl);

    assert.equal(result.ok, true);
    assert.equal(result.openMode, "system");
    assert.equal(logoutUrl.origin, "https://auth.example.test");
    assert.equal(logoutUrl.pathname, "/application/o/desktop/end-session/");
    assert.equal(logoutUrl.searchParams.get("id_token_hint"), session.idToken);
    const postLogoutRedirect = new URL(logoutUrl.searchParams.get("post_logout_redirect_uri"));
    assert.equal(postLogoutRedirect.hostname, "127.0.0.1");
    assert.equal(postLogoutRedirect.pathname, "/api/auth/oidc/logout-callback");
    assert.notEqual(postLogoutRedirect.port, "");
    __testInternals.closeCallbackServer();
  }
});

test("desktop sso browser-cookie logout never returns a browser URL", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-browser-cookie-logout-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://app.example.test",
    loginUrl: "https://app.example.test/login",
    appendLoginState: false,
    loginCompletionUrls: ["https://app.example.test/"],
    logoutUrl: "https://app.example.test/logout"
  });
  __testInternals.completeDesktopSsoCookieLogin(app, createUnsignedJwt({
    sub: "user-1",
    iss: "https://app.example.test",
    aud: "desktop-client"
  }));

  const result = await logoutDesktopSso(app);

  assert.equal(result.ok, true);
  assert.equal(result.logoutUrl, undefined);
  assert.equal(result.browserUrl, undefined);
  assert.equal(result.openMode, undefined);
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
  writeSsoSession(app, {
    schemaVersion: 2,
    authenticated: true,
    issuer: "http://127.0.0.1:65530/application/o/desktop/",
    audience: "desktop-client",
    authMode: "oidc",
    updatedAt: "2026-07-30T15:31:26.402Z"
  });
  cancelDesktopSsoLogin(app, "simulate restart");

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
