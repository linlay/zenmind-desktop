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
  getDesktopSsoStatus
} = require("../dist-electron/main/oidc-sso.js");

const {
  DEFAULT_OIDC_CONFIG,
  DESKTOP_SSO_CONFIG_FILE_NAME,
  buildAuthorizeUrl,
  buildDesktopSsoProxyUrl,
  buildDesktopSsoBrowserCookieDetails,
  rewriteDesktopSsoProxyLocation,
  rewriteDesktopSsoProxySetCookieHeader,
  getIdentityProviderCookieHosts,
  loadDesktopSsoConfig,
  resolveDesktopSsoConfigPath,
  buildTokenExchangeRequest,
  normalizeCallbackRequest,
  validateIdToken
} = __testInternals;

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
      throw new Error(`unexpected app path ${name}`);
    }
  };
}

test("buildAuthorizeUrl creates an authorization-code URL with state and fixed localhost redirect", () => {
  const url = new URL(buildAuthorizeUrl("state-123"));

  assert.equal(url.origin + url.pathname, "https://eiam.qiuer.net/auth/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("prompt"), "login");
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
    JSON.stringify({ enabled: false, identityProviderHost: "eiam.gtjaqh.net" }),
    JSON.stringify({ identityProviderHost: "eiam.gtjaqh.net" }),
    "eiam.gtjaqh.net"
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
    JSON.stringify({ enabled: true, identityProviderHost: "eiam.gtjaqh.net" }),
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
  assert.equal(result.config.browserOrigin, "https://eiam.gtjaqh.net");
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
  assert.deepEqual(getIdentityProviderCookieHosts(), ["eiam.qiuer.net"]);
});

test("buildDesktopSsoProxyUrl keeps the browser on the localhost callback origin", () => {
  assert.equal(
    buildDesktopSsoProxyUrl("https://eiam.qiuer.net/auth/oauth2/authorize?client_id=desktop#frag"),
    "http://localhost:8080/auth/oauth2/authorize?client_id=desktop#frag"
  );
});

test("rewriteDesktopSsoProxyLocation maps IAM redirects back through the localhost proxy", () => {
  const upstreamRequestUrl = new URL("https://eiam.qiuer.net/auth/oauth2/authorize?client_id=desktop");

  assert.equal(
    rewriteDesktopSsoProxyLocation("https://eiam.qiuer.net/#/login?service=svc", upstreamRequestUrl),
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
    rewriteDesktopSsoProxySetCookieHeader("iauth=abc; Path=/; Domain=eiam.qiuer.net; Secure; HttpOnly; SameSite=None"),
    "iauth=abc; Path=/; HttpOnly; SameSite=Lax"
  );
});

test("buildDesktopSsoBrowserCookieDetails mirrors proxy cookies to business-visible IAM origins", () => {
  assert.deepEqual(
    buildDesktopSsoBrowserCookieDetails(
      new Map([["iauth", "abc"]]),
      { ...DEFAULT_OIDC_CONFIG, browserOrigin: "https://eiam.gtjaqh.net" }
    ),
    [
      {
        url: "https://eiam.qiuer.net",
        name: "iauth",
        value: "abc",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      },
      {
        url: "https://eiam.gtjaqh.net",
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

  assert.equal(url.origin + url.pathname, "https://eiam.qiuer.net/auth/oauth2/token");
  assert.equal(request.method, "POST");
  assert.equal(url.searchParams.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(url.searchParams.get("client_secret"), DEFAULT_OIDC_CONFIG.clientSecret);
  assert.equal(url.searchParams.get("redirect_uri"), DEFAULT_OIDC_CONFIG.redirectUri);
  assert.equal(url.searchParams.get("grant_type"), "authorization_code");
  assert.equal(url.searchParams.get("code"), "callback-code");
  assert.equal(request.body, undefined);
  assert.equal("Content-Type" in request.headers, false);
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
        json: async () => ({ jwks_uri: "https://eiam.qiuer.net/auth/oidc/jwks" })
      };
    }
    if (url === "https://eiam.qiuer.net/auth/oidc/jwks") {
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
