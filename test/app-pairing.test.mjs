import test from "node:test";
import assert from "node:assert/strict";

const { selectPairingHost } = await import("../dist-electron/main/app-pairing.js");

test("selectPairingHost prefers private non-internal IPv4 addresses", () => {
  assert.equal(selectPairingHost({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    utun: [{ family: "IPv6", internal: false, address: "fe80::1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.8" }],
    en1: [{ family: "IPv4", internal: false, address: "203.0.113.9" }]
  }), "192.168.1.8");
});

test("selectPairingHost falls back to first external IPv4 then loopback", () => {
  assert.equal(selectPairingHost({
    en0: [{ family: "IPv4", internal: false, address: "203.0.113.9" }]
  }), "203.0.113.9");

  assert.equal(selectPairingHost({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }]
  }), "127.0.0.1");
});
