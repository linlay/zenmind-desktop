import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} = require("../dist-electron/main/desktop-profile-store.js");

test("desktop profile defaults Desktop Action confirmation to enabled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profile = readDesktopProfileFromRoot(root);

  assert.equal(profile.general.desktopActionConfirmationEnabled, true);
  assert.equal(profile.general.enterpriseChatEnabled, true);
});

test("desktop profile preserves an explicit enterprise chat disable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    general: {
      enterpriseChatEnabled: false
    }
  }), "utf8");

  assert.equal(readDesktopProfileFromRoot(root).general.enterpriseChatEnabled, false);
});

test("desktop profile ignores retired files and nested aliases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "preferences.json"), JSON.stringify({ locale: "zh-CN" }), "utf8");
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    desktopHelperAgentKey: "legacy-helper"
  }), "utf8");
  fs.writeFileSync(path.join(root, "kanban.json"), JSON.stringify({ deviceAlias: "legacy-device" }), "utf8");

  const fromRetiredFiles = readDesktopProfileFromRoot(root);
  assert.equal(fs.existsSync(path.join(root, "profile.json")), false);
  assert.equal(fromRetiredFiles.general.deviceName, "");
  assert.equal(fromRetiredFiles.assistant.copilot.agentKey, "desktopAssistant");

  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({
    assistant: {
      desktopHelperAgentKey: "legacy-helper"
    },
    navigation: {
      websiteOrder: ["legacy-site"]
    }
  }), "utf8");

  const fromRetiredAliases = readDesktopProfileFromRoot(root);
  assert.equal(fromRetiredAliases.assistant.copilot.agentKey, "desktopAssistant");
  assert.deepEqual(fromRetiredAliases.navigation.webOrder, []);
});

test("desktop profile preserves explicit Desktop Action confirmation disable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    general: {
      desktopActionConfirmationEnabled: false
    }
  }, null, 2)}\n`, "utf8");

  const profile = readDesktopProfileFromRoot(root);

  assert.equal(profile.general.desktopActionConfirmationEnabled, false);
});

test("desktop profile leaves Chat agent unset instead of inheriting the sidebar helper", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    assistant: {
      copilot: { agentKey: "existing-helper" }
    }
  }, null, 2)}\n`, "utf8");

  assert.equal(readDesktopProfileFromRoot(root).assistant.chat.agentKey, "");

  updateDesktopProfileInRoot(root, {
    assistant: {
      chat: { agentKey: "chat-agent" }
    }
  });

  assert.equal(readDesktopProfileFromRoot(root).assistant.chat.agentKey, "chat-agent");
});
