import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  DESKTOP_ROUTE_APPLIED_MESSAGE_TYPE,
  DESKTOP_ROUTE_READY_MESSAGE_TYPE,
  isServiceWebviewRouteStatus,
} = require("../dist-electron/shared/service-webview-bridge.js");

test("service webview route status accepts READY and exact positive-revision APPLIED payloads", () => {
  assert.equal(isServiceWebviewRouteStatus({
    type: DESKTOP_ROUTE_READY_MESSAGE_TYPE,
    routerLocation: "/agent/demo?chatId=chat-a#timeline",
  }), true);
  assert.equal(isServiceWebviewRouteStatus({
    type: DESKTOP_ROUTE_APPLIED_MESSAGE_TYPE,
    routeRevision: 17,
    routerLocation: "/agent/demo?chatId=chat-b",
  }), true);
});

test("service webview route status rejects invalid types, routes, lengths, and revisions", () => {
  const invalidPayloads = [
    null,
    [],
    { type: "desktopRouteReceived", routerLocation: "/agent/demo" },
    { type: DESKTOP_ROUTE_READY_MESSAGE_TYPE, routerLocation: "agent/demo" },
    { type: DESKTOP_ROUTE_READY_MESSAGE_TYPE, routerLocation: "//example.test/chat" },
    { type: DESKTOP_ROUTE_READY_MESSAGE_TYPE, routerLocation: "/agent\\demo" },
    { type: DESKTOP_ROUTE_READY_MESSAGE_TYPE, routerLocation: "/agent/demo\u0000" },
    { type: DESKTOP_ROUTE_READY_MESSAGE_TYPE, routerLocation: `/${"a".repeat(8_192)}` },
    {
      type: DESKTOP_ROUTE_APPLIED_MESSAGE_TYPE,
      routerLocation: "/agent/demo",
    },
    {
      type: DESKTOP_ROUTE_APPLIED_MESSAGE_TYPE,
      routeRevision: 0,
      routerLocation: "/agent/demo",
    },
    {
      type: DESKTOP_ROUTE_APPLIED_MESSAGE_TYPE,
      routeRevision: 1.5,
      routerLocation: "/agent/demo",
    },
  ];

  for (const payload of invalidPayloads) {
    assert.equal(isServiceWebviewRouteStatus(payload), false);
  }
});
