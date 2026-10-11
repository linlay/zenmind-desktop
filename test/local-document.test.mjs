import test from "node:test";
import assert from "node:assert/strict";

const { decodeLocalMarkdown, renderLocalMarkdown } = await import("../dist-electron/main/modules/work-panel/local-document-markdown.js");

test("local Markdown renders headings, fenced code and GFM tables, tasks and strikethrough", () => {
  const html = renderLocalMarkdown(Buffer.from([
    "# 本地文档",
    "",
    "| Name | State |",
    "| --- | --- |",
    "| **task** | ready |",
    "",
    "- [x] complete",
    "- [ ] pending",
    "",
    "~~old~~ https://example.test/guide",
    "",
    "```js",
    "const value = '<unsafe>';",
    "```",
  ].join("\n")), "说明.md");

  assert.match(html, /<h1>本地文档<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<strong>task<\/strong>/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/>/);
  assert.match(html, /<input type="checkbox" disabled=""\/>/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<a href="https:\/\/example\.test\/guide">/);
  assert.match(html, /<pre><code class="language-js">const value = &#x27;&lt;unsafe&gt;&#x27;;/);
});

test("local Markdown skips embedded HTML, sanitizes script URLs and escapes the filename", () => {
  const html = renderLocalMarkdown(Buffer.from([
    "# Safe heading",
    "",
    "<script>globalThis.compromised = true</script>",
    "",
    '<img src="x" onerror="alert(1)">',
    "",
    "[unsafe](javascript:alert%281%29)",
    "",
    '![unsafe](data:image/svg+xml,<svg/onload="alert(1)">)',
  ].join("\n")), '</title><script>alert("filename")</script>.md');

  assert.match(html, /<h1>Safe heading<\/h1>/);
  assert.doesNotMatch(html, /<script\b|onerror=|<svg\b/i);
  assert.doesNotMatch(html, /(?:href|src)="(?:javascript|data):/i);
  assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(&quot;filename&quot;\)&lt;\/script&gt;\.md<\/title>/);
});

test("local Markdown preserves relative image URLs for the isolated file protocol", () => {
  const html = renderLocalMarkdown(Buffer.from("![A diagram](assets/diagram.png)\n\n[Sibling](notes.md)"), "README.md");
  assert.match(html, /<img src="assets\/diagram\.png" alt="A diagram"\/>/);
  assert.match(html, /<a href="notes\.md">Sibling<\/a>/);
});

test("local Markdown decodes UTF-8 with and without BOM", () => {
  const source = "# 中文与 emoji 🚀\n\n完整文本";
  for (const bytes of [Buffer.from(source), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])]) {
    assert.equal(decodeLocalMarkdown(bytes), source);
    assert.match(renderLocalMarkdown(bytes, "说明.md"), /<h1>中文与 emoji 🚀<\/h1>/);
  }
});

test("local Markdown decodes UTF-16LE and UTF-16BE BOMs without losing surrogate pairs", () => {
  const source = "# UTF-16 中文 🚀\r\n\r\n正文";
  const littleEndian = Buffer.from(source, "utf16le");
  const bigEndian = Buffer.from(littleEndian).swap16();
  for (const bytes of [
    Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]),
  ]) {
    assert.equal(decodeLocalMarkdown(bytes), source);
    assert.match(renderLocalMarkdown(bytes, "说明.md"), /<h1>UTF-16 中文 🚀<\/h1>/);
  }
});

test("invalid UTF-8 and truncated UTF-16 fail explicitly instead of silently replacing text", () => {
  for (const bytes of [Buffer.from([0xff, 0xff]), Buffer.from([0xff, 0xfe, 0x61]), Buffer.from([0xfe, 0xff, 0x61])]) {
    assert.throws(() => decodeLocalMarkdown(bytes), TypeError);
    assert.throws(() => renderLocalMarkdown(bytes, "invalid.md"), TypeError);
  }
});
