export type BrowserClickIntent = {
  action: "click";
  target: string;
};

export type BrowserInputIntent = {
  action: "input";
  value: string;
  submit: boolean;
  summarizeAfterSubmit: boolean;
};

export type BrowserIntent = BrowserClickIntent | BrowserInputIntent;

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
const POLITE_PREFIX_PATTERN = /^(?:请|麻烦|麻烦你|帮我|给我|小宅|zenmind助手|ZenMind助手|在当前页面|在这个页面|在网页里|在页面里|你能不能|能不能)+/u;
const TARGET_SUFFIX_PATTERN = /(?:这个|一下|按钮|入口|卡片|菜单|页面|链接|流程|应用|选项|吧|呀|。|！|!|\.)+$/u;
const SENSITIVE_CLICK_PATTERN =
  /(提交|确认|确定|同意|批准|删除|移除|清空|支付|付款|下单|购买|转账|发送|登录|登陆|注册|退出|注销|保存|授权|允许|导出|上传|取消预约|取消订单|关闭账户|开通|签署|签章)/u;
const INPUT_PATTERN =
  /(?:在)?(?:搜索框|输入框|文本框|搜索栏|框)?(?:里|中)?(?:输入|填入|填写|打入)\s*[“"']?(.+?)[”"']?(?=，?然后|,?然后|，?再|,?再|，?并|,?并|，?接着|,?接着|，?之后|,?之后|$)/u;
const SEARCH_PATTERN = /(?:搜索|百度|搜一下|查一下|查询|查找|检索)\s*[“"']?(.+?)[”"']?(?=，?然后|,?然后|，?再|,?再|，?并|,?并|，?接着|,?接着|，?之后|,?之后|$)/u;
const SUMMARIZE_AFTER_PATTERN = /(然后|再|并|并且|接着|之后).*(总结|概括|归纳|提炼|说明).*(页面|结果|内容|信息|搜索结果)|搜索.*后.*(总结|概括|归纳|提炼)/u;
const FORM_AUTOFILL_PATTERN =
  /(填表|填好|补全|完善|填写).*(表单|字段|资料|信息|申请|右侧|左侧|这一页|当前页)|(?:表单|字段|资料|信息|申请).*(随便填|帮我填|填写|填好|补全|完善)/u;

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
    .replace(/(?:这个|一下|吧|呀|。|！|!|\.)+$/u, "")
    .trim();
}

export function extractBrowserClickIntent(message: string): BrowserClickIntent | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
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

  const inputMatch = trimmed.match(INPUT_PATTERN);
  const searchMatch = inputMatch ? null : trimmed.match(SEARCH_PATTERN);
  const rawValue = inputMatch?.[1] ?? searchMatch?.[1] ?? "";
  const value = cleanInputValue(rawValue);
  if (!value || normalizeBrowserText(value).length < 1) {
    return null;
  }

  const summarizeAfterSubmit = SUMMARIZE_AFTER_PATTERN.test(trimmed);
  const submitText = trimmed.replace(/搜索框|输入框|文本框|搜索栏/gu, "");
  const submit = summarizeAfterSubmit || Boolean(searchMatch) || /(搜索|搜一下|查一下|百度一下|查询|查找|检索|回车|按下回车|提交搜索)/u.test(submitText);

  return {
    action: "input",
    value,
    submit,
    summarizeAfterSubmit
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
