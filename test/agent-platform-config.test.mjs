import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadAgentPlatformProviderSettings } = require("../dist-electron/main/copilot/core/agent-platform-config.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "userData") return path.join(root, "user-data");
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function writeProviderFixture(registriesRoot, providerKey = "openai") {
  fs.mkdirSync(path.join(registriesRoot, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registriesRoot, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(registriesRoot, "providers", `${providerKey}.yml`),
    [
      `key: ${providerKey}`,
      "baseUrl: https://api.example.test",
      "apiKey: test-key",
      "defaultModel: demo-model"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(registriesRoot, "models", "demo-model.yml"),
    "modelId: demo-model-id\n",
    "utf8"
  );
}

function clearRegistryEnvForTest(t) {
  const previousRegistriesDir = process.env.REGISTRIES_DIR;
  const previousAgentRegistriesDir = process.env.AGENT_PLATFORM_REGISTRIES_DIR;
  delete process.env.REGISTRIES_DIR;
  delete process.env.AGENT_PLATFORM_REGISTRIES_DIR;
  t.after(() => {
    if (previousRegistriesDir === undefined) {
      delete process.env.REGISTRIES_DIR;
    } else {
      process.env.REGISTRIES_DIR = previousRegistriesDir;
    }
    if (previousAgentRegistriesDir === undefined) {
      delete process.env.AGENT_PLATFORM_REGISTRIES_DIR;
    } else {
      process.env.AGENT_PLATFORM_REGISTRIES_DIR = previousAgentRegistriesDir;
    }
  });
}

test("loadAgentPlatformProviderSettings expands home-relative configured registries dir", (t) => {
  clearRegistryEnvForTest(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-provider-registry-home-"));
  const app = createApp(root);
  const configRoot = path.join(root, "user-data", "config", "services", "agent-platform");
  const registriesRoot = path.join(root, "home", ".zenmind", "registries");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(configRoot), { recursive: true });
  fs.writeFileSync(path.join(configRoot, ".env"), "REGISTRIES_DIR=~/.zenmind/registries\n", "utf8");
  writeProviderFixture(registriesRoot);

  const settings = loadAgentPlatformProviderSettings(app, "openai");

  assert.equal(settings?.baseURL, "https://api.example.test/v1");
  assert.equal(settings?.model, "demo-model-id");
  assert.equal(settings?.apiKey, "test-key");
});

test("loadAgentPlatformProviderSettings ignores legacy desktop registries and env files", (t) => {
  clearRegistryEnvForTest(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-provider-registry-legacy-"));
  const app = createApp(root);
  const desktopRoot = path.join(root, "home", "Desktop");
  const currentRegistriesRoot = path.join(root, "home", ".zenmind", "registries");
  const legacyRegistriesRoots = [
    path.join(desktopRoot, ".zenmind", "registries"),
    path.join(desktopRoot, "zenmind-env", "registries"),
    path.join(root, "home", "zenmind", "registries")
  ];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const registriesRoot of legacyRegistriesRoots) {
    writeProviderFixture(registriesRoot);
  }

  const legacyEnvRoot = path.join(desktopRoot, "agent-platform");
  const explicitRegistriesRoot = path.join(root, "explicit-registry");
  fs.mkdirSync(legacyEnvRoot, { recursive: true });
  writeProviderFixture(explicitRegistriesRoot);
  fs.writeFileSync(path.join(legacyEnvRoot, ".env"), `REGISTRIES_DIR=${explicitRegistriesRoot}\n`, "utf8");

  assert.equal(loadAgentPlatformProviderSettings(app, "openai"), null);

  writeProviderFixture(currentRegistriesRoot);
  const settings = loadAgentPlatformProviderSettings(app, "openai");
  assert.equal(settings?.baseURL, "https://api.example.test/v1");
});
