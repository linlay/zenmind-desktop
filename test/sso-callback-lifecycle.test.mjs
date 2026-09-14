import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sso = require("../dist-electron/main/modules/identity/oidc-sso.js");
const lifecycle = require("../dist-electron/main/modules/identity/callback-lifecycle.js");

function fixture(t, browserMode = "system", extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sso-callback-"));
  const app = Object.assign(new EventEmitter(), { getPath: () => root });
  const configPath = sso.resolveDesktopSsoConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true, browserMode, authMode: "oidc",
    issuer: "https://auth.example.test/", authorizeUrl: "https://auth.example.test/authorize",
    jwksUrl: "https://auth.example.test/jwks",
    tokenUrl: "https://auth.example.test/token", clientId: "desktop", usePkce: true,
    redirectUri: "http://localhost:8080/api/auth/oidc/callback", ...extra
  }));
  t.after(() => {
    lifecycle.closeCallbackServer(undefined, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return app;
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}

async function assertReleased(servers, addresses) {
  assert.ok(servers.every(server => !server.listening));
  for (const address of addresses) {
    const replacement = http.createServer();
    replacement.listen({ host: address.address, port: address.port, ipv6Only: address.family === "IPv6" });
    await once(replacement, "listening");
    await new Promise(resolve => replacement.close(resolve));
  }
}

for (const browserMode of ["system", "embedded"]) {
  test(`${browserMode} login ignores occupied configured port and preserves that service`, async t => {
    const occupied = http.createServer((_req, res) => res.end("user app"));
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const port = occupied.address().port;
    const app = fixture(t, browserMode, { redirectUri: `http://localhost:${port}/api/auth/oidc/callback` });
    const result = await sso.startDesktopSsoLogin(app);
    assert.equal(result.ok, true, result.message);
    const redirect = new URL(new URL(result.authorizeUrl).searchParams.get("redirect_uri"));
    assert.ok(Number(redirect.port) > 0);
    assert.notEqual(Number(redirect.port), port);
    if (browserMode === "embedded") assert.equal(new URL(result.browserUrl).origin, redirect.origin);
    const tokenRequest = sso.buildTokenExchangeRequest("code", sso.desktopSsoRuntimeState.pendingLogin.config, {
      redirectUri: sso.desktopSsoRuntimeState.pendingLogin.redirectUri, codeVerifier: "verifier"
    });
    assert.equal(new URLSearchParams(tokenRequest.body).get("redirect_uri"), redirect.href);
    assert.equal((await request(`http://127.0.0.1:${port}`)).body, "user app");
    const servers = [...sso.desktopSsoRuntimeState.callbackServers];
    const addresses = servers.map(server => server.address());
    assert.equal(app.listenerCount("will-quit"), 1);
    sso.cancelDesktopSsoLogin(app);
    assert.equal(app.listenerCount("will-quit"), 0);
    await assertReleased(servers, addresses);
    assert.equal((await request(`http://127.0.0.1:${port}`)).body, "user app");
  });
}

test("callback error sends its page and releases both loopbacks", async t => {
  const app = fixture(t, "embedded");
  const result = await sso.startDesktopSsoLogin(app);
  const servers = [...sso.desktopSsoRuntimeState.callbackServers];
  const addresses = servers.map(server => server.address());
  const redirect = new URL(new URL(result.authorizeUrl).searchParams.get("redirect_uri"));
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("state", sso.desktopSsoRuntimeState.pendingLogin.state);
  assert.equal((await request(redirect)).status, 400);
  await assertReleased(servers, addresses);
});

test("server ticket success returns a complete page, focuses Desktop and releases listeners", async t => {
  const app = fixture(t, "system", { authMode: "server", serverAuthorizeUrl: "https://auth.example.test/desktop",
    webSessionExchange: { url: "https://auth.example.test/session" } });
  let returned = false;
  const result = await sso.startDesktopSsoLogin(app, {
    onBeforeStatusChanged: () => ({ sub: "user", issuer: "https://auth.example.test/", audience: "desktop" }),
    onReturnToAppRequested: () => { returned = true; }
  });
  assert.equal(result.ok, true, result.message);
  const servers = [...sso.desktopSsoRuntimeState.callbackServers];
  const addresses = servers.map(server => server.address());
  const callback = new URL(new URL(result.authorizeUrl).searchParams.get("callback"));
  callback.searchParams.set("state", sso.desktopSsoRuntimeState.pendingLogin.state);
  callback.searchParams.set("ticket", "test-ticket");
  const response = await request(callback);
  assert.equal(response.status, 200, response.body);
  assert.equal(returned, true);
  assert.doesNotMatch(response.body, /href=.*return-to-app/u);
  await assertReleased(servers, addresses);
});

for (const end of ["failure", "quit", "timeout", "cookie-completion"]) {
  test(`${end} releases listeners and removes quit hook`, async t => {
    const app = fixture(t);
    if (end === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal((await sso.startDesktopSsoLogin(app)).ok, true);
    const servers = [...sso.desktopSsoRuntimeState.callbackServers];
    const addresses = servers.map(server => server.address());
    if (end === "failure") sso.failDesktopSsoFlow("browser failed to open");
    if (end === "quit") app.emit("will-quit");
    if (end === "timeout") t.mock.timers.tick(lifecycle.CALLBACK_TIMEOUT_MS);
    if (end === "cookie-completion") {
      sso.completeDesktopSsoBrowserSession(app);
      sso.finalizeDesktopSsoLoginAttempt();
    }
    assert.equal(app.listenerCount("will-quit"), 0);
    await assertReleased(servers, addresses);
  });
}

test("late cleanup from a previous attempt preserves the new listener", async t => {
  const app = fixture(t);
  await sso.startDesktopSsoLogin(app);
  const previous = sso.desktopSsoRuntimeState.callbackServers;
  const response = new EventEmitter();
  sso.closeCallbackServerAfterResponse(response);
  await sso.startDesktopSsoLogin(app);
  response.emit("finish");
  lifecycle.closeCallbackServer(previous);
  assert.ok(sso.desktopSsoRuntimeState.callbackServers.every(server => server.listening));
  assert.equal(app.listenerCount("will-quit"), 1);
});

test("proxy rewriting consistently uses the dynamic origin", async t => {
  const app = fixture(t, "embedded");
  const result = await sso.startDesktopSsoLogin(app);
  const origin = new URL(result.browserUrl).origin;
  const config = sso.desktopSsoRuntimeState.pendingLogin.config;
  assert.equal(sso.rewriteDesktopSsoProxyHeaderUrl(`${origin}/login`, config), "https://auth.example.test/login");
  assert.equal(sso.rewriteDesktopSsoProxyLocation("/next", new URL(config.authorizeUrl), config), `${origin}/next`);
  assert.equal(sso.rewriteDesktopSsoProxyBody(Buffer.from('"https://auth.example.test/next"'), "application/json", config).toString(), `"${origin}/next"`);
});

test("an in-flight callback cannot finalize a cancelled attempt or close its replacement", async t => {
  const app = fixture(t, "system", {
    authMode: "server", serverAuthorizeUrl: "https://auth.example.test/desktop",
    webSessionExchange: { url: "https://auth.example.test/session" }
  });
  let release;
  const claims = new Promise(resolve => { release = resolve; });
  await sso.startDesktopSsoLogin(app, { onBeforeStatusChanged: () => claims });
  const callback = new URL(sso.desktopSsoRuntimeState.pendingLogin.redirectUri);
  callback.searchParams.set("state", sso.desktopSsoRuntimeState.pendingLogin.state);
  callback.searchParams.set("ticket", "delayed-ticket");
  const completed = sso.handleLoginCallback(app, callback);
  await sso.startDesktopSsoLogin(app);
  const replacement = sso.desktopSsoRuntimeState.callbackServers;
  const pending = sso.desktopSsoRuntimeState.pendingLogin;
  release({ sub: "old-user", issuer: "https://auth.example.test/", audience: "desktop" });
  await assert.rejects(completed);
  assert.equal(sso.desktopSsoRuntimeState.pendingLogin, pending);
  assert.ok(replacement.length > 0 && replacement.every(server => server.listening));
});

test("front-channel logout uses a dynamic port and releases it after responding", async t => {
  const app = fixture(t, "system", {
    logoutUrl: "https://auth.example.test/logout",
    logoutCallbackUri: "http://localhost:8080/api/auth/oidc/logout-callback"
  });
  sso.beginAuthenticatedSession(app, { authMode: "oidc" }, "test-id-token");
  const result = await sso.logoutDesktopSso(app);
  assert.equal(result.ok, true, result.message);
  const callback = new URL(new URL(result.logoutUrl).searchParams.get("post_logout_redirect_uri"));
  assert.ok(Number(callback.port) > 0);
  assert.notEqual(callback.port, "8080");
  const servers = [...sso.desktopSsoRuntimeState.callbackServers];
  const addresses = servers.map(server => server.address());
  assert.equal((await request(callback)).status, 200);
  await assertReleased(servers, addresses);
});
