import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import dns from "node:dns";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
dns.setDefaultResultOrder("ipv4first");

const { registerSsoIpcHandlers } = require("../dist-electron/main/modules/identity/ipc.js");
const { createDesktopSsoController } = require("../dist-electron/main/modules/identity/sso-controller.js");
const {
  __testInternals,
  completeDesktopSsoRestoredBrowserSession,
  failDesktopSsoFlow,
  finalizeDesktopSsoLoginAttempt,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  startDesktopSsoLogin
} = require("../dist-electron/main/modules/identity/oidc-sso.js");

function createApp(homePath) {
  return {
    focus: () => undefined,
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

function createStatus(pending = true) {
  return {
    configured: true,
    authenticated: false,
    pending,
    user: null,
    completedSteps: {
      session: false,
      userInfo: false,
      accessToken: false
    },
    message: pending ? "pending" : "signed out",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

function createUnsignedJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function writeBrowserCookieRestoreCandidate(app, {
  accessToken = "old-access-token",
  userSub = "old-user"
} = {}) {
  const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-session.json"), `${JSON.stringify({
    schemaVersion: 2,
    authenticated: true,
    issuer: "https://ai.example.test",
    audience: "desktop",
    authMode: "browser-cookie",
    message: "Single sign-on completed.",
    updatedAt: "2026-08-01T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(stateRoot, "sso-user-info.json"), `${JSON.stringify({
    schemaVersion: 2,
    sub: userSub,
    name: userSub,
    issuer: "https://ai.example.test",
    audience: "desktop",
    source: "browser_session",
    updatedAt: "2026-08-01T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(stateRoot, "sso-access-token.txt"), `${accessToken}\n`, "utf8");
  const legacySiteTokenPath = path.join(path.dirname(path.dirname(stateRoot)), "secrets", "sso-site-token.json");
  fs.mkdirSync(path.dirname(legacySiteTokenPath), { recursive: true });
  fs.writeFileSync(legacySiteTokenPath, `${JSON.stringify({
    accessToken: "retired-duplicate-token"
  })}\n`, "utf8");
  return stateRoot;
}

function createHarness(startResult, options = {}) {
  const handlers = new Map();
  const calls = {
    openBrowserUrl: [],
    openEmbeddedLoginDialog: [],
    openSystemBrowserUrl: [],
    canonicalTokenExchanges: 0,
    webSessionExchanges: 0,
    clearBrowserCookies: [],
    broadcasts: [],
    kanbanRefreshes: 0,
    tunnelHubStops: 0,
  };
  registerSsoIpcHandlers({
    handle(name, handler) {
      handlers.set(name, handler);
    }
  }, {
    app: {},
    desktopSsoController: {
      broadcastStatus: (status) => calls.broadcasts.push(status),
      returnToApp: () => undefined,
      syncBrowserCookies: async () => undefined,
      exchangeBrowserCookieAccessToken: async () => {
        calls.canonicalTokenExchanges += 1;
        return "canonical-token";
      },
      exchangeWebSession: async () => {
        calls.webSessionExchanges += 1;
        return false;
      },
      clearBrowserCookies: async () => { calls.clearBrowserCookies.push(true); },
      clearWebSessionCookies: async () => undefined,
      openBrowserUrl: async (input) => {
        calls.openBrowserUrl.push(input);
        return { ok: true };
      },
      openEmbeddedLoginDialog: async (input) => {
        calls.openEmbeddedLoginDialog.push(input);
        return { ok: true };
      },
      openSystemBrowserUrl: async (input) => {
        calls.openSystemBrowserUrl.push(input);
        return { ok: true };
      }
    },
    getDesktopSsoStatus: () => createStatus(false),
    startDesktopSsoLogin: async (_app, hooks) => {
      if (options.invokeAuthenticatedHook) {
        const status = { authenticated: true };
        const context = { idToken: "id-token-1" };
        await hooks.onBeforeStatusChanged(status, context);
        await hooks.onAfterStatusChanged?.(status, context);
      }
      return startResult;
    },
    logoutDesktopSso: async () => options.logoutResult ?? ({ ok: true, status: createStatus(false) }),
    failDesktopSsoFlow: (message) => ({ ...createStatus(false), error: message, message }),
    cancelDesktopSsoLogin: () => createStatus(false),
    issueAgentAccessToken: async () => ({ ok: false, token: "", message: "unavailable" }),
    refreshKanbanConnection: () => { calls.kanbanRefreshes += 1; },
    stopTunnelHubRuntime: () => { calls.tunnelHubStops += 1; },

  });
  return { handlers, calls };
}

test("embedded desktop sso login opens the dedicated dialog instead of the main browser", async () => {
  const status = createStatus(true);
  const { handlers, calls } = createHarness({
    ok: true,
    openMode: "embedded",
    authorizeUrl: "https://auth.example.test/login",
    browserLabel: "ZenMind 登录",
    browserOrigin: "https://app.example.test",
    status,
    message: "started"
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.equal(calls.openBrowserUrl.length, 0);
  assert.equal(calls.openSystemBrowserUrl.length, 0);
  assert.deepEqual(calls.openEmbeddedLoginDialog, [{
    url: "https://auth.example.test/login",
    label: "ZenMind 登录",
    browserOrigin: "https://app.example.test",
    resolveRedirect: false
  }]);
});

test("system desktop sso login still opens the system browser", async () => {
  const status = createStatus(true);
  const { handlers, calls } = createHarness({
    ok: true,
    openMode: "system",
    authorizeUrl: "https://auth.example.test/login",
    browserLabel: "ZenMind 登录",
    status,
    message: "started"
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.equal(calls.openEmbeddedLoginDialog.length, 0);
  assert.equal(calls.openBrowserUrl.length, 0);
  assert.deepEqual(calls.openSystemBrowserUrl, [{
    url: "https://auth.example.test/login",
    label: "ZenMind 登录"
  }]);
});

test("desktop sso login exchanges the canonical token after the web session is ready", async () => {
  const status = createStatus(false);
  const { handlers, calls } = createHarness({
    ok: true,
    status,
    message: "started"
  }, {
    invokeAuthenticatedHook: true
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.equal(calls.webSessionExchanges, 1);
  assert.equal(calls.canonicalTokenExchanges, 1);
  assert.equal(calls.kanbanRefreshes, 1);
  assert.equal(calls.openSystemBrowserUrl.length, 0);
  assert.equal(calls.openEmbeddedLoginDialog.length, 0);
});

test("desktop sso logout stops Tunnel Hub runtime", async () => {
  const { handlers, calls } = createHarness({
    ok: true,
    status: createStatus(false),
    message: "started"
  });

  const result = await handlers.get("sso.logout")();

  assert.equal(result.ok, true);
  assert.equal(calls.tunnelHubStops, 1);
  assert.deepEqual(calls.clearBrowserCookies, [true]);
  assert.equal(calls.openSystemBrowserUrl.length, 0);
  assert.equal(calls.openBrowserUrl.length, 0);
});

test("desktop sso OIDC logout still opens the configured system-browser endpoint", async () => {
  const logoutUrl = "https://auth.example.test/application/o/desktop/end-session/";
  const { handlers, calls } = createHarness({
    ok: true,
    status: createStatus(false),
    message: "started"
  }, {
    logoutResult: {
      ok: true,
      openMode: "system",
      logoutUrl,
      browserLabel: "ZenMind 退出登录",
      status: createStatus(false),
      message: "signed out"
    }
  });

  const result = await handlers.get("sso.logout")();

  assert.equal(result.ok, true);
  assert.deepEqual(calls.openSystemBrowserUrl, [{
    url: logoutUrl,
    label: "ZenMind 退出登录"
  }]);
  assert.equal(calls.openBrowserUrl.length, 0);
});

test("desktop sso web session exchange uses configured provider", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    provider: "zenmind",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
    usePkce: true,
    webSessionExchange: {
      url: "https://app.example.test/api/auth/desktop-sso/session",
      provider: "zenmind-session"
    }
  });
  const setCookies = [];
  const fakeSession = {
    cookies: {
      flushStore: async () => undefined,
      set: async (details) => {
        setCookies.push(details);
      },
      get: async () => [],
      remove: async () => undefined
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: {
      defaultSession: fakeSession,
      fromPartition: () => fakeSession
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });
  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "set-cookie": "sid=abc; Path=/; HttpOnly" }),
      json: async () => ({})
    };
  };

  const exchanged = await controller.exchangeWebSession("id-token-1", fetchImpl);

  assert.equal(exchanged, true);
  assert.deepEqual(requestBody, {
    provider: "zenmind-session",
    id_token: "id-token-1"
  });
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.every((cookie) => cookie.name === "sid" && cookie.value === "abc"));
});

function createCookieSsoControllerFixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => {
    __testInternals.closeCallbackServer();
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://ai.example.test",
    loginUrl: "https://ai.example.test/login",
    appendLoginState: false,
    loginCompletionUrls: ["https://ai.example.test/"],
    browserSession: {
      url: "https://ai.example.test/oauth2/auth",
      successStatuses: [200, 202],
      userInfoHeaders: {
        sub: "x-auth-request-user",
        name: "x-auth-request-preferred-username",
        email: "x-auth-request-email"
      }
    },
    userInfo: {
      url: "https://ai.example.test/oauth2/userinfo",
      authMode: "cookie",
      required: false,
      subPath: "user",
      namePath: "preferredUsername",
      emailPath: "email"
    },
    cookieAccessTokenExchange: {
      url: "https://ai.example.test/authorization",
      method: "GET",
      accessTokenPath: "access_token"
    }
  });
  const fakeSession = {
    cookies: {
      flushStore: async () => undefined,
      set: async () => undefined,
      get: async () => [{ name: "_oauth2_proxy", value: "browser-session" }],
      remove: async () => undefined
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: {
      defaultSession: fakeSession,
      fromPartition: () => fakeSession
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });
  return { app, controller };
}

function createCookieSsoRestoreFixture(t, name, fetchHandler, configOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://ai.example.test",
    loginUrl: "https://ai.example.test/login",
    appendLoginState: false,
    claims: {
      audience: "desktop",
      cookieFallbackSub: "cookie-fallback"
    },
    browserSession: {
      url: "https://ai.example.test/oauth2/auth",
      successStatuses: [200, 202],
      userInfoHeaders: {
        sub: "x-auth-request-user",
        name: "x-auth-request-preferred-username",
        email: "x-auth-request-email"
      }
    },
    cookieAccessTokenExchange: {
      url: "https://ai.example.test/authorization",
      method: "GET",
      accessTokenPath: "access_token"
    },
    ...configOverrides
  });

  const calls = {
    statusEvents: [],
    restoreResults: [],
    defaultSets: [],
    defaultRemoves: [],
    defaultFlushes: 0,
    defaultCookieFlushes: 0,
    fetches: []
  };
  const browserCookie = {
    name: "_oauth2_proxy",
    value: "browser-session",
    domain: ".ai.example.test",
    path: "/",
    secure: true,
    httpOnly: true
  };
  const defaultSession = {
    cookies: {
      flushStore: async () => {
        if (calls.cookieFlushError) throw calls.cookieFlushError;
        calls.defaultCookieFlushes += 1;
      },
      set: async (details) => { calls.defaultSets.push(details); },
      get: async ({ url } = {}) => url ? [{ ...browserCookie }] : [],
      remove: async (url, cookieName) => { calls.defaultRemoves.push({ url, name: cookieName }); }
    },
    flushStorageData: async () => { calls.defaultFlushes += 1; },
    fetch: async (url, init) => {
      calls.fetches.push({ url, init });
      return fetchHandler(url, init, calls);
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: {
      defaultSession,
      fromPartition: () => assert.fail("SSO must use the default Session")
    },
    getMainWindow: () => ({ webContents: { send: (...args) => calls.statusEvents.push(args) } }),
    onRestoreResult: (result) => calls.restoreResults.push(result),
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });
  return { app, controller, calls };
}

test("desktop sso default restart validates Cookie, exchanges a fresh JWT, and flushes the default session", async (t) => {
  const expiresAt = Math.floor(Date.now() / 1000) + 7_200;
  const oldToken = createUnsignedJwt({ sub: "old-user", exp: expiresAt + 7_200 });
  const freshToken = createUnsignedJwt({
    sub: "new-user",
    name: "New User",
    email: "new.user@example.test",
    iss: "https://ai.example.test",
    aud: "desktop",
    exp: expiresAt
  });
  const { app, controller, calls } = createCookieSsoRestoreFixture(
    t,
    "zenmind-sso-restore-success-",
    async (url) => url.endsWith("/oauth2/auth")
      ? {
        ok: true,
        status: 202,
        statusText: "Accepted",
        headers: new Headers({
          "x-auth-request-user": "new-user",
          "x-auth-request-preferred-username": "New User",
          "x-auth-request-email": "new.user@example.test"
        }),
        text: async () => ""
      }
      : {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/plain" }),
        json: async () => ({}),
        text: async () => freshToken
      }
  );
  const stateRoot = writeBrowserCookieRestoreCandidate(app, {
    accessToken: oldToken,
    userSub: "old-user"
  });

  const result = await controller.restoreDesktopSsoSession();

  assert.equal(result.state, "authenticated");
  assert.equal(result.status.authenticated, true);
  assert.equal(result.status.user.sub, "new-user");
  assert.deepEqual(result.status.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: true
  });
  assert.equal(calls.fetches.length, 2, "a still-valid local JWT must not skip upstream validation and exchange");
  assert.ok(calls.fetches.every(({ init }) => init.headers.Authorization === undefined));
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), freshToken);
  const storedUser = JSON.parse(fs.readFileSync(path.join(stateRoot, "sso-user-info.json"), "utf8"));
  assert.equal(storedUser.sub, "new-user");
  const storedSession = JSON.parse(fs.readFileSync(path.join(stateRoot, "sso-session.json"), "utf8"));
  assert.deepEqual(Object.keys(storedSession).sort(), [
    "audience",
    "authMode",
    "authenticated",
    "issuer",
    "message",
    "schemaVersion",
    "updatedAt"
  ]);
  assert.equal(storedSession.schemaVersion, 2);
  assert.equal(storedSession.authMode, "browser-cookie");
  assert.match(storedSession.message, /单点登录已完成|Single sign-on completed/ui);
  for (const cookieWrites of [calls.defaultSets]) {
    const accessTokenCookie = cookieWrites.find((cookie) => cookie.name === "access_token");
    assert.ok(accessTokenCookie);
    assert.equal(accessTokenCookie.value, freshToken);
    assert.equal(accessTokenCookie.expirationDate, expiresAt);
  }
  assert.equal(calls.defaultFlushes, 2, "stale derived Cookie removal and fresh Cookie write are both flushed");
  assert.equal(calls.defaultCookieFlushes, 2, "DOM Storage flushes do not persist Cookie writes");
});

test("desktop sso Bearer restore clears rejected credentials but retains candidates on upstream failure", async (t) => {
  for (const status of [401, 503]) {
    await t.test(`upstream ${status}`, async (t) => {
      const { app, controller, calls } = createCookieSsoRestoreFixture(
        t, "desktop-sso-bearer-failure-", async (url, init) => {
          assert.equal(url, "https://ai.example.test/authorization");
          assert.match(init.headers.Authorization, /^Bearer /u);
          assert.equal(init.redirect, "manual");
          return new Response("upstream failure", { status });
        }, {
          sessionRestore: { authMode: "bearer" },
          userInfo: { url: "https://ai.example.test/userinfo", authMode: "cookie", subPath: "data.id" }
        }
      );
      const stateRoot = writeBrowserCookieRestoreCandidate(app);
      const result = await controller.restoreDesktopSsoSession();
      assert.equal(result.state, status === 401 ? "signed_out" : "temporarily_unavailable");
      assert.equal(getDesktopSsoAccessToken(), null);
      assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), status !== 401);
      assert.equal(calls.defaultSets.length, 0);
      assert.equal(calls.fetches.length, 1);
    });
  }
});

test("desktop sso restore retains candidates and stays unavailable when Cookie persistence fails", async (t) => {
  const { app, controller, calls } = createCookieSsoRestoreFixture(
    t, "zenmind-sso-restore-cookie-flush-", async () => { throw new Error("unexpected fetch"); }
  );
  const stateRoot = writeBrowserCookieRestoreCandidate(app);
  calls.cookieFlushError = new Error("Cookie store unavailable");

  const result = await controller.restoreDesktopSsoSession();

  assert.equal(result.state, "temporarily_unavailable");
  assert.equal(result.status.authenticated, false);
  assert.match(result.status.error, /Cookie store unavailable/u);
  assert.equal(calls.fetches.length, 0);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), true);
});

test("desktop sso restart 401 clears canonical files and known cookies", async (t) => {
  const { app, controller, calls } = createCookieSsoRestoreFixture(
    t,
    "zenmind-sso-restore-401-",
    async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "Unauthorized"
    })
  );
  const stateRoot = writeBrowserCookieRestoreCandidate(app);

  const result = await controller.restoreDesktopSsoSession();

  assert.equal(result.state, "signed_out");
  assert.equal(result.status.authenticated, false);
  for (const fileName of [
    "sso-session.json",
    "sso-user-info.json",
    "sso-access-token.txt"
  ]) {
    assert.equal(fs.existsSync(path.join(stateRoot, fileName)), false, `${fileName} should be removed`);
  }
  assert.equal(
    fs.existsSync(path.join(path.dirname(path.dirname(stateRoot)), "secrets", "sso-site-token.json")),
    false
  );
  assert.ok(calls.defaultRemoves.some(({ name }) => name === "_oauth2_proxy"));
});

test("desktop sso restart keeps files unavailable on 5xx and retries with single-flight", async (t) => {
  let upstreamAvailable = false;
  const freshToken = createUnsignedJwt({
    sub: "restored-user",
    iss: "https://ai.example.test",
    aud: "desktop",
    exp: Math.floor(Date.now() / 1000) + 3_600
  });
  const { app, controller, calls } = createCookieSsoRestoreFixture(
    t,
    "zenmind-sso-restore-retry-",
    async (url) => {
      if (!upstreamAvailable) {
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          headers: new Headers(),
          text: async () => "temporarily unavailable"
        };
      }
      return url.endsWith("/oauth2/auth")
        ? {
          ok: true,
          status: 202,
          statusText: "Accepted",
          headers: new Headers({ "x-auth-request-user": "restored-user" }),
          text: async () => ""
        }
        : {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "text/plain" }),
          text: async () => freshToken,
          json: async () => ({})
        };
    }
  );
  const stateRoot = writeBrowserCookieRestoreCandidate(app);

  const unavailable = await controller.restoreDesktopSsoSession();
  assert.equal(unavailable.state, "temporarily_unavailable");
  assert.equal(unavailable.status.authenticated, false);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-user-info.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), true);
  assert.ok(calls.defaultRemoves.some(({ name }) => name === "access_token"));
  assert.equal(getDesktopSsoStatus(app).authenticated, false);
  assert.equal(isDesktopSsoCredentialRuntimeReady(), false);
  assert.equal(getDesktopSsoStatus(app).authenticated, false, "status reads must not resurrect the disk candidate");

  upstreamAvailable = true;
  const [firstRetry, secondRetry] = await Promise.all([
    controller.retryDesktopSsoSessionRestoreIfNeeded(),
    controller.retryDesktopSsoSessionRestoreIfNeeded()
  ]);
  assert.equal(firstRetry.state, "authenticated");
  assert.equal(secondRetry.state, "authenticated");
  assert.equal(isDesktopSsoCredentialRuntimeReady(), true);
  assert.equal(calls.fetches.length, 3, "one failed validation plus one shared validation/exchange retry");
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), freshToken);
});

test("desktop sso restart timeout preserves the candidate without publishing a token", async (t) => {
  const { app, controller } = createCookieSsoRestoreFixture(
    t,
    "zenmind-sso-restore-timeout-",
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  );
  const stateRoot = writeBrowserCookieRestoreCandidate(app);

  const result = await controller.restoreDesktopSsoSession(10);

  assert.equal(result.state, "temporarily_unavailable");
  assert.equal(result.status.authenticated, false);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), true);
  assert.equal(getDesktopSsoStatus(app).completedSteps.accessToken, false);
});

for (const authMode of ["oidc", "server"]) {
test(`${authMode} restart keeps file recovery and does not probe Cookie or Bearer endpoints`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-restore-oidc-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    authMode,
    browserMode: "system",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "desktop",
    usePkce: true,
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    ...(authMode === "server" ? {
      serverAuthorizeUrl: "https://auth.example.test/api/auth/desktop-sso/start",
      webSessionExchange: { url: "https://auth.example.test/api/auth/desktop-sso/session", provider: "zenmind" },
      cookieAccessTokenExchange: { url: "https://auth.example.test/api/auth/desktop-sso/token" }
    } : {})
  });
  const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-session.json"), `${JSON.stringify({
    schemaVersion: 2,
    authenticated: true,
    issuer: "https://auth.example.test/application/o/desktop/",
    audience: "desktop",
    authMode,
    message: "Single sign-on completed.",
    updatedAt: "2026-08-01T00:00:00.000Z"
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stateRoot, "sso-access-token.txt"), "oidc-access-token\n", "utf8");
  let fetchCount = 0;
  const fakeSession = {
    cookies: {
      flushStore: async () => undefined,
      set: async () => undefined,
      get: async () => [],
      remove: async () => undefined
    },
    fetch: async () => {
      fetchCount += 1;
      throw new Error("unexpected Cookie probe");
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: { defaultSession: fakeSession, fromPartition: () => fakeSession },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });

  const result = await controller.restoreDesktopSsoSession();

  assert.equal(result.state, "authenticated");
  assert.equal(result.status.authenticated, true);
  assert.equal(result.status.completedSteps.accessToken, true);
  assert.equal(fetchCount, 0);
});
}

test("desktop sso logout scopes default-session cleanup to identity origins", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-switch-cookies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "embedded",
    browserOrigin: "https://ai.example.test",
    loginUrl: "https://ai.example.test/login",
    appendLoginState: false,
    loginCompletionUrls: ["https://ai.example.test/"]
  });

  const defaultGets = [];
  const defaultRemoves = [];
  let cookieFlushes = 0;
  const defaultSession = {
    cookies: {
      flushStore: async () => { cookieFlushes += 1; },
      set: async () => undefined,
      get: async (filter) => {
        defaultGets.push(filter);
        return filter.url ? [{ name: "_oauth2_proxy", value: "default", domain: "ai.example.test", path: "/", secure: true }] : [];
      },
      remove: async (url, name) => { defaultRemoves.push({ url, name }); }
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: {
      defaultSession,
      fromPartition: () => assert.fail("SSO must use the default Session")
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });

  await controller.clearBrowserCookies();

  assert.equal(cookieFlushes, 1, "logout must persist Cookie deletions before completing");
  assert.equal(defaultGets.every((filter) => typeof filter.url === "string"), true);
  assert.equal(defaultRemoves.some(({ url }) => url.includes("identity.example.test")), false);
  assert.ok(defaultRemoves.some(({ name }) => name === "_oauth2_proxy"));
});

test("desktop sso cookie flow keeps session and userinfo when access token returns 401", async (t) => {
  const { app, controller } = createCookieSsoControllerFixture(t, "zenmind-sso-cookie-401-");
  const sessionStatus = await controller.validateBrowserSession(async () => ({
    ok: true,
    status: 202,
    statusText: "Accepted",
    headers: new Headers({ "x-auth-request-user": "107078" }),
    text: async () => ""
  }));
  assert.equal(sessionStatus.authenticated, true);

  await controller.fetchBrowserUserInfo(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ email: "" })
  }));

  await assert.rejects(
    controller.exchangeBrowserCookieAccessToken(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers({ "content-type": "text/plain" }),
      json: async () => ({}),
      text: async () => "Unauthorized"
    })),
    /401/u
  );

  const stateRoot = path.dirname(__testInternals.getDesktopSsoUserInfoFilePath(app));
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-user-info.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), false);
  const status = getDesktopSsoStatus(app);
  assert.equal(status.authenticated, true);
  assert.equal(status.user.sub, "107078");
  assert.equal(status.user.name, "107078");
  assert.equal(status.user.email, undefined);
});

test("desktop sso accepts a verified user id when email and name are empty", async (t) => {
  const { app, controller } = createCookieSsoControllerFixture(t, "zenmind-sso-cookie-user-id-");
  const sessionStatus = await controller.validateBrowserSession(async () => ({
    ok: true,
    status: 202,
    statusText: "Accepted",
    headers: new Headers({
      "x-auth-request-user": "107078",
      "x-auth-request-email": ""
    }),
    text: async () => ""
  }));
  assert.equal(sessionStatus.authenticated, true);
  assert.equal(sessionStatus.user.sub, "107078");
  assert.equal(sessionStatus.user.name, "107078");
  assert.equal(sessionStatus.user.email, undefined);

  const optionalUserInfoStatus = await controller.fetchBrowserUserInfo(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ email: "" })
  }));
  assert.equal(optionalUserInfoStatus.user.sub, "107078");

  await controller.exchangeBrowserCookieAccessToken(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    json: async () => ({}),
    text: async () => "access-token-user-id"
  }));
  const finalStatus = finalizeDesktopSsoLoginAttempt();
  assert.equal(finalStatus.pending, false);
  assert.deepEqual(finalStatus.completedSteps, {
    session: true,
    userInfo: true,
    accessToken: true
  });

  const stateRoot = path.dirname(__testInternals.getDesktopSsoUserInfoFilePath(app));
  const storedUser = JSON.parse(fs.readFileSync(path.join(stateRoot, "sso-user-info.json"), "utf8"));
  assert.equal(storedUser.sub, "107078");
  assert.equal(storedUser.name, "107078");
  assert.equal(storedUser.email, undefined);
  assert.equal(storedUser.source, "browser_session");
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), "access-token-user-id");
});

test("desktop sso cookie flow still stores access token when userinfo fails", async (t) => {
  const { app, controller } = createCookieSsoControllerFixture(t, "zenmind-sso-cookie-userinfo-fail-");
  await controller.validateBrowserSession(async () => ({
    ok: true,
    status: 202,
    statusText: "Accepted",
    headers: new Headers(),
    text: async () => ""
  }));
  await controller.fetchBrowserUserInfo(async () => ({
    ok: false,
    status: 503,
    statusText: "Unavailable",
    headers: new Headers(),
    text: async () => "temporarily unavailable"
  }));
  const accessToken = await controller.exchangeBrowserCookieAccessToken(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    json: async () => ({}),
    text: async () => "access-token-1"
  }));

  assert.equal(accessToken, "access-token-1");
  const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-user-info.json")), false);
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), "access-token-1");
  const status = getDesktopSsoStatus(app);
  assert.deepEqual(status.completedSteps, {
    session: true,
    userInfo: false,
    accessToken: true
  });
});

test("desktop sso keeps the webview pending until cookie userinfo and token settle", async (t) => {
  const { app, controller } = createCookieSsoControllerFixture(t, "zenmind-sso-cookie-finalize-");
  const broadcasts = [];
  const started = await startDesktopSsoLogin(app, {
    onStatusChanged: (status) => broadcasts.push(status)
  });
  assert.equal(started.ok, true, started.message);

  const sessionStatus = await controller.validateBrowserSession(async () => ({
    ok: true,
    status: 202,
    statusText: "Accepted",
    headers: new Headers(),
    text: async () => ""
  }));
  assert.equal(sessionStatus.authenticated, true);
  assert.equal(sessionStatus.pending, true);
  assert.equal(broadcasts.at(-1).pending, true);

  await controller.fetchBrowserUserInfo(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ email: "", preferredUsername: "Missing Email" })
  }));
  await controller.exchangeBrowserCookieAccessToken(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    json: async () => ({}),
    text: async () => "access-token-2"
  }));

  const pendingStatus = getDesktopSsoStatus(app);
  assert.equal(pendingStatus.pending, true);
  assert.deepEqual(pendingStatus.completedSteps, {
    session: true,
    userInfo: false,
    accessToken: true
  });

  const finalStatus = finalizeDesktopSsoLoginAttempt();
  assert.equal(finalStatus.authenticated, true);
  assert.equal(finalStatus.pending, false);
  assert.equal(finalStatus.user, null);
  assert.match(finalStatus.message, /用户信息未就绪|user information is not ready/ui);
  assert.equal(finalStatus.error, undefined);
  assert.equal(broadcasts.at(-1).pending, false);

  const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-user-info.json")), false);
  assert.equal(fs.readFileSync(path.join(stateRoot, "sso-access-token.txt"), "utf8").trim(), "access-token-2");

  failDesktopSsoFlow("simulate restart");
  const restoredStatus = getDesktopSsoStatus(app);
  assert.equal(restoredStatus.authenticated, true);
  assert.equal(restoredStatus.user, null);
  assert.deepEqual(restoredStatus.completedSteps, finalStatus.completedSteps);
  assert.match(restoredStatus.message, /用户信息未就绪|user information is not ready/ui);
});

test("desktop sso cookie flow writes no state when browser session validation fails", async (t) => {
  const { app, controller } = createCookieSsoControllerFixture(t, "zenmind-sso-cookie-session-fail-");
  await assert.rejects(
    controller.validateBrowserSession(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers(),
      text: async () => "Unauthorized"
    })),
    /401/u
  );
  const stateRoot = path.dirname(__testInternals.getDesktopSsoUserInfoFilePath(app));
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-session.json")), false);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-user-info.json")), false);
  assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), false);
});


test("runtime SSO refresh invalidates rejected or expired identity and broadcasts account state", async (t) => {
  for (const scenario of [
    { status: 401, force: true, expiresIn: 3600, state: "signed_out" },
    { status: 403, force: true, expiresIn: 3600, state: "signed_out" },
    { status: 302, force: true, expiresIn: 3600, state: "signed_out" },
    { status: 503, force: true, expiresIn: 3600, state: "temporarily_unavailable" },
    { status: 503, force: false, expiresIn: -1, state: "temporarily_unavailable" },
    { status: 503, force: false, expiresIn: 600, state: "authenticated" }
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-expiry-", async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response("upstream failure", { status: scenario.status });
      });
      const token = createUnsignedJwt({ sub: "runtime-user", exp: Math.floor(Date.now() / 1000) + scenario.expiresIn });
      completeDesktopSsoRestoredBrowserSession(app, token, { sub: "runtime-user", name: "Runtime User" });
      await assert.rejects(controller.refreshBrowserCookieAccessTokenIfNeeded(scenario.force));
      const authenticated = scenario.state === "authenticated";
      assert.equal(getDesktopSsoStatus(app).authenticated, authenticated);
      assert.equal(getDesktopSsoAccessToken(), authenticated ? token : null);
      assert.equal(calls.statusEvents.length, authenticated ? 0 : 1);
      if (!authenticated) {
        assert.equal(calls.statusEvents[0][0], "sso.statusChanged");
        assert.equal(calls.statusEvents[0][1].user, null);
        assert.equal(calls.restoreResults.at(-1).state, scenario.state);
      }
      const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
      assert.equal(fs.existsSync(path.join(stateRoot, "sso-access-token.txt")), scenario.state !== "signed_out");
    });
  }
});

test("runtime SSO refresh renews canonical token and its Cookie together", async (t) => {
  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  const freshToken = createUnsignedJwt({ sub: "runtime-user", exp: expiresAt });
  const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-renew-", async () =>
    new Response(JSON.stringify({ access_token: freshToken }), { headers: { "content-type": "application/json" } })
  );
  completeDesktopSsoRestoredBrowserSession(app,
    createUnsignedJwt({ sub: "runtime-user", exp: expiresAt - 7100 }), { sub: "runtime-user" });
  const tokens = await Promise.all([
    controller.refreshBrowserCookieAccessTokenIfNeeded(), controller.refreshBrowserCookieAccessTokenIfNeeded()
  ]);
  assert.deepEqual(tokens, [freshToken, freshToken]);
  assert.equal(calls.fetches.length, 1);
  assert.equal(getDesktopSsoAccessToken(), freshToken);
  assert.equal(getDesktopSsoStatus(app).authenticated, true);
  assert.equal(calls.defaultSets.find((cookie) => cookie.name === "access_token").expirationDate, expiresAt);
});

test("late runtime refresh rejection cannot sign out a replacement account", async (t) => {
  let respond;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-stale-", async () => {
    started();
    return new Promise((resolve) => { respond = resolve; });
  });
  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  completeDesktopSsoRestoredBrowserSession(app,
    createUnsignedJwt({ sub: "old-user", exp: expiresAt }), { sub: "old-user" });
  const refresh = controller.refreshBrowserCookieAccessTokenIfNeeded(true);
  await requestStarted;
  const replacementToken = createUnsignedJwt({ sub: "new-user", exp: expiresAt });
  completeDesktopSsoRestoredBrowserSession(app, replacementToken, { sub: "new-user" });
  respond(new Response("expired", { status: 401 }));
  assert.equal(await refresh, "");
  assert.equal(getDesktopSsoAccessToken(), replacementToken);
  assert.equal(getDesktopSsoStatus(app).user.sub, "new-user");
  assert.equal(calls.statusEvents.length, 0);
});

for (const mode of ["bearer", "cookie"]) {
  test(`runtime ${mode} refresh honors configured transport and remains single flight`, async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const previousToken = createUnsignedJwt({ sub: "runtime-user", exp: now + 90 });
    const freshToken = createUnsignedJwt({ sub: "runtime-user", exp: now + 7200 });
    const { app, controller, calls } = createCookieSsoRestoreFixture(t, `sso-runtime-${mode}-transport-`, async (url, init) => {
      assert.equal(url, "https://ai.example.test/authorization");
      assert.equal(init.redirect, "manual");
      const headers = new Headers(init.headers);
      if (mode === "bearer") {
        assert.equal(headers.get("Authorization"), `Bearer ${previousToken}`);
        assert.equal(headers.has("Cookie"), false);
        assert.equal(init.credentials, "omit");
      } else {
        assert.equal(headers.has("Authorization"), false);
        assert.match(headers.get("Cookie"), /_oauth2_proxy=browser-session/u);
      }
      return new Response(JSON.stringify({ access_token: freshToken }), { headers: { "content-type": "application/json" } });
    }, mode === "bearer" ? { sessionRestore: { authMode: "bearer" }, userInfo: { url: "https://ai.example.test/userinfo", authMode: "cookie", subPath: "data.id" } } : {});
    completeDesktopSsoRestoredBrowserSession(app, previousToken, { sub: "runtime-user" });
    const results = await Promise.all([
      controller.refreshBrowserCookieAccessTokenIfNeeded(true),
      controller.refreshBrowserCookieAccessTokenIfNeeded(true)
    ]);
    assert.deepEqual(results, [freshToken, freshToken]);
    assert.equal(calls.fetches.length, 1);
    assert.equal(getDesktopSsoStatus(app).authenticated, true);
    assert.equal(getDesktopSsoAccessToken(), freshToken);
    assert.equal(calls.statusEvents.length, 0);
  });
}

for (const status of [401, 403, 302, 503]) {
  test(`runtime Bearer refresh preserves rejection semantics for upstream ${status}`, async (t) => {
    const previousToken = createUnsignedJwt({ sub: "runtime-user", exp: Math.floor(Date.now() / 1000) + 600 });
    const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-bearer-response-", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${previousToken}`);
      assert.equal(new Headers(init.headers).has("Cookie"), false);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      return new Response("upstream failure", { status });
    }, { sessionRestore: { authMode: "bearer" }, userInfo: { url: "https://ai.example.test/userinfo", authMode: "cookie", subPath: "data.id" } });
    completeDesktopSsoRestoredBrowserSession(app, previousToken, { sub: "runtime-user" });
    await assert.rejects(controller.refreshBrowserCookieAccessTokenIfNeeded(false));
    const temporary = status === 503;
    assert.equal(getDesktopSsoStatus(app).authenticated, temporary);
    assert.equal(getDesktopSsoAccessToken(), temporary ? previousToken : null);
    assert.equal(calls.statusEvents.length, temporary ? 0 : 1);
    if (!temporary) assert.equal(calls.restoreResults.at(-1).state, "signed_out");
  });
}

test("late Bearer refresh rejection cannot clear a newly signed in account", async (t) => {
  let respond, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  const oldToken = createUnsignedJwt({ sub: "old-user", exp: expiresAt });
  const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-bearer-account-switch-", async (_url, init) => {
    started();
    return new Promise(resolve => { respond = resolve; });
  }, { sessionRestore: { authMode: "bearer" }, userInfo: { url: "https://ai.example.test/userinfo", authMode: "cookie", subPath: "data.id" } });
  completeDesktopSsoRestoredBrowserSession(app, oldToken, { sub: "old-user" });
  const refreshing = controller.refreshBrowserCookieAccessTokenIfNeeded(true);
  await Promise.race([requestStarted, refreshing.then(() => { throw new Error("Refresh returned without making a request"); })]);
  const newToken = createUnsignedJwt({ sub: "new-user", exp: expiresAt });
  completeDesktopSsoRestoredBrowserSession(app, newToken, { sub: "new-user" });
  const request = calls.fetches[0].init;
  respond(new Response("expired", { status: 401 }));
  assert.equal(await refreshing, "");
  assert.equal(getDesktopSsoAccessToken(), newToken);
  assert.equal(getDesktopSsoStatus(app).authenticated, true);
  assert.equal(getDesktopSsoStatus(app).user.sub, "new-user");
  assert.equal(calls.statusEvents.length, 0);
  assert.equal(new Headers(request.headers).get("Authorization"), `Bearer ${oldToken}`);
  assert.equal(request.credentials, "omit");
});

test("runtime Bearer refresh fetches CSRF anonymously and scopes identity to the token exchange", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const previousToken = createUnsignedJwt({ sub: "runtime-user", exp: now + 90 });
  const freshToken = createUnsignedJwt({ sub: "runtime-user", exp: now + 7200 });
  const { app, controller, calls } = createCookieSsoRestoreFixture(t, "sso-runtime-bearer-csrf-", async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    assert.equal(headers.has("Cookie"), false);
    if (url === "https://ai.example.test/csrf") {
      assert.equal(headers.has("Authorization"), false);
      return new Response(JSON.stringify({ csrfToken: "test-csrf-value" }), { headers: { "content-type": "application/json" } });
    }
    assert.equal(url, "https://ai.example.test/authorization");
    assert.equal(headers.get("Authorization"), `Bearer ${previousToken}`);
    assert.equal(headers.get("X-CSRF-Token"), "test-csrf-value");
    return new Response(JSON.stringify({ access_token: freshToken }), { headers: { "content-type": "application/json" } });
  }, {
    sessionRestore: { authMode: "bearer" },
    userInfo: { url: "https://ai.example.test/userinfo", authMode: "cookie", subPath: "data.id" },
    cookieAccessTokenExchange: {
      url: "https://ai.example.test/authorization", method: "GET", accessTokenPath: "access_token",
      csrfUrl: "https://ai.example.test/csrf"
    }
  });
  completeDesktopSsoRestoredBrowserSession(app, previousToken, { sub: "runtime-user" });
  assert.equal(await controller.refreshBrowserCookieAccessTokenIfNeeded(true), freshToken);
  assert.deepEqual(calls.fetches.map(request => request.url), ["https://ai.example.test/csrf", "https://ai.example.test/authorization"]);
  assert.equal(getDesktopSsoAccessToken(), freshToken);
  assert.equal(getDesktopSsoStatus(app).authenticated, true);
  assert.equal(calls.statusEvents.length, 0);
});
