import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  readAssistantSettingsFromRoot,
  saveAssistantSettingsToRoot
} = await import("../dist-electron/main/copilot/core/settings-store.js");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-assistant-settings-"));
}

test("assistant settings backfills default desktop copilot pages", () => {
  const root = makeTempRoot();
  const settings = readAssistantSettingsFromRoot(root);

  assert.equal(settings.quickAssistantEnabled, true);
  assert.equal(settings.quickAssistantAgentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.controlCenter.enabled, true);
  assert.equal(settings.desktopCopilotPages.controlCenter.agentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.market.agentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.help.agentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.agents.agentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.schedules.agentKey, "desktopAssistant");
  assert.equal(settings.desktopCopilotPages.memory.agentKey, "desktopAssistant");
});

test("assistant settings saves quick assistant preferences", () => {
  const root = makeTempRoot();
  const saved = saveAssistantSettingsToRoot(root, {
    quickAssistantEnabled: false,
    quickAssistantAgentKey: "quickAgent"
  });

  assert.equal(saved.quickAssistantEnabled, false);
  assert.equal(saved.quickAssistantAgentKey, "quickAgent");

  const restored = readAssistantSettingsFromRoot(root);
  assert.equal(restored.quickAssistantEnabled, false);
  assert.equal(restored.quickAssistantAgentKey, "quickAgent");
});

test("assistant settings falls back empty quick assistant agent keys", () => {
  const root = makeTempRoot();
  const saved = saveAssistantSettingsToRoot(root, {
    quickAssistantAgentKey: ""
  });

  assert.equal(saved.quickAssistantAgentKey, "desktopAssistant");
});

test("assistant settings saves one desktop copilot page without losing sibling fields", () => {
  const root = makeTempRoot();
  saveAssistantSettingsToRoot(root, {
    desktopCopilotPages: {
      market: {
        enabled: false,
        agentKey: "marketAgent"
      }
    }
  });

  const saved = saveAssistantSettingsToRoot(root, {
    desktopCopilotPages: {
      market: {
        agentKey: "marketAgent2"
      }
    }
  });

  assert.equal(saved.desktopCopilotPages.market.enabled, false);
  assert.equal(saved.desktopCopilotPages.market.agentKey, "marketAgent2");
});

test("assistant settings ignores unknown copilot page keys and falls back empty agent keys", () => {
  const root = makeTempRoot();
  const saved = saveAssistantSettingsToRoot(root, {
    desktopCopilotPages: {
      help: {
        enabled: true,
        agentKey: ""
      },
      unknownPage: {
        enabled: false,
        agentKey: "bad"
      }
    }
  });

  assert.equal(saved.desktopCopilotPages.help.agentKey, "desktopAssistant");
  assert.equal("unknownPage" in saved.desktopCopilotPages, false);
});

test("assistant settings migrates legacy settings.json into profile.json", () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, "settings.json"), `${JSON.stringify({
    desktopHelperAgentKey: "helper",
    quickAssistantEnabled: false,
    quickAssistantAgentKey: "quick",
    voiceCorrectionEnabled: false,
    desktopCopilotPages: {
      help: {
        enabled: false,
        agentKey: "helper"
      }
    }
  }, null, 2)}\n`, "utf8");

  const settings = readAssistantSettingsFromRoot(root);
  const profile = JSON.parse(fs.readFileSync(path.join(root, "profile.json"), "utf8"));

  assert.equal(settings.desktopHelperAgentKey, "helper");
  assert.equal(settings.quickAssistantEnabled, false);
  assert.equal(settings.quickAssistantAgentKey, "quick");
  assert.equal(settings.voiceCorrectionEnabled, false);
  assert.equal(profile.assistant.desktopHelperAgentKey, "helper");
  assert.equal(profile.assistant.quickAssistant.enabled, false);
  assert.equal(profile.navigation.desktopCopilotPages.help.enabled, false);
});
