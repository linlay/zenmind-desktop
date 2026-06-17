import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  startDesktopSsoLogin,
  __testInternals
} = require("../dist-electron/main/oidc-sso.js");

function createApp(homePath) {
  return {
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

test("desktop sso parses provider-free system browser OIDC config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "system",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.authMode, "oidc");
  assert.equal(result.config.browserMode, "system");
  assert.equal(result.config.redirectUri, "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(result.config.logoutCallbackUri, "http://localhost:8080/api/auth/oidc/logout-callback");
  assert.equal(result.config.usePkce, true);
  assert.equal(__testInternals.shouldUseSystemBrowser(result.config), true);
});

test("desktop sso keeps embedded browser default for ordinary OIDC without browserMode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  const result = __testInternals.loadDesktopSsoConfig(app, "darwin");
  assert.equal(result.configured, true);
  assert.equal(__testInternals.shouldUseSystemBrowser(result.config), false);
});

test("desktop sso system browser login uses localhost callback for explicit browserMode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-oidc-sso-"));
  t.after(() => {
    __testInternals.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const app = createApp(path.join(root, "home"));
  writeSsoConfig(app, {
    enabled: true,
    browserMode: "system",
    issuer: "https://auth.zenmind.cc/application/o/zenmind-desktop/",
    authorizeUrl: "https://auth.zenmind.cc/application/o/authorize/",
    tokenUrl: "https://auth.zenmind.cc/application/o/token/",
    clientId: "zenmind-desktop",
    redirectUri: "http://127.0.0.1:0/api/auth/oidc/callback",
    wellKnownUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/.well-known/openid-configuration",
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  });

  return startDesktopSsoLogin(app).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.openMode, "system");
    assert.equal(result.browserUrl, undefined);
    const authorizeUrl = new URL(result.authorizeUrl);
    const redirectUri = new URL(authorizeUrl.searchParams.get("redirect_uri"));
    assert.equal(redirectUri.hostname, "127.0.0.1");
    assert.equal(redirectUri.pathname, "/api/auth/oidc/callback");
    assert.notEqual(redirectUri.port, "");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  });
});

test("desktop sso authorize and logout URLs use standard OIDC defaults", () => {
  const config = {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    clientSecret: undefined,
    clientId: "zenmind-desktop",
    usePkce: true,
    logoutUrl: "https://auth.zenmind.cc/application/o/zenmind-desktop/end-session/"
  };
  const authorizeUrl = new URL(__testInternals.buildAuthorizeUrl("state-1", config, {
    codeChallenge: "challenge-1"
  }));
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://localhost:8080/api/auth/oidc/callback");
  assert.equal(authorizeUrl.searchParams.get("scope"), "openid email profile");
  assert.equal(authorizeUrl.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(authorizeUrl.searchParams.has("prompt"), false);

  const logoutUrl = new URL(__testInternals.buildLogoutUrl(config));
  assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), "http://localhost:8080/api/auth/oidc/logout-callback");
  assert.equal(logoutUrl.searchParams.has("callback"), false);
});

test("desktop sso authorize URL keeps explicit OIDC prompt", () => {
  const config = {
    ...__testInternals.DEFAULT_OIDC_CONFIG,
    prompt: "login"
  };
  const authorizeUrl = new URL(__testInternals.buildAuthorizeUrl("state-1", config));
  assert.equal(authorizeUrl.searchParams.get("prompt"), "login");
});
