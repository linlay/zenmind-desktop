import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  registerQuickCopilotShortcut,
  unregisterQuickCopilotShortcut
} = require("../dist-electron/main/assistant/quick/shortcut.js");
const {
  normalizeQuickAssistantShortcut
} = require("../dist-electron/shared/assistant-settings.js");

test("quick assistant shortcut normalizes typed accelerator labels", () => {
  assert.equal(normalizeQuickAssistantShortcut("control+space"), "Control+Space");
  assert.equal(normalizeQuickAssistantShortcut("ctrl + spacebar"), "Control+Space");
  assert.equal(normalizeQuickAssistantShortcut("cmdorctrl+k"), "CommandOrControl+K");
});

test("quick assistant shortcut registers custom accelerator", () => {
  const calls = [];
  let callback = null;
  let toggled = 0;
  const globalShortcut = {
    register(accelerator, nextCallback) {
      calls.push(["register", accelerator]);
      callback = nextCallback;
      return true;
    },
    unregister(accelerator) {
      calls.push(["unregister", accelerator]);
    }
  };

  const result = registerQuickCopilotShortcut({
    platform: "darwin",
    globalShortcut,
    controller: {
      toggleWindow() {
        toggled += 1;
      }
    },
    accelerator: "CommandOrControl+Shift+K"
  });

  assert.equal(result.accelerator, "CommandOrControl+Shift+K");
  assert.equal(result.registered, true);
  assert.equal(typeof callback, "function");

  callback();

  unregisterQuickCopilotShortcut({
    platform: "darwin",
    globalShortcut,
    accelerator: "CommandOrControl+Shift+K"
  });

  assert.equal(toggled, 1);
  assert.deepEqual(calls, [
    ["register", "CommandOrControl+Shift+K"],
    ["unregister", "CommandOrControl+Shift+K"]
  ]);
});
