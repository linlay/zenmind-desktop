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
    logoutDesktopSso: async () => ({ ok: true, status: createStatus(false) }),
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
