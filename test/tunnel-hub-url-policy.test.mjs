import test from "node:test";
import assert from "node:assert/strict";

const { isTunnelHubForbiddenHostname, isTunnelHubLoopbackHostname } = await import(
  "../dist-electron/main/tunnel-hub-url-policy.js"
);

test("Tunnel Hub loopback hostname policy accepts only canonical loopback hosts", () => {
  for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(isTunnelHubLoopbackHostname(hostname), true, hostname);
  }
  for (const hostname of ["127.0.0.2", "demo.localhost", "0.0.0.0", "192.0.2.1"]) {
    assert.equal(isTunnelHubLoopbackHostname(hostname), false, hostname);
  }
});

test("Tunnel Hub hostname policy rejects reserved non-canonical local hosts", () => {
  for (const hostname of ["127.0.0.2", "127.255.255.255", "demo.localhost", "0.0.0.0"]) {
    assert.equal(isTunnelHubForbiddenHostname(hostname), true, hostname);
  }
  for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]", "relay.example.test", "192.0.2.1"]) {
    assert.equal(isTunnelHubForbiddenHostname(hostname), false, hostname);
  }
});
