import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
  buildAuthorizeUrl,
  getIdentityProviderCookieHosts,
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

test("buildAuthorizeUrl creates an authorization-code URL with state and fixed localhost redirect", () => {
  const url = new URL(buildAuthorizeUrl("state-123"));

  assert.equal(url.origin + url.pathname, "https://eiam.qiuer.net/auth/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("prompt"), "login");
});

test("getIdentityProviderCookieHosts targets the IAM host used by Chrome login", () => {
  assert.deepEqual(getIdentityProviderCookieHosts(), ["eiam.qiuer.net"]);
});

test("buildTokenExchangeRequest posts code and secret from the main-process config", () => {
  const request = buildTokenExchangeRequest("callback-code");
  const body = new URLSearchParams(request.body);

  assert.equal(request.url, "https://eiam.qiuer.net/auth/oauth2/token");
  assert.equal(request.method, "POST");
  assert.equal(body.get("client_id"), DEFAULT_OIDC_CONFIG.clientId);
  assert.equal(body.get("client_secret"), DEFAULT_OIDC_CONFIG.clientSecret);
  assert.equal(body.get("redirect_uri"), DEFAULT_OIDC_CONFIG.redirectUri);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "callback-code");
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
