import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/support/manifest/manifest-utils.js");

function manifest(proxyRoutes) {
  return {
    id: "agent-webclient",
    name: "Agent WebClient",
    version: "2.0.0",
    lifecycle: { start: "start.sh", stop: "stop.sh" },
    frontend: { mode: "standalone", hostManaged: true, dist: "frontend/dist" },
    desktop: { hosting: { proxyRoutes } },
  };
}

function normalize(value) {
  return normalizeManifest(value, { defaultKind: "builtin" });
}

const voiceRoute = {
  match: "prefix",
  path: "/api/voice",
  targetEnv: "VOICE_BASE_URL",
  optional: true,
  websocket: true,
};
const apiRoute = {
  match: "prefix",
  path: "/api",
  targetEnv: "BASE_URL",
  http: true,
  websocket: false,
  auth: "agent-platform-access-token",
};

test("Frame Port bundle accepts only an authenticated HTTP Agent Platform route", () => {
  const normalized = normalize(manifest([voiceRoute, apiRoute]));
  assert.deepEqual(normalized.desktop.hosting.proxyRoutes, [voiceRoute, apiRoute]);
});

test("Frame Port bundle rejects old or partially upgraded Agent WebClient manifests", () => {
  assert.throws(
    () => normalize(manifest([{ ...apiRoute, auth: undefined }])),
    /authenticated \/api route/u,
  );
  assert.throws(
    () => normalize(manifest([apiRoute, {
      match: "exact", path: "/ws", targetEnv: "BASE_URL", websocket: true,
    }])),
    /must not expose \/auth or \/ws/u,
  );
  assert.throws(
    () => normalize(manifest([{ ...apiRoute, websocket: true }])),
    /authenticated \/api route/u,
  );
  assert.throws(
    () => normalize(manifest([{ ...apiRoute, ssePaths: ["/api/query"] }])),
    /authenticated \/api route/u,
  );
});

test("Frame Port rejects duplicate /api routes regardless of their order or authentication", () => {
  for (const routes of [
    [apiRoute, { ...apiRoute }],
    [apiRoute, { ...apiRoute, auth: undefined }],
    [{ ...apiRoute, auth: undefined }, apiRoute],
  ]) {
    assert.throws(() => normalize(manifest(routes)), /requires exactly one/u);
  }
});

test("Frame Port rejects missing API routes and forbidden proxy routes", () => {
  for (const routes of [
    [],
    [voiceRoute],
    [{ ...apiRoute, targetEnv: "OTHER_URL" }],
    [{ ...apiRoute, http: false }],
    [apiRoute, { match: "prefix", path: "/auth", targetEnv: "AUTH_URL" }],
    [apiRoute, { match: "exact", path: "/realtime", targetEnv: "BASE_URL", websocket: true }],
  ]) {
    assert.throws(() => normalize(manifest(routes)), /Frame Port manifest/u);
  }
});

test("Frame Port consolidation preserves hosting defaults and service selection", () => {
  const value = manifest([]);
  delete value.desktop.hosting;
  assert.doesNotThrow(() => normalize(value));
  const unmanaged = manifest([]);
  unmanaged.frontend.hostManaged = false;
  assert.doesNotThrow(() => normalize(unmanaged));
  assert.doesNotThrow(() => normalize({ ...manifest([]), id: "another-service" }));
});
