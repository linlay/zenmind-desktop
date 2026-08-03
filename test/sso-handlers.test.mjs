import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { registerSsoIpcHandlers } = require("../dist-electron/main/ipc/sso-handlers.js");
const { createDesktopSsoController } = require("../dist-electron/main/sso-controller.js");
const {
  __testInternals,
  failDesktopSsoFlow,
  finalizeDesktopSsoLoginAttempt,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  startDesktopSsoLogin
} = require("../dist-electron/main/oidc-sso.js");

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
  const siteTokenPath = __testInternals.getDesktopSsoSiteTokenFilePath(app);
  fs.mkdirSync(path.dirname(siteTokenPath), { recursive: true });
  fs.writeFileSync(siteTokenPath, `${JSON.stringify({
    accessToken: "old-site-token"
  })}\n`, "utf8");
  return stateRoot;
}

function createHarness(startResult, options = {}) {
  const handlers = new Map();
  const calls = {
    openBrowserUrl: [],
    openEmbeddedLoginDialog: [],
    openSystemBrowserUrl: [],
    siteTokenBridgeTickets: [],
    clearBrowserCookies: [],
    broadcasts: [],
    kanbanRefreshes: 0,
    tunnelHubStops: 0
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
      exchangeBrowserCookieAccessToken: async () => "",
      exchangeWebSession: async () => false,
      exchangeSiteTokenBridgeTicket: async (ticket) => {
        calls.siteTokenBridgeTickets.push(ticket);
        return true;
      },
      clearBrowserCookies: async () => { calls.clearBrowserCookies.push(true); },
      clearWebSessionCookies: async () => undefined,
      clearSiteTokenBridgeCookies: async () => undefined,
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
      if (options.invokeSiteTokenBridgeTicket) {
        await hooks.onSiteTokenBridgeTicket?.("site-ticket-1", { required: false });
      }
      return startResult;
    },
    startDesktopSsoSiteTokenBridge: options.startDesktopSsoSiteTokenBridge,
    logoutDesktopSso: async () => options.logoutResult ?? ({ ok: true, status: createStatus(false) }),
    failDesktopSsoFlow: (message) => ({ ...createStatus(false), error: message, message }),
    cancelDesktopSsoLogin: () => createStatus(false),
    issueAgentAccessToken: async () => ({ ok: false, token: "", message: "unavailable" }),
    refreshKanbanConnection: () => { calls.kanbanRefreshes += 1; },
    stopTunnelHubRuntime: () => { calls.tunnelHubStops += 1; }
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

test("desktop sso login opens system site token bridge after oidc success", async () => {
  const status = createStatus(false);
  const { handlers, calls } = createHarness({
    ok: true,
    status,
    message: "started"
  }, {
    invokeAuthenticatedHook: true,
    startDesktopSsoSiteTokenBridge: () => ({
      ok: true,
      configured: true,
      required: false,
      startUrl: "https://site.example.test/api/auth/desktop-sso/start?state=site-state",
      browserLabel: "ZenMind 登录",
      openMode: "system",
      message: "bridge opened"
    })
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.deepEqual(calls.openSystemBrowserUrl, [{
    url: "https://site.example.test/api/auth/desktop-sso/start?state=site-state",
    label: "ZenMind 登录"
  }]);
});

test("desktop sso login opens embedded site token bridge when configured by browserMode", async () => {
  const status = createStatus(false);
  const { handlers, calls } = createHarness({
    ok: true,
    status,
    message: "started"
  }, {
    invokeAuthenticatedHook: true,
    startDesktopSsoSiteTokenBridge: () => ({
      ok: true,
      configured: true,
      required: false,
      startUrl: "https://site.example.test/api/auth/desktop-sso/start?state=site-state",
      browserLabel: "ZenMind 登录",
      browserOrigin: "https://app.example.test",
      openMode: "embedded",
      message: "bridge opened"
    })
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.equal(calls.openSystemBrowserUrl.length, 0);
  assert.deepEqual(calls.openEmbeddedLoginDialog, [{
    url: "https://site.example.test/api/auth/desktop-sso/start?state=site-state",
    label: "ZenMind 登录",
    browserOrigin: "https://app.example.test",
    resolveRedirect: true
  }]);
});

test("desktop sso site token bridge ticket is exchanged by the controller", async () => {
  const status = createStatus(false);
  const { handlers, calls } = createHarness({
    ok: true,
    status,
    message: "started"
  }, {
    invokeSiteTokenBridgeTicket: true
  });

  const result = await handlers.get("sso.startLogin")();

  assert.equal(result.ok, true);
  assert.deepEqual(calls.siteTokenBridgeTickets, ["site-ticket-1"]);
  assert.equal(calls.kanbanRefreshes, 1);
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
  assert.equal(setCookies.length, 4);
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

function createCookieSsoRestoreFixture(t, name, fetchHandler) {
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
    }
  });

  const calls = {
    defaultSets: [],
    partitionSets: [],
    defaultRemoves: [],
    partitionRemoves: [],
    defaultFlushes: 0,
    partitionFlushes: 0,
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
      set: async (details) => { calls.defaultSets.push(details); },
      get: async ({ url } = {}) => url ? [{ ...browserCookie }] : [],
      remove: async (url, cookieName) => { calls.defaultRemoves.push({ url, name: cookieName }); }
    },
    flushStorageData: async () => { calls.defaultFlushes += 1; }
  };
  const partitionSession = {
    cookies: {
      set: async (details) => { calls.partitionSets.push(details); },
      get: async (filter = {}) => Object.keys(filter).length === 0
        ? [{ ...browserCookie }]
        : [{ ...browserCookie }],
      remove: async (url, cookieName) => { calls.partitionRemoves.push({ url, name: cookieName }); }
    },
    flushStorageData: async () => { calls.partitionFlushes += 1; },
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
      fromPartition: () => partitionSession
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });
  return { app, controller, calls };
}

test("desktop sso restart always validates Cookie, exchanges a fresh JWT, and flushes both sessions", async (t) => {
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
  for (const cookieWrites of [calls.defaultSets, calls.partitionSets]) {
    const accessTokenCookie = cookieWrites.find((cookie) => cookie.name === "access_token");
    assert.ok(accessTokenCookie);
    assert.equal(accessTokenCookie.value, freshToken);
    assert.equal(accessTokenCookie.expirationDate, expiresAt);
  }
  assert.equal(calls.defaultFlushes, 2, "stale derived Cookie removal and fresh Cookie write are both flushed");
  assert.equal(calls.partitionFlushes, 2, "stale derived Cookie removal and fresh Cookie write are both flushed");
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
  assert.equal(fs.existsSync(__testInternals.getDesktopSsoSiteTokenFilePath(app)), false);
  assert.ok(calls.defaultRemoves.some(({ name }) => name === "_oauth2_proxy"));
  assert.ok(calls.partitionRemoves.some(({ name }) => name === "_oauth2_proxy"));
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
  assert.ok(calls.partitionRemoves.some(({ name }) => name === "access_token"));
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

test("standard OIDC restart keeps file recovery and does not probe Cookie endpoints", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-restore-oidc-"));
  t.after(() => {
    failDesktopSsoFlow("reset test state");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    authMode: "oidc",
    browserMode: "system",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "desktop",
    usePkce: true,
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration"
  });
  const stateRoot = path.dirname(__testInternals.getDesktopSsoAccessTokenFilePath(app));
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "sso-session.json"), `${JSON.stringify({
    schemaVersion: 2,
    authenticated: true,
    issuer: "https://auth.example.test/application/o/desktop/",
    audience: "desktop",
    authMode: "oidc",
    message: "Single sign-on completed.",
    updatedAt: "2026-08-01T00:00:00.000Z"
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stateRoot, "sso-access-token.txt"), "oidc-access-token\n", "utf8");
  let fetchCount = 0;
  const fakeSession = {
    cookies: {
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

test("desktop sso logout clears every dedicated-partition cookie but scopes default-session cleanup", async (t) => {
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
  const partitionGets = [];
  const partitionRemoves = [];
  const defaultSession = {
    cookies: {
      set: async () => undefined,
      get: async (filter) => {
        defaultGets.push(filter);
        return filter.url ? [{ name: "_oauth2_proxy", value: "default", domain: "ai.example.test", path: "/", secure: true }] : [];
      },
      remove: async (url, name) => { defaultRemoves.push({ url, name }); }
    }
  };
  const partitionSession = {
    cookies: {
      set: async () => undefined,
      get: async (filter) => {
        partitionGets.push(filter);
        if (Object.keys(filter).length === 0) {
          return [
            { name: "_oauth2_proxy", value: "sso", domain: ".ai.example.test", path: "/", secure: true },
            { name: "eiam_session", value: "identity", domain: ".identity.example.test", path: "/oauth2", secure: true }
          ];
        }
        return [{ name: "_oauth2_proxy", value: "sso", domain: ".ai.example.test", path: "/", secure: true }];
      },
      remove: async (url, name) => { partitionRemoves.push({ url, name }); }
    }
  };
  const controller = createDesktopSsoController({
    app,
    platform: "darwin",
    session: {
      defaultSession,
      fromPartition: () => partitionSession
    },
    getMainWindow: () => null,
    openBrowserUrl: async () => ({ ok: true, action: "open", target: "", url: "", message: "" }),
    openExternal: async () => undefined
  });

  await controller.clearBrowserCookies();

  assert.equal(defaultGets.every((filter) => typeof filter.url === "string"), true);
  assert.equal(partitionGets.some((filter) => Object.keys(filter).length === 0), true);
  assert.equal(defaultRemoves.some(({ url }) => url.includes("identity.example.test")), false);
  assert.equal(partitionRemoves.some(({ url, name }) =>
    url === "https://identity.example.test/oauth2" && name === "eiam_session"), true);
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

test("desktop sso site token bridge exchange stores returned token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-site-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    providerLabel: "ZenMind",
    browserMode: "system",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
    siteTokenBridge: {
      startUrl: "https://site.example.test/api/auth/desktop-sso/start",
      exchangeUrl: "https://site.example.test/api/auth/desktop-sso/session"
    }
  });
  const setCookies = [];
  const fakeSession = {
    cookies: {
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
      json: async () => ({
        ok: true,
        accessToken: "site-access-token-1",
        tokenType: "Bearer",
        expiresAt: "2026-06-18T12:00:00Z",
        issuer: "https://official.example.test",
        audience: ["zenmind-market-server", "zenmind-tunnel-hub-server"],
        scope: "profile market tunnel",
        user: { id: 1, email: "desktop.user@example.test" }
      })
    };
  };

  const exchanged = await controller.exchangeSiteTokenBridgeTicket("site-ticket-1", fetchImpl);

  assert.equal(exchanged, true);
  assert.deepEqual(requestBody, { ticket: "site-ticket-1" });
  assert.equal(setCookies.length, 4);
  const tokenPath = __testInternals.getDesktopSsoSiteTokenFilePath(app);
  const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  assert.equal(stored.accessToken, "site-access-token-1");
  assert.deepEqual(stored.audience, ["zenmind-market-server", "zenmind-tunnel-hub-server"]);
  assert.equal(stored.issuer, "https://official.example.test");
  assert.equal(stored.scope, "profile market tunnel");
});

test("desktop sso site token bridge exchange fails without returned access token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-site-token-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    providerLabel: "ZenMind",
    browserMode: "system",
    issuer: "https://auth.example.test/application/o/desktop/",
    authorizeUrl: "https://auth.example.test/o/authorize/",
    tokenUrl: "https://auth.example.test/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.example.test/application/o/desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.example.test/application/o/desktop/end-session/",
    siteTokenBridge: {
      startUrl: "https://site.example.test/api/auth/desktop-sso/start",
      exchangeUrl: "https://site.example.test/api/auth/desktop-sso/session"
    }
  });
  const fakeSession = {
    cookies: {
      set: async () => undefined,
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

  const exchanged = await controller.exchangeSiteTokenBridgeTicket("site-ticket-1", async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "set-cookie": "sid=abc; Path=/; HttpOnly" }),
    json: async () => ({ ok: true, user: { id: 1 } })
  }));

  assert.equal(exchanged, false);
  assert.equal(fs.existsSync(__testInternals.getDesktopSsoSiteTokenFilePath(app)), false);
});
