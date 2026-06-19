import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { registerSsoIpcHandlers } = require("../dist-electron/main/ipc/sso-handlers.js");
const { createDesktopSsoController } = require("../dist-electron/main/sso-controller.js");
const { __testInternals } = require("../dist-electron/main/oidc-sso.js");

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
    broadcasts: []
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
      clearBrowserCookies: async () => undefined,
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
        await hooks.onBeforeStatusChanged({ authenticated: true }, { idToken: "id-token-1" });
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
    issueAgentAccessToken: async () => ({ ok: false, token: "", message: "unavailable" })
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

test("desktop sso login opens configured site token bridge after oidc success", async () => {
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
