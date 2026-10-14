import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { authenticateDesktopWsProtocolSession, issueDesktopWsRefreshAuth, validateDesktopWsConnectionRoute } = require('../dist-electron/main/modules/desktop-protocol/ws-authentication.js');
const { createDesktopWsProtocolSession } = require('../dist-electron/main/modules/desktop-protocol/ws-session.js');
function fixture() {
  const credential = `tr_${crypto.randomBytes(32).toString('base64url')}`;
  let valid = true; let calls = 0; const now = Date.now();
  const route = { schemaVersion: 1, accountId: 'account', sourceDeviceId: 'phone', targetDesktopId: 'desktop', requestId: crypto.randomUUID(), jti: crypto.randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString() };
  const options = { app: {}, verifyAccountRoute: async () => { calls++; if (!valid) throw new Error('revoked'); return route; }, issueAccessToken: async () => ({ok: true, token: 'local-token'}), verifyToken: async token => { assert.equal(token, 'local-token'); return {subject: 'unchanged-local-subject', deviceId: 'local-device', scope: 'app', expiresAt: Date.now() + 3600000}; } };
  return { options, route, credential, revoke: () => {valid = false;}, calls: () => calls };
}
test('remote authorization preserves local Platform identity and rejects JTI replay', async () => {
 const f = fixture(); const auth = await authenticateDesktopWsProtocolSession(f.options, f.credential, undefined, true);
 assert.equal(auth.subject, 'unchanged-local-subject'); assert.equal(auth.deviceId, 'local-device'); assert.equal(auth.accountRoute.targetDesktopId, 'desktop');
 await assert.rejects(authenticateDesktopWsProtocolSession(f.options, f.credential, undefined, true), /consumed/);
 await authenticateDesktopWsProtocolSession(f.options, f.credential, undefined, true, false);
 await assert.rejects(issueDesktopWsRefreshAuth(f.options, {auth}, 'missing'), /fresh account/);
});
test('remote endpoint refuses local credentials and expired route', async () => {
 const f = fixture(); await assert.rejects(authenticateDesktopWsProtocolSession(f.options, 'local-token', undefined, true), /account route/);
 f.route.expiresAt = new Date(Date.now() - 1000).toISOString(); await assert.rejects(authenticateDesktopWsProtocolSession(f.options, f.credential, undefined, true), /invalid account/);
});
test('connection validation is single flight and rejects revoked source without cancelling remote tasks', async () => {
 const f = fixture(); const auth = await authenticateDesktopWsProtocolSession(f.options, f.credential, undefined, true);
 const connection = {auth, closed: false, routeValidatedAt: 0, routeValidation: null};
 await Promise.all([validateDesktopWsConnectionRoute(f.options, connection), validateDesktopWsConnectionRoute(f.options, connection)]);
 assert.equal(f.calls(), 2); f.revoke(); connection.routeValidatedAt = 0;
 await assert.rejects(validateDesktopWsConnectionRoute(f.options, connection), /revoked/);
});
test('tunnel session accepts verified account route and closes only its transport', async () => {
 const f = fixture(); let closes = 0;
 const session = await createDesktopWsProtocolSession(f.options, {authToken: f.credential, transport: {sendText() {}, close() {closes++;}}});
 session.close(); assert.equal(closes, 1);
});
