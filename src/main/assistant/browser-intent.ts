export type BrowserClickIntent = {
  action: "click";
  target: string;
};

export type BrowserInputIntent = {
  action: "input";
  value: string;
  submit: boolean;
  summarizeAfterSubmit: boolean;
  extraction?: {
    count: number;
    itemLabel: string;
  };
};

export type BrowserIntent = BrowserClickIntent | BrowserInputIntent;

export type BrowserTaskExtractionKind =
  | "search_results"
  | "hot_search"
  | "headings"
  | "links"
  | "table_rows"
  | "form_state";

export type BrowserTaskExtraction = {
  kind: BrowserTaskExtractionKind;
  count: number;
  itemLabel: string;
};

export type BrowserTaskWebsite = {
  label: string;
  url: string;
};

export type BrowserTaskIntent =
  | {
      kind: "open_url";
      url: string;
      label: string;
      newTab: boolean;
    }
  | {
      kind: "navigate_current";
      url: string;
      label: string;
    }
  | {
      kind: "site_search";
      website: BrowserTaskWebsite;
      query: string;
      extraction?: BrowserTaskExtraction;
    }
  | {
      kind: "extract";
      extraction: BrowserTaskExtraction;
    }
  | {
      kind: "compound";
      website?: BrowserTaskWebsite;
      query?: string;
      extraction?: BrowserTaskExtraction;
    }
  | {
      kind: "service_control";
      serviceId: string;
      operation: "start" | "stop" | "restart";
    };

export type BrowserElementCandidate = {
  index: number;
  text: string;
  tagName: string;
  role: string;
  ariaLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  interactive: boolean;
};

const CLICK_VERB_PATTERN =
  /(?:帮我点击|帮我打开|帮我进入|帮我点|点击|点一下|点开|打开|进入|选择|选中|切到|跳到)\s*[“"']?(.+?)[”"']?\s*$/u;
const SERVICE_CONTROL_CLICK_PATTERN =
  /(?:(?:左侧|左边|当前|这个)?(?:页面|网页)|控制中心|服务|容器仓库|智能体平台|智能助理).*(?:无法启动|启动起来|启动一下|帮我启动|启动|重新启动|重启)|(?:启动|重新启动|重启).*(?:(?:左侧|左边|当前|这个)?(?:页面|网页)|控制中心|服务|容器仓库|智能体平台|智能助理)/u;
const POLITE_PREFIX_PATTERN = /^(?:请|麻烦|麻烦你|帮我|给我|zenmind(?:\s*助手)?|在当前页面|在这个页面|在网页里|在页面里|你能不能|能不能)+/iu;
const TARGET_SUFFIX_PATTERN = /(?:这个|一下|按钮|入口|卡片|菜单|页面|链接|流程|应用|选项|吧|呀|。|！|!|\.)+$/u;
const SENSITIVE_CLICK_PATTERN =
  /(提交|确认|确定|同意|批准|删除|移除|清空|支付|付款|下单|购买|转账|发送|登录|登陆|注册|退出|注销|保存|授权|允许|导出|上传|取消预约|取消订单|关闭账户|开通|签署|签章)/u;
const FOLLOWUP_BOUNDARY_PATTERN =
  "，?然后|,?然后|，?再|,?再|，?并|,?并|，?接着|,?接着|，?之后|,?之后|，?搜索后|,?搜索后|，?搜完后|,?搜完后|，?搜完以后|,?搜完以后|，?查完后|,?查完后|，?查完以后|,?查完以后|，?查询后|,?查询后|，?检索后|,?检索后|，?打开后|,?打开后|，?筛选后|,?筛选后|$";
const INPUT_PATTERN =
  new RegExp(`(?:在)?(?:百度|谷歌|google|bing|必应|搜索框|输入框|文本框|搜索栏|框)?(?:里|中|上|里面)?(?:输入|填入|填写|打入)\\s*[“"']?(.+?)[”"']?(?=${FOLLOWUP_BOUNDARY_PATTERN})`, "iu");
const SEARCH_PATTERN = new RegExp(
  `(?:(?:在)?(?:百度|谷歌|google|bing|必应)(?:里|中|上|里面)?\\s*)?(?:搜索(?!结果)|搜一下|搜搜|搜(?!索)|查一下|查询|查找|检索)\\s*[“"']?(.+?)[”"']?(?=${FOLLOWUP_BOUNDARY_PATTERN})|(?:百度|谷歌|google|bing|必应)\\s*[“"']?(.+?)[”"']?(?=${FOLLOWUP_BOUNDARY_PATTERN})`,
  "iu"
);
const EXPLICIT_BROWSER_SEARCH_PATTERN = new RegExp(
  `(?:左边|左侧|当前(?:页面|网页|浏览器)|这个(?:页面|网页|浏览器)|页面里|网页里|浏览器里).*?(?:百度|谷歌|google|bing|必应)?(?:里|中|上|里面|的)?\\s*(?:搜索(?!结果)|搜一下|搜搜|搜(?!索)|查一下|查询|查找|检索)\\s*[“"']?(.+?)[”"']?(?=${FOLLOWUP_BOUNDARY_PATTERN})`,
  "iu"
);
const SUMMARIZE_AFTER_PATTERN = /(然后|再|并|并且|接着|之后|搜索后|搜完后|搜完以后|查完后|查完以后|查询后|检索后|打开后|筛选后).*(总结|概括|归纳|提炼|说明|发给我|发送给我|列出来|告诉我|读取|读出|记录|结果|标题)|搜索.*后.*(总结|概括|归纳|提炼|发给我|发送给我|记录|结果|标题)/u;
const FORM_AUTOFILL_PATTERN =
  /(填表|填好|补全|完善|填写).*(表单|字段|资料|信息|申请|右侧|左侧|这一页|当前页)|(?:表单|字段|资料|信息|申请).*(随便填|帮我填|填写|填好|补全|完善)/u;
const SEARCH_RESULT_SUMMARY_PATTERN =
  /(?:(?:当前|页面上|网页里|根据|把)?(?:搜索结果|结果页|搜索页).*(?:前\s*(?:\d+|[一二三四五六七八九十两]+)\s*条|前三条|前3条)?.*(?:总结|概括|归纳|提炼|解读|发给我|发送给我)|(?:总结|概括|归纳|提炼|解读).*(?:搜索结果|结果页|搜索页|前\s*(?:\d+|[一二三四五六七八九十两]+)\s*条|前三条|前3条))/u;
const URL_ENTRY_PATTERN =
  /(?:新\s*(?:tab|标签页|页面|网页)|地址栏|URL|url|网址).*(?:输入|访问|打开|进入)\s*[“"']?([a-z][a-z0-9+.-]*:\/\/[^\s，。！？]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s，。！？]*)?)[”"']?/iu;
const DIRECT_URL_OPEN_PATTERN =
  /(?:打开|进入|访问)\s*(?:一个)?(?:新\s*(?:tab|标签页|页面|网页))?.*?[“"']?([a-z][a-z0-9+.-]*:\/\/[^\s，。！？]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s，。！？]*)?)[”"']?/iu;
const HOT_SEARCH_PATTERN = /(?:热搜|热榜|热点榜|热搜榜)/u;
const SEARCH_RESULTS_PATTERN = /(?:搜索的?结果|结果页|主结果|自然结果)/u;
const SERVICE_NAME_ALIASES: Array<{ pattern: RegExp; serviceId: string }> = [
  { pattern: /容器仓库|容器服务|container\s*hub|agent-container-hub/iu, serviceId: "agent-container-hub" },
  { pattern: /智能体平台|agent-platform/iu, serviceId: "agent-platform" },
  { pattern: /智能助理|agent-webclient/iu, serviceId: "agent-webclient" },
  { pattern: /认证服务|管理后台|zenmind-app-server/iu, serviceId: "zenmind-app-server" }
];
const KNOWN_WEBSITES: Array<{ pattern: RegExp; website: BrowserTaskWebsite }> = [
  { pattern: /百度/u, website: { label: "百度", url: "https://www.baidu.com/" } },
  { pattern: /谷歌|google/iu, website: { label: "谷歌", url: "https://www.google.com/" } },
  { pattern: /必应|bing/iu, website: { label: "必应", url: "https://www.bing.com/" } }
];

export function normalizeBrowserText(value: string) {
  return value
    .replace(/\s+/gu, "")
    .replace(/[，,。.!！?？:：;；"'“”‘’「」『』（）()【】\[\]<>《》]/gu, "")
    .trim()
    .toLowerCase();
}

function cleanClickTarget(value: string) {
  return value
    .replace(POLITE_PREFIX_PATTERN, "")
    .replace(TARGET_SUFFIX_PATTERN, "")
    .replace(/^[“"']|[”"']$/gu, "")
    .trim();
}

function cleanInputValue(value: string) {
  return value
    .replace(/^[“"']|[”"']$/gu, "")
    .replace(/^(?:搜索|搜一下|搜搜|搜(?!索)|查一下|查询|查找|检索)\s*/u, "")
    .replace(/(?:这个|一下|吧|呀|。|！|!|\.)+$/u, "")
    .trim();
}

function parseSmallChineseNumber(value: string) {
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    return Number(normalized);
  }
  const map = new Map([
    ["一", 1],
    ["二", 2],
    ["两", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
    ["十", 10]
  ]);
  if (map.has(normalized)) {
    return map.get(normalized);
  }
  if (normalized.startsWith("十") && normalized.length === 2) {
    return 10 + (map.get(normalized.slice(1)) ?? 0);
  }
  if (normalized.endsWith("十") && normalized.length === 2) {
    return (map.get(normalized.slice(0, 1)) ?? 0) * 10;
  }
  const tenMatch = normalized.match(/^([一二两三四五六七八九])十([一二三四五六七八九])$/u);
  if (tenMatch) {
    return (map.get(tenMatch[1]) ?? 0) * 10 + (map.get(tenMatch[2]) ?? 0);
  }
  return undefined;
}

function extractRequestedItems(message: string): BrowserInputIntent["extraction"] {
  const numbered = message.match(/前\s*([0-9一二两三四五六七八九十]+)\s*(条|个|项|篇|则|首)?\s*(记录|结果|标题|条目|新闻|商品|公司|内容|歌曲|歌)?/u);
  const compact = numbered ? null : message.match(/前([一二两三四五六七八九十])\s*(条|个|项|篇|则|首)?\s*(记录|结果|标题|条目|新闻|商品|公司|内容|歌曲|歌)?/u);
  const loose = numbered || compact
    ? null
    : message.match(/(?:搜索的?结果|结果|新闻|热点|热搜|榜单|排行|排名|热门|歌曲|歌).{0,16}?([0-9一二两三四五六七八九十]+)\s*(条|个|项|篇|则|首)\s*(记录|结果|标题|条目|新闻|商品|公司|内容|歌曲|歌)?/u);
  const rawCount = numbered?.[1] ?? compact?.[1] ?? loose?.[1];
  const count = rawCount ? parseSmallChineseNumber(rawCount) : undefined;
  if (!count || count <= 0) {
    return undefined;
  }
  const usesSongUnit = numbered?.[2] === "首" || compact?.[2] === "首" || loose?.[2] === "首";
  const rawItemLabel = numbered?.[3] ?? compact?.[3] ?? loose?.[3] ?? (
    /记录/u.test(message) ? "记录" :
      /标题/u.test(message) ? "标题" :
        /新闻/u.test(message) ? "新闻" :
          /商品/u.test(message) ? "商品" :
            /公司/u.test(message) ? "公司" :
              usesSongUnit || /歌曲/u.test(message) ? "歌曲" :
              "结果"
  );
  const itemLabel = rawItemLabel === "歌" ? "歌曲" : rawItemLabel;
  return {
    count: Math.min(count, 10),
    itemLabel
  };
}

function normalizeUrlForTask(rawValue: string) {
  const value = rawValue.trim().replace(/[”"']+$/gu, "");
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`);
    if (!/^https?:$/iu.test(parsed.protocol)) {
      return null;
    }
    return {
      url: parsed.toString(),
      label: parsed.hostname
    };
  } catch {
    return null;
  }
}

function extractRequestedTaskExtraction(message: string): BrowserTaskExtraction | undefined {
  const requested = extractRequestedItems(message);
  if (!requested) {
    return HOT_SEARCH_PATTERN.test(message)
      ? { kind: "hot_search", count: 10, itemLabel: "热搜" }
      : undefined;
  }
  const kind: BrowserTaskExtractionKind = HOT_SEARCH_PATTERN.test(message)
    ? "hot_search"
    : SEARCH_RESULTS_PATTERN.test(message) || /标题|结果|搜索|搜一下|搜搜|查询|查找|检索/u.test(message)
      ? "search_results"
      : "headings";
  return {
    kind,
    count: requested.count,
    itemLabel: kind === "hot_search" ? "热搜" : requested.itemLabel
  };
}

function extractWebsiteForTask(message: string): BrowserTaskWebsite | undefined {
  return KNOWN_WEBSITES.find((entry) => entry.pattern.test(message))?.website;
}

function cleanTaskSearchQuery(value: string) {
  return value
    .replace(/^[，,\s]*(?:在)?(?:谷歌|google|百度|必应|bing)(?:里|中|上|里面)?\s*/iu, "")
    .replace(/^[，,\s]*(?:搜索|搜一下|搜搜|搜|查一下|查询|查找|检索)\s*/u, "")
    .replace(/(?:把|将)?(?:搜索结果|结果页|热搜|热榜|前\s*[0-9一二两三四五六七八九十]+\s*(?:条|个|项)?|标题|发给我|告诉我).*$/u, "")
    .replace(/(?:这个|一下|吧|呀|。|！|!|\.)+$/u, "")
    .trim();
}

function extractTaskSearchQuery(message: string) {
  const match = message.match(
    /(?:在)?(?:百度|谷歌|google|必应|bing)?(?:里|中|上|里面)?\s*(?:搜索|搜一下|搜搜|搜(?!索)|查一下|查询|查找|检索)\s*[“"']?(.+?)[”"']?(?=，|,|然后|再|并|把|将|$)/iu
  );
  return match?.[1] ? cleanTaskSearchQuery(match[1]) : "";
}

function extractFreshNewsQuery(message: string) {
  if (!/(今天|今日|现在|当前|最新).*(热点|新闻|资讯|消息|热搜)/u.test(message)) {
    return "";
  }
  return /今天/u.test(message) ? "今天热点新闻" : "今日热点新闻";
}

function extractServiceTaskIntent(message: string): BrowserTaskIntent | null {
  const service = SERVICE_NAME_ALIASES.find((entry) => entry.pattern.test(message));
  if (!service || !SERVICE_CONTROL_CLICK_PATTERN.test(message)) {
    return null;
  }
  const operation: "start" | "stop" | "restart" =
    /重新启动|重启/u.test(message) ? "restart" :
      /停止|关闭|停掉/u.test(message) ? "stop" :
        "start";
  return {
    kind: "service_control",
    serviceId: service.serviceId,
    operation
  };
}

export function extractBrowserTaskIntent(message: string): BrowserTaskIntent | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const serviceIntent = extractServiceTaskIntent(trimmed);
  if (serviceIntent) {
    return serviceIntent;
  }

  const urlMatch = trimmed.match(URL_ENTRY_PATTERN) ?? trimmed.match(DIRECT_URL_OPEN_PATTERN);
  if (urlMatch?.[1]) {
    const url = normalizeUrlForTask(urlMatch[1]);
    if (url) {
      return {
        kind: /新\s*(?:tab|标签页|页面|网页)|new\s*tab/iu.test(trimmed) ? "open_url" : "navigate_current",
        url: url.url,
        label: url.label,
        ...(/新\s*(?:tab|标签页|页面|网页)|new\s*tab/iu.test(trimmed) ? { newTab: true } : {})
      } as BrowserTaskIntent;
    }
  }

  const extraction = extractRequestedTaskExtraction(trimmed);
  const website = extractWebsiteForTask(trimmed);
  const query = extractTaskSearchQuery(trimmed) || extractFreshNewsQuery(trimmed);
  if (website && !query && /打开|进入|访问|启动/u.test(trimmed)) {
    return {
      kind: "open_url",
      url: website.url,
      label: website.label,
      newTab: true
    };
  }
  if (HOT_SEARCH_PATTERN.test(trimmed) && extraction?.kind === "hot_search") {
    return {
      kind: "compound",
      ...(website ? { website } : {}),
      extraction
    };
  }
  if (website && query && extraction) {
    return {
      kind: "compound",
      website,
      query,
      extraction
    };
  }
  if (website && query) {
    return {
      kind: "site_search",
      website,
      query
    };
  }
  if (query && /热点|新闻|资讯|消息|热搜/u.test(query)) {
    return {
      kind: "compound",
      query,
      extraction: extraction ?? {
        kind: "search_results",
        count: 5,
        itemLabel: "结果"
      }
    };
  }
  if (extraction && !query) {
    return {
      kind: "extract",
      extraction
    };
  }
  return null;
}

function extractServiceControlTarget(message: string) {
  if (!SERVICE_CONTROL_CLICK_PATTERN.test(message)) {
    return null;
  }
  return /重新启动|重启/u.test(message) ? "重启" : "启动";
}

export function extractBrowserClickIntent(message: string): BrowserClickIntent | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const serviceTarget = extractServiceControlTarget(trimmed);
  if (serviceTarget) {
    return {
      action: "click",
      target: serviceTarget
    };
  }

  const match = trimmed.match(CLICK_VERB_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const target = cleanClickTarget(match[1]);
  if (!target || normalizeBrowserText(target).length < 2) {
    return null;
  }

  return {
    action: "click",
    target
  };
}

export function extractBrowserInputIntent(message: string): BrowserInputIntent | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }
  if (FORM_AUTOFILL_PATTERN.test(trimmed)) {
    return null;
  }
  if (SEARCH_RESULT_SUMMARY_PATTERN.test(trimmed)) {
    return null;
  }

  const inputMatch = trimmed.match(INPUT_PATTERN);
  const searchMatch = inputMatch ? null : (trimmed.match(EXPLICIT_BROWSER_SEARCH_PATTERN) ?? trimmed.match(SEARCH_PATTERN));
  const rawValue = inputMatch?.[1] ?? searchMatch?.[1] ?? searchMatch?.[2] ?? "";
  const value = cleanInputValue(rawValue);
  if (!value || normalizeBrowserText(value).length < 1) {
    return null;
  }

  const summarizeAfterSubmit = SUMMARIZE_AFTER_PATTERN.test(trimmed);
  const extraction = extractRequestedItems(trimmed);
  const submitText = trimmed.replace(/搜索框|输入框|文本框|搜索栏/gu, "");
  const submit = summarizeAfterSubmit || Boolean(searchMatch) || /(搜索|搜一下|查一下|百度一下|查询|查找|检索|回车|按下回车|提交搜索)/u.test(submitText);

  return {
    action: "input",
    value,
    submit,
    summarizeAfterSubmit: summarizeAfterSubmit || Boolean(extraction),
    ...(extraction ? { extraction } : {})
  };
}

export function extractBrowserIntent(message: string): BrowserIntent | null {
  return extractBrowserInputIntent(message) ?? extractBrowserClickIntent(message);
}

export function isPotentiallySensitiveClickTarget(target: string) {
  return SENSITIVE_CLICK_PATTERN.test(target);
}

function levenshteinDistance(a: string, b: string) {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return b.length;
  }
  if (!b) {
    return a.length;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function characterOverlapScore(a: string, b: string) {
  const aChars = [...a];
  const bCounts = new Map<string, number>();
  for (const char of b) {
    bCounts.set(char, (bCounts.get(char) ?? 0) + 1);
  }

  let overlap = 0;
  for (const char of aChars) {
    const count = bCounts.get(char) ?? 0;
    if (count <= 0) {
      continue;
    }
    overlap += 1;
    bCounts.set(char, count - 1);
  }

  return (overlap * 2) / Math.max(1, a.length + b.length);
}

export function scoreBrowserElementCandidate(candidate: BrowserElementCandidate, target: string) {
  const normalizedTarget = normalizeBrowserText(target);
  const candidateParts = [candidate.text, candidate.ariaLabel, candidate.role]
    .map((part) => normalizeBrowserText(part))
    .filter(Boolean);
  const normalizedText = candidateParts.join("");
  if (!normalizedTarget || !normalizedText) {
    return 0;
  }

  let score = 0;
  if (normalizedText === normalizedTarget) {
    score = 1000;
  } else if (normalizedText.includes(normalizedTarget)) {
    score = 850 - Math.min(120, normalizedText.length - normalizedTarget.length);
  } else if (normalizedTarget.includes(normalizedText) && normalizedText.length >= 2) {
    score = 720 - Math.min(120, normalizedTarget.length - normalizedText.length);
  } else {
    const distance = levenshteinDistance(normalizedText, normalizedTarget);
    const maxLength = Math.max(normalizedText.length, normalizedTarget.length);
    if (maxLength <= 16 && distance <= Math.max(2, Math.floor(maxLength * 0.35))) {
      score = 680 - distance * 55;
    } else {
      score = characterOverlapScore(normalizedText, normalizedTarget) * 560;
    }
  }

  if (candidate.interactive) {
    score += 80;
  }
  if (candidate.text.length > 80) {
    score -= Math.min(200, candidate.text.length - 80);
  }
  if (candidate.width > 800 || candidate.height > 260) {
    score -= 80;
  }

  return Math.max(0, score);
}

export function chooseBestBrowserElement(candidates: BrowserElementCandidate[], target: string) {
  let best: { candidate: BrowserElementCandidate; score: number } | null = null;

  for (const candidate of candidates) {
    const score = scoreBrowserElementCandidate(candidate, target);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }

  return best && best.score >= 300 ? best : null;
}
