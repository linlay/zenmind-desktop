import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadAgentPlatformProviderSettings } = require("../dist-electron/main/assistant/agent-platform-config.js");

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

test("loadAgentPlatformProviderSettings expands home-relative configured registries dir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-provider-registry-home-"));
  const app = createApp(root);
  const configRoot = path.join(root, "user-data", "config", "services", "agent-platform");
  const registriesRoot = path.join(root, "home", ".zenmind", "registries");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(configRoot), { recursive: true });
  fs.mkdirSync(path.join(registriesRoot, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registriesRoot, "models"), { recursive: true });
  fs.writeFileSync(path.join(configRoot, ".env"), "REGISTRIES_DIR=~/.zenmind/registries\n", "utf8");
  fs.writeFileSync(
    path.join(registriesRoot, "providers", "openai.yml"),
    [
      "key: openai",
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

  const settings = loadAgentPlatformProviderSettings(app, "openai");

  assert.equal(settings?.baseURL, "https://api.example.test/v1");
  assert.equal(settings?.model, "demo-model-id");
  assert.equal(settings?.apiKey, "test-key");
});
