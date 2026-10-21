import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateDesktopInitSsoEnvironmentUpgrade } = require("../dist-electron/main/app/bootstrap/desktop-init-sso-upgrade.js");
const { applyDesktopInitVersionUpgrade } = require("../dist-electron/main/app/bootstrap/desktop-init-upgrade.js");
const { resolveDesktopSsoConfigPath } = require("../dist-electron/main/modules/identity/index.js");
const upgrade = require("../dist-electron/main/modules/services/manager/desktop-config-upgrade.js");
const runtimeUpgrade = require("../dist-electron/main/modules/services/manager/runtime-upgrade.js");

function cookieConfig(origin, overrides = {}) {
  return {
    enabled: true,
    browserOrigin: origin,
    loginUrl: `${origin}/login`,
    browserSession: { url: `${origin}/session` },
    claims: { audience: "desktop" },
    cookieAccessTokenExchange: {
      url: `${origin}/authorization`,
      accessTokenIssuer: `${origin}/oidc`,
      accessTokenAudience: "desktop"
    },
    ...overrides
  };
}

function oidcConfig(issuer, overrides = {}) {
  const origin = new URL(issuer).origin;
  return {
    enabled: true,
    issuer,
    authorizeUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    jwksUrl: `${origin}/keys`,
    clientId: "desktop",
    usePkce: true,
    ...overrides
  };
}

function serverConfig(origin, overrides = {}) {
  return {
    enabled: true,
    authMode: "server",
    browserOrigin: origin,
    serverAuthorizeUrl: `${origin}/authorize`,
    webSessionExchange: { url: `${origin}/api/auth/desktop/exchange` },
    claims: { audience: "desktop" },
    ...overrides
  };
}

function fixture(t, platform = process.platform, current = cookieConfig("https://dev.example.test")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sso-upgrade-environment-"));
  const previousCwd = process.cwd();
  // Windows path strings remain confined to this temporary cwd on a POSIX host.
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = {
    isPackaged: true,
    getPath(name) { return path.join(root, name); }
  };
  const canonical = resolveDesktopSsoConfigPath(app, platform);
  if (current !== null) {
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, JSON.stringify(current));
  }
  return { app, root, canonical };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: automatic SSO preflight rejects another Cookie environment without changing canonical files`, (t) => {
    const { app, root, canonical } = fixture(t, platform);
    const updates = path.join(root, "updates.json");
    const serviceConfig = path.join(root, "service-owned.env");
    fs.writeFileSync(updates, '{"feedUrl":"https://updates-dev.example.test/feed"}');
    fs.writeFileSync(serviceConfig, "UNCHANGED=true\n");
    const before = [canonical, updates, serviceConfig].map(file => fs.readFileSync(file));
    assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: cookieConfig("https://prod.example.test")
    }, platform), /dev\.example\.test.*prod\.example\.test|prod\.example\.test.*dev\.example\.test/u);
    for (const [index, file] of [canonical, updates, serviceConfig].entries()) {
      assert.deepEqual(fs.readFileSync(file), before[index]);
    }
  });

  test(`${platform}: the same normalized Cookie identity allows endpoint and UI changes`, (t) => {
    const current = cookieConfig("https://dev.example.test");
    const { app } = fixture(t, platform, current);
    assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: { ...current, browserOrigin: "https://DEV.example.test:443/ignored?view=login", loginUrl: "https://dev.example.test/new-login", providerLabel: "New label" }
    }, platform));
  });

  test(`${platform}: Cookie claim and token selector changes cannot silently select another identity`, (t) => {
    const current = cookieConfig("https://dev.example.test");
    const { app } = fixture(t, platform, current);
    for (const sso of [
      { ...current, claims: { audience: "another-environment" } },
      { ...current, cookieAccessTokenExchange: { ...current.cookieAccessTokenExchange, accessTokenIssuer: "https://dev.example.test/another-realm" } },
      { ...current, cookieAccessTokenExchange: { ...current.cookieAccessTokenExchange, accessTokenAudience: "another-environment" } }
    ]) assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, { sso }, platform));
  });

  test(`${platform}: OIDC issuer realms on the same origin remain distinct`, (t) => {
    const { app } = fixture(t, platform, oidcConfig("https://identity.example.test/realms/dev"));
    assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: oidcConfig("https://identity.example.test/realms/prod")
    }, platform), /realms\/dev.*realms\/prod|realms\/prod.*realms\/dev/u);
    assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: oidcConfig("https://identity.example.test/realms/dev", { authorizeUrl: "https://identity.example.test/new-authorize" })
    }, platform));
    assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: oidcConfig("https://identity.example.test/realms/dev", { clientId: "another-application" })
    }, platform));
  });

  test(`${platform}: server mode compares the normalized broker identity and requires its exchange configuration`, (t) => {
    const { app, canonical } = fixture(t, platform, serverConfig("https://broker-dev.example.test"));
    assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: serverConfig("https://broker-dev.example.test", { webSessionExchange: { url: "https://broker-dev.example.test/new-exchange" } })
    }, platform));
    assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: serverConfig("https://broker-prod.example.test")
    }, platform), /broker-dev\.example\.test|broker-prod\.example\.test/u);
    const before = fs.readFileSync(canonical);
    const missingExchange = serverConfig("https://broker-dev.example.test");
    delete missingExchange.webSessionExchange;
    assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
      sso: missingExchange
    }, platform), error => {
      assert.notEqual(error.name, "TypeError");
      return true;
    });
    assert.deepEqual(fs.readFileSync(canonical), before);
  });

  test(`${platform}: missing, disabled and first-time SSO configuration retain their existing behavior`, (t) => {
    const { app, canonical } = fixture(t, platform);
    for (const defaults of [{}, { sso: { enabled: false } }]) {
      assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, defaults, platform));
    }
    fs.writeFileSync(canonical, '{"enabled":false}');
    assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, { sso: cookieConfig("https://prod.example.test") }, platform));
    fs.rmSync(canonical);
    assert.doesNotThrow(() => validateDesktopInitSsoEnvironmentUpgrade(app, { sso: cookieConfig("https://prod.example.test") }, platform));
  });

  test(`${platform}: explicit Desktop configuration import can switch SSO environment`, (t) => {
    const { app, root, canonical } = fixture(t, platform);
    const incoming = cookieConfig("https://prod.example.test");
    applyDesktopInitVersionUpgrade(app, { sso: incoming }, path.join(root, "manual-backup"), platform);
    assert.deepEqual(JSON.parse(fs.readFileSync(canonical, "utf8")), incoming);
  });
}

test("SSO upgrade errors do not expose URL credentials, query parameters or fragments", (t) => {
  const current = oidcConfig("https://username:synthetic-password@identity.example.test/realms/dev?token=synthetic-token#synthetic-fragment");
  const { app } = fixture(t, process.platform, current);
  assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
    sso: oidcConfig("https://identity.example.test/realms/prod")
  }), error => {
    assert.match(error.message, /identity\.example\.test\/realms\/dev/u);
    assert.doesNotMatch(error.message, /username|synthetic-|token=|\?/u);
    return true;
  });
});

test("opaque OIDC issuer identities remain distinct without exposing their contents in errors", (t) => {
  const current = { ...oidcConfig("https://identity.example.test/realms/dev"), issuer: "urn:synthetic-secret-dev" };
  const { app } = fixture(t, process.platform, current);
  assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
    sso: { ...current, issuer: "urn:synthetic-secret-prod" }
  }), error => {
    assert.notEqual(error.name, "TypeError");
    assert.match(error.message, /urn:/u);
    assert.doesNotMatch(error.message, /synthetic-secret|null/u);
    return true;
  });
});

test("invalid enabled incoming SSO is rejected instead of guessing its identity", (t) => {
  const { app, canonical } = fixture(t);
  const before = fs.readFileSync(canonical);
  assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
    sso: cookieConfig("https://prod.example.test", { cookieAccessTokenExchange: { url: "/authorization", accessTokenIssuer: "https://prod.example.test/oidc" } })
  }));
  assert.deepEqual(fs.readFileSync(canonical), before);
  assert.throws(() => validateDesktopInitSsoEnvironmentUpgrade(app, {
    sso: cookieConfig("https://dev.example.test", { cookieAccessTokenExchange: {
      url: "/authorization", accessTokenIssuer: "urn:opaque-cookie-issuer", accessTokenAudience: "desktop"
    } })
  }), error => {
    assert.notEqual(error.name, "TypeError");
    assert.doesNotMatch(error.message, /opaque-cookie-issuer/u);
    return true;
  });
});

for (const isPackaged of [true, false]) {
  test(`${isPackaged ? "packaged" : "development"}: the real automatic upgrade coordinator rejects cross-environment input before stage, apply or service stop`, async (t) => {
    const { app, canonical } = fixture(t);
    app.isPackaged = isPackaged;
    upgrade.completeDesktopServiceConfigUpgrade(app, "0.5.14");
    const environment = require("../dist-electron/main/infrastructure/filesystem/runtime-env-upgrade.js");
    const registry = require("../dist-electron/main/modules/services/service-registry.js");
    const validated = {
      desktopInit: { sso: cookieConfig("https://prod.example.test") },
      sourceZipPath: "/validated/env.zip", sha256: "a".repeat(64), size: 1024
    };
    let staged = 0;
    let applied = 0;
    let beganServiceUpgrade = 0;
    t.mock.method(registry, "getService", () => ({ web: { defaultPort: 17078 } }));
    t.mock.method(environment, "validateBundledEnvForDesktopVersionUpgrade", async () => validated);
    t.mock.method(environment, "validateSelectedEnvZipForDesktopVersionUpgrade", async () => validated);
    t.mock.method(environment, "stageValidatedDesktopVersionUpgradeInput", async () => { staged += 1; return validated; });
    const before = fs.readFileSync(canonical);
    const result = await runtimeUpgrade.runDesktopServiceConfigUpgradePreparation(app, "0.5.15", {
      ...(!isPackaged ? { desktopVersionUpgradeEnvZipPath: validated.sourceZipPath } : {}),
      validateDesktopConfigurationUpgrade: validateDesktopInitSsoEnvironmentUpgrade,
      applyDesktopConfiguration: () => { applied += 1; }
    }, () => { beganServiceUpgrade += 1; });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /dev\.example\.test/u);
    assert.deepEqual([staged, applied, beganServiceUpgrade], [0, 0, 0]);
    assert.deepEqual(fs.readFileSync(canonical), before);
    assert.equal(upgrade.__testInternals.readVersionState(app, process.platform).desktopVersion, "v0.5.14");
    assert.equal(result.journal.desktopConfig.status, "failed");
  });
}

test("first installation does not run the automatic environment-change guard", async (t) => {
  const { app } = fixture(t);
  const registry = require("../dist-electron/main/modules/services/service-registry.js");
  t.mock.method(registry, "getService", () => ({ web: { defaultPort: 17078 } }));
  let checked = 0;
  const result = await runtimeUpgrade.runDesktopServiceConfigUpgradePreparation(app, "0.5.15", {
    isFirstDesktopInstall: true,
    validateDesktopConfigurationUpgrade: () => { checked += 1; assert.fail("First installation has no previous environment to preserve"); }
  }, () => assert.fail("First installation must not reset services"));
  assert.equal(result.mode, "fresh-install");
  assert.deepEqual(result.failures, []);
  assert.equal(checked, 0);
});

test("the real explicit env import path can select another environment and keeps its manual-import lifecycle", async (t) => {
  const { app, canonical } = fixture(t);
  const environment = require("../dist-electron/main/infrastructure/filesystem/runtime-env-upgrade.js");
  const registry = require("../dist-electron/main/modules/services/service-registry.js");
  const state = require("../dist-electron/main/modules/services/manager/service-state.js");
  const installation = require("../dist-electron/main/modules/services/manager/installation.js");
  const ports = require("../dist-electron/main/modules/services/port-defaults.js");
  const lifecycle = require("../dist-electron/main/modules/services/lifecycle-args.js");
  const incoming = cookieConfig("https://prod.example.test");
  const validated = {
    desktopInit: { sso: incoming }, sourceZipPath: "/validated/manual-env.zip",
    sha256: "b".repeat(64), size: 1024
  };
  const calls = [];
  t.mock.method(environment, "validateEnvZipForDesktopManualImport", async () => validated);
  t.mock.method(registry, "getService", id => ({ id, frontend: {}, web: { defaultPort: 17078 } }));
  t.mock.method(state, "getServiceState", async () => ({ installed: false }));
  t.mock.method(ports, "rewriteServicePortDefaultsForDesktopConfigUpgrade", () => ({ services: { "agent-platform": { defaultPort: 17078 } } }));
  t.mock.method(lifecycle, "rewriteServiceLifecycleArgsForDesktopConfigUpgrade", () => undefined);
  t.mock.method(installation, "installBuiltinService", async (_app, id, options) => { calls.push(["install", id, options.source]); });
  t.mock.method(installation, "initializeServiceInternal", async (_app, id, options) => {
    calls.push(["initialize", id, options.desktopConfigReset.runtimeResourceMode]);
    return { ok: true };
  });
  const result = await runtimeUpgrade.importEnvZipIntoExistingRuntime(app, "/selected/manual-env.zip", "0.5.15", process.platform, applyDesktopInitVersionUpgrade);
  assert.equal(result.platformResourcesMigrated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(canonical, "utf8")), incoming);
  assert.deepEqual(calls, [
    ["install", "agent-platform", "manual-env-import"],
    ["initialize", "agent-platform", "manual-import"]
  ]);
});
