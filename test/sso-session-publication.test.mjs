import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  completeDesktopSsoRestoredBrowserSession,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  persistDesktopSsoAccessToken,
  getDesktopSsoBusinessToken
} = require("../dist-electron/main/modules/identity/sso-browser-session.js");
const { clearSession, finalizeDesktopSsoLoginAttempt } = require("../dist-electron/main/modules/identity/sso-session.js");
const {
  desktopSsoRuntimeState,
  createSignedOutStatus,
  createPendingStatus,
  subscribeDesktopSsoCredentialRevocation
} = require("../dist-electron/main/modules/identity/sso-state.js");
const {
  resolveDesktopSsoConfigPath,
  getSessionPath,
  getDesktopSsoUserInfoFilePath
} = require("../dist-electron/main/modules/identity/sso-paths.js");
const { getDesktopSsoIdTokenFilePath } = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");

const origin = "https://publication.example.test";
const user = { sub: "staff-1", name: "Original user", email: "staff@example.test" };
const marketIdentity = status => JSON.stringify([
  status.user?.issuer, status.user?.sub, status.user?.audience, status.completedSteps.accessToken
]);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-sso-publication-"));
  const app = { getPath: name => name === "home" ? root : path.join(root, name) };
  const configPath = resolveDesktopSsoConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    browserOrigin: origin,
    loginUrl: `${origin}/login`,
    tokenExchange: { url: `${origin}/authorization` },
    tokenRefresh: { url: `${origin}/refresh` },
    userInfo: { url: `${origin}/userinfo`, authMode: "cookie", subPath: "data.staffno" }
  }));
  desktopSsoRuntimeState.callbackHooks = {};
  clearSession(app);
  desktopSsoRuntimeState.currentStatus = createSignedOutStatus("Not signed in");
  const tokenPath = getDesktopSsoIdTokenFilePath(app);
  const files = [getSessionPath(app), getDesktopSsoUserInfoFilePath(app), tokenPath];
  const events = [];
  let revocations = 0;
  const unsubscribe = subscribeDesktopSsoCredentialRevocation(() => revocations++);
  desktopSsoRuntimeState.callbackHooks = {
    onStatusChanged: status => events.push({
      status,
      token: getDesktopSsoBusinessToken(),
      diskToken: fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : null
    })
  };
  t.after(() => {
    desktopSsoRuntimeState.callbackHooks = {};
    unsubscribe();
    clearSession(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, tokenPath, files, events, get revocations() { return revocations; } };
}

function assertReadyEvent(event, expectedToken) {
  assert.equal(event.status.authenticated, true);
  assert.equal(event.status.pending, false);
  assert.equal(event.status.user.sub, user.sub);
  assert.deepEqual(event.status.completedSteps, { session: true, userInfo: true, accessToken: true });
  assert.equal(event.token, expectedToken);
  assert.equal(event.diskToken, expectedToken);
  assert.equal(JSON.stringify(event.status).includes(expectedToken), false);
}

test("verified startup restoration publishes one complete identity after all files are ready", t => {
  const f = fixture(t);
  const result = completeDesktopSsoRestoredBrowserSession(f.app, "restored-business-token", user);
  assert.equal(f.events.length, 1);
  assertReadyEvent(f.events[0], "restored-business-token");
  assert.deepEqual(result, f.events[0].status);
  assert.equal(f.revocations, 0);
  const session = JSON.parse(fs.readFileSync(f.files[0], "utf8"));
  assert.equal(session.authMode, "browser-cookie");
  assert.equal(session.issuer, origin);
  const persistedUser = JSON.parse(fs.readFileSync(f.files[1], "utf8"));
  assert.equal(persistedUser.source, "browser_session");
  assert.equal(persistedUser.sub, user.sub);
});

test("same-account renewal preserves identity and the old token until the replacement is ready", t => {
  const f = fixture(t);
  const previous = completeDesktopSsoRestoredBrowserSession(f.app, "old-business-token", user);
  f.events.length = 0;
  const rename = fs.renameSync;
  const observed = [];
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    observed.push(path.basename(String(to)));
    assert.equal(getDesktopSsoBusinessToken(), "old-business-token");
    assert.equal(fs.readFileSync(f.tokenPath, "utf8").trim(), "old-business-token");
    return rename(from, to);
  });
  try {
    completeDesktopSsoRestoredBrowserSession(f.app, "new-business-token", { ...user, name: "Updated user" });
  } finally {
    mock.mock.restore();
  }
  assert.deepEqual(observed, f.files.map(file => path.basename(file)));
  assert.equal(f.events.length, 1);
  assertReadyEvent(f.events[0], "new-business-token");
  assert.equal(marketIdentity(f.events[0].status), marketIdentity(previous));
  assert.equal(f.events[0].status.user.name, "Updated user");
  assert.equal(f.revocations, 0);
});

for (const fileIndex of [0, 1, 2]) {
  test(`renewal staging failure for file ${fileIndex + 1} preserves the previous identity and files`, t => {
    const f = fixture(t);
    const previous = completeDesktopSsoRestoredBrowserSession(f.app, "old-business-token", user);
    const snapshots = f.files.map(file => fs.readFileSync(file));
    f.events.length = 0;
    const write = fs.writeFileSync;
    const failedPrefix = `.${path.basename(f.files[fileIndex])}.`;
    const mock = t.mock.method(fs, "writeFileSync", (file, ...args) => {
      if (path.basename(String(file)).startsWith(failedPrefix)) throw new Error("simulated storage failure");
      return write(file, ...args);
    });
    try {
      assert.throws(() => completeDesktopSsoRestoredBrowserSession(f.app, "new-business-token", { ...user, name: "Updated user" }), /simulated storage failure/);
    } finally {
      mock.mock.restore();
    }
    assert.deepEqual(desktopSsoRuntimeState.currentStatus, previous);
    assert.equal(getDesktopSsoBusinessToken(), "old-business-token");
    assert.equal(f.events.length, 0);
    assert.equal(f.revocations, 0);
    f.files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), snapshots[index]));
    assert.equal(fs.readdirSync(path.dirname(f.tokenPath)).some(name => name.endsWith(".tmp")), false);
  });
}

test("a failed canonical token replacement rolls back session and user files without revocation", t => {
  const f = fixture(t);
  const previous = completeDesktopSsoRestoredBrowserSession(f.app, "old-business-token", user);
  const snapshots = f.files.map(file => fs.readFileSync(file));
  f.events.length = 0;
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === f.tokenPath) throw new Error("simulated token replacement failure");
    return rename(from, to);
  });
  try {
    assert.throws(() => completeDesktopSsoRestoredBrowserSession(f.app, "new-business-token", { ...user, name: "Updated user" }), /simulated token replacement failure/);
  } finally {
    mock.mock.restore();
  }
  assert.deepEqual(desktopSsoRuntimeState.currentStatus, previous);
  assert.equal(getDesktopSsoBusinessToken(), "old-business-token");
  assert.equal(f.events.length, 0);
  assert.equal(f.revocations, 0);
  f.files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), snapshots[index]));
});

test("an invalid restored user never withdraws the current identity", t => {
  const f = fixture(t);
  const previous = completeDesktopSsoRestoredBrowserSession(f.app, "old-business-token", user);
  f.events.length = 0;
  assert.throws(() => completeDesktopSsoRestoredBrowserSession(f.app, "new-business-token", { sub: " " }));
  assert.deepEqual(desktopSsoRuntimeState.currentStatus, previous);
  assert.equal(getDesktopSsoBusinessToken(), "old-business-token");
  assert.equal(fs.readFileSync(f.tokenPath, "utf8").trim(), "old-business-token");
  assert.equal(f.events.length, 0);
  assert.equal(f.revocations, 0);
});

test("interactive login retains its distinct session, user and token progress", t => {
  const f = fixture(t);
  desktopSsoRuntimeState.currentStatus = createPendingStatus("Waiting for login");
  completeDesktopSsoBrowserSession(f.app);
  completeDesktopSsoBrowserSessionUserInfo(f.app, user);
  persistDesktopSsoAccessToken(f.app, "interactive-business-token");
  finalizeDesktopSsoLoginAttempt();
  assert.deepEqual(f.events.map(({ status }) => [status.completedSteps.session, status.completedSteps.userInfo, status.completedSteps.accessToken, status.pending]), [
    [true, false, false, true],
    [true, true, false, true],
    [true, true, true, true],
    [true, true, true, false]
  ]);
});
