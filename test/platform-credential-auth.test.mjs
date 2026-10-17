import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getDesktopDeviceId } = require("../dist-electron/main/modules/identity/index.js");
const { authenticateDesktopWsProtocolSession, issueDesktopWsRefreshAuth } = require("../dist-electron/main/modules/desktop-protocol/ws-authentication.js");
const { createDesktopWsProtocolSession } = require("../dist-electron/main/modules/desktop-protocol/ws-session.js");
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function fixture(t) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-platform-auth-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const app = { getPath: () => homePath, getAppPath: () => process.cwd() };
  const deviceId = getDesktopDeviceId(app, { readMachineIdentity: () => ({ source: "unavailable", value: "" }) });
  function sign(overrides = {}, privateKey = keys.privateKey) {
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "local-user", scope: "app", device_id: deviceId, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })).toString("base64url");
    const data = `${header}.${payload}`;
    return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
  }
  let issues = 0;
  const options = {
    app,
    ensureIdentityCenterJwk: async () => ({ publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) }),
    issueAccessToken: async () => { issues++; return { ok: true, token: sign() }; },
    logger: { log() {}, warn() {}, error() {} }
  };
  return { options, deviceId, sign, issues: () => issues };
}

test("remote session verifies the original signed Platform identity without minting a token", async t => {
  const f = fixture(t);
  const token = f.sign();
  const auth = await authenticateDesktopWsProtocolSession(f.options, token);
  assert.equal(auth.subject, "local-user");
  assert.equal(auth.deviceId, f.deviceId);
  const session = await createDesktopWsProtocolSession(f.options, {
    source: "tunnel-hub", authToken: token, transport: { sendText() {}, close() {} }
  });
  t.after(() => session.close());
  assert.equal(f.issues(), 0);
  // Reconnects reuse a valid Platform token; there is no synthetic single-use route ticket.
  assert.deepEqual(await authenticateDesktopWsProtocolSession(f.options, token), auth);
  await assert.rejects(issueDesktopWsRefreshAuth(f.options, { auth, source: "tunnel-hub" }, "missing"), /fresh Platform/);
  assert.equal(f.issues(), 0);
});

test("signature, local device, scope and expiry remain mandatory", async t => {
  const f = fixture(t);
  const wrongKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const [token, error] of [
    [f.sign({}, wrongKeys.privateKey), /signature/],
    [f.sign({ device_id: "different-desktop" }), /device_id/],
    [f.sign({ scope: "tunnel" }), /scope/],
    [f.sign({ exp: Math.floor(Date.now() / 1000) - 1 }), /expired/],
    ["tr_obsolete-route-credential", /invalid JWT/]
  ]) await assert.rejects(authenticateDesktopWsProtocolSession(f.options, token), error);
});

test("auth.refresh accepts a new token for the same local identity and refuses a changed subject", async t => {
  const f = fixture(t);
  const frames = [];
  const session = await createDesktopWsProtocolSession(f.options, {
    source: "tunnel-hub", authToken: f.sign(),
    transport: { sendText(text) { frames.push(JSON.parse(text)); }, close() {} }
  });
  t.after(() => session.close());
  async function request(id, token) {
    session.receiveTextFrame(JSON.stringify({ frame: "request", ns: "d", type: "auth.refresh", id, payload: { token } }));
    for (let index = 0; index < 100; index++) {
      const response = frames.find(frame => frame.id === id);
      if (response) return response;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`missing response ${id}`);
  }
  const refreshed = f.sign({ exp: Math.floor(Date.now() / 1000) + 7200 });
  assert.equal((await request("refresh", refreshed)).frame, "response");
  const rejected = await request("changed-user", f.sign({ sub: "different-local-user" }));
  assert.equal(rejected.frame, "error");
  assert.equal(f.issues(), 0);
});
