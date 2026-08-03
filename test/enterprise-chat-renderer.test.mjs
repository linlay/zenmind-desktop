import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("enterprise chat renderer uses the compact panel and persistent list searches", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );

  assert.match(panel, /const CHAT_PANEL_WIDTH = 400;/);
  assert.match(panel, /const CHAT_PANEL_HEIGHT = 500;/);
  assert.match(panel, /Math\.min\(CHAT_PANEL_WIDTH, viewport\.width - 24\)/);
  assert.match(panel, /Math\.min\(CHAT_PANEL_HEIGHT, viewport\.height - 82\)/);
  assert.match(panel, /const \[chatSearch, setChatSearch\] = useState\(""\);/);
  assert.match(panel, /const \[contactSearch, setContactSearch\] = useState\(""\);/);
  assert.match(panel, /conversationTitle\(conversation\)[\s\S]*peer\?\.email[\s\S]*conversationPreview\(conversation\)/);
  assert.match(panel, /\[user\.displayName, user\.email\]/);
});

test("enterprise chat deletion remains a renderer-only sequence-aware hide", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const preload = readSource("src", "preload", "index.ts");

  assert.match(panel, /zenmind\.enterpriseChat\.hiddenConversations\.v1/);
  assert.match(panel, /JSON\.stringify\(\[serverUrl, userId\]\)/);
  assert.match(panel, /lastSeq <= preference\.lastSeq/);
  assert.match(panel, /conversation\.lastSeq > hiddenAtSeq/);
  assert.match(panel, /restoreHiddenConversation\([\s\S]*next\.activeConversationId/);
  assert.match(panel, /window\.confirm\(t\("enterpriseChat\.deleteConversationConfirm"/);
  assert.doesNotMatch(panel, /electronAPI\.enterpriseChat\.delete/);
  assert.doesNotMatch(preload, /enterpriseChat\.deleteConversation/);
});
