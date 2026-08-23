import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_CONVERSATION_HTML_BYTES,
  conversationHtmlFilename,
  saveConversationHtmlExport,
} = require("../dist-electron/main/assistant/core/conversation-html-export.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-html-export-"));
  const downloads = path.join(root, "Downloads");
  const home = path.join(root, "home");
  const app = {
    getPath(name) {
      if (name === "downloads") return downloads;
      if (name === "home") return home;
      if (name === "appData") return path.join(root, "app-data");
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
  const configPath = path.join(
    home,
    APP_BRAND.paths.runtimeRootDirName,
    APP_BRAND.paths.desktopDataSubdir,
    "config",
    "desktop",
    "tunnel-hub.json",
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    relayUrl: "wss://tunnel.example.test/tunnel",
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { app, downloads, root };
}

test("conversation HTML export writes the exact Worker-rendered bytes to Downloads", async (t) => {
  const { app, downloads } = createFixture(t);
  const html = Buffer.from("<!doctype html><html><body>中文</body></html>", "utf8");
  const bridge = {
    async renderChatHtml(chatId, assetOrigin) {
      assert.equal(chatId, "chat-1");
      assert.equal(assetOrigin, "https://tunnel.example.test");
      return { ok: true, filename: "Transcript.html", bytes: html };
    }
  };

  const result = await saveConversationHtmlExport(app, bridge, " chat-1 ", "darwin");

  assert.equal(result.ok, true, result.message);
  assert.equal(result.filePath, path.join(downloads, "Transcript.html"));
  assert.equal(Buffer.compare(fs.readFileSync(result.filePath), html), 0);
});

test("conversation HTML export avoids overwriting an existing file", async (t) => {
  const { app, downloads } = createFixture(t);
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, "Transcript.html"), "existing");
  const bridge = {
    async renderChatHtml() {
      return { ok: true, filename: "Transcript.html", bytes: Buffer.from("new") };
    }
  };

  const result = await saveConversationHtmlExport(app, bridge, "chat-1", "darwin");

  assert.equal(result.ok, true, result.message);
  assert.equal(result.filePath, path.join(downloads, "Transcript (1).html"));
  assert.equal(fs.readFileSync(path.join(downloads, "Transcript.html"), "utf8"), "existing");
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "new");
});

test("conversation HTML export rejects a defense-in-depth response above 20 MiB", async (t) => {
  const { app, downloads } = createFixture(t);
  const bridge = {
    async renderChatHtml() {
      return {
        ok: true,
        filename: "Transcript.html",
        bytes: Buffer.alloc(MAX_CONVERSATION_HTML_BYTES + 1)
      };
    }
  };

  const result = await saveConversationHtmlExport(app, bridge, "chat-1", "darwin");

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(downloads), false);
});

test("conversation HTML export keeps only rendered HTML filenames", () => {
  assert.equal(
    conversationHtmlFilename("Transcript.html", "chat-1"),
    "Transcript.html",
  );
  assert.equal(
    conversationHtmlFilename("Transcript.md", "chat-1"),
    "chat-1.html",
  );
  assert.equal(conversationHtmlFilename("", "chat-1"), "chat-1.html");
});
