import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pet = require("../dist-electron/main/modules/pet/desktop-pet.part-1.js");
const websites = require("../dist-electron/main/modules/webs/websites/store.js");
const actions = require("../dist-electron/main/modules/webs/websites/actions.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-current-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { getPath: (name) => path.join(root, name) };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: pet selection and runtime state round-trip independently`, (t) => {
    const app = fixture(t);
    const initial = pet.readDesktopPetStoredState(app, platform);
    assert.equal(initial.selectedPetId, pet.DEFAULT_DESKTOP_PET_ID);
    assert.equal(initial.unreadCount, 0);
    const saved = pet.saveDesktopPetSettings(app, {
      enabled: true, appearanceId: "user:cat", unreadCount: 4,
      position: { x: 200, y: 300, displayId: "display-2" }
    }, platform);
    assert.equal(saved.appearanceId, "user:cat");
    assert.equal(saved.selectedPetId, "user:cat");
    const configPath = pet.getDesktopPetSettingsPath(app, platform);
    const statePath = pet.getDesktopPetStatePath(app, platform);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(Object.hasOwn(config, "appearanceId"), false);
    assert.equal(Object.hasOwn(config, "unreadCount"), false);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).unreadCount, 4);
    assert.deepEqual(pet.readDesktopPetStoredState(app, platform), saved);
    // Extra configuration keys do not become alternative persistence sources.
    fs.writeFileSync(configPath, JSON.stringify({ ...config, appearanceId: "user:other", unreadCount: 99 }));
    fs.rmSync(statePath);
    const withoutState = pet.readDesktopPetStoredState(app, platform);
    assert.equal(withoutState.appearanceId, "user:cat");
    assert.equal(withoutState.unreadCount, 0);
    assert.equal(pet.saveDesktopPetSettings(app, { selectedPetId: pet.DEFAULT_DESKTOP_PET_ID }, platform).appearanceId,
      initial.appearanceId);
  });

  test(`${platform}: website current manifest and import preserve Copilot and timestamps`, (t) => {
    const app = fixture(t);
    const item = websites.createWebsiteItem({
      id: "docs", label: "Docs", url: "https://docs.example.test", copilotAgentKey: "helper",
      createdAt: 1788000000000, updatedAt: 1788000000100
    });
    websites.writeWebsiteItem(app, item, platform);
    const manifest = JSON.parse(fs.readFileSync(websites.getWebsitePath(app, item.id, platform), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.createdAt, new Date(item.createdAt).toISOString());
    assert.deepEqual(websites.readWebsiteItems(app, platform), [item]);
    const result = actions.importWebsiteItems(app, JSON.stringify({ items: [{
      id: "imported", label: "Imported", url: "https://import.example.test", copilotAgentKey: "importHelper", agentKey: "unused"
    }] }), platform);
    assert.equal(result.ok, true);
    assert.equal(result.items.find(({ id }) => id === "imported").copilotAgentKey, "importHelper");
    assert.equal(websites.normalizeWebsiteManifest({ ...manifest, copilotAgentKey: undefined, agentKey: "unused" }).copilotAgentKey, undefined);
    assert.throws(() => websites.createWebsiteItem({ url: "javascript:alert(1)" }));
  });
}

test("website add and edit use only the current Copilot input", (t) => {
  const app = fixture(t);
  const added = actions.addWebsiteItem(app, {
    url: "https://example.test", copilotAgentKey: "helper", agentKey: { unused: true }
  });
  assert.equal(added.ok, true);
  assert.equal(added.item.copilotAgentKey, "helper");
  const updated = actions.updateWebsiteItem(app, added.item.id, { copilotAgentKey: "changed" });
  assert.equal(updated.item.copilotAgentKey, "changed");
  assert.equal(actions.updateWebsiteItem(app, added.item.id, { agentKey: "unused" }).item.copilotAgentKey, "changed");
  assert.equal(actions.updateWebsiteItem(app, added.item.id, { copilotAgentKey: "" }).item.copilotAgentKey, undefined);
  assert.equal(actions.addWebsiteItem(app, { url: "https://invalid.example.test", copilotAgentKey: 7 }).ok, false);
});
