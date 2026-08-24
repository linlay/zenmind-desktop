import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot,
  writeDesktopProfileToRoot
} = require("../dist-electron/main/desktop-profile-store.js");

test("desktop profile enables Desktop Action confirmation by default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profile = readDesktopProfileFromRoot(root);

  assert.equal(profile.general.desktopActionConfirmationEnabled, true);
  assert.equal("enterpriseChatEnabled" in profile.general, false);
});

test("desktop profile ignores the retired enterprise chat enable field", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    general: {
      enterpriseChatEnabled: true
    }
  }), "utf8");

  assert.equal("enterpriseChatEnabled" in readDesktopProfileFromRoot(root).general, false);
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

test("desktop profile recovers a complete JSON document with trailing corruption", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "profile.json");
  const original = `${JSON.stringify({
    schemaVersion: 1,
    appearance: { theme: "dark", locale: "zh-CN" },
    assistant: { chat: { agentKey: "cutej" } }
  }, null, 2)}\n\"agentKey\": \"stale-fragment\"\n}`;
  fs.writeFileSync(profilePath, original, "utf8");

  const profile = readDesktopProfileFromRoot(root);

  assert.equal(profile.appearance.theme, "dark");
  assert.equal(profile.assistant.chat.agentKey, "cutej");
  const recovered = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  assert.equal(recovered.appearance.theme, "dark");
  assert.equal(recovered.assistant.chat.agentKey, "cutej");
  const backups = fs.readdirSync(root).filter((name) => name.startsWith("profile.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), original);
});

test("desktop profile does not guess through malformed JSON content", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "profile.json"), '{"general":,}', "utf8");

  assert.throws(() => readDesktopProfileFromRoot(root), SyntaxError);
  assert.deepEqual(fs.readdirSync(root), ["profile.json"]);
});

test("desktop profile commits writes with an atomic rename", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalRenameSync = fs.renameSync;
  let temporaryPath = "";
  fs.renameSync = (from, to) => {
    temporaryPath = from;
    return originalRenameSync(from, to);
  };
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  const profile = readDesktopProfileFromRoot(root);
  writeDesktopProfileToRoot(root, profile);

  assert.equal(path.dirname(temporaryPath), root);
  assert.match(path.basename(temporaryPath), /^\.profile\.json\.\d+\.[\da-f-]+\.tmp$/u);
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "profile.json"), "utf8")), profile);
});
