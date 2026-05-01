import test from "node:test";
import assert from "node:assert/strict";

const {
  parseAssistantMarkdown
} = await import("../dist-electron/shared/assistant-markdown.js");

function inlineText(segments) {
  return segments.map((segment) => segment.text).join("");
}

test("assistant markdown parser turns headings, emphasis, and inline code into structured content", () => {
  const blocks = parseAssistantMarkdown([
    "您的桌面共有 **55 个文件/文件夹**，按类型整理如下：",
    "",
    "### 文件（3个）",
    "",
    "**ZenMind 相关**：`zenmind-desktop`、`zenmind-app-server`"
  ].join("\n"));

  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[0].children.some((segment) => segment.type === "strong" && segment.text === "55 个文件/文件夹"), true);
  assert.equal(blocks[1].type, "heading");
  assert.equal(blocks[1].level, 3);
  assert.equal(inlineText(blocks[1].children), "文件（3个）");
  assert.equal(blocks[2].type, "paragraph");
  assert.equal(blocks[2].children.some((segment) => segment.type === "code" && segment.text === "zenmind-desktop"), true);
});

test("assistant markdown parser recognizes pipe tables", () => {
  const blocks = parseAssistantMarkdown([
    "| 文件名 | 大小 | 修改时间 |",
    "|---|---|---|",
    "| ZenMind.dmg | 134 MB | 2026-05-01 |",
    "| build-all.sh | 5.9 KB | 2026-04-23 |"
  ].join("\n"));

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.equal(inlineText(blocks[0].header[0]), "文件名");
  assert.equal(inlineText(blocks[0].rows[0][0]), "ZenMind.dmg");
  assert.equal(inlineText(blocks[0].rows[1][1]), "5.9 KB");
});

test("assistant markdown parser keeps lists and rules as display blocks", () => {
  const blocks = parseAssistantMarkdown([
    "- 第一项",
    "- 第二项",
    "",
    "---",
    "",
    "结尾"
  ].join("\n"));

  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].type, "rule");
  assert.equal(blocks[2].type, "paragraph");
});
