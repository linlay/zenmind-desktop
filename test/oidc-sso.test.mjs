import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createSign, generateKeyPairSync } from "node:crypto";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  exchangeConfiguredDesktopSsoCookieForAccessToken,
  getDesktopSsoStatus,
  logoutDesktopSso,
  startDesktopSsoLogin
} = require("../dist-electron/main/oidc-sso.js");

const {
  DEFAULT_OIDC_CONFIG,
  DEFAULT_GOOGLE_OIDC_CONFIG,
  DESKTOP_SSO_CONFIG_FILE_NAME,
  buildAuthorizeUrl,
  createPkceCodeChallenge,
  buildDesktopSsoProxyUrl,
  buildReturnToAppUrl,
  buildDesktopSsoBrowserCookieDetails,
  rewriteDesktopSsoProxyLocation,
  rewriteDesktopSsoProxySetCookieHeader,
  getIdentityProviderCookieHosts,
  loadDesktopSsoConfig,
  resolveDesktopSsoConfigPath,
  buildTokenExchangeRequest,
  buildCookieAccessTokenExchangeRequest,
  buildDesktopSsoAccessTokenCookieDetails,
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoCookieLogin,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoAccessTokenFilePath,
  getDesktopSsoAccessTokenCookieLookup,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoWebSessionClearCookies,
  isDesktopSsoLoginCompletionUrl,
  readCookieAccessTokenFromResponse,
  normalizeCallbackRequest,
  getDefaultOidcFetch,
  exchangeCodeForTokenClaims,
  exchangeCodeForClaims,
  validateIdToken,
  renderCallbackHtml
} = __testInternals;

const TEST_INTERNAL_TLD = String.fromCharCode(110, 101, 116);
const TEST_VENDOR_HOST = String.fromCharCode(113, 105, 117, 101, 114);
const TEST_BROKER_HOSTNAME = String.fromCharCode(103, 116, 106, 97, 113, 104);
const TEST_AI_HOST = ["ai", TEST_VENDOR_HOST, TEST_INTERNAL_TLD].join(".");
const TEST_BROKER_HOST = [TEST_BROKER_HOSTNAME, TEST_INTERNAL_TLD].join(".");
const TEST_AI_ORIGIN = `https://${TEST_AI_HOST}`;
const TEST_AI_ROOT_URL = `${TEST_AI_ORIGIN}/`;
const TEST_AI_CALLBACK_URL = `${TEST_AI_ORIGIN}/oauth2/callback`;
const TEST_AI_TOKEN_URL = `${TEST_AI_ORIGIN}/api/auth/token`;
const TEST_AI_AUTHORIZATION_URL = `${TEST_AI_ORIGIN}/authorization`;
const TEST_AI_APP_URL = `${TEST_AI_ORIGIN}/app`;
const TEST_AI_LOGIN_URL = `${TEST_AI_ORIGIN}/login`;
const TEST_BROKER_ROOT_URL = `https://${TEST_BROKER_HOST}/`;

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createSignedJwt({ privateKey, kid, claims }) {
  const headerPart = encodeJwtPart({ alg: "RS256", typ: "JWT", kid });
  const payloadPart = encodeJwtPart(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerPart}.${payloadPart}`);
  signer.end();
  const signaturePart = signer.sign(privateKey).toString("base64url");
  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

function createTestApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "userData") {
        return path.join(homePath, "userData");
      }
      throw new Error(`unexpected app path ${name}`);
    }
  };
}

test("buildAuthorizeUrl creates an authorization-code URL with state and fixed localhost redirect", () => {
  const url = new URL(buildAuthorizeUrl("state-123"));

  assert.equal(url.origin + url.pathname, "https://iam.example.com/auth/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("prompt"), "login");
});

test("Google provider builds a PKCE authorization URL for loopback redirects", () => {
  const codeVerifier = "google-desktop-code-verifier";
  const redirectUri = "http://127.0.0.1:43123/api/auth/oidc/callback";
  const url = new URL(buildAuthorizeUrl("state-123", {
    ...DEFAULT_GOOGLE_OIDC_CONFIG,
    clientId: "google-desktop-client"
  }, {
    redirectUri,
    codeChallenge: createPkceCodeChallenge(codeVerifier)
  }));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "google-desktop-client");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createPkceCodeChallenge(codeVerifier));
  assert.equal(url.searchParams.has("prompt"), false);
});

test("buildAuthorizeUrl preserves configured hash login URL params and only replaces state", () => {
  const loginUrl = "https://iam.example.com/#/login?service=yrlvk3yqqwa70xv6yq9y4q&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fauth%2Foidc%2Fcallback&state=placeholder&prompt=login&client_id=MTdjNzdjZTU3ZTExNDUzMWJmMjk4OTQ4MzdkNzY1YmU&sourceApp=Desktop";
  const url = new URL(buildAuthorizeUrl("runtime-state", {
    ...DEFAULT_OIDC_CONFIG,
    loginUrl
  }));
  const hashQuery = url.hash.slice(url.hash.indexOf("?") + 1);
  const hashParams = new URLSearchParams(hashQuery);

  assert.equal(url.origin, "https://iam.example.com");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash.startsWith("#/login?"), true);
  assert.equal(hashParams.get("service"), "yrlvk3yqqwa70xv6yq9y4q");
  assert.equal(hashParams.get("response_type"), "code");
  assert.equal(hashParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(hashParams.get("state"), "runtime-state");
  assert.equal(hashParams.get("prompt"), "login");
  assert.equal(hashParams.get("client_id"), "MTdjNzdjZTU3ZTExNDUzMWJmMjk4OTQ4MzdkNzY1YmU");
  assert.equal(hashParams.get("sourceApp"), "Desktop");
});

test("getDesktopSsoStatus hides Desktop SSO when the home config file is missing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-default-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const status = getDesktopSsoStatus(createTestApp(path.join(root, "home")));

  assert.equal(status.configured, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.pending, false);
  assert.equal(status.user, null);
  assert.equal(status.error, undefined);
});

test("loadDesktopSsoConfig requires enabled true before exposing the login entry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-disabled-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });

  for (const content of [
    JSON.stringify({ enabled: false, identityProviderHost: "business.example.com" }),
    JSON.stringify({ identityProviderHost: "business.example.com" }),
    "business.example.com"
  ]) {
    fs.writeFileSync(path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME), content, "utf8");

    const result = loadDesktopSsoConfig(createTestApp(homePath));

    assert.equal(result.configured, false);
    assert.equal(result.message, "未配置 Desktop 单点登录。");
  }
});

test("loadDesktopSsoConfig does not rewrite copied OIDC endpoints from a bare IAM host", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({ enabled: true, identityProviderHost: "business.example.com" }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.authorizeUrl, DEFAULT_OIDC_CONFIG.authorizeUrl);
  assert.equal(result.config.tokenUrl, DEFAULT_OIDC_CONFIG.tokenUrl);
  assert.equal(result.config.wellKnownUrl, DEFAULT_OIDC_CONFIG.wellKnownUrl);
  assert.equal(result.config.logoutUrl, DEFAULT_OIDC_CONFIG.logoutUrl);
  assert.equal(result.config.redirectUri, DEFAULT_OIDC_CONFIG.redirectUri);
  assert.equal(result.config.clientId, DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(result.config.browserOrigin, "https://business.example.com");
});

test("loadDesktopSsoConfig honors explicit copied IAM OIDC URLs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-explicit-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      issuer: "https://iam.example.com/auth/oidc/app-id",
      authorizeUrl: "https://iam.example.com/auth/oauth2/authorize",
      tokenUrl: "https://iam.example.com/auth/oauth2/token",
      wellKnownUrl: "https://iam.example.com/auth/oidc/app-id/.well-known/openid-configuration",
      logoutUrl: "https://iam.example.com/auth/ssoLogout"
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.authorizeUrl, "https://iam.example.com/auth/oauth2/authorize");
  assert.equal(result.config.tokenUrl, "https://iam.example.com/auth/oauth2/token");
  assert.equal(result.config.wellKnownUrl, "https://iam.example.com/auth/oidc/app-id/.well-known/openid-configuration");
  assert.equal(result.config.logoutUrl, "https://iam.example.com/auth/ssoLogout");
  assert.equal(result.config.clientId, DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(result.config.browserOrigin, undefined);
});

test("loadDesktopSsoConfig honors explicit full IAM login URL", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-login-url-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  const loginUrl = "https://iam.example.com/#/login?service=svc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fauth%2Foidc%2Fcallback&state=old&prompt=login&client_id=desktop&sourceApp=Desktop";
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl,
      clientId: "desktop",
      clientSecret: "secret"
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.loginUrl, loginUrl);
  assert.equal(result.config.clientId, "desktop");
  assert.equal(result.config.clientSecret, "secret");
});

test("loadDesktopSsoConfig requires Google desktop OAuth client secret", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-google-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client"
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.match(result.error, /Google Desktop SSO 需要配置 clientSecret/);
});

test("loadDesktopSsoConfig supports Google desktop OAuth with a client secret", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-google-config-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret"
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.provider, "google");
  assert.equal(result.config.issuer, "https://accounts.google.com");
  assert.equal(result.config.authorizeUrl, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(result.config.tokenUrl, "https://oauth2.googleapis.com/token");
  assert.equal(result.config.wellKnownUrl, "https://accounts.google.com/.well-known/openid-configuration");
  assert.equal(result.config.clientId, "google-desktop-client");
  assert.equal(result.config.clientSecret, "google-desktop-secret");
  assert.equal(result.config.scope, "openid email profile");
  assert.equal(result.config.usePkce, true);
});

test("loadDesktopSsoConfig supports Google desktop web session exchange", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-google-web-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret",
      webSessionExchange: {
        url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
        cookieOrigins: ["https://www.zenmind.cc/app"],
        clearCookies: [
          {
            url: "https://www.zenmind.cc",
            name: "__Host-zm_session"
          }
        ]
      }
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const result = loadDesktopSsoConfig(app);

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.provider, "google");
  assert.equal(result.config.usePkce, true);
  assert.deepEqual(getDesktopSsoWebSessionExchangeConfig(app), {
    url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
    cookieOrigins: ["https://www.zenmind.cc"],
    clearCookies: [
      {
        url: "https://www.zenmind.cc/",
        name: "__Host-zm_session"
      }
    ]
  });
  assert.deepEqual(getDesktopSsoWebSessionClearCookies(app), [
    {
      url: "https://www.zenmind.cc/",
      name: "__Host-zm_session"
    }
  ]);
});

test("loadDesktopSsoConfig infers Google desktop OAuth from Google endpoints and ignores legacy web login fields", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-google-inferred-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret",
      loginUrl: "https://zenmind.cc/login",
      redirectUri: "https://zenmind.cc/api/v1/auth/google/callback",
      browserOrigin: "https://zenmind.cc",
      loginCompletionUrls: [
        "https://zenmind.cc/"
      ],
      cookieAccessTokenExchange: {
        url: "https://zenmind.cc/api/v1/auth/desktop/token",
        method: "post",
        accessTokenPath: "access_token"
      },
      accessTokenCookie: {
        url: "https://zenmind.cc",
        name: "access_token"
      },
      logoutUrl: "https://zenmind.cc/logout"
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.provider, "google");
  assert.equal(result.config.clientId, "google-desktop-client");
  assert.equal(result.config.clientSecret, "google-desktop-secret");
  assert.equal(result.config.loginUrl, undefined);
  assert.equal(result.config.redirectUri, DEFAULT_GOOGLE_OIDC_CONFIG.redirectUri);
  assert.equal(result.config.browserOrigin, undefined);
  assert.equal(result.config.loginCompletionUrls, undefined);
  assert.equal(result.config.cookieAccessTokenExchange, undefined);
  assert.equal(result.config.accessTokenCookie, undefined);
  assert.equal(result.config.webSessionExchange, undefined);
  assert.equal(result.config.logoutUrl, "");
  assert.equal(result.config.usePkce, true);
});

test("loadDesktopSsoConfig supports configurable AI login and cookie access token exchange", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-cookie-token-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      browserOrigin: TEST_AI_ORIGIN,
      loginCompletionUrl: TEST_AI_CALLBACK_URL,
      cookieAccessTokenExchange: {
        url: "/api/auth/token",
        method: "post",
        headers: {
          "X-Desktop-Client": "ZenMind"
        },
        body: {
          source: "desktop"
        },
        accessTokenPath: "data.access_token"
      },
      accessTokenCookie: {
        url: TEST_AI_ORIGIN,
        name: "ai_access_token",
        httpOnly: false
      }
    }),
    "utf8"
  );

  const result = loadDesktopSsoConfig(createTestApp(homePath));

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.loginUrl, TEST_AI_ROOT_URL);
  assert.equal(result.config.browserOrigin, TEST_AI_ORIGIN);
  assert.equal(result.config.loginCompletionUrl, TEST_AI_CALLBACK_URL);
  assert.deepEqual(result.config.cookieAccessTokenExchange, {
    url: TEST_AI_TOKEN_URL,
    method: "POST",
    headers: {
      "X-Desktop-Client": "ZenMind",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ source: "desktop" }),
    accessTokenPath: "data.access_token"
  });
  assert.deepEqual(result.config.accessTokenCookie, {
    url: TEST_AI_ROOT_URL,
    name: "ai_access_token",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax"
  });
});

test("direct AI login can preserve the configured URL and complete with browser cookies only", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-ai-cookie-login-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      appendLoginState: false,
      browserOrigin: TEST_AI_ORIGIN,
      loginCompletionUrl: TEST_AI_CALLBACK_URL
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const result = loadDesktopSsoConfig(app);

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.equal(result.config.appendLoginState, false);
  assert.equal(buildAuthorizeUrl("runtime-state", result.config), TEST_AI_ROOT_URL);
  assert.equal(isDesktopSsoLoginCompletionUrl(app, `${TEST_AI_CALLBACK_URL}?code=abc`), true);

  const status = completeDesktopSsoBrowserLogin(app, `${TEST_AI_CALLBACK_URL}?code=abc`);

  assert.equal(status.authenticated, true);
  assert.equal(status.user.sub, TEST_AI_HOST);
  assert.equal("accessToken" in status, false);
});

test("startDesktopSsoLogin uses an ephemeral 127.0.0.1 loopback server for Google", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-google-loopback-"));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret"
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  t.after(async () => {
    await logoutDesktopSso(app);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await startDesktopSsoLogin(app);
  const url = new URL(result.authorizeUrl);
  const redirectUri = new URL(url.searchParams.get("redirect_uri"));

  assert.equal(result.ok, true);
  assert.equal(result.openMode, "system");
  assert.equal(result.browserUrl, undefined);
  assert.equal(redirectUri.hostname, "127.0.0.1");
  assert.notEqual(redirectUri.port, "");
  assert.equal(redirectUri.pathname, "/api/auth/oidc/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
});

test("OIDC return-to-app endpoint responds without consuming the auth callback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-return-to-app-"));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret"
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  let returnRequests = 0;
  t.after(async () => {
    await logoutDesktopSso(app);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await startDesktopSsoLogin(app, {
    onReturnToAppRequested: () => {
      returnRequests += 1;
    }
  });
  const authorizeUrl = new URL(result.authorizeUrl);
  const redirectUri = new URL(authorizeUrl.searchParams.get("redirect_uri"));
  const response = await fetch(buildReturnToAppUrl(redirectUri.origin));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(returnRequests, 1);
  assert.match(html, /可以关闭此浏览器页面。/);
});

test("direct AI login can complete on a logged-in page and inject token cookies into configured targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-ai-authorization-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      appendLoginState: false,
      browserOrigin: TEST_AI_ORIGIN,
      loginCompletionUrls: [
        TEST_AI_CALLBACK_URL,
        TEST_AI_ROOT_URL
      ],
      cookieAccessTokenExchange: {
        url: TEST_AI_AUTHORIZATION_URL,
        accessTokenPath: "access_token"
      },
      accessTokenCookies: [
        {
          url: TEST_AI_ROOT_URL,
          name: "access_token",
          httpOnly: false
        },
        {
          url: TEST_BROKER_ROOT_URL,
          name: "access_token",
          httpOnly: false
        }
      ]
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const result = loadDesktopSsoConfig(app);

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.config.loginCompletionUrls, [
    TEST_AI_CALLBACK_URL,
    TEST_AI_ROOT_URL
  ]);
  assert.equal(result.config.cookieAccessTokenExchange.url, TEST_AI_AUTHORIZATION_URL);
  assert.equal(isDesktopSsoLoginCompletionUrl(app, TEST_AI_ROOT_URL), true);
  assert.equal(isDesktopSsoLoginCompletionUrl(app, `${TEST_AI_ROOT_URL}?from=desktop`), true);
  assert.equal(isDesktopSsoLoginCompletionUrl(app, TEST_AI_LOGIN_URL), false);
  assert.deepEqual(getDesktopSsoAccessTokenCookieLookups(app), [
    {
      url: TEST_AI_ROOT_URL,
      name: "access_token"
    },
    {
      url: TEST_BROKER_ROOT_URL,
      name: "access_token"
    }
  ]);
  assert.deepEqual(buildDesktopSsoAccessTokenCookieDetails("token-123", result.config), [
    {
      url: TEST_AI_ROOT_URL,
      name: "access_token",
      value: "token-123",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    },
    {
      url: TEST_BROKER_ROOT_URL,
      name: "access_token",
      value: "token-123",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    }
  ]);
});

test("direct AI login defaults cookie access_token exchange to the authorization endpoint", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-ai-default-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      appendLoginState: false,
      browserOrigin: TEST_AI_ORIGIN
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const result = loadDesktopSsoConfig(app);

  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.config.cookieAccessTokenExchange, {
    url: TEST_AI_AUTHORIZATION_URL,
    method: "GET",
    headers: {},
    accessTokenPath: "access_token"
  });
  assert.deepEqual(result.config.accessTokenCookie, {
    url: TEST_AI_ROOT_URL,
    name: "access_token",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax"
  });
  assert.equal(getDesktopSsoCookieAccessTokenExchangeUrl(app), TEST_AI_AUTHORIZATION_URL);
});

test("resolveDesktopSsoConfigPath uses platform-specific home paths", () => {
  assert.equal(
    resolveDesktopSsoConfigPath(createTestApp("/Users/tester"), "darwin"),
    "/Users/tester/.zenmind/desktop-sso.json"
  );
  assert.equal(
    resolveDesktopSsoConfigPath(createTestApp("C:\\Users\\tester"), "win32"),
    "C:\\Users\\tester\\.zenmind\\desktop-sso.json"
  );
});

test("getIdentityProviderCookieHosts targets the IAM host used by Chrome login", () => {
  assert.deepEqual(getIdentityProviderCookieHosts(), ["iam.example.com"]);
});

test("buildDesktopSsoProxyUrl keeps the browser on the localhost callback origin", () => {
  assert.equal(
    buildDesktopSsoProxyUrl("https://iam.example.com/auth/oauth2/authorize?client_id=desktop#frag"),
    "http://localhost:8080/auth/oauth2/authorize?client_id=desktop#frag"
  );
});

test("OIDC callback success page renders a return-to-app button on the loopback origin", () => {
  const returnUrl = buildReturnToAppUrl("http://127.0.0.1:60456");
  const html = renderCallbackHtml(
    "登录成功",
    "107554318085010644350 已完成单点登录，可以回到 Desktop 继续使用。",
    {
      actionHref: returnUrl,
      actionLabel: "回到 ZenMind"
    }
  );

  assert.equal(returnUrl, "http://127.0.0.1:60456/api/auth/oidc/return-to-app");
  assert.match(html, /登录成功/);
  assert.match(html, /回到 ZenMind/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:60456\/api\/auth\/oidc\/return-to-app"/);
});

test("rewriteDesktopSsoProxyLocation maps IAM redirects back through the localhost proxy", () => {
  const upstreamRequestUrl = new URL("https://iam.example.com/auth/oauth2/authorize?client_id=desktop");

  assert.equal(
    rewriteDesktopSsoProxyLocation("https://iam.example.com/#/login?service=svc", upstreamRequestUrl),
    "http://localhost:8080/#/login?service=svc"
  );
  assert.equal(
    rewriteDesktopSsoProxyLocation("/auth/sso/redirect/abc?next=1", upstreamRequestUrl),
    "http://localhost:8080/auth/sso/redirect/abc?next=1"
  );
  assert.equal(
    rewriteDesktopSsoProxyLocation("http://localhost:8080/api/auth/oidc/callback?code=abc", upstreamRequestUrl),
    "http://localhost:8080/api/auth/oidc/callback?code=abc"
  );
});

test("rewriteDesktopSsoProxySetCookieHeader makes IAM cookies usable on localhost", () => {
  assert.equal(
    rewriteDesktopSsoProxySetCookieHeader("iauth=abc; Path=/; Domain=iam.example.com; Secure; HttpOnly; SameSite=None"),
    "iauth=abc; Path=/; HttpOnly; SameSite=Lax"
  );
});

test("buildDesktopSsoBrowserCookieDetails mirrors proxy cookies to business-visible IAM origins", () => {
  assert.deepEqual(
    buildDesktopSsoBrowserCookieDetails(
      new Map([["iauth", "abc"]]),
      { ...DEFAULT_OIDC_CONFIG, browserOrigin: "https://business.example.com" }
    ),
    [
      {
        url: "https://iam.example.com",
        name: "iauth",
        value: "abc",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      },
      {
        url: "https://business.example.com",
        name: "iauth",
        value: "abc",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      }
    ]
  );
});

test("buildTokenExchangeRequest posts the document-style token URL from the main-process config", () => {
  const request = buildTokenExchangeRequest("callback-code");
  const url = new URL(request.url);

  assert.equal(url.origin + url.pathname, "https://iam.example.com/auth/oauth2/token");
  assert.equal(request.method, "POST");
  assert.equal(url.searchParams.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(url.searchParams.get("client_secret"), DEFAULT_OIDC_CONFIG.clientSecret);
  assert.equal(url.searchParams.get("redirect_uri"), DEFAULT_OIDC_CONFIG.redirectUri);
  assert.equal(url.searchParams.get("grant_type"), "authorization_code");
  assert.equal(url.searchParams.get("code"), "callback-code");
  assert.equal(request.body, undefined);
  assert.equal("Content-Type" in request.headers, false);
});

test("buildTokenExchangeRequest sends Google desktop PKCE exchanges as form-urlencoded body", () => {
  const redirectUri = "http://127.0.0.1:43123/api/auth/oidc/callback";
  const request = buildTokenExchangeRequest("callback-code", {
    ...DEFAULT_GOOGLE_OIDC_CONFIG,
    clientId: "google-desktop-client",
    clientSecret: "google-desktop-secret"
  }, {
    redirectUri,
    codeVerifier: "pkce-verifier"
  });
  const body = new URLSearchParams(request.body);

  assert.equal(request.url, "https://oauth2.googleapis.com/token");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(body.get("client_id"), "google-desktop-client");
  assert.equal(body.get("client_secret"), "google-desktop-secret");
  assert.equal(body.get("redirect_uri"), redirectUri);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "callback-code");
  assert.equal(body.get("code_verifier"), "pkce-verifier");
});

test("default OIDC fetch provider uses Electron net.fetch when available", async () => {
  const calls = [];
  const fetchImpl = getDefaultOidcFetch({
    net: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      }
    }
  });

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: "grant_type=authorization_code"
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    {
      url: "https://oauth2.googleapis.com/token",
      init: {
        method: "POST",
        headers: { Accept: "application/json" },
        body: "grant_type=authorization_code"
      }
    }
  ]);
});

test("exchangeCodeForClaims reports Google token exchange network failures with stage context", async () => {
  const redirectUri = "http://127.0.0.1:43123/api/auth/oidc/callback";
  const error = Object.assign(new TypeError("fetch failed"), {
    cause: new Error("connect ETIMEDOUT 142.250.0.1:443")
  });

  await assert.rejects(
    () => exchangeCodeForClaims(
      "callback-code",
      async () => {
        throw error;
      },
      {
        ...DEFAULT_GOOGLE_OIDC_CONFIG,
        clientId: "google-desktop-client",
        clientSecret: "google-desktop-secret"
      },
      {
        redirectUri,
        codeVerifier: "pkce-verifier"
      }
    ),
    /Google token exchange failed: fetch failed - connect ETIMEDOUT/
  );
});

test("buildCookieAccessTokenExchangeRequest sends cookies and extracts configured access token path", () => {
  const config = {
    ...DEFAULT_OIDC_CONFIG,
    cookieAccessTokenExchange: {
      url: TEST_AI_TOKEN_URL,
      method: "POST",
      headers: {
        "X-Desktop-Client": "ZenMind"
      },
      body: "{}",
      accessTokenPath: "data.access_token"
    }
  };
  const request = buildCookieAccessTokenExchangeRequest("sid=abc; iam=def", config);

  assert.deepEqual(request, {
    url: TEST_AI_TOKEN_URL,
    method: "POST",
    headers: {
      Accept: "text/plain,application/json,*/*",
      "X-Desktop-Client": "ZenMind",
      Cookie: "sid=abc; iam=def"
    },
    body: "{}"
  });
  assert.equal(readCookieAccessTokenFromResponse({ data: { access_token: "token-123" } }, config), "token-123");
  assert.throws(
    () => readCookieAccessTokenFromResponse({ data: {} }, config),
    /access_token/i
  );
});

test("login completion URL and access token cookie injection are configurable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-cookie-injection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      browserOrigin: TEST_AI_ORIGIN,
      loginCompletionUrl: TEST_AI_CALLBACK_URL,
      cookieAccessTokenExchange: {
        url: TEST_AI_TOKEN_URL
      },
      accessTokenCookie: {
        url: TEST_AI_APP_URL,
        name: "desktop_token",
        sameSite: "none"
      }
    }),
    "utf8"
  );
  const app = createTestApp(homePath);

  assert.equal(isDesktopSsoLoginCompletionUrl(app, `${TEST_AI_CALLBACK_URL}?code=abc`), true);
  assert.equal(isDesktopSsoLoginCompletionUrl(app, TEST_AI_ROOT_URL), false);
  assert.deepEqual(getDesktopSsoAccessTokenCookieLookup(app), {
    url: TEST_AI_APP_URL,
    name: "desktop_token"
  });
  assert.deepEqual(buildDesktopSsoAccessTokenCookieDetails("token-123", loadDesktopSsoConfig(app).config), [
    {
      url: TEST_AI_APP_URL,
      name: "desktop_token",
      value: "token-123",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "no_restriction"
    }
  ]);
  const status = completeDesktopSsoCookieLogin(app, "token-123");

  assert.equal(status.authenticated, true);
  assert.equal(status.user.sub, "desktop-sso-cookie");
  assert.equal("accessToken" in status, false);
});

test("cookie access_token exchange persists the token file and logout removes it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-token-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      appendLoginState: false,
      browserOrigin: TEST_AI_ORIGIN
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const tokenFilePath = getDesktopSsoAccessTokenFilePath(app);

  assert.equal(fs.existsSync(tokenFilePath), false);

  const accessToken = await exchangeConfiguredDesktopSsoCookieForAccessToken(app, "sid=cookie-123", async () => ({
    ok: true,
    json: async () => ({ access_token: "token-123" })
  }));

  assert.equal(accessToken, "token-123");
  assert.equal(fs.readFileSync(tokenFilePath, "utf8"), "token-123\n");
  assert.equal(fs.statSync(tokenFilePath).mode & 0o777, 0o600);

  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({ enabled: false }),
    "utf8"
  );
  await logoutDesktopSso(app);

  assert.equal(fs.existsSync(tokenFilePath), false);
});

test("cookie access_token exchange accepts a plain text token response", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-text-token-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      loginUrl: TEST_AI_ROOT_URL,
      appendLoginState: false,
      browserOrigin: TEST_AI_ORIGIN
    }),
    "utf8"
  );
  const app = createTestApp(homePath);
  const tokenFilePath = getDesktopSsoAccessTokenFilePath(app);
  const calls = [];

  const accessToken = await exchangeConfiguredDesktopSsoCookieForAccessToken(app, "sid=cookie-123", async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/plain;charset=UTF-8" : null;
        }
      },
      text: async () => "token-from-plain-text\n",
      json: async () => {
        throw new Error("plain text token should not be parsed as JSON");
      }
    };
  });

  assert.equal(accessToken, "token-from-plain-text");
  assert.equal(fs.readFileSync(tokenFilePath, "utf8"), "token-from-plain-text\n");
  assert.equal(calls[0].url, TEST_AI_AUTHORIZATION_URL);
  assert.equal(calls[0].init.headers.Accept, "text/plain,application/json,*/*");
});

test("normalizeCallbackRequest rejects missing, mismatched, and reused authorization codes", () => {
  const usedCodes = new Set();

  assert.throws(
    () => normalizeCallbackRequest(new URL("http://localhost:8080/api/auth/oidc/callback?state=expected"), "expected", usedCodes),
    /missing authorization code/i
  );
  assert.throws(
    () => normalizeCallbackRequest(new URL("http://localhost:8080/api/auth/oidc/callback?code=abc&state=wrong"), "expected", usedCodes),
    /state mismatch/i
  );

  assert.deepEqual(
    normalizeCallbackRequest(new URL("http://localhost:8080/api/auth/oidc/callback?code=abc&state=expected"), "expected", usedCodes),
    { code: "abc", state: "expected" }
  );
  assert.throws(
    () => normalizeCallbackRequest(new URL("http://localhost:8080/api/auth/oidc/callback?code=abc&state=expected"), "expected", usedCodes),
    /already been used/i
  );
});

test("validateIdToken verifies RS256 signature, issuer, audience, and returns public claims", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "desktop-sso-test-key";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = createSignedJwt({
    privateKey,
    kid,
    claims: {
      iss: DEFAULT_OIDC_CONFIG.issuer,
      aud: DEFAULT_OIDC_CONFIG.clientId,
      sub: "user-001",
      name: "测试用户",
      email: "user@example.com",
      iat: nowSeconds,
      exp: nowSeconds + 300
    }
  });
  const jwk = publicKey.export({ format: "jwk" });
  const fetchImpl = async (url) => {
    if (url === DEFAULT_OIDC_CONFIG.wellKnownUrl) {
      return {
        ok: true,
        json: async () => ({ jwks_uri: "https://iam.example.com/auth/oidc/jwks" })
      };
    }
    if (url === "https://iam.example.com/auth/oidc/jwks") {
      return {
        ok: true,
        json: async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] })
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  assert.deepEqual(await validateIdToken(token, fetchImpl), {
    sub: "user-001",
    name: "测试用户",
    email: "user@example.com",
    issuer: DEFAULT_OIDC_CONFIG.issuer,
    audience: DEFAULT_OIDC_CONFIG.clientId
  });
});

test("exchangeCodeForTokenClaims preserves the raw id_token internally", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "desktop-sso-token-claims-key";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = createSignedJwt({
    privateKey,
    kid,
    claims: {
      iss: DEFAULT_OIDC_CONFIG.issuer,
      aud: DEFAULT_OIDC_CONFIG.clientId,
      sub: "user-claims",
      iat: nowSeconds,
      exp: nowSeconds + 300
    }
  });
  const jwk = publicKey.export({ format: "jwk" });
  const fetchImpl = async (url) => {
    if (url.startsWith(DEFAULT_OIDC_CONFIG.tokenUrl)) {
      return {
        ok: true,
        json: async () => ({ id_token: token })
      };
    }
    if (url === DEFAULT_OIDC_CONFIG.wellKnownUrl) {
      return {
        ok: true,
        json: async () => ({ jwks_uri: "https://iam.example.com/auth/oidc/jwks" })
      };
    }
    if (url === "https://iam.example.com/auth/oidc/jwks") {
      return {
        ok: true,
        json: async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] })
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await exchangeCodeForTokenClaims("callback-code", fetchImpl);

  assert.equal(result.idToken, token);
  assert.deepEqual(result.claims, {
    sub: "user-claims",
    issuer: DEFAULT_OIDC_CONFIG.issuer,
    audience: DEFAULT_OIDC_CONFIG.clientId
  });
  assert.deepEqual(await exchangeCodeForClaims("callback-code", fetchImpl), result.claims);
});

test("validateIdToken reports Google discovery network failures with stage context", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const googleConfig = {
    ...DEFAULT_GOOGLE_OIDC_CONFIG,
    clientId: "google-desktop-client"
  };
  const token = createSignedJwt({
    privateKey,
    kid: "google-test-key",
    claims: {
      iss: googleConfig.issuer,
      aud: googleConfig.clientId,
      sub: "user-001",
      iat: nowSeconds,
      exp: nowSeconds + 300
    }
  });

  await assert.rejects(
    () => validateIdToken(
      token,
      async () => {
        throw new TypeError("fetch failed");
      },
      googleConfig
    ),
    /Google OIDC discovery failed: fetch failed/
  );
});

test("validateIdToken reports Google JWKS network failures with stage context", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const googleConfig = {
    ...DEFAULT_GOOGLE_OIDC_CONFIG,
    clientId: "google-desktop-client"
  };
  const token = createSignedJwt({
    privateKey,
    kid: "google-test-key",
    claims: {
      iss: googleConfig.issuer,
      aud: googleConfig.clientId,
      sub: "user-001",
      iat: nowSeconds,
      exp: nowSeconds + 300
    }
  });
  const fetchImpl = async (url) => {
    if (url === googleConfig.wellKnownUrl) {
      return {
        ok: true,
        json: async () => ({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" })
      };
    }
    throw Object.assign(new TypeError("fetch failed"), {
      cause: new Error("connect ETIMEDOUT 142.250.0.1:443")
    });
  };

  await assert.rejects(
    () => validateIdToken(token, fetchImpl, googleConfig),
    /Google JWKS fetch failed: fetch failed - connect ETIMEDOUT/
  );
});

test("getDesktopSsoStatus exposes only public session state", () => {
  const status = getDesktopSsoStatus();

  assert.equal(typeof status.authenticated, "boolean");
  assert.equal("accessToken" in status, false);
  assert.equal("idToken" in status, false);
  assert.equal("clientSecret" in status, false);
});

test("OIDC client secret is absent from renderer and preload bundles", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const sensitiveBundles = [
    path.join(projectRoot, "dist-renderer"),
    path.join(projectRoot, "dist-electron", "preload"),
    path.join(projectRoot, "build", "bundle", "dist-electron", "preload")
  ];

  for (const bundleRoot of sensitiveBundles) {
    if (!fs.existsSync(bundleRoot)) {
      continue;
    }
    const stack = [bundleRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const stats = fs.statSync(current);
      if (stats.isDirectory()) {
        for (const child of fs.readdirSync(current)) {
          stack.push(path.join(current, child));
        }
        continue;
      }
      if (!/\.(?:js|html|css)$/u.test(current)) {
        continue;
      }
      assert.equal(
        fs.readFileSync(current, "utf8").includes(DEFAULT_OIDC_CONFIG.clientSecret),
        false,
        `secret leaked into ${path.relative(projectRoot, current)}`
      );
    }
  }
});

test("renderer tolerates an older preload without the sso api", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const appShellSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "AppShell.tsx"),
    "utf8"
  );

  assert.match(appShellSource, /window\.electronAPI\.sso\?/);
  assert.doesNotMatch(appShellSource, /window\.electronAPI\.sso\s*\.\s*getStatus/);
  assert.doesNotMatch(appShellSource, /window\.electronAPI\.sso\s*\.\s*startLogin/);
  assert.doesNotMatch(appShellSource, /window\.electronAPI\.sso\s*\.\s*logout/);
});
