import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CONTAINER_HUB_SERVICE_HOSTS,
  DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
  getWebUrl,
  isDesktopManagedHttpUrl,
  parsePort
} = require("../dist-electron/main/services/manager/service-network.js");

function createService(web) {
  return {
    web: {
      routePath: "",
      portEnvKey: "",
      defaultPort: 0,
      ...web
    }
  };
}

test("parsePort reads configured service port env values with defaults", () => {
  const service = createService({
    portEnvKey: "SERVER_PORT",
    defaultPort: 7076
  });

  assert.equal(parsePort(service, new Map([["SERVER_PORT", "11950"]])), 11950);
  assert.equal(parsePort(service, new Map([["SERVER_PORT", "127.0.0.1:11950"]])), 11950);
  assert.equal(parsePort(service, new Map([["SERVER_PORT", "not-a-port"]])), 7076);
  assert.equal(parsePort(service, new Map()), 7076);
});

test("getWebUrl builds loopback URLs from service web config", () => {
  const service = createService({
    routePath: "/admin/",
    portEnvKey: "SERVER_PORT",
    defaultPort: 7076
  });

  assert.equal(getWebUrl(service, new Map([["SERVER_PORT", "11950"]])), "http://127.0.0.1:11950/admin/");
});

test("isDesktopManagedHttpUrl recognizes stale desktop-managed loopback URLs", () => {
  assert.equal(
    isDesktopManagedHttpUrl(
      "http://127.0.0.1:117079",
      DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
      CONTAINER_HUB_SERVICE_HOSTS
    ),
    true
  );
  assert.equal(
    isDesktopManagedHttpUrl(
      "https://example.com:117079",
      DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
      CONTAINER_HUB_SERVICE_HOSTS
    ),
    false
  );
});
