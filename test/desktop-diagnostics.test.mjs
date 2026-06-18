import assert from "node:assert/strict";
import test from "node:test";

const {
  inspectIdentityAccessToken
} = await import("../dist-electron/main/desktop-diagnostics.js");

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createToken(payload) {
  return [
    encodeJwtPart({ alg: "RS256", typ: "JWT" }),
    encodeJwtPart(payload),
    "signature"
  ].join(".");
}

test("inspectIdentityAccessToken returns full token and decoded claims", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = createToken({
    sub: "desktop-agent",
    iss: "identity-center",
    aud: ["agent-platform", "desktop"],
    scope: "app",
    device_id: "mac-mini-office",
    iat: nowSeconds,
    exp: nowSeconds + 3600
  });
  const result = await inspectIdentityAccessToken(
    {},
    async () => ({ ok: true, token, message: "issued" }),
    { reason: "missing" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.token, token);
  assert.equal(result.header?.alg, "RS256");
  assert.equal(result.payload?.device_id, "mac-mini-office");
  assert.equal(result.claims.deviceId, "mac-mini-office");
  assert.equal(result.claims.audience, "agent-platform, desktop");
  assert.equal(result.claims.expired, false);
});

test("inspectIdentityAccessToken surfaces parse errors without hiding token", async () => {
  const result = await inspectIdentityAccessToken(
    {},
    async () => ({ ok: true, token: "not-a-jwt", message: "issued" }),
    { reason: "missing" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.token, "not-a-jwt");
  assert.equal(result.header, null);
  assert.equal(result.payload, null);
  assert.match(result.message, /not a JWT/);
});
