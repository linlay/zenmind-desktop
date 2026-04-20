import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals: serviceManagerInternals
} = require("../dist-electron/main/service-manager.js");
const {
  __testInternals: registryInternals,
  registerPlugin,
  getService
} = require("../dist-electron/main/service-registry.js");

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function registerBuiltinManifest(manifest) {
  registerPlugin({
    kind: "builtin",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: []
    },
    ...manifest
  });
  return getService(manifest.id);
}

test("resolveEnvBindings renders fromService templates and fills defaulted values", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bindings-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  registerBuiltinManifest({
    id: "agent-platform",
    name: "智能体平台",
    version: "v0.1.0",
    description: "platform fixture",
    web: {
      routePath: "",
      portEnvKey: "SERVER_PORT",
      defaultPort: 12949
    }
  });
  const webclient = registerBuiltinManifest({
    id: "agent-webclient",
    name: "小宅助理",
    version: "v0.1.0",
    description: "webclient fixture",
    web: {
      routePath: "/",
      portEnvKey: "PORT",
      defaultPort: 11948
    },
    desktop: {
      envBindings: [
        {
          key: "BASE_URL",
          fromService: "agent-platform",
          template: "http://127.0.0.1:{{port}}",
          onlyIfDefault: true,
          defaults: ["http://localhost:11949"]
        },
        {
          key: "PORT",
          value: "{{serviceDefaultPort}}",
          onlyIfDefault: true
        },
        {
          key: "NODE_BIN",
          value: "{{processExecPath}}"
        }
      ]
    }
  });

  const platformInstallDir = path.join(userDataRoot, "services", "agent-platform", "v0.1.0");
  fs.mkdirSync(platformInstallDir, { recursive: true });
  fs.writeFileSync(path.join(platformInstallDir, ".env"), "SERVER_PORT=12949\n", "utf8");

  const updates = await serviceManagerInternals.resolveEnvBindings(
    app,
    webclient,
    new Map([["BASE_URL", "http://localhost:11949"]])
  );

  assert.equal(updates.get("BASE_URL"), "http://127.0.0.1:12949");
  assert.equal(updates.get("PORT"), "11948");
  assert.equal(updates.get("NODE_BIN"), process.execPath);
});

test("resolveEnvBindings leaves customized values untouched when onlyIfDefault is enabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bindings-custom-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const app = createApp(userDataRoot);

  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  registerBuiltinManifest({
    id: "agent-platform",
    name: "智能体平台",
    version: "v0.1.0",
    description: "platform fixture",
    web: {
      routePath: "",
      portEnvKey: "SERVER_PORT",
      defaultPort: 12949
    }
  });
  const webclient = registerBuiltinManifest({
    id: "agent-webclient",
    name: "小宅助理",
    version: "v0.1.0",
    description: "webclient fixture",
    web: {
      routePath: "/",
      portEnvKey: "PORT",
      defaultPort: 11948
    },
    desktop: {
      envBindings: [
        {
          key: "BASE_URL",
          fromService: "agent-platform",
          template: "http://127.0.0.1:{{port}}",
          onlyIfDefault: true,
          defaults: ["http://localhost:11949"]
        }
      ]
    }
  });

  const platformInstallDir = path.join(userDataRoot, "services", "agent-platform", "v0.1.0");
  fs.mkdirSync(platformInstallDir, { recursive: true });
  fs.writeFileSync(path.join(platformInstallDir, ".env"), "SERVER_PORT=12949\n", "utf8");

  const updates = await serviceManagerInternals.resolveEnvBindings(
    app,
    webclient,
    new Map([["BASE_URL", "https://example.com/api"]])
  );

  assert.equal(updates.has("BASE_URL"), false);
});
