import type { AssistantPageContext } from "../../shared/contracts";
import type { BrowserToolResult } from "./browser-use";

export type BrowserExtractionRequest = {
  kind?: "search_results" | "hot_search" | "headings" | "links" | "table_rows" | "form_state";
  count: number;
  itemLabel: string;
};

export type BrowserRuntimeItem = {
  title: string;
  url?: string;
  snippet?: string;
  source?: string;
  rank?: number;
  confidence?: number;
};

export type BrowserRuntimeExtractionResult = {
  ok: boolean;
  error?: "insufficient_items" | "unsupported_extraction";
  items: BrowserRuntimeItem[];
  candidates: BrowserRuntimeItem[];
  excluded: Array<{ title: string; reason: string; source?: string }>;
  verification: {
    requestedCount: number;
    extractedCount: number;
    enoughItems: boolean;
    kind: NonNullable<BrowserExtractionRequest["kind"]>;
  };
};

export type BrowserRuntimeSearchInput = {
  task: string;
  query: string;
  extraction: BrowserExtractionRequest;
  allowSensitive?: boolean;
  maxSteps?: number;
};

export type BrowserRuntimeController = {
  fillBestInputAndSubmit?: (webContentsId: number, value: string) => Promise<{
    ok: boolean;
    value: string;
    submitted: boolean;
    inputLabel?: string;
    message?: string;
  }>;
  readPageContext?: (webContentsId: number) => Promise<AssistantPageContext | null | undefined>;
  waitForPageSettle?: (webContentsId: number, timeoutMs?: number) => Promise<void>;
  extractPage?: (webContentsId: number, extraction: BrowserExtractionRequest) => Promise<BrowserRuntimeExtractionResult>;
};

export type BrowserRuntimeExecuteOptions = {
  signal?: AbortSignal;
  onEvent?: (event: { type?: string; message?: string; data?: unknown }) => void;
};

const GENERIC_BROWSER_RUNTIME_SYSTEM_INSTRUCTION = [
  "你是 ZenMind Desktop 的通用 Browser Runtime 执行器。",
  "按用户目标操作当前可见网页，不要假设搜索引擎、业务系统或 DOM 选择器固定。",
  "每一步都先依据可见字段、按钮、链接、列表和页面状态判断，再执行最小必要动作。",
  "搜索或筛选后必须等待页面状态变化，再读取真实页面内容；不要把输入框联想词、导航栏、热搜、广告、相关搜索当作结果。",
  "用户要求前 N 条记录、结果、标题、新闻、商品或公司时，只返回页面里真实可见的前 N 个条目；数量不足时明确说明不足，不要编造。",
  "默认不要执行登录、支付、删除、授权、最终提交、保存线上数据等敏感动作。"
].join("\n");

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isTransientBrowserRuntimeError(error: unknown) {
  return /Cannot find default execution context|Execution context was destroyed|Cannot find context with specified id|context.*destroyed|target.*(?:closed|navigat)|frame.*(?:detached|navigat)|page_context_not_ready/iu.test(runtimeErrorMessage(error));
}

async function retryTransientBrowserRuntimeStep<T>(
  label: string,
  operation: () => Promise<T>,
  options: BrowserRuntimeExecuteOptions
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientBrowserRuntimeError(error) || attempt >= 3) {
        throw error;
      }
      options.onEvent?.({
        type: "retry_context",
        message: `${label}时页面仍在导航，正在等待页面上下文就绪后重试第 ${attempt + 1} 次。`,
        data: {
          label,
          attempt,
          error: runtimeErrorMessage(error)
        }
      });
      await delay(300 * attempt);
      if (options.signal?.aborted) {
        throw new Error("aborted");
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}失败。`);
}

function normalizeLine(value: string) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .replace(/^[\s\-*•·#]+/u, "")
    .replace(/^\d+\s*[.)、:：-]?\s*/u, "")
    .trim();
}

function isLikelyChromeOrSearchNoise(value: string) {
  const normalized = value.trim().replace(/[？?。.!！\s]+$/gu, "");
  if (!normalized) {
    return true;
  }
  if (normalized.length < 2 || normalized.length > 180) {
    return true;
  }
  if (/^(videos?|images?|news|maps|shopping|books|finance|flights|all|more|tools|settings|related searches|people also ask)$/iu.test(normalized)) {
    return true;
  }
  if (/^(skip to main content|accessibility help|accessibility feedback|sign in|ai mode|short videos|forums|any time|past hour|past 24 hours|past week|past month|past year|verbatim|safe search)$/iu.test(normalized)) {
    return true;
  }
  return /(搜索工具|相关搜索|大家还在搜|用户反馈|广告|企业推广|百度热搜|热搜榜|深度思考|展开剩余|查看更多|上条.*满意吗|百度AI|图片|视频|地图|贴吧|文库|知道|购物|资讯|登录|无障碍功能帮助|无障碍功能反馈)/u.test(normalized);
}

function dedupeItemTitle(title: string, seen: Set<string>) {
  const normalized = normalizeLine(title)
    .replace(/\s*[-_]\s*(百度搜索|Google Search|Bing Search)$/iu, "")
    .trim();
  if (isLikelyChromeOrSearchNoise(normalized)) {
    return "";
  }
  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return "";
  }
  seen.add(key);
  return normalized;
}

function bodyLineCandidates(pageContext: AssistantPageContext, seen: Set<string>) {
  return String(pageContext.bodyText || "")
    .split(/\r?\n/u)
    .map((line) => dedupeItemTitle(line, seen))
    .filter(Boolean)
    .map((title) => ({ title }));
}

function stripHtml(value: string) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function htmlToReadableLines(html: string) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|section|article|main|aside|li|ul|ol|h[1-6]|tr|td|th|table|blockquote)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function normalizeItemTitle(value: string) {
  return stripHtml(value)
    .replace(/^[\s\-*•·#]+/u, "")
    .replace(/^\d+\s*[.)、:：-]?\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function uniquePushItem(
  items: BrowserRuntimeItem[],
  seen: Set<string>,
  candidate: BrowserRuntimeItem,
  excluded: BrowserRuntimeExtractionResult["excluded"],
  reasonContext = ""
) {
  const title = normalizeItemTitle(candidate.title);
  if (!title || title.length < 2 || title.length > 180) {
    if (title) {
      excluded.push({ title, reason: reasonContext || "标题长度不合适", source: candidate.source });
    }
    return;
  }
  if (isLikelyChromeOrSearchNoise(title)) {
    excluded.push({ title, reason: reasonContext || "导航/噪声内容", source: candidate.source });
    return;
  }
  if (/广告|赞助|推广|ec-tuiguang|sponsored/iu.test(`${candidate.source || ""} ${title}`)) {
    excluded.push({ title, reason: reasonContext || "广告或推广内容", source: candidate.source });
    return;
  }
  const key = title.toLowerCase();
  if (seen.has(key)) {
    excluded.push({ title, reason: "重复条目", source: candidate.source });
    return;
  }
  seen.add(key);
  items.push({
    ...candidate,
    title,
    rank: items.length + 1,
    confidence: candidate.confidence ?? 0.75
  });
}

function extractAttr(value: string, attrName: string) {
  const pattern = new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
  const match = value.match(pattern);
  return match?.[2] || match?.[3] || match?.[4] || "";
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function normalizeGoogleHref(rawHref: string) {
  const href = decodeHtmlAttribute(rawHref || "").trim();
  if (!href || href.startsWith("#")) {
    return "";
  }
  try {
    const url = new URL(href, "https://www.google.com");
    if (url.pathname === "/url" && url.searchParams.get("q")) {
      return url.searchParams.get("q") || "";
    }
    return url.toString();
  } catch {
    return href;
  }
}

function isGoogleInternalNavigationUrl(rawUrl: string) {
  const normalizedUrl = normalizeGoogleHref(rawUrl);
  if (!normalizedUrl) {
    return false;
  }
  try {
    const url = new URL(normalizedUrl, "https://www.google.com");
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (/\/(?:search|preferences|advanced_search|webhp|intl|policies|services|setprefs)$/iu.test(path)) {
      return true;
    }
    if (path === "/aclk" || path.includes("/aclk")) {
      return true;
    }
    return host.includes("google.") && !path.startsWith("/url") && !path.startsWith("/amp/");
  } catch {
    return /^\/(?:search|preferences|advanced_search|webhp|intl|policies|services|setprefs|aclk)(?:[/?#]|$)/iu.test(normalizedUrl);
  }
}

function extractAnchorItems(html: string, source: string): BrowserRuntimeItem[] {
  const items: BrowserRuntimeItem[] = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const title = normalizeItemTitle(match[2] || "");
    if (!title) {
      continue;
    }
    items.push({
      title,
      url: extractAttr(match[1] || "", "href") || undefined,
      source
    });
  }
  return items;
}

function sliceFirstMatch(html: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }
  return "";
}

function extractBaiduMainResultsFromHtml(html: string): Pick<BrowserRuntimeExtractionResult, "items" | "candidates" | "excluded"> {
  const mainHtml = sliceFirstMatch(html, [
    /<div\b[^>]*(?:id|class)=["'][^"']*(?:content_left|result-op|result)[^"']*["'][^>]*>[\s\S]*?(?=<aside\b|<div\b[^>]*id=["']con-ar|<\/body>)/iu,
    /<main\b[\s\S]*?<\/main>/iu
  ]) || html;
  const blockStartPattern = /<(?:div|section|article)\b[^>]*(?:class|tpl|id)=["'][^"']*(?:result|c-container|result-op|algo)[^"']*["'][^>]*>/giu;
  const blockStarts = [...mainHtml.matchAll(blockStartPattern)].map((match) => match.index ?? 0);
  const blocks = blockStarts.map((start, index) => mainHtml.slice(start, blockStarts[index + 1] ?? mainHtml.length));
  const sourceBlocks = blocks.length > 0 ? blocks : [mainHtml];
  const items: BrowserRuntimeItem[] = [];
  const candidates: BrowserRuntimeItem[] = [];
  const excluded: BrowserRuntimeExtractionResult["excluded"] = [];
  const seen = new Set<string>();

  for (const block of sourceBlocks) {
    const anchors = extractAnchorItems(block, "baidu_main");
    const h3Match = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/iu);
    const fallbackTitle = h3Match?.[1] ? normalizeItemTitle(h3Match[1]) : "";
    const candidate = anchors[0] ?? (fallbackTitle ? { title: fallbackTitle, source: "baidu_main" } : null);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    uniquePushItem(
      items,
      seen,
      candidate,
      excluded,
      /广告|赞助|推广|ec-tuiguang/iu.test(block) ? "广告或推广内容" : ""
    );
  }

  return { items, candidates, excluded };
}

function extractBaiduHotSearchFromHtml(html: string): Pick<BrowserRuntimeExtractionResult, "items" | "candidates" | "excluded"> {
  const hotHtml = sliceFirstMatch(html, [
    /<(?:aside|div|section)\b[^>]*(?:id|class)=["'][^"']*(?:con-ar|FYB_RD|hot|热搜|realtime)[^"']*["'][^>]*>[\s\S]*?(?=<main\b|<div\b[^>]*id=["']content_left|<\/body>)/iu,
    /百度热搜[\s\S]*?(?=<main\b|<\/body>)/iu
  ]) || html;
  const items: BrowserRuntimeItem[] = [];
  const candidates = extractAnchorItems(hotHtml, "baidu_hot_search");
  const excluded: BrowserRuntimeExtractionResult["excluded"] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    uniquePushItem(items, seen, {
      ...candidate,
      source: "baidu_hot_search",
      confidence: 0.86
    }, excluded);
  }

  if (items.length === 0) {
    for (const line of stripHtml(hotHtml).split(/\s{2,}|\r?\n/u)) {
      const title = normalizeItemTitle(line);
      if (title && !/百度热搜|热搜榜/u.test(title)) {
        const candidate = { title, source: "baidu_hot_search", confidence: 0.66 };
        candidates.push(candidate);
        uniquePushItem(items, seen, candidate, excluded);
      }
    }
  }

  return { items, candidates, excluded };
}

function extractGenericResultsFromHtml(html: string): Pick<BrowserRuntimeExtractionResult, "items" | "candidates" | "excluded"> {
  const candidates = [
    ...extractAnchorItems(html, "generic_link"),
    ...[...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/giu)]
      .map((match) => ({ title: normalizeItemTitle(match[1] || ""), source: "generic_heading" }))
  ];
  const items: BrowserRuntimeItem[] = [];
  const excluded: BrowserRuntimeExtractionResult["excluded"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    uniquePushItem(items, seen, candidate, excluded);
  }
  return { items, candidates, excluded };
}

function extractGoogleSearchResultsFromHtml(html: string): Pick<BrowserRuntimeExtractionResult, "items" | "candidates" | "excluded"> {
  const mainHtml = sliceFirstMatch(html, [
    /<div\b[^>]*id=["']search["'][^>]*>[\s\S]*?(?=<div\b[^>]*id=["']botstuff|<footer\b|<\/body>)/iu,
    /<main\b[\s\S]*?<\/main>/iu
  ]) || html;
  const h3Pattern = /<h3\b[^>]*>([\s\S]*?)<\/h3>/giu;
  const items: BrowserRuntimeItem[] = [];
  const candidates: BrowserRuntimeItem[] = [];
  const excluded: BrowserRuntimeExtractionResult["excluded"] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = h3Pattern.exec(mainHtml)) !== null) {
    const title = normalizeItemTitle(match[1] || "");
    if (!title) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = mainHtml.slice(Math.max(0, start - 1400), start);
    const after = mainHtml.slice(end, Math.min(mainHtml.length, end + 1400));
    const h3InnerAnchor = match[1]?.match(/<a\b([^>]*)>/iu);
    const previousAnchors = [...before.matchAll(/<a\b([^>]*)>/giu)];
    const previousAnchor = previousAnchors.at(-1);
    const attrs = h3InnerAnchor?.[1] || previousAnchor?.[1] || "";
    const href = normalizeGoogleHref(extractAttr(attrs, "href"));
    const source = "google_main";
    const candidate = {
      title,
      url: href || undefined,
      source,
      confidence: 0.86
    };
    candidates.push(candidate);
    const block = `${before.slice(-500)}${match[0]}${after.slice(0, 500)}`;
    const isAd = /(?:Sponsored|广告|赞助|推广)|\/aclk(?:[/?#]|$)/iu.test(block) || isGoogleInternalNavigationUrl(href);
    uniquePushItem(items, seen, candidate, excluded, isAd ? "广告或 Google 导航内容" : "");
  }

  if (items.length === 0) {
    const generic = extractGenericResultsFromHtml(mainHtml);
    return {
      items: [],
      candidates: generic.candidates,
      excluded: [
        ...excluded,
        ...generic.candidates.map((candidate) => ({
          title: candidate.title,
          reason: "没有匹配到 Google 主搜索结果标题，避免把导航/辅助链接当作结果",
          source: candidate.source
        })),
        ...generic.excluded
      ]
    };
  }

  return { items, candidates, excluded };
}

function isSongExtractionRequest(extraction: BrowserExtractionRequest) {
  return /歌曲|首|歌\b|song/iu.test(extraction.itemLabel || "");
}

function cleanSongSinger(value: string) {
  return normalizeItemTitle(value)
    .replace(/^.*(?:包括|榜单前列热歌|高频流行曲|粤语经典\/热门|热门歌曲主要包括|主要包括)[：:\s]*/u, "")
    .replace(/^(?:和|及|以及|等|、|，|,|：|:|\s)+/u, "")
    .replace(/(?:等|歌曲|歌手|演唱|原唱|cover)$/iu, "")
    .trim();
}

function buildSongTitle(song: string, singer?: string) {
  const normalizedSong = normalizeItemTitle(song).replace(/[。；;，,、]+$/u, "");
  const normalizedSinger = cleanSongSinger(singer || "").replace(/[。；;，,、]+$/u, "");
  if (!normalizedSong) {
    return "";
  }
  if (!normalizedSinger || normalizedSong.includes(normalizedSinger) || /^(?:榜单|热门|热歌|高频|粤语|经典|歌曲|主要)$/u.test(normalizedSinger)) {
    return normalizedSong;
  }
  return `${normalizedSong} - ${normalizedSinger}`;
}

function pushSongCandidate(
  items: BrowserRuntimeItem[],
  candidates: BrowserRuntimeItem[],
  excluded: BrowserRuntimeExtractionResult["excluded"],
  seen: Set<string>,
  song: string,
  singer: string | undefined,
  source: string,
  confidence: number
) {
  const title = buildSongTitle(song, singer);
  if (!title) {
    return;
  }
  const candidate = { title, source, confidence };
  candidates.push(candidate);
  uniquePushItem(items, seen, candidate, excluded);
}

function extractSongItemsFromText(
  text: string,
  source: string,
  items: BrowserRuntimeItem[],
  candidates: BrowserRuntimeItem[],
  excluded: BrowserRuntimeExtractionResult["excluded"],
  seen: Set<string>,
  confidence: number
) {
  const quotePattern = /([^《》\n，。；;,、]{0,50})《([^》]{1,60})》/gu;
  let match: RegExpExecArray | null;
  while ((match = quotePattern.exec(text)) !== null) {
    pushSongCandidate(items, candidates, excluded, seen, match[2] || "", match[1] || "", source, confidence);
  }

  if (!/(?:热歌|热门歌曲|流行曲|粤语经典|榜单前列|主要包括|高频)/u.test(text)) {
    return;
  }

  const afterColon = text.includes("：") || text.includes(":")
    ? text.replace(/^.*?[：:]/u, "")
    : text;
  for (const rawPart of afterColon.split(/[、，,；;]/u)) {
    if (/《[^》]+》/u.test(rawPart)) {
      continue;
    }
    const part = normalizeItemTitle(rawPart)
      .replace(/《[^》]+》/gu, "")
      .replace(/^(?:和|及|以及|等)\s*/u, "")
      .replace(/\s*(?:等|为主|可在.*|查看|包括)$/u, "")
      .trim();
    if (!part || part.length < 2 || part.length > 40) {
      continue;
    }
    if (/(?:202\d|歌曲|热歌|榜单|趋势|平台|主要|涵盖|用户|视频|搜索|查看|更多|实时|QQ音乐|Apple Music|抖音|YouTube|年|月)/iu.test(part)) {
      continue;
    }
    pushSongCandidate(items, candidates, excluded, seen, part, undefined, source, confidence - 0.08);
  }
}

function extractGoogleSongResultsFromHtml(html: string): Pick<BrowserRuntimeExtractionResult, "items" | "candidates" | "excluded"> {
  const lines = htmlToReadableLines(html);
  const items: BrowserRuntimeItem[] = [];
  const candidates: BrowserRuntimeItem[] = [];
  const excluded: BrowserRuntimeExtractionResult["excluded"] = [];
  const seen = new Set<string>();
  const aiStart = lines.findIndex((line) => /^AI Overview$/iu.test(line) || /AI 概览|智能概览/u.test(line));
  if (aiStart >= 0) {
    const stopOffset = lines.slice(aiStart + 1).findIndex((line) =>
      /^(?:网页搜索结果|Search Results|People also ask|Images|People also search for|Page Navigation|Footer Links|Videos|Short videos|News|Forums)$/iu.test(line)
    );
    const aiLines = lines.slice(aiStart + 1, stopOffset >= 0 ? aiStart + 1 + stopOffset : Math.min(lines.length, aiStart + 36));
    for (const line of aiLines) {
      extractSongItemsFromText(line, "google_ai_overview", items, candidates, excluded, seen, 0.9);
    }
  }

  if (items.length >= 3) {
    return { items, candidates, excluded };
  }

  const qqSnippet = lines.filter((line) => /抖音热歌榜|QQ音乐|Apple Music|热门歌曲|Douyin|TikTok|抖音/u.test(line)).join("\n");
  extractSongItemsFromText(qqSnippet, "google_song_snippet", items, candidates, excluded, seen, 0.78);

  const numberedSongPattern = /(?:^|\s)\d+\s+\d+\.\s*([^.\n。·]{1,40})[.。]\s*([^·\n]{1,40})/gu;
  let match: RegExpExecArray | null;
  while ((match = numberedSongPattern.exec(lines.join("\n"))) !== null) {
    pushSongCandidate(items, candidates, excluded, seen, match[1] || "", match[2] || "", "google_song_snippet", 0.8);
  }

  return { items, candidates, excluded };
}

export function extractBrowserItemsFromHtml(
  html: string,
  url: string,
  extraction: BrowserExtractionRequest
): BrowserRuntimeExtractionResult {
  const kind = extraction.kind ?? "search_results";
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const extracted = kind === "hot_search" && host.includes("baidu.com")
    ? extractBaiduHotSearchFromHtml(html)
    : kind === "search_results" && host.includes("google.")
      ? (isSongExtractionRequest(extraction)
          ? (() => {
              const songResults = extractGoogleSongResultsFromHtml(html);
              return songResults.items.length > 0 ? songResults : extractGoogleSearchResultsFromHtml(html);
            })()
          : extractGoogleSearchResultsFromHtml(html))
    : kind === "search_results" && host.includes("baidu.com")
      ? extractBaiduMainResultsFromHtml(html)
      : extractGenericResultsFromHtml(html);
  const items = extracted.items.slice(0, extraction.count);
  const enoughItems = items.length >= extraction.count;
  return {
    ok: enoughItems,
    error: enoughItems ? undefined : "insufficient_items",
    items,
    candidates: extracted.candidates,
    excluded: extracted.excluded,
    verification: {
      requestedCount: extraction.count,
      extractedCount: items.length,
      enoughItems,
      kind
    }
  };
}

export function extractGenericPageItems(pageContext: AssistantPageContext | null | undefined, count: number): BrowserRuntimeItem[] {
  if (!pageContext || count <= 0) {
    return [];
  }
  const seen = new Set<string>();
  const headingItems = (Array.isArray(pageContext.headings) ? pageContext.headings : [])
    .map((heading) => dedupeItemTitle(heading, seen))
    .filter(Boolean)
    .map((title) => ({ title }));
  const items = headingItems.length >= count
    ? headingItems
    : [...headingItems, ...bodyLineCandidates(pageContext, seen)];
  return items.slice(0, count);
}

function extractionResultFromPageContext(
  pageContext: AssistantPageContext | null | undefined,
  extraction: BrowserExtractionRequest
): BrowserRuntimeExtractionResult {
  const items = extractGenericPageItems(pageContext, extraction.count)
    .map((item, index) => ({
      ...item,
      source: "generic_page_context",
      rank: index + 1,
      confidence: 0.55
    }));
  const enoughItems = items.length >= extraction.count;
  return {
    ok: enoughItems,
    error: enoughItems ? undefined : "insufficient_items",
    items,
    candidates: items,
    excluded: [],
    verification: {
      requestedCount: extraction.count,
      extractedCount: items.length,
      enoughItems,
      kind: extraction.kind ?? "search_results"
    }
  };
}

export function formatBrowserRuntimeItems(items: BrowserRuntimeItem[], extraction: BrowserExtractionRequest) {
  if (items.length === 0) {
    return `没有从当前页面读取到可用${extraction.itemLabel || "结果"}。`;
  }
  const label = extraction.itemLabel || "结果";
  return [
    `已完成搜索并读取到前 ${items.length} 条${label}：`,
    ...items.map((item, index) => `${index + 1}. ${item.title}`)
  ].join("\n");
}

export class BrowserRuntime {
  constructor(private readonly controller: BrowserRuntimeController) {}

  async executeSearchExtraction(
    webContentsId: number,
    input: BrowserRuntimeSearchInput,
    options: BrowserRuntimeExecuteOptions = {}
  ): Promise<BrowserToolResult> {
    if (!this.controller.fillBestInputAndSubmit || !this.controller.readPageContext) {
      return {
        ok: false,
        action: "runtime_search_extract",
        target: input.query,
        error: "unsupported_tool",
        message: "当前版本缺少通用浏览器搜索与读取能力。"
      };
    }

    if (this.controller.waitForPageSettle) {
      options.onEvent?.({
        type: "wait_ready",
        message: "正在等待页面上下文就绪。"
      });
      try {
        await this.controller.waitForPageSettle(webContentsId, 5000);
      } catch (error) {
        return {
          ok: false,
          action: "runtime_search_extract",
          target: input.query,
          error: "page_context_not_ready",
          message: `页面上下文还没有就绪，无法开始搜索：${runtimeErrorMessage(error)}`
        };
      }
    }

    let fillResult;
    try {
      fillResult = await retryTransientBrowserRuntimeStep(
        "提交搜索",
        () => this.controller.fillBestInputAndSubmit!(webContentsId, input.query),
        options
      );
    } catch (error) {
      return {
        ok: false,
        action: "runtime_search_extract",
        target: input.query,
        error: isTransientBrowserRuntimeError(error) ? "page_context_not_ready" : "search_submit_failed",
        message: isTransientBrowserRuntimeError(error)
          ? `页面上下文还没有就绪，无法提交搜索：${runtimeErrorMessage(error)}`
          : runtimeErrorMessage(error) || "没有成功提交搜索。"
      };
    }
    if (!fillResult.ok) {
      return {
        ok: false,
        action: "runtime_search_extract",
        target: input.query,
        error: "search_submit_failed",
        message: fillResult.message || "没有成功提交搜索。"
      };
    }

    let attempts = 1;
    if (this.controller.waitForPageSettle) {
      options.onEvent?.({
        type: "wait_after_submit",
        message: "搜索已提交，正在等待页面稳定。"
      });
      try {
        await this.controller.waitForPageSettle(webContentsId, 1500);
      } catch (error) {
        if (!isTransientBrowserRuntimeError(error)) {
          throw error;
        }
        options.onEvent?.({
          type: "retry_context",
          message: "页面仍在导航，准备重试读取结果。",
          data: { error: runtimeErrorMessage(error) }
        });
      }
    }
    let pageContext: AssistantPageContext | null | undefined;
    try {
      pageContext = await retryTransientBrowserRuntimeStep(
        "读取页面",
        () => this.controller.readPageContext!(webContentsId),
        options
      );
    } catch (error) {
      return {
        ok: false,
        action: "runtime_search_extract",
        target: input.query,
        error: "page_context_not_ready",
        message: `页面仍在导航，读取结果失败：${runtimeErrorMessage(error)}`
      };
    }
    let extractionResult = this.controller.extractPage
      ? await retryTransientBrowserRuntimeStep(
          "提取页面",
          () => this.controller.extractPage!(webContentsId, input.extraction),
          options
        ).catch(() => extractionResultFromPageContext(pageContext, input.extraction))
      : extractionResultFromPageContext(pageContext, input.extraction);
    let items = extractionResult.items;

    if (items.length < input.extraction.count) {
      options.onEvent?.({
        type: "retry_read",
        message: "结果数量不足，正在等待页面稳定后重新读取。",
        data: {
          requestedCount: input.extraction.count,
          extractedCount: items.length
        }
      });
      if (this.controller.waitForPageSettle) {
        await this.controller.waitForPageSettle(webContentsId, 1200);
      } else {
        await delay(700);
      }
      if (options.signal?.aborted) {
        throw new Error("aborted");
      }
      attempts += 1;
      pageContext = await retryTransientBrowserRuntimeStep(
        "再次读取页面",
        () => this.controller.readPageContext!(webContentsId),
        options
      ).catch(() => pageContext);
      extractionResult = this.controller.extractPage
        ? await retryTransientBrowserRuntimeStep(
            "再次提取页面",
            () => this.controller.extractPage!(webContentsId, input.extraction),
            options
          ).catch(() => extractionResultFromPageContext(pageContext, input.extraction))
        : extractionResultFromPageContext(pageContext, input.extraction);
      items = extractionResult.items;
    }

    const enoughItems = items.length >= input.extraction.count;
    const message = enoughItems
      ? formatBrowserRuntimeItems(items, input.extraction)
      : [
          `已提交搜索，但当前页面只读取到 ${items.length} 条${input.extraction.itemLabel || "结果"}，少于请求的 ${input.extraction.count} 条。`,
          ...items.map((item, index) => `${index + 1}. ${item.title}`)
        ].filter(Boolean).join("\n");

    return {
      ok: enoughItems,
      action: "runtime_search_extract",
      target: input.query,
      url: pageContext?.url,
      title: pageContext?.title,
      error: enoughItems ? undefined : "insufficient_items",
      message,
      data: {
        query: input.query,
        extraction: input.extraction,
        items,
        candidates: extractionResult.candidates,
        excluded: extractionResult.excluded,
        verification: {
          submitted: fillResult.submitted,
          requestedCount: input.extraction.count,
          extractedCount: items.length,
          enoughItems,
          attempts,
          kind: input.extraction.kind ?? "search_results"
        },
        pageContext
      }
    };
  }
}

export const __testInternals = {
  GENERIC_BROWSER_RUNTIME_SYSTEM_INSTRUCTION,
  extractBrowserItemsFromHtml,
  extractGenericPageItems,
  formatBrowserRuntimeItems
};
