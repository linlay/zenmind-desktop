import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __testInternals } = require("../dist-electron/main/assistant/browser-runtime.js");

function writeFixture(name, html) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-browser-fixture-"));
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, html, "utf8");
  return { root, filePath };
}

test("typed extraction reads Baidu main search results without hot search or ads", () => {
  const { root, filePath } = writeFixture("baidu-results.html", `
<!doctype html>
<html>
  <body>
    <div id="content_left">
      <div class="result c-container"><h3><a href="https://news.example/1">张雪机车手退赛 官方通报</a></h3><div class="c-abstract">第一条摘要</div></div>
      <div class="result c-container"><span class="ec-tuiguang">广告</span><h3><a href="https://ad.example">摩托车广告</a></h3></div>
      <div class="result c-container"><h3><a href="https://news.example/2">张雪回应机车赛事退赛</a></h3><div class="c-abstract">第二条摘要</div></div>
      <div class="result c-container"><h3><a href="https://news.example/3">赛事组委会说明退赛原因</a></h3><div class="c-abstract">第三条摘要</div></div>
    </div>
    <aside id="con-ar"><h2>百度热搜</h2><a>不该混入的热搜标题</a></aside>
  </body>
</html>
`);
  try {
    const result = __testInternals.extractBrowserItemsFromHtml(
      fs.readFileSync(filePath, "utf8"),
      "https://www.baidu.com/s?wd=%E5%BC%A0%E9%9B%AA%E6%9C%BA%E8%BD%A6%E6%89%8B%E9%80%80%E8%B5%9B",
      {
        kind: "search_results",
        count: 3,
        itemLabel: "标题"
      }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((item) => item.title), [
      "张雪机车手退赛 官方通报",
      "张雪回应机车赛事退赛",
      "赛事组委会说明退赛原因"
    ]);
    assert.equal(result.items.every((item) => item.source === "baidu_main"), true);
    assert.equal(result.excluded.some((item) => /广告/.test(item.reason)), true);
    assert.equal(result.items.some((item) => /热搜/.test(item.title)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typed extraction reads Baidu hot search separately from main results", () => {
  const html = `
<!doctype html>
<html>
  <body>
    <main id="content_left"><h3><a>普通搜索结果不该混入</a></h3></main>
    <aside class="FYB_RD">
      <h2>百度热搜</h2>
      <a class="title-content-title">张雪机车手退赛</a>
      <a class="title-content-title">“如果有来生 我还娶你”</a>
      <a class="title-content-title">文旅产业从流量变留量</a>
    </aside>
  </body>
</html>
`;

  const result = __testInternals.extractBrowserItemsFromHtml(
    html,
    "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
    {
      kind: "hot_search",
      count: 3,
      itemLabel: "热搜"
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.title), [
    "张雪机车手退赛",
    "“如果有来生 我还娶你”",
    "文旅产业从流量变留量"
  ]);
  assert.equal(result.items.every((item) => item.source === "baidu_hot_search"), true);
});

test("typed extraction reads Google song answers without navigation noise", () => {
  const html = `
<!doctype html>
<html>
  <body>
    <nav>
      <a>Skip to main content</a>
      <a>Accessibility help</a>
      <a>Accessibility feedback</a>
      <a>Sign in</a>
      <a>AI Mode</a>
      <a>Short videos</a>
      <a>Forums</a>
      <a>Any time</a>
      <a>Past hour</a>
      <a>Past 24 hours</a>
    </nav>
    <div id="search">
      <section>
        <h2>AI Overview</h2>
        <p>2026年4月至5月，抖音平台热门歌曲主要包括颜人中《我只能离开》、李荣浩《恋人》、周杰伦《晴天》等。</p>
        <p>榜单前列热歌： 颜人中《我只能离开》、李荣浩《恋人》、周杰伦《晴天》、Justin Bieber/Nicki Minaj《Beauty And A Beat》、唯一。</p>
        <p>高频流行曲： LBI利比《跳楼机》、王菲《世界赠予我的》、郑润泽《瞬》。</p>
        <p>粤语经典/热门： 《刚刚好》、《一夜入冬》、《爱情被告》。</p>
      </section>
      <h2>Search Results</h2>
      <h3><a href="https://y.qq.com/toplist">抖音热歌榜_榜单 - QQ音乐</a></h3>
    </div>
  </body>
</html>
`;

  const result = __testInternals.extractBrowserItemsFromHtml(
    html,
    "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E6%9C%80%E6%96%B0%E7%83%AD%E9%97%A8%E6%AD%8C%E6%9B%B2",
    {
      kind: "search_results",
      count: 10,
      itemLabel: "歌曲"
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.title), [
    "我只能离开 - 颜人中",
    "恋人 - 李荣浩",
    "晴天 - 周杰伦",
    "Beauty And A Beat - Justin Bieber/Nicki Minaj",
    "唯一",
    "跳楼机 - LBI利比",
    "世界赠予我的 - 王菲",
    "瞬 - 郑润泽",
    "刚刚好",
    "一夜入冬"
  ]);
  assert.equal(result.items.some((item) => /Skip to main content|Accessibility|Sign in|Any time|Past hour/iu.test(item.title)), false);
  assert.equal(result.items.every((item) => item.source === "google_ai_overview"), true);
});

test("typed extraction returns insufficient_items with candidates and exclusion reasons", () => {
  const result = __testInternals.extractBrowserItemsFromHtml(
    "<main><h3><a>唯一结果</a></h3><a>广告</a></main>",
    "https://www.google.com/search?q=zenmind",
    {
      kind: "search_results",
      count: 3,
      itemLabel: "结果"
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "insufficient_items");
  assert.equal(result.items.length, 1);
  assert.equal(result.verification.requestedCount, 3);
  assert.equal(result.verification.extractedCount, 1);
  assert.equal(Array.isArray(result.candidates), true);
  assert.equal(Array.isArray(result.excluded), true);
});
