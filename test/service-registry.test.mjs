import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerPlugin, unregisterPlugin } = require("../dist-electron/main/services/service-registry.js");

test("registerPlugin ignores legacy hasFrontend without frontend.mode", () => {
  const definition = registerPlugin({
    id: "current-plugin",
    name: "Current Plugin",
    version: "v1.0.0",
    description: "current manifest",
    hasFrontend: true,
    scripts: {
      start: ["./start.sh"],
      stop: ["./stop.sh"]
    },
    runtime: {
      pidRelativePath: ".runtime/legacy.pid",
      logRelativePath: ".runtime/legacy.log"
    },
    web: {
      routePath: "/legacy/",
      portEnvKey: "PORT",
      defaultPort: 9000
    }
  });

  assert.equal(definition.frontendMode, "none");
  unregisterPlugin("current-plugin");
});

test("registerPlugin preserves explicit frontend.mode", () => {
  const definition = registerPlugin({
    id: "embedded-plugin",
    name: "Embedded Plugin",
    version: "v1.0.0",
    description: "embedded manifest",
    frontend: {
      mode: "embedded"
    },
    scripts: {
      start: ["./start.sh"],
      stop: ["./stop.sh"]
    },
    runtime: {
      pidRelativePath: ".runtime/embedded.pid",
      logRelativePath: ".runtime/embedded.log"
    },
    web: {
      routePath: "/",
      portEnvKey: "PORT",
      defaultPort: 9001
    }
  });

  assert.equal(definition.frontendMode, "embedded");
  assert.equal(definition.runtime.errorLogRelativePath, "");
  unregisterPlugin("embedded-plugin");
});

test("registerPlugin preserves runtime.errorLogRelativePath when provided", () => {
  const definition = registerPlugin({
    id: "windows-plugin",
    name: "Windows Plugin",
    version: "v1.0.0",
    description: "windows manifest",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: ["./start.ps1", "--daemon"],
      stop: ["./stop.ps1"]
    },
    runtime: {
      pidRelativePath: ".runtime/windows.pid",
      logRelativePath: ".runtime/windows.log",
      errorLogRelativePath: ".runtime/windows.stderr.log"
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 0
    }
  });

  assert.equal(definition.runtime.errorLogRelativePath, ".runtime/windows.stderr.log");
  unregisterPlugin("windows-plugin");
});
