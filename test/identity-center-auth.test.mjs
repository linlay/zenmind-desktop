import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const capabilities = require("../dist-electron/main/modules/services/manager/capabilities.js");
const {
  __testInternals: registryInternals,
  registerPlugin,
} = require("../dist-electron/main/modules/services/service-registry.js");
const {
  ensureIdentityCenterJwk,
  getIdentityCenterPublicKeyExportPath,
} = require("../dist-electron/main/modules/identity/identity-center-auth.js");
const resolveDesktopCapability = (...args) => capabilities.resolveDesktopCapability(...args);

function registerIdentityCenter() {
  registerPlugin({
    id: "identity-center",
    name: "Identity Center",
    kind: "builtin",
    version: "v0.3.60",
    description: "fixture",
    frontend: { mode: "none" },
    scripts: { start: "start.sh", stop: "stop.sh" },
    runtime: {},
    web: { routePath: "/", portEnvKey: "SERVER_PORT", defaultPort: 19076 },
    desktop: { capabilities: { provides: [], requires: [] } },
  }, { defaultKind: "builtin" });
}

test("identity public-key lookup uses capability output, falls back to the canonical export, and fails closed", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-identity-auth-"));
  const app = {
    getPath(name) {
      if (name === "home") return tempRoot;
      if (name === "appData") return path.join(tempRoot, "app-data");
      throw new Error(`unexpected app path: ${name}`);
    },
  };
  const originalResolveDesktopCapability = capabilities.resolveDesktopCapability;
  const capabilityCalls = [];

  try {
    registryInternals.clearServices();
    registerIdentityCenter();

    const capabilityPath = path.join(tempRoot, "capability", "publicKey.pem");
    fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
    fs.writeFileSync(capabilityPath, "capability-public-key", "utf8");
    capabilities.resolveDesktopCapability = async (_app, capabilityId) => {
      capabilityCalls.push(capabilityId);
      return { id: capabilityId, providerServiceId: "identity-center", output: "file", filePath: capabilityPath };
    };
    assert.deepEqual(await ensureIdentityCenterJwk(app, resolveDesktopCapability), {
      publicKeyPath: capabilityPath,
      publicKeyPem: "capability-public-key",
    });

    const fallbackPath = getIdentityCenterPublicKeyExportPath(app);
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.writeFileSync(fallbackPath, "fallback-public-key", "utf8");
    capabilities.resolveDesktopCapability = async (_app, capabilityId) => {
      capabilityCalls.push(capabilityId);
      return { id: capabilityId, providerServiceId: "identity-center", output: "file" };
    };
    assert.deepEqual(await ensureIdentityCenterJwk(app, resolveDesktopCapability), {
      publicKeyPath: fallbackPath,
      publicKeyPem: "fallback-public-key",
    });

    capabilities.resolveDesktopCapability = async (_app, capabilityId) => {
      capabilityCalls.push(capabilityId);
      throw new Error("capability command failed");
    };
    await assert.rejects(ensureIdentityCenterJwk(app, resolveDesktopCapability), /capability command failed/u);

    fs.unlinkSync(fallbackPath);
    capabilities.resolveDesktopCapability = async (_app, capabilityId) => {
      capabilityCalls.push(capabilityId);
      return { id: capabilityId, providerServiceId: "identity-center", output: "file" };
    };
    await assert.rejects(ensureIdentityCenterJwk(app, resolveDesktopCapability), (error) => {
      assert.match(String(error?.message), new RegExp(fallbackPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
      return true;
    });
    assert.deepEqual(capabilityCalls, [
      "auth.publicKey",
      "auth.publicKey",
      "auth.publicKey",
      "auth.publicKey",
    ]);
  } finally {
    capabilities.resolveDesktopCapability = originalResolveDesktopCapability;
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
