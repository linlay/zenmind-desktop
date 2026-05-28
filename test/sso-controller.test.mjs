import test from "node:test";
import assert from "node:assert/strict";

const {
  parseDesktopSsoSetCookieHeader,
  rewriteDesktopSsoUrlOrigin,
  splitDesktopSsoSetCookieHeader
} = await import("../dist-electron/main/sso-controller.js");

test("desktop SSO controller parses Set-Cookie attributes for browser mirroring", () => {
  const cookie = parseDesktopSsoSetCookieHeader(
    "sid=abc; Path=/login; Domain=iam.example.com; Secure; HttpOnly; SameSite=None; Max-Age=60",
    "https://iam.example.com/login/callback"
  );

  assert.equal(cookie.url, "https://iam.example.com");
  assert.equal(cookie.name, "sid");
  assert.equal(cookie.value, "abc");
  assert.equal(cookie.path, "/login");
  assert.equal(cookie.domain, "iam.example.com");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "no_restriction");
  assert.equal(typeof cookie.expirationDate, "number");
});

test("desktop SSO controller rewrites IAM navigation back to the embedded browser origin", () => {
  assert.equal(
    rewriteDesktopSsoUrlOrigin(
      "https://eiam.qiuer.net/auth/oauth2/authorize?state=abc",
      "https://iam.example.com"
    ),
    "https://iam.example.com/auth/oauth2/authorize?state=abc"
  );
  assert.equal(
    rewriteDesktopSsoUrlOrigin("https://eiam.qiuer.net/auth/oauth2/authorize?state=abc"),
    "https://eiam.qiuer.net/auth/oauth2/authorize?state=abc"
  );
});

test("desktop SSO controller splits combined Set-Cookie headers without splitting expires dates", () => {
  assert.deepEqual(
    splitDesktopSsoSetCookieHeader("a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT, b=2; Path=/"),
    [
      "a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT",
      "b=2; Path=/"
    ]
  );
});
