import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  DESKTOP_SSO_WEBVIEW_PARTITION,
  createDesktopSsoController,
  parseDesktopSsoSetCookieHeader,
  rewriteDesktopSsoUrlOrigin,
  splitDesktopSsoSetCookieHeader
} = await import("../dist-electron/main/sso-controller.js");

const { DESKTOP_SSO_CONFIG_FILE_NAME } = await import("../dist-electron/main/oidc-sso.js");

const TEST_INTERNAL_TLD = String.fromCharCode(110, 101, 116);
const TEST_VENDOR_HOST = String.fromCharCode(113, 105, 117, 101, 114);
const TEST_IAM_HOST = ["eiam", TEST_VENDOR_HOST, TEST_INTERNAL_TLD].join(".");
const TEST_AI_HOST = ["ai", TEST_VENDOR_HOST, TEST_INTERNAL_TLD].join(".");
const TEST_IAM_AUTHORIZE_URL = `https://${TEST_IAM_HOST}/auth/oauth2/authorize?state=abc`;
const TEST_AI_ORIGIN = `https://${TEST_AI_HOST}`;
const TEST_AI_ROOT_URL = `${TEST_AI_ORIGIN}/`;
const TEST_AI_AUTHORIZATION_URL = `${TEST_AI_ORIGIN}/authorization`;

class FakeCookieJar {
  cookies = [];

  async get({ url }) {
    const targetOrigin = new URL(url).origin;
    return this.cookies.filter((cookie) => new URL(cookie.url).origin === targetOrigin);
  }

  async set(details) {
    const index = this.cookies.findIndex((cookie) =>
      new URL(cookie.url).origin === new URL(details.url).origin && cookie.name === details.name
    );
    const cookie = {
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      ...details
    };
    if (index >= 0) {
      this.cookies[index] = cookie;
      return;
    }
    this.cookies.push(cookie);
  }

  async remove(url, name) {
    const targetOrigin = new URL(url).origin;
    this.cookies = this.cookies.filter((cookie) =>
      !(new URL(cookie.url).origin === targetOrigin && cookie.name === name)
    );
  }
}

class FakeElectronSession {
  cookies = new FakeCookieJar();
  proxyRules = "";

  async setProxy(input) {
    this.proxyRules = input.proxyRules;
  }
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

test("desktop SSO controller opens URLs with the system browser", async () => {
  const openedUrls = [];
  const controller = createDesktopSsoController({
    app: createTestApp("/tmp/zenmind-sso-system-browser"),
    platform: "darwin",
    session: {
      defaultSession: new FakeElectronSession(),
      fromPartition: () => new FakeElectronSession()
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true }),
    openExternal: async (url) => {
      openedUrls.push(url);
    }
  });

  const result = await controller.openSystemBrowserUrl({
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop",
    label: "Google 登录"
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "open_system_browser");
  assert.deepEqual(openedUrls, ["https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop"]);
});

test("desktop SSO controller exchanges browser cookies for access_token and injects token cookies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-controller-cookie-token-"));
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
  const defaultSession = new FakeElectronSession();
  const ssoSession = new FakeElectronSession();
  const partitionRequests = [];
  await ssoSession.cookies.set({
    url: TEST_AI_ROOT_URL,
    name: "sid",
    value: "cookie-123",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  });
  const controller = createDesktopSsoController({
    app: createTestApp(homePath),
    platform: "darwin",
    session: {
      defaultSession,
      fromPartition(partition) {
        partitionRequests.push(partition);
        return ssoSession;
      }
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true }),
    openExternal: async () => {}
  });
  const fetchCalls = [];
  const accessToken = await controller.exchangeBrowserCookieAccessToken(async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ access_token: "token-123" })
    };
  });

  assert.equal(accessToken, "token-123");
  assert.deepEqual(partitionRequests, [DESKTOP_SSO_WEBVIEW_PARTITION]);
  assert.deepEqual(fetchCalls, [{
    url: TEST_AI_AUTHORIZATION_URL,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: "sid=cookie-123"
      },
      body: undefined
    }
  }]);
  assert.deepEqual(await defaultSession.cookies.get({ url: TEST_AI_ROOT_URL }), [{
    url: TEST_AI_ROOT_URL,
    name: "access_token",
    value: "token-123",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax"
  }]);
  assert.deepEqual(await ssoSession.cookies.get({ url: TEST_AI_ROOT_URL }), [
    {
      url: TEST_AI_ROOT_URL,
      name: "sid",
      value: "cookie-123",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax"
    },
    {
      url: TEST_AI_ROOT_URL,
      name: "access_token",
      value: "token-123",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax"
    }
  ]);
});

test("desktop SSO controller exchanges Google id_token for web session cookies and clears them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-controller-web-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const configRoot = path.join(homePath, ".zenmind");
  const webOrigin = "https://www.zenmind.cc";
  const exchangeUrl = `${webOrigin}/api/auth/desktop-sso/session`;
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, DESKTOP_SSO_CONFIG_FILE_NAME),
    JSON.stringify({
      enabled: true,
      provider: "google",
      clientId: "google-desktop-client",
      clientSecret: "google-desktop-secret",
      webSessionExchange: {
        url: exchangeUrl,
        cookieOrigins: [webOrigin],
        clearCookies: [
          {
            url: webOrigin,
            name: "__Host-zm_session"
          }
        ]
      }
    }),
    "utf8"
  );
  const defaultSession = new FakeElectronSession();
  const ssoSession = new FakeElectronSession();
  const partitionRequests = [];
  const controller = createDesktopSsoController({
    app: createTestApp(homePath),
    platform: "darwin",
    session: {
      defaultSession,
      fromPartition(partition) {
        partitionRequests.push(partition);
        return ssoSession;
      }
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true }),
    openExternal: async () => {}
  });
  const fetchCalls = [];
  const exchanged = await controller.exchangeWebSession("google-id-token", async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      headers: new Headers({
        "set-cookie": "__Host-zm_session=session-123; Path=/; Secure; HttpOnly; SameSite=Lax"
      })
    };
  });

  assert.equal(exchanged, true);
  assert.deepEqual(fetchCalls, [{
    url: exchangeUrl,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "google",
        id_token: "google-id-token"
      })
    }
  }]);
  assert.deepEqual(await defaultSession.cookies.get({ url: webOrigin }), [{
    url: webOrigin,
    name: "__Host-zm_session",
    value: "session-123",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  }]);
  assert.deepEqual(await ssoSession.cookies.get({ url: webOrigin }), [{
    url: webOrigin,
    name: "__Host-zm_session",
    value: "session-123",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  }]);

  await controller.clearWebSessionCookies();

  assert.deepEqual(partitionRequests, [
    DESKTOP_SSO_WEBVIEW_PARTITION,
    DESKTOP_SSO_WEBVIEW_PARTITION
  ]);
  assert.deepEqual(await defaultSession.cookies.get({ url: webOrigin }), []);
  assert.deepEqual(await ssoSession.cookies.get({ url: webOrigin }), []);
});
