import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  applyDesktopDefaultBootstrap,
  resolveDesktopBootstrapStatePath,
  resolveDesktopDefaultPath
} = await import("../dist-electron/main/desktop-default-bootstrap.js");

function createApp(root) {
  const homePath = path.join(root, "home");
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(root, "app-data");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

test("desktop-default bootstrap applies once into canonical desktop files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-default-"));
  const app = createApp(root);
  const defaultPath = resolveDesktopDefaultPath(app, "darwin");
  fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fs.writeFileSync(defaultPath, `${JSON.stringify({
    profile: {
      appearance: {
        theme: "dark",
        locale: "en-US"
      },
      assistant: {
        desktopHelperAgentKey: "desktopAssistant",
        quickAssistant: {
          enabled: true,
          agentKey: "zenmi"
        }
      }
    },
    pet: {
      enabled: false,
      selectedPetId: "builtin:zenmi",
      position: {
        x: 20,
        y: 78,
        displayId: "primary"
      }
    },
    market: {
      apiBaseUrl: "https://zenmind.cc/market/api/v1"
    },
    sso: {
      enabled: true,
      identityProviderHost: "business.example.com"
    },
    websites: [
      {
        id: "docs",
        label: "Docs",
        url: "https://docs.example.com/",
        agentKey: "desktopAssistant"
      }
    ],
    bootstrapAssistant: {
      agentKey: "zenmi",
      prompt: "hello once"
    }
  }, null, 2)}\n`, "utf8");

  try {
    const first = applyDesktopDefaultBootstrap(app, "darwin");
    assert.equal(first.applied, true);

    const desktopRoot = path.join(root, "home", ".zenmind", ".desktop");
    const profile = JSON.parse(fs.readFileSync(path.join(desktopRoot, "config", "desktop", "profile.json"), "utf8"));
    const pet = JSON.parse(fs.readFileSync(path.join(desktopRoot, "config", "desktop", "pet.json"), "utf8"));
    const market = JSON.parse(fs.readFileSync(path.join(desktopRoot, "config", "marketplace", "settings.json"), "utf8"));
    const sso = JSON.parse(fs.readFileSync(path.join(desktopRoot, "config", "desktop", "sso.json"), "utf8"));
    const website = JSON.parse(fs.readFileSync(path.join(desktopRoot, "data", "websites", "docs", "website.json"), "utf8"));
    const bootstrap = JSON.parse(fs.readFileSync(resolveDesktopBootstrapStatePath(app), "utf8"));

    assert.equal(profile.appearance.theme, "dark");
    assert.equal(profile.appearance.locale, "en-US");
    assert.equal("bootstrapAssistant" in profile, false);
    assert.equal(pet.enabled, false);
    assert.equal(pet.selectedPetId, "builtin:zenmi");
    assert.equal("boundAgentKey" in pet, false);
    assert.equal(market.marketApiBaseUrl, "https://zenmind.cc/market/api/v1");
    assert.equal(sso.enabled, true);
    assert.equal(website.id, "docs");
    assert.equal(website.agentKey, "desktopAssistant");
    assert.equal(bootstrap.bootstrapAssistant.agentKey, "zenmi");

    fs.writeFileSync(defaultPath, JSON.stringify({
      profile: {
        appearance: {
          theme: "light",
          locale: "zh-CN"
        }
      }
    }), "utf8");

    const second = applyDesktopDefaultBootstrap(app, "darwin");
    const profileAfterSecondRun = JSON.parse(fs.readFileSync(path.join(desktopRoot, "config", "desktop", "profile.json"), "utf8"));
    assert.equal(second.applied, false);
    assert.equal(second.reason, "already-applied");
    assert.equal(profileAfterSecondRun.appearance.theme, "dark");
    assert.equal(profileAfterSecondRun.appearance.locale, "en-US");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
