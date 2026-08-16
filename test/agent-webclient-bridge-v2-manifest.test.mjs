import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/manifest-utils.js");

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

test("Bridge v2 accepts only an authenticated HTTP Agent Platform route", () => {
  const normalized = normalize(manifest([voiceRoute, apiRoute]));
  assert.deepEqual(normalized.desktop.hosting.proxyRoutes, [voiceRoute, apiRoute]);
});

test("Bridge v2 rejects old or partially upgraded Agent WebClient manifests", () => {
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
