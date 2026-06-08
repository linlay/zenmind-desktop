import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/manifest-utils.js");
const { getPluginInstallDir } = require("../dist-electron/main/plugin-loader.js");
const { resolveDesktopCapability } = require("../dist-electron/main/services/manager/capabilities.js");
const {
  __testInternals: registryInternals,
  registerPlugin
} = require("../dist-electron/main/services/service-registry.js");

function createAppStub(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "userData") return path.join(root, "user-data");
      return root;
    }
  };
}

function createManifest(id, desktop = {}) {
  return {
    id,
    name: id,
    kind: "plugin",
    version: "v1.0.0",
    description: "capability fixture",
    frontend: { mode: "none" },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {},
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: 0
    },
    desktop
  };
}

test("normalizeManifest parses desktop capability providers and requirements", () => {
  const service = normalizeManifest(createManifest("capability-service", {
    capabilities: {
      provides: [
        {
          id: "fixture.file",
          command: ["scripts/provide.sh", "--out", "{{output.path}}"],
          env: { FIXTURE_OUT: "{{output.path}}" },
          output: "file",
          outputPath: "{{provider.dataDir}}/fixture.txt",
          retryOnSqliteBusy: true
        }
      ],
      requires: [
        {
          phase: "preStart",
          capability: "fixture.file",
          action: "copyFile",
          target: "fixture.txt"
        },
        {
          phase: "verifyRunning",
          service: "other-service",
          action: "waitHttp",
          target: "/health"
        }
      ]
    }
  }));

  assert.equal(service.desktop.capabilities.provides.length, 1);
  assert.deepEqual(service.desktop.capabilities.provides[0], {
    id: "fixture.file",
    command: ["scripts/provide.sh", "--out", "{{output.path}}"],
    env: { FIXTURE_OUT: "{{output.path}}" },
    output: "file",
    outputPath: "{{provider.dataDir}}/fixture.txt",
    retryOnSqliteBusy: true
  });
  assert.deepEqual(service.desktop.capabilities.requires, [
    {
      phase: "preStart",
      capability: "fixture.file",
      action: "copyFile",
      target: "fixture.txt"
    },
    {
      phase: "verifyRunning",
      service: "other-service",
      action: "waitHttp",
      target: "/health"
    }
  ]);
});

test("normalizeManifest rejects invalid desktop capability declarations", () => {
  assert.throws(
    () => normalizeManifest(createManifest("bad-output", {
      capabilities: {
        provides: [{ id: "bad.output", output: "binary" }]
      }
    })),
    /invalid Desktop capability output for bad\.output: binary/u
  );

  assert.throws(
    () => normalizeManifest(createManifest("bad-action", {
      capabilities: {
        requires: [{ phase: "preStart", capability: "fixture.file", action: "download" }]
      }
    })),
    /invalid Desktop capability requirement action: download/u
  );
});

test("normalizeManifest does not synthesize core service capabilities", () => {
  const appServer = normalizeManifest(createManifest("zenmind-app-server"));
  const platform = normalizeManifest(createManifest("agent-platform"));
  const webclient = normalizeManifest(createManifest("agent-webclient"));

  assert.deepEqual(appServer.desktop.capabilities.provides, []);
  assert.deepEqual(appServer.desktop.capabilities.requires, []);
  assert.deepEqual(platform.desktop.capabilities.provides, []);
  assert.deepEqual(platform.desktop.capabilities.requires, []);
  assert.equal(platform.desktop.envBindings.some((binding) => binding.key === "AUTH_ENABLED"), false);
  assert.equal(platform.desktop.envBindings.some((binding) => binding.key === "AUTH_LOCAL_PUBLIC_KEY_FILE"), false);
  assert.deepEqual(webclient.desktop.capabilities.provides, []);
  assert.deepEqual(webclient.desktop.capabilities.requires, []);
});

test("resolveDesktopCapability reports a missing provider clearly", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-capability-missing-"));
  const app = createAppStub(tempRoot);

  registryInternals.clearServices();
  try {
    await assert.rejects(
      () => resolveDesktopCapability(app, "fixture.missing"),
      /missing Desktop capability provider: fixture\.missing/u
    );
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveDesktopCapability reports dependency cycles clearly", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-capability-cycle-"));
  const app = createAppStub(tempRoot);

  registryInternals.clearServices();
  try {
    const serviceA = registerPlugin(createManifest("provider-a", {
      capabilities: {
        provides: [{ id: "fixture.a", command: "provide-a.sh", dependsOn: ["fixture.b"] }]
      }
    }));
    const serviceB = registerPlugin(createManifest("provider-b", {
      capabilities: {
        provides: [{ id: "fixture.b", command: "provide-b.sh", dependsOn: ["fixture.a"] }]
      }
    }));
    fs.mkdirSync(getPluginInstallDir(app, serviceA.id, serviceA.version), { recursive: true });
    fs.mkdirSync(getPluginInstallDir(app, serviceB.id, serviceB.version), { recursive: true });

    await assert.rejects(
      () => resolveDesktopCapability(app, "fixture.a"),
      /Desktop capability dependency cycle: fixture\.a -> fixture\.b -> fixture\.a/u
    );
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
