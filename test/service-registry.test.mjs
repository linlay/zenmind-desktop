import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerPlugin, unregisterPlugin } = require("../dist-electron/main/service-registry.js");

test("registerPlugin keeps backward compatibility for legacy hasFrontend manifests", () => {
  const definition = registerPlugin({
    id: "legacy-plugin",
    name: "Legacy Plugin",
    version: "v1.0.0",
    description: "legacy manifest",
    hasFrontend: true,
    runtime: {
      pidRelativePath: ".runtime/legacy.pid",
      logRelativePath: ".runtime/legacy.log",
      startCommand: ["./start.sh"],
      stopCommand: ["./stop.sh"]
    },
    web: {
      routePath: "/legacy/",
      portEnvKey: "PORT",
      defaultPort: 9000
    }
  });

  assert.equal(definition.frontendMode, "standalone");
  unregisterPlugin("legacy-plugin");
});

test("registerPlugin preserves explicit frontendMode", () => {
  const definition = registerPlugin({
    id: "embedded-plugin",
    name: "Embedded Plugin",
    version: "v1.0.0",
    description: "embedded manifest",
    frontendMode: "embedded",
    runtime: {
      pidRelativePath: ".runtime/embedded.pid",
      logRelativePath: ".runtime/embedded.log",
      startCommand: ["./start.sh"],
      stopCommand: ["./stop.sh"]
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
    frontendMode: "none",
    runtime: {
      pidRelativePath: ".runtime/windows.pid",
      logRelativePath: ".runtime/windows.log",
      errorLogRelativePath: ".runtime/windows.stderr.log",
      startCommand: ["./start.ps1", "--daemon"],
      stopCommand: ["./stop.ps1"]
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
