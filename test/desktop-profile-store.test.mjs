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

test("desktop profile stores custom quick assistant shortcut", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-profile-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  updateDesktopProfileInRoot(root, {
    assistant: {
      quick: {
        shortcut: "CommandOrControl+Shift+K"
      }
    }
  });

  const profile = readDesktopProfileFromRoot(root);

  assert.equal(profile.assistant.quick.shortcut, "CommandOrControl+Shift+K");
});
