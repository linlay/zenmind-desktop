import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  registerDesktopSsoAvatarProtocol,
  registerDesktopSsoAvatarProtocolScheme,
} = require("../dist-electron/main/modules/identity/avatar-protocol.js");
const {
  clearCachedDesktopSsoAvatar,
  getDesktopSsoAvatarCacheDir,
} = require("../dist-electron/main/modules/identity/avatar-storage.js");
const { __testInternals: oidcInternals } = require("../dist-electron/main/modules/identity/oidc-sso.js");
const {
  DESKTOP_SSO_AVATAR_PROTOCOL,
  buildDesktopSsoAvatarUrl,
} = require("../dist-electron/shared/sso-avatar.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "Library", "Application Support");
      }
      return homePath;
    }
  };
}

function writeAvatarFixture(app, sourceUrl) {
  const configPath = oidcInternals.resolveDesktopSsoConfigPath(app, "darwin");
  const stateRoot = path.join(
    path.dirname(path.dirname(path.dirname(configPath))),
    "state",
    "desktop"
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    enabled: true,
    authMode: "server",
    issuer: "https://www.zenmind.cc",
    authorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    serverAuthorizeUrl: "https://www.zenmind.cc/api/auth/desktop-sso/start",
    tokenUrl: "https://www.zenmind.cc/api/auth/desktop-sso/token",
    clientId: "zenmind-desktop",
    avatarCache: {
      enabled: true,
      trustedOrigin: "https://www.zenmind.cc"
    },
    webSessionExchange: {
      url: "https://www.zenmind.cc/api/auth/desktop-sso/session",
      provider: "zenmind"
    }
  }, null, 2)}\n`);
  const user = {
    schemaVersion: 2,
    sub: "zenmind-user:6",
    issuer: "https://www.zenmind.cc",
    audience: "zenmind-desktop",
    name: "Frank Linlay",
    avatarUrl: sourceUrl
  };
  fs.writeFileSync(
    path.join(stateRoot, "sso-user-info.json"),
    `${JSON.stringify(user, null, 2)}\n`,
    { mode: 0o600 }
  );
  const version = createHash("sha256")
    .update(`${user.sub}\x00${sourceUrl}`)
    .digest("hex")
    .slice(0, 24);
  return { version };
}

test("desktop sso avatar protocol downloads the trusted official URL once and serves local cache", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-avatar-protocol-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const sourceUrl = "https://www.zenmind.cc/api/auth/avatar/version";
  const { version } = writeAvatarFixture(app, sourceUrl);
  let protocolHandler;
  let registeredScheme;
  let fetchCount = 0;
  const protocolModule = {
    registerSchemesAsPrivileged(entries) {
      registeredScheme = entries[0];
    },
    handle(_scheme, handler) {
      protocolHandler = handler;
    }
  };
  registerDesktopSsoAvatarProtocolScheme(protocolModule);
  registerDesktopSsoAvatarProtocol(
    app,
    protocolModule,
    {
      async fetch(fileUrl) {
        return new Response(fs.readFileSync(fileURLToPath(fileUrl)), {
          status: 200,
          headers: { "Content-Type": "image/png" }
        });
      }
    },
    {
      defaultSession: {
        async fetch(url, init) {
          fetchCount += 1;
          assert.equal(url, sourceUrl);
          assert.equal(init.credentials, "include");
          assert.equal(init.redirect, "manual");
          return new Response(Buffer.from("\x89PNG\r\n\x1a\navatar"), {
            status: 200,
            headers: { "Content-Type": "image/png" }
          });
        }
      }
    },
    "darwin"
  );

  assert.equal(registeredScheme.scheme, DESKTOP_SSO_AVATAR_PROTOCOL);
  assert.equal(registeredScheme.privileges.secure, true);
  const requestUrl = buildDesktopSsoAvatarUrl(version);
  const first = await protocolHandler({ url: requestUrl });
  assert.equal(first.status, 200);
  assert.match(Buffer.from(await first.arrayBuffer()).toString("utf8"), /avatar/u);
  const second = await protocolHandler({ url: requestUrl });
  assert.equal(second.status, 200);
  assert.equal(fetchCount, 1);

  const cacheDir = getDesktopSsoAvatarCacheDir(app, "darwin");
  assert.deepEqual(fs.readdirSync(cacheDir), [`${version}.png`]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(cacheDir, `${version}.png`)).mode & 0o777, 0o600);
  }
  clearCachedDesktopSsoAvatar(app, "darwin");
  assert.equal(fs.existsSync(cacheDir), false);
});

test("desktop sso avatar protocol rejects redirects outside the configured official origin", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-sso-avatar-redirect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const { version } = writeAvatarFixture(
    app,
    "https://www.zenmind.cc/api/auth/avatar/version"
  );
  let protocolHandler;
  registerDesktopSsoAvatarProtocol(
    app,
    {
      registerSchemesAsPrivileged() {},
      handle(_scheme, handler) {
        protocolHandler = handler;
      }
    },
    {
      async fetch() {
        throw new Error("local file fetch should not run");
      }
    },
    {
      defaultSession: {
        async fetch() {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://lh3.googleusercontent.com/avatar.png" }
          });
        }
      }
    },
    "darwin"
  );

  const response = await protocolHandler({ url: buildDesktopSsoAvatarUrl(version) });
  assert.equal(response.status, 404);
  assert.equal(fs.existsSync(getDesktopSsoAvatarCacheDir(app, "darwin")), false);
});
