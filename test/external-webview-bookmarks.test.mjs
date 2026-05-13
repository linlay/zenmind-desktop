import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_EXTERNAL_WEBVIEW_BOOKMARKS,
  getAnchoredBookmarkMenuCoordinates,
  getItemsHiddenByVisibleIds,
  moveItemByIdToIndex,
  normalizeBookmarkUrl,
  normalizeFaviconUrl,
  normalizeStoredBookmarks,
  reorderItemsById,
  shouldOpenBookmarkInNewTab
} = require("../dist-electron/shared/external-webview-bookmarks.js");

test("normalizeStoredBookmarks keeps old bookmark data compatible while sanitizing new fields", () => {
  const bookmarks = normalizeStoredBookmarks([
    {
      id: "google",
      title: "  Google Search  ",
      url: "https://www.google.com/",
      faviconUrl: "/favicon.ico",
      createdAt: 100,
      customTitle: true
    },
    {
      id: "duplicate",
      title: "Duplicate",
      url: "https://www.google.com/"
    },
    {
      title: "Unsafe favicon",
      url: "https://example.com/page",
      faviconUrl: "javascript:alert(1)"
    },
    {
      title: "Unsupported protocol",
      url: "ftp://example.com"
    }
  ]);

  assert.equal(bookmarks.length, 2);
  assert.deepEqual(bookmarks[0], {
    id: "google",
    title: "Google Search",
    url: "https://www.google.com/",
    faviconUrl: "https://www.google.com/favicon.ico",
    createdAt: 100,
    customTitle: true
  });
  assert.equal(bookmarks[1].title, "Unsafe favicon");
  assert.equal(bookmarks[1].url, "https://example.com/page");
  assert.equal(bookmarks[1].faviconUrl, undefined);
  assert.equal(bookmarks[1].customTitle, undefined);
});

test("bookmark helpers reject unsupported URLs and keep safe favicon sources", () => {
  assert.equal(normalizeBookmarkUrl("https://example.com/work"), "https://example.com/work");
  assert.equal(normalizeBookmarkUrl("mailto:support@example.com"), null);
  assert.equal(normalizeBookmarkUrl("not-a-url"), null);

  assert.equal(
    normalizeFaviconUrl("/favicon.ico", "https://example.com/docs/page"),
    "https://example.com/favicon.ico"
  );
  assert.equal(
    normalizeFaviconUrl("data:image/png;base64,aaaa"),
    "data:image/png;base64,aaaa"
  );
  assert.equal(normalizeFaviconUrl("data:text/html;base64,aaaa"), null);
  assert.equal(normalizeFaviconUrl("javascript:alert(1)", "https://example.com"), null);
});

test("bookmark open modifier follows platform-specific browser conventions", () => {
  assert.equal(shouldOpenBookmarkInNewTab({ button: 1 }, "MacIntel"), true);
  assert.equal(shouldOpenBookmarkInNewTab({ metaKey: true }, "MacIntel"), true);
  assert.equal(shouldOpenBookmarkInNewTab({ ctrlKey: true }, "Win32"), true);
  assert.equal(shouldOpenBookmarkInNewTab({ ctrlKey: true }, "MacIntel"), false);
  assert.equal(shouldOpenBookmarkInNewTab({ metaKey: true }, "Win32"), false);
  assert.equal(shouldOpenBookmarkInNewTab({}, "Win32"), false);
});

test("bookmark menu coordinates anchor to the bookmark item instead of pointer coordinates", () => {
  const coordinates = getAnchoredBookmarkMenuCoordinates(
    { left: 112, top: 144, right: 268, bottom: 176 },
    { width: 1200, height: 800 },
    { menuWidth: 306, menuMaxHeight: 340 }
  );

  assert.deepEqual(coordinates, { x: 112, y: 180 });

  const lowerEdgeCoordinates = getAnchoredBookmarkMenuCoordinates(
    { left: 980, top: 620, right: 1130, bottom: 652 },
    { width: 1200, height: 720 },
    { menuWidth: 306, menuMaxHeight: 340 }
  );

  assert.deepEqual(lowerEdgeCoordinates, { x: 886, y: 276 });
});

test("reorderItemsById moves tabs without mutating the original order", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  assert.deepEqual(reorderItemsById(tabs, "b", "d").map((tab) => tab.id), ["a", "c", "d", "b"]);
  assert.deepEqual(reorderItemsById(tabs, "d", "b").map((tab) => tab.id), ["a", "d", "b", "c"]);
  assert.deepEqual(tabs.map((tab) => tab.id), ["a", "b", "c", "d"]);
  assert.equal(reorderItemsById(tabs, "missing", "b"), tabs);
  assert.equal(reorderItemsById(tabs, "a", "a"), tabs);
});

test("moveItemByIdToIndex supports pointer-based bookmark reordering", () => {
  const bookmarks = [{ id: "google" }, { id: "baidu" }, { id: "news" }];

  assert.deepEqual(moveItemByIdToIndex(bookmarks, "news", 0).map((item) => item.id), ["news", "google", "baidu"]);
  assert.deepEqual(moveItemByIdToIndex(bookmarks, "google", 3).map((item) => item.id), ["baidu", "news", "google"]);
  assert.equal(moveItemByIdToIndex(bookmarks, "missing", 1), bookmarks);
  assert.equal(moveItemByIdToIndex(bookmarks, "baidu", 2), bookmarks);
});

test("getItemsHiddenByVisibleIds returns only bookmark rows hidden behind overflow", () => {
  const bookmarks = [{ id: "hao123" }, { id: "baidu" }, { id: "google" }, { id: "news" }];

  assert.deepEqual(
    getItemsHiddenByVisibleIds(bookmarks, ["hao123", "baidu"]).map((bookmark) => bookmark.id),
    ["google", "news"]
  );
  assert.equal(getItemsHiddenByVisibleIds(bookmarks, ["hao123", "baidu", "google", "news"]).length, 0);
  assert.equal(getItemsHiddenByVisibleIds(bookmarks, []), bookmarks);
});

test("normalizeStoredBookmarks caps persisted rows to the supported bookmark bar size", () => {
  const rawBookmarks = Array.from({ length: MAX_EXTERNAL_WEBVIEW_BOOKMARKS + 3 }, (_, index) => ({
    title: `Bookmark ${index}`,
    url: `https://example.com/${index}`
  }));

  const bookmarks = normalizeStoredBookmarks(rawBookmarks);

  assert.equal(bookmarks.length, MAX_EXTERNAL_WEBVIEW_BOOKMARKS);
  assert.equal(bookmarks.at(-1)?.url, `https://example.com/${MAX_EXTERNAL_WEBVIEW_BOOKMARKS - 1}`);
});
