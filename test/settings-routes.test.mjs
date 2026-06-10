import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildSettingsSectionPath,
  getDefaultSettingsSectionPath,
  isSettingsRoute,
  parseSettingsSectionId,
  resolveSettingsSectionId
} = require("../dist-electron/shared/settings-routes.js");

const visibleSectionIds = [
  "appearance",
  "navigation",
  "quickAssistant",
  "embeddedWebsites",
  "about"
];

test("settings route helpers build and detect section paths", () => {
  assert.equal(buildSettingsSectionPath("appearance"), "/settings/appearance");
  assert.equal(isSettingsRoute("/settings"), true);
  assert.equal(isSettingsRoute("/settings/appearance"), true);
  assert.equal(isSettingsRoute("/kanban"), false);
  assert.equal(parseSettingsSectionId("/settings/appearance"), "appearance");
  assert.equal(parseSettingsSectionId("/settings/debug"), "about");
  assert.equal(parseSettingsSectionId("/settings/runtimeReset"), "about");
  assert.equal(parseSettingsSectionId("/settings"), null);
  assert.equal(parseSettingsSectionId("/settings/foo/extra"), "foo");
});

test("settings route helpers resolve invalid sections to the default", () => {
  assert.equal(resolveSettingsSectionId("/settings", visibleSectionIds), "appearance");
  assert.equal(resolveSettingsSectionId("/settings/appearance", visibleSectionIds), "appearance");
  assert.equal(resolveSettingsSectionId("/settings/desktopPet", visibleSectionIds), "appearance");
  assert.equal(getDefaultSettingsSectionPath(visibleSectionIds), "/settings/appearance");
  assert.equal(getDefaultSettingsSectionPath([]), "/settings");
});
