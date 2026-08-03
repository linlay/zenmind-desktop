import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  clearEnterpriseChatAvatar,
  readEnterpriseChatSelfProfile,
  saveEnterpriseChatAvatar,
  saveEnterpriseChatMotto
} = await import("../dist-electron/main/enterprise-chat-local-profile.js");

function fixtureApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(homePath, "Library", "Application Support");
      throw new Error(`unexpected app path ${name}`);
    }
  };
}

test("enterprise chat local profile isolates motto and avatar by server and user", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-chat-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = fixtureApp(homePath);
  const avatarPath = path.join(root, "avatar.png");
  fs.writeFileSync(avatarPath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02
  ]));

  let profile = await saveEnterpriseChatMotto(
    app,
    "darwin",
    "https://im.example.test",
    "alice",
    "  Stay curious.  "
  );
  assert.equal(profile.motto, "Stay curious.");
  assert.equal(profile.hasCustomAvatar, false);

  profile = await saveEnterpriseChatAvatar(
    app,
    "darwin",
    "https://im.example.test",
    "alice",
    avatarPath
  );
  assert.equal(profile.hasCustomAvatar, true);
  assert.match(profile.avatarDataUrl, /^data:image\/png;base64,/u);

  const otherUser = readEnterpriseChatSelfProfile(
    app,
    "darwin",
    "https://im.example.test",
    "bob"
  );
  assert.deepEqual(otherUser, { motto: "", avatarDataUrl: "", hasCustomAvatar: false });

  profile = await clearEnterpriseChatAvatar(
    app,
    "darwin",
    "https://im.example.test",
    "alice"
  );
  assert.equal(profile.motto, "Stay curious.");
  assert.equal(profile.hasCustomAvatar, false);
});
