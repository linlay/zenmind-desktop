import test from "node:test";
import assert from "node:assert/strict";
import { findUnexpectedLatin } from "../scripts/i18n/validate-language-separation.mjs";

test("language checking preserves approved technical terms and numeric units", () => {
  assert.deepEqual(findUnexpectedLatin("使用 HTTPS、HTTP、Frame、Port，限制 32MB 或 1.5GB"), []);
  assert.deepEqual(findUnexpectedLatin("使用 images[]、agent-platform 和 Node.js"), []);
});

test("allowed terms do not hide unknown words or corrupt their diagnostic spelling", () => {
  assert.deepEqual(findUnexpectedLatin("提示 Application 和 Portal"), ["Application", "Portal"]);
  assert.deepEqual(findUnexpectedLatin("提示 Dockerish"), ["Dockerish"]);
});

test("Markdown link labels are checked while destinations and inline code are ignored", () => {
  assert.deepEqual(findUnexpectedLatin("打开 [帮助](https://example.test/help) 或 `unknownCode`"), []);
  assert.deepEqual(findUnexpectedLatin("打开 [Continue](https://example.test/help)"), ["Continue"]);
  assert.deepEqual(findUnexpectedLatin("打开 [Application](https://example.test/help)"), ["Application"]);
});
