import test from "node:test";
import assert from "node:assert/strict";

const { registerSsoIpcHandlers } = await import("../dist-electron/main/ipc/sso-handlers.js");

function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: {
      handle(channel, callback) {
        handlers[channel] = callback;
      }
    },
    handlers
  };
}

function makeBaseOptions(overrides = {}) {
  return {
    app: { name: "test-app" },
    desktopSsoController: {
      broadcastStatus: () => {},
      syncBrowserCookies: async () => {},
      exchangeBrowserCookieAccessToken: async () => "",
      exchangeWebSession: async () => false,
      clearBrowserCookies: async () => {},
      clearWebSessionCookies: async () => {},
      openBrowserUrl: async () => ({ ok: true }),
      openSystemBrowserUrl: async () => ({ ok: true })
    },
    getDesktopSsoStatus: async () => ({ configured: true, authenticated: false }),
    startDesktopSsoLogin: async () => ({ ok: true }),
    logoutDesktopSso: async () => ({ ok: true }),
    failDesktopSsoFlow: (message) => ({ configured: true, authenticated: false, pending: false, message }),
    ...overrides
  };
}

test("sso.getStatus returns desktop SSO status", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const status = { configured: true, authenticated: true, user: { email: "me@example.test" } };

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    getDesktopSsoStatus: async (app) => {
      assert.equal(app.name, "test-app");
      return status;
    }
  }));

  assert.ok(handlers["sso.getStatus"], "Should register sso.getStatus");
  const result = await handlers["sso.getStatus"]({});
  assert.deepEqual(result, status);
});

test("sso.startLogin syncs cookies before broadcasting authenticated status and opens the embedded browser for legacy flows", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];
  const authenticatedStatus = { configured: true, authenticated: true, pending: false };

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    desktopSsoController: {
      syncBrowserCookies: async () => { calls.push("sync"); },
      exchangeBrowserCookieAccessToken: async () => { calls.push("exchange"); },
      exchangeWebSession: async (idToken) => { calls.push(["web-session", idToken]); },
      broadcastStatus: (status) => { calls.push(["broadcast", status]); },
      clearBrowserCookies: async () => { calls.push("clear"); },
      clearWebSessionCookies: async () => { calls.push("clear-web"); },
      openBrowserUrl: async (input) => {
        calls.push(["open", input]);
        return { ok: true };
      },
      openSystemBrowserUrl: async (input) => {
        calls.push(["system", input]);
        return { ok: true };
      },
    },
    startDesktopSsoLogin: async (app, options) => {
      assert.equal(app.name, "test-app");
      await options.onBeforeStatusChanged(authenticatedStatus, { idToken: "google-id-token" });
      options.onStatusChanged(authenticatedStatus);
      return {
        ok: true,
        authorizeUrl: "https://iam.example.test/auth",
        browserUrl: "http://localhost:8080/auth",
        browserOrigin: "https://iam.example.test"
      };
    }
  }));

  const result = await handlers["sso.startLogin"]({});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "sync",
    "exchange",
    ["web-session", "google-id-token"],
    ["broadcast", authenticatedStatus],
    ["open", {
      url: "http://localhost:8080/auth",
      label: "IAM 登录",
      browserOrigin: undefined,
      resolveRedirect: true
    }]
  ]);
});

test("sso.startLogin opens Google flows in the system browser", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    desktopSsoController: {
      broadcastStatus: (status) => calls.push(["broadcast", status]),
      syncBrowserCookies: async () => { calls.push("sync"); },
      exchangeBrowserCookieAccessToken: async () => { calls.push("exchange"); },
      exchangeWebSession: async (idToken) => { calls.push(["web-session", idToken]); },
      clearBrowserCookies: async () => { calls.push("clear"); },
      clearWebSessionCookies: async () => { calls.push("clear-web"); },
      openBrowserUrl: async (input) => {
        calls.push(["embedded", input]);
        return { ok: true };
      },
      openSystemBrowserUrl: async (input) => {
        calls.push(["system", input]);
        return { ok: true };
      }
    },
    startDesktopSsoLogin: async () => ({
      ok: true,
      openMode: "system",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop"
    })
  }));

  const result = await handlers["sso.startLogin"]({});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["system", {
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop",
      label: "Google 登录"
    }]
  ]);
});

test("sso.startLogin fails the flow when system browser opening fails", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const broadcasts = [];
  const failedStatus = { configured: true, authenticated: false, pending: false, message: "open failed" };

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    desktopSsoController: {
      broadcastStatus: (status) => broadcasts.push(status),
      syncBrowserCookies: async () => {},
      exchangeBrowserCookieAccessToken: async () => "",
      exchangeWebSession: async () => false,
      clearBrowserCookies: async () => {},
      clearWebSessionCookies: async () => {},
      openBrowserUrl: async () => ({ ok: true }),
      openSystemBrowserUrl: async () => ({ ok: false, message: "open failed" })
    },
    startDesktopSsoLogin: async () => ({
      ok: true,
      openMode: "system",
      authorizeUrl: "https://iam.example.test/auth",
      browserOrigin: "https://iam.example.test"
    }),
    failDesktopSsoFlow: (message) => ({ ...failedStatus, message })
  }));

  const result = await handlers["sso.startLogin"]({});

  assert.equal(result.ok, false);
  assert.equal(result.message, "open failed");
  assert.deepEqual(result.status, failedStatus);
  assert.deepEqual(broadcasts, [failedStatus]);
});

test("sso.logout clears browser cookies and opens logout URL", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];
  const loggedOutStatus = { configured: true, authenticated: false, pending: false };

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    desktopSsoController: {
      broadcastStatus: (status) => calls.push(["broadcast", status]),
      syncBrowserCookies: async () => { calls.push("sync"); },
      exchangeBrowserCookieAccessToken: async () => { calls.push("exchange"); },
      exchangeWebSession: async (idToken) => { calls.push(["web-session", idToken]); },
      clearBrowserCookies: async () => { calls.push("clear"); },
      clearWebSessionCookies: async () => { calls.push("clear-web"); },
      openBrowserUrl: async (input) => {
        calls.push(["open", input]);
        return { ok: true };
      },
      openSystemBrowserUrl: async (input) => {
        calls.push(["system", input]);
        return { ok: true };
      }
    },
    logoutDesktopSso: async (app, options) => {
      assert.equal(app.name, "test-app");
      options.onStatusChanged(loggedOutStatus);
      return {
        ok: true,
        logoutUrl: "https://iam.example.test/logout",
        browserOrigin: "https://iam.example.test"
      };
    }
  }));

  const result = await handlers["sso.logout"]({});

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["broadcast", loggedOutStatus],
    "clear",
    "clear-web",
    ["open", {
      url: "https://iam.example.test/logout",
      label: "IAM 登出",
      browserOrigin: "https://iam.example.test",
      resolveRedirect: false
    }]
  ]);
});

test("agentAuth.issueAccessToken invokes issueAgentAccessToken", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let issuedReason = null;

  registerSsoIpcHandlers(ipc, makeBaseOptions({
    issueAgentAccessToken: async (app, reason) => {
      assert.equal(app.name, "test-app");
      issuedReason = reason;
      return "mocked-token";
    }
  }));

  assert.ok(handlers["agentAuth.issueAccessToken"], "Should register agentAuth.issueAccessToken");
  const result = await handlers["agentAuth.issueAccessToken"]({}, "missing");
  assert.equal(result, "mocked-token");
  assert.equal(issuedReason, "missing");
});
