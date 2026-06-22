import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  handleDesktopActionRequest
} = require("../dist-electron/main/desktop-action-bridge.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      if (name === "temp") {
        return path.join(homePath, "tmp");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getAppPath() {
      return process.cwd();
    },
    getVersion() {
      return "0.0.0-test";
    }
  };
}

function createDesktopActionOptions(t) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-action-bridge-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));

  const appearances = [
    { id: "classic", displayName: "Classic", description: "Builtin pet." },
    { id: "user:dario", displayName: "Dario", description: "Local pet." }
  ];
  const state = {
    supported: true,
    enabled: true,
    visible: false,
    appearanceId: "classic",
    appearanceOptions: appearances,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const calls = {
    refreshState: 0,
    saveSettings: []
  };

  return {
    calls,
    state,
    options: {
      app: createApp(homePath),
      assistantBridge: {},
      getMainWindow: () => null,
      getCurrentPageSnapshot: () => null,
      navigate: () => {},
      openLogViewer: async () => ({ ok: true }),
      callRendererAction: async () => ({ ok: false }),
      executeCdpCommand: async () => {
        throw new Error("unexpected cdp call");
      },
      desktopPet: {
        refreshState: async () => {
          calls.refreshState += 1;
          return state;
        },
        saveSettings: async (input) => {
          calls.saveSettings.push(input);
          return { ...state, appearanceId: input.appearanceId };
        },
        show: async () => ({ ...state, enabled: true, visible: true }),
        hide: async () => ({ ...state, enabled: false, visible: false })
      }
    }
  };
}

test("desktop pet actions expose the simplified local pet API", async (t) => {
  const { calls, options, state } = createDesktopActionOptions(t);

  const stateResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.state"
  });
  assert.equal(stateResponse.ok, true);
  assert.equal(stateResponse.result, state);
  assert.equal(calls.refreshState, 1);

  const listResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.list"
  });
  assert.equal(listResponse.ok, true);
  assert.deepEqual(listResponse.result, {
    appearanceId: "classic",
    appearances: state.appearanceOptions
  });

  const setResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.set",
    args: { id: "user:dario" },
    permissionMode: "full_access"
  });
  assert.equal(setResponse.ok, true);
  assert.deepEqual(calls.saveSettings, [{ appearanceId: "user:dario" }]);
  assert.equal(setResponse.result.appearanceId, "user:dario");
});

test("desktop pet actions reject unknown local appearances and removed legacy names", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);

  const missingResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.set",
    args: { id: "user:missing" },
    permissionMode: "full_access"
  });
  assert.equal(missingResponse.ok, false);
  assert.equal(missingResponse.error.code, "pet_appearance_not_found");
  assert.deepEqual(calls.saveSettings, []);

  for (const action of [
    "desktop.pet.getState",
    "desktop.pet.getSettings",
    "desktop.pet.setEnabled",
    "desktop.pet.listAppearances",
    "desktop.pet.setAppearance"
  ]) {
    const legacyResponse = await handleDesktopActionRequest(options, { action });
    assert.equal(legacyResponse.ok, false, action);
    assert.equal(legacyResponse.error.code, "unknown_action", action);
  }
});
