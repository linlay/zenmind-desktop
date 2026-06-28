import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  handleDesktopActionRequest,
  __testInternals
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

test("desktop website add accepts item payloads and name alias", async (t) => {
  const { options } = createDesktopActionOptions(t);

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.web.website.add",
    permissionMode: "full_access",
    args: {
      items: [{
        description: "全球天气资讯与预报",
        icon: "https://weather.com/favicon.ico",
        name: "Weather.com",
        url: "https://weather.com"
      }]
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.ok, true, response.result.message);
  assert.equal(response.result.item.label, "Weather.com");
  assert.equal(response.result.item.url, "https://weather.com/");
  assert.equal(response.result.items.length, 1);
});

test("desktop website add returns detailed input issues", async (t) => {
  const { options } = createDesktopActionOptions(t);

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.web.website.add",
    permissionMode: "full_access",
    args: {
      items: [{
        name: "Weather.com"
      }]
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.ok, false);
  assert.match(response.result.message, /url|网站地址/u);
  assert.equal(response.result.issues.length, 1);
  assert.equal(response.result.issues[0].field, "url");
  assert.match(response.result.issues[0].message, /Website address is required|网站地址不能为空/u);
  assert.equal(response.result.issues[0].expected, "non-empty string");
  assert.equal(response.result.issues[0].received, "missing");
});

test("desktop action confirmation detail exposes debug context with redacted args", () => {
  const detail = __testInternals.buildDesktopActionConfirmationDetail({
    requestId: "request-123",
    action: "desktop.web.navigate",
    source: {
      runId: "run-abc",
      chatId: "chat-def",
      agentKey: "zenmi"
    }
  }, {
    url: "https://example.test/path/to/page?desktopAuthContext=secret#hash",
    accessToken: "secret-token",
    nested: {
      password: "hidden-password",
      href: "https://nested.test/safe/path?cookie=bad#fragment",
      callback: "zenmind://auth/callback?token=secret#hash"
    },
    longText: "x".repeat(240),
    confirmationSummary: "提醒主人喝水",
    alpha: "a",
    beta: "b",
    gamma: "c",
    delta: "d",
    epsilon: "e",
    zeta: "z"
  }, {
    permissionMode: "page_control",
    target: "Agent Webclient | https://example.test/path/to/page?token=secret#fragment"
  });

  assert.match(detail, /desktop\.web\.navigate/u);
  assert.match(detail, /request-123/u);
  assert.match(detail, /page_control/u);
  assert.match(detail, /run-abc/u);
  assert.match(detail, /chat-def/u);
  assert.match(detail, /zenmi/u);
  assert.match(detail, /Agent Webclient/u);
  assert.match(detail, /https:\/\/example\.test\/path\/to\/page/u);
  assert.match(detail, /zenmind:\/\/auth\/callback/u);
  assert.match(detail, /\[已隐藏\]/u);
  assert.match(detail, /另有 2 项未显示/u);
  assert.doesNotMatch(detail, /secret-token/u);
  assert.doesNotMatch(detail, /hidden-password/u);
  assert.doesNotMatch(detail, /desktopAuthContext/u);
  assert.doesNotMatch(detail, /cookie=bad/u);
  assert.doesNotMatch(detail, /token=secret/u);
  assert.doesNotMatch(detail, /#fragment/u);
  assert.doesNotMatch(detail, /提醒主人喝水/u);
  assert.doesNotMatch(detail, new RegExp("x".repeat(200), "u"));
});
