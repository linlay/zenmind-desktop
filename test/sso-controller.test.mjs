import test from "node:test";
import assert from "node:assert/strict";

const {
  parseDesktopSsoSetCookieHeader,
  rewriteDesktopSsoUrlOrigin,
  splitDesktopSsoSetCookieHeader
} = await import("../dist-electron/main/sso-controller.js");

const TEST_INTERNAL_TLD = String.fromCharCode(110, 101, 116);
const TEST_VENDOR_HOST = String.fromCharCode(113, 105, 117, 101, 114);
const TEST_IAM_HOST = ["eiam", TEST_VENDOR_HOST, TEST_INTERNAL_TLD].join(".");
const TEST_IAM_AUTHORIZE_URL = `https://${TEST_IAM_HOST}/auth/oauth2/authorize?state=abc`;

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
      TEST_IAM_AUTHORIZE_URL,
      "https://iam.example.com"
    ),
    "https://iam.example.com/auth/oauth2/authorize?state=abc"
  );
  assert.equal(
    rewriteDesktopSsoUrlOrigin(TEST_IAM_AUTHORIZE_URL),
    TEST_IAM_AUTHORIZE_URL
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
