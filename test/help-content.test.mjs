import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const helpRoot = path.join(projectRoot, "help-content");
const locales = ["zh-CN", "en-US"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function flattenIndex(index) {
  return index.categories.flatMap((category) =>
    category.items.map((item) => ({
      categoryId: category.id,
      itemId: item.id,
      file: item.file
    }))
  );
}

test("help content indexes reference existing markdown files", () => {
  for (const locale of locales) {
    const localeRoot = path.join(helpRoot, locale);
    const index = readJson(path.join(localeRoot, "index.json"));

    assert.equal(typeof index.sidebarTitle, "string");
    assert.equal(typeof index.heroTitle, "string");
    assert.equal(typeof index.heroDescription, "string");
    assert.ok(Array.isArray(index.categories));

    for (const category of index.categories) {
      assert.equal(typeof category.id, "string");
      assert.equal(typeof category.label, "string");
      assert.ok(Array.isArray(category.items));

      for (const item of category.items) {
        assert.equal(typeof item.id, "string");
        assert.equal(typeof item.title, "string");
        assert.equal(typeof item.file, "string");
        assert.ok(fs.existsSync(path.join(localeRoot, item.file)), `${locale} missing ${item.file}`);
      }
    }
  }
});

test("help content locales keep matching category and item ids", () => {
  const base = flattenIndex(readJson(path.join(helpRoot, "zh-CN", "index.json")));
  const english = flattenIndex(readJson(path.join(helpRoot, "en-US", "index.json")));

  assert.deepEqual(
    english.map((item) => `${item.categoryId}/${item.itemId}`),
    base.map((item) => `${item.categoryId}/${item.itemId}`)
  );
});

test("help content includes platform template variables for plugin packaging", () => {
  for (const locale of locales) {
    const pluginDoc = fs.readFileSync(
      path.join(helpRoot, locale, "plugins", "package-and-install-plugin.md"),
      "utf8"
    );

    assert.match(pluginDoc, /\{\{pluginArchiveLabel\}\}/);
    assert.match(pluginDoc, /\{\{pluginArchiveCommand\}\}/);
  }
});

test("help content uses brand template variables for product names and shared paths", () => {
  const allHelpContent = locales.flatMap((locale) => {
    const localeRoot = path.join(helpRoot, locale);
    const files = [];
    const visit = (dirPath) => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const filePath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(filePath);
        } else if (entry.name.endsWith(".md") || entry.name === "index.json") {
          files.push(fs.readFileSync(filePath, "utf8"));
        }
      }
    };
    visit(localeRoot);
    return files;
  }).join("\n");

  assert.match(allHelpContent, /\{\{productName\}\}/);
  assert.match(allHelpContent, /\{\{runtimeDataPathMac\}\}/);
  assert.match(allHelpContent, /\{\{runtimeDataPathWindows\}\}/);
  assert.doesNotMatch(allHelpContent, /ZenMind/);
});

test("help markdown renderer handles internal app links through React Router", () => {
  const rendererSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "help", "MarkdownContent.tsx"),
    "utf8"
  );

  assert.match(rendererSource, /import \{ Link \} from "react-router-dom"/);
  assert.match(rendererSource, /isInternalLink\(href\)/);
  assert.match(rendererSource, /<Link[\s\S]*?to=\{href\}/);
  assert.match(rendererSource, /href=\{href\}[\s\S]*?target="_blank"/);
});
