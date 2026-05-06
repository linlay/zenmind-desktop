import type { BrowserElementCandidate } from "./browser-intent";
import {
  chooseBestBrowserElement,
  isPotentiallySensitiveClickTarget,
  normalizeBrowserText
} from "./browser-intent";
import type { AssistantPageContext } from "../../shared/contracts";
import {
  extractBrowserItemsFromHtml,
  type BrowserExtractionRequest,
  type BrowserRuntimeExtractionResult
} from "./browser-runtime";

export type DebuggerLike = {
  isAttached: () => boolean;
  attach: (protocolVersion?: string) => void;
  detach: () => void;
  sendCommand: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>;
};

export type WebContentsLike = {
  id: number;
  isDestroyed: () => boolean;
  focus: () => void;
  getURL: () => string;
  getTitle?: () => string;
  debugger: DebuggerLike;
};

export type BrowserUseControllerOptions = {
  resolveWebContents?: (webContentsId: number) => WebContentsLike | null | undefined;
};

export type BrowserClickResult =
  | {
      ok: true;
      target: string;
      matchedText: string;
      score: number;
    }
  | {
      ok: false;
      target: string;
      message: string;
      candidates: string[];
    };

export type BrowserInputResult =
  | {
      ok: true;
      value: string;
      submitted: boolean;
      inputLabel: string;
    }
  | {
      ok: false;
      value: string;
      submitted: false;
      message: string;
    };

export type BrowserSurface = {
  id: string;
  label: string;
  url: string;
  active?: boolean;
  title?: string;
  currentUrl?: string;
  webContentsId?: number;
};

export type BrowserAgentTaskInput = {
  task: string;
  target?: string;
  allowSensitive?: boolean;
  systemInstruction?: string;
  maxSteps?: number;
};

export type BrowserObservedElement = BrowserElementCandidate & {
  elementRef: string;
  ref?: string;
  selector?: string;
  kind: "button" | "link" | "input" | "select" | "checkbox" | "radio" | "text" | "other";
  unsafe: boolean;
};

export type BrowserObservedField = {
  index: number;
  elementRef: string;
  ref?: string;
  selector?: string;
  label: string;
  tagName: string;
  type: string;
  role: string;
  value: string;
  placeholder: string;
  required: boolean;
  checked: boolean;
  options: Array<{ value: string; label: string; selected: boolean }>;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserObservation = {
  ok: true;
  action: "observe";
  url: string;
  title: string;
  bodyText: string;
  elements: BrowserObservedElement[];
  fields: BrowserObservedField[];
};

export type BrowserToolResult = {
  ok: boolean;
  action: string;
  target?: string;
  url?: string;
  title?: string;
  message?: string;
  error?: string;
  data?: unknown;
};

export type BrowserRuntimeSnapshot = {
  snapshotId?: string;
  url: string;
  title: string;
  observation?: BrowserObservation;
  pageContext?: AssistantPageContext;
  accessibility?: unknown[];
  screenshot?: {
    mimeType: "image/png" | "image/jpeg";
    data: string;
  };
};

export type BrowserElementRef = {
  ref: string;
  snapshotId: string;
  rawElementRef: string;
  selector?: string;
  text?: string;
  label?: string;
  tagName?: string;
  role?: string;
  kind: BrowserObservedElement["kind"] | "field";
  unsafe?: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  pageSignature: {
    url: string;
    title: string;
  };
  fingerprint: string;
};

export type BrowserActionSnapshot = BrowserRuntimeSnapshot & {
  snapshotId: string;
  readyState: string;
  elements: BrowserElementRef[];
  fields: BrowserElementRef[];
  observation: BrowserObservation;
};

export type BrowserActionabilityCheck = {
  ok: boolean;
  reason?: string;
  reasons?: string[];
  x?: number;
  y?: number;
  rect?: { x: number; y: number; width: number; height: number };
};

export type BrowserVerification = {
  ok: boolean;
  reason?: string;
  before?: unknown;
  after?: unknown;
};

export type BrowserWaitCondition = {
  type: "dom_stable" | "text_present" | "text_gone" | "url_changed" | "title_changed" | "result_count";
  text?: string;
  previousUrl?: string;
  previousTitle?: string;
  count?: number;
  timeoutMs?: number;
};

export type BrowserFieldInput = {
  field?: string;
  label?: string;
  elementRef?: string;
  value: string;
};

export type BrowserAutofillInput = {
  instruction?: string;
  skill?: string;
  submit?: boolean;
  allowSensitive?: boolean;
};

type ElementRefPayload = {
  selector?: string;
  text?: string;
  label?: string;
  tagName?: string;
  role?: string;
};

const OBSERVE_CLICKABLES_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const visible = (element) => {
    if (!element || element === document.documentElement || element === document.body) return false;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
  };
  const interactive = (element) => {
    const tag = element.tagName;
    const role = (element.getAttribute("role") || "").toLowerCase();
    const className = String(element.className || "").toLowerCase();
    const style = getComputedStyle(element);
    return (
      ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "LABEL"].includes(tag) ||
      Boolean(element.onclick) ||
      /button|link|menuitem|tab|option|checkbox|radio/.test(role) ||
      element.hasAttribute("tabindex") ||
      style.cursor === "pointer" ||
      /btn|button|item|card|cell|menu|link|flow|app|entry/.test(className)
    );
  };
  const actionElementFor = (element) => {
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (visible(current) && interactive(current)) return current;
      current = current.parentElement;
    }
    return element;
  };
  const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,label,[role],[tabindex],[onclick],div,span,li,td"));
  const candidates = [];
  const seen = new Set();
  for (const element of elements) {
    if (!visible(element)) continue;
    const ownText = normalize(element.innerText || element.textContent || "");
    const ariaLabel = normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || "");
    const text = ownText || ariaLabel;
    if (!text || text.length > 160) continue;
    const actionElement = actionElementFor(element);
    if (!visible(actionElement)) continue;
    const rect = actionElement.getBoundingClientRect();
    if (rect.width > Math.max(900, innerWidth * 0.85) && rect.height > 260) continue;
    const key = [text, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      index: candidates.length,
      text,
      tagName: actionElement.tagName,
      role: actionElement.getAttribute("role") || "",
      ariaLabel,
      x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      width: rect.width,
      height: rect.height,
      interactive: interactive(actionElement)
    });
    if (candidates.length >= 220) break;
  }
  return candidates;
})()`;

const READ_PAGE_CONTEXT_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const readMetaDescription = () => {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return normalize(meta?.getAttribute("content") || "");
  };
  return {
    url: String(location.href || ""),
    title: normalize(document.title || ""),
    selectedText: normalize(getSelection()?.toString() || "").slice(0, 8000),
    metaDescription: readMetaDescription(),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => normalize(node.textContent || ""))
      .filter(Boolean)
      .slice(0, 24),
    bodyText: normalize(document.body?.innerText || "").slice(0, 40000)
  };
})()`;

const OBSERVE_PAGE_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const sensitivePattern = /(提交订单|确认支付|支付|付款|删除|移除|清空|授权|同意|批准|保存|登录|登陆|注册|退出|注销|开通|签署|签章)/;
  const visible = (element) => {
    if (!element || element === document.documentElement || element === document.body) return false;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
  };
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  };
  const selectorFor = (element) => {
    if (element.id) return "#" + cssEscape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.classList && current.classList.length > 0) {
        part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) {
          part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(" > ");
  };
  const refFor = (element, label, text) => JSON.stringify({
    selector: selectorFor(element),
    text: normalize(text).slice(0, 120),
    label: normalize(label).slice(0, 120),
    tagName: element.tagName,
    role: element.getAttribute("role") || ""
  });
  const formLabelFor = (element) => {
    const item = element.closest('.el-form-item,.ant-form-item,.arco-form-item,.semi-form-field,.form-item,.form-group,[class*="form-item"],[class*="FormItem"]');
    if (!item) return "";
    const label = item.querySelector('.el-form-item__label,.ant-form-item-label label,.arco-form-item-label,.semi-form-field-label,label,[class*="label"],[class*="Label"]');
    return normalize(label?.textContent || "").replace(/^\\*\\s*/, "");
  };
  const labelFor = (element) => {
    const formLabel = formLabelFor(element);
    if (formLabel) return formLabel;
    const direct = normalize(
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("name") ||
      element.getAttribute("placeholder") ||
      element.id ||
      ""
    );
    if (direct) return direct;
    if (element.labels && element.labels.length > 0) {
      const labelText = normalize(Array.from(element.labels).map((label) => label.textContent || "").join(" "));
      if (labelText) return labelText;
    }
    if (element.id) {
      const label = document.querySelector('label[for="' + cssEscape(element.id) + '"]');
      const labelText = normalize(label?.textContent || "");
      if (labelText) return labelText;
    }
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1) {
      if (parent.tagName === "LABEL") {
        const text = normalize(parent.textContent || "");
        if (text) return text;
      }
      parent = parent.parentElement;
    }
    return normalize(element.textContent || element.value || element.tagName);
  };
  const isCustomSelect = (element) => {
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const container = element.closest('.el-select,.ant-select,.arco-select,.semi-select,[role="combobox"],[class*="select"],[class*="Select"]');
    return role === "combobox" || Boolean(container);
  };
  const fieldKind = (element) => {
    const tag = element.tagName;
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "SELECT" || isCustomSelect(element)) return "select";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable || element.getAttribute("role") === "textbox") return "input";
    return "other";
  };
  const isEditable = (element) => {
    const tag = element.tagName;
    if (tag === "INPUT") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (element.readOnly && isCustomSelect(element)) return true;
      return !["hidden", "button", "submit", "reset", "file", "image"].includes(type);
    }
    return tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable || element.getAttribute("role") === "textbox";
  };
  const interactive = (element) => {
    const tag = element.tagName;
    const role = (element.getAttribute("role") || "").toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const style = getComputedStyle(element);
    return (
      ["A", "BUTTON", "SUMMARY", "LABEL", "SELECT"].includes(tag) ||
      (tag === "INPUT" && ["button", "submit", "reset", "checkbox", "radio"].includes(type)) ||
      Boolean(element.onclick) ||
      /button|link|menuitem|tab|option|checkbox|radio/.test(role) ||
      style.cursor === "pointer"
    );
  };
  const optionList = (element) => {
    if (element.tagName !== "SELECT") {
      const placeholder = normalize(element.getAttribute("placeholder") || "");
      if (!isCustomSelect(element) || !/[\\/／、,，]/.test(placeholder)) return [];
      return placeholder.split(/[\\/／、,，]/).map((item) => normalize(item)).filter(Boolean).slice(0, 20).map((label) => ({
        value: label,
        label,
        selected: false
      }));
    }
    return Array.from(element.options || []).slice(0, 80).map((option) => ({
      value: String(option.value || ""),
      label: normalize(option.textContent || option.label || option.value || ""),
      selected: Boolean(option.selected)
    }));
  };

  const fields = [];
  const fieldSeen = new Set();
  for (const element of Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'))) {
    if (!isEditable(element) || !visible(element) || element.disabled || (element.readOnly && !isCustomSelect(element))) continue;
    const rect = element.getBoundingClientRect();
    const label = labelFor(element);
    const type = String(element.getAttribute("type") || element.tagName).toLowerCase();
    const item = element.closest('.el-form-item,.ant-form-item,.arco-form-item,.semi-form-field,.form-item,.form-group,[class*="form-item"],[class*="FormItem"]');
    const required = Boolean(
      element.required ||
      element.getAttribute("aria-required") === "true" ||
      item?.className?.toString?.().includes("required") ||
      /^\\*/.test(normalize(item?.textContent || ""))
    );
    const key = selectorFor(element);
    if (fieldSeen.has(key)) continue;
    fieldSeen.add(key);
    fields.push({
      index: fields.length,
      elementRef: refFor(element, label, ""),
      label,
      tagName: element.tagName,
      type,
      role: element.getAttribute("role") || "",
      value: normalize(element.value || element.textContent || ""),
      placeholder: normalize(element.getAttribute("placeholder") || ""),
      required,
      checked: Boolean(element.checked),
      options: optionList(element),
      x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      width: rect.width,
      height: rect.height
    });
    if (fields.length >= 160) break;
  }

  const elements = [];
  const seen = new Set();
  for (const element of Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,label,[role],[tabindex],[onclick],div,span,li,td"))) {
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > Math.max(900, innerWidth * 0.9) && rect.height > 280) continue;
    const label = labelFor(element);
    const text = normalize(element.innerText || element.textContent || label);
    const ariaLabel = normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || "");
    if (!text && !ariaLabel) continue;
    const kind = fieldKind(element);
    if (!interactive(element) && kind === "other" && text.length > 80) continue;
    const key = [selectorFor(element), text, Math.round(rect.left), Math.round(rect.top)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({
      index: elements.length,
      elementRef: refFor(element, label, text || ariaLabel),
      kind: kind === "other"
        ? (element.tagName === "A" ? "link" : element.tagName === "BUTTON" ? "button" : "other")
        : kind,
      text: (text || ariaLabel).slice(0, 180),
      tagName: element.tagName,
      role: element.getAttribute("role") || "",
      ariaLabel,
      x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      width: rect.width,
      height: rect.height,
      interactive: interactive(element) || kind !== "other",
      unsafe: sensitivePattern.test([text, ariaLabel, label].join(" "))
    });
    if (elements.length >= 220) break;
  }

  return {
    ok: true,
    action: "observe",
    url: String(location.href || ""),
    title: normalize(document.title || ""),
    bodyText: normalize(document.body?.innerText || "").slice(0, 12000),
    elements,
    fields
  };
})()`;

const FIND_ELEMENT_HELPERS_SCRIPT = `
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseRef = (value) => {
    if (!value || typeof value !== "string") return {};
    try { return JSON.parse(value); } catch { return { selector: value }; }
  };
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
  };
  const formLabelFor = (element) => {
    const item = element.closest('.el-form-item,.ant-form-item,.arco-form-item,.semi-form-field,.form-item,.form-group,[class*="form-item"],[class*="FormItem"]');
    if (!item) return "";
    const label = item.querySelector('.el-form-item__label,.ant-form-item-label label,.arco-form-item-label,.semi-form-field-label,label,[class*="label"],[class*="Label"]');
    return normalize(label?.textContent || "").replace(/^\\*\\s*/, "");
  };
  const labelFor = (element) => {
    const formLabel = formLabelFor(element);
    if (formLabel) return formLabel;
    const direct = normalize(
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("name") ||
      element.getAttribute("placeholder") ||
      element.id ||
      ""
    );
    if (direct) return direct;
    if (element.labels && element.labels.length > 0) {
      const labelText = normalize(Array.from(element.labels).map((label) => label.textContent || "").join(" "));
      if (labelText) return labelText;
    }
    return normalize(element.textContent || element.value || element.tagName);
  };
  const isCustomSelect = (element) => {
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const container = element.closest('.el-select,.ant-select,.arco-select,.semi-select,[role="combobox"],[class*="select"],[class*="Select"]');
    return role === "combobox" || Boolean(container);
  };
  const matchesText = (element, target) => {
    if (!target) return false;
    const normalizedTarget = normalize(target).toLowerCase();
    const haystack = [
      labelFor(element),
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      element.id,
      element.value
    ].map(normalize).join(" ").toLowerCase();
    if (!haystack) return false;
    return haystack.includes(normalizedTarget) || normalizedTarget.includes(haystack);
  };
  const findElement = (input, selector) => {
    const ref = parseRef(input?.elementRef || input?.field || input?.target || "");
    const candidates = [];
    if (ref.selector) {
      try {
        const element = document.querySelector(ref.selector);
        if (element && visible(element)) candidates.push(element);
      } catch {}
    }
    const target = input?.label || input?.field || input?.target || ref.label || ref.text || "";
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (visible(element) && matchesText(element, target)) candidates.push(element);
    }
    return candidates[0] || null;
  };
`;

const SET_FIELD_SCRIPT = `async (input) => {
  ${FIND_ELEMENT_HELPERS_SCRIPT}
  const element = findElement(input, 'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]');
  if (!element) return { ok: false, message: "没有找到匹配的字段。" };
  const value = String(input.value ?? "");
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus({ preventScroll: true });
  if (element.tagName === "SELECT") {
    const option = Array.from(element.options || []).find((item) =>
      normalize(item.value) === normalize(value) || normalize(item.textContent || item.label) === normalize(value)
    );
    if (!option) return { ok: false, message: "没有找到匹配的下拉选项。" };
    element.value = option.value;
  } else if (isCustomSelect(element) && (element.readOnly || element.getAttribute("role") === "combobox")) {
    const trigger = element.closest('.el-select,.ant-select,.arco-select,.semi-select,[role="combobox"],[class*="select"],[class*="Select"]') || element;
    trigger.scrollIntoView({ block: "center", inline: "center" });
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const normalizedValue = normalize(value).toLowerCase();
    const options = Array.from(document.querySelectorAll('[role="option"],.el-select-dropdown__item,.ant-select-item-option,.arco-select-option,.semi-select-option,[class*="select-option"],[class*="SelectOption"],[class*="dropdown-item"],[class*="DropdownItem"]'))
      .filter((option) => visible(option))
      .map((option) => ({
        option,
        text: normalize(option.innerText || option.textContent || option.getAttribute("title") || option.getAttribute("aria-label") || "")
      }))
      .filter((item) => item.text && item.text.length <= 120);
    const match = options.find((item) => item.text.toLowerCase() === normalizedValue)
      || options.find((item) => item.text.toLowerCase().includes(normalizedValue) || normalizedValue.includes(item.text.toLowerCase()));
    if (!match) {
      return {
        ok: false,
        message: "没有找到匹配的下拉选项。",
        options: options.slice(0, 12).map((item) => item.text)
      };
    }
    match.option.scrollIntoView({ block: "center", inline: "center" });
    match.option.click();
    return { ok: true, label: labelFor(element), value: match.text };
  } else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else {
    element.textContent = value;
  }
  try {
    window.__zenmindLastFilledElement = element;
    element.setAttribute("data-zenmind-last-filled", "true");
  } catch {}
  element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: labelFor(element), value };
}`;

const SET_CHECKED_SCRIPT = `(input) => {
  ${FIND_ELEMENT_HELPERS_SCRIPT}
  const element = findElement(input, 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]');
  if (!element) return { ok: false, message: "没有找到匹配的选项。" };
  const checked = Boolean(input.checked);
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus({ preventScroll: true });
  if ("checked" in element) {
    element.checked = checked;
  } else {
    element.setAttribute("aria-checked", checked ? "true" : "false");
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: labelFor(element), checked };
}`;

const SUBMIT_SCRIPT = `(input) => {
  ${FIND_ELEMENT_HELPERS_SCRIPT}
  const compact = (value) => normalize(value).replace(/[，,。.!！?？:：;；"'“”‘’「」『』（）()【】\\[\\]<>《》]/g, "").toLowerCase();
  const targetText = normalize(input?.target || "");
  const compactTarget = compact(targetText || "搜索");
  const genericSearchTarget = !targetText || /^(搜索|搜一下|查询|检索|百度一下|search)$/i.test(compactTarget);
  const forbiddenSubmitPattern = /(图片|图像|按图|搜图|识图|以图|相机|拍照|上传|附件|文件|语音|麦克风|清除|清空|关闭|删除|image\\s*search|visual\\s*search|image|camera|photo|upload|attach|file|voice|mic|clear|close)/i;
  const positiveSubmitPattern = /^(搜索|搜一下|查询|检索|百度一下|提交|确定|确认|search|submit|ok)$/i;
  const selectors = 'button, input[type="submit"], input[type="button"], [role="button"], a';

  const textFor = (element) => normalize(
    element.value ||
    element.innerText ||
    element.textContent ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    labelFor(element)
  );
  const isEditable = (element) => {
    if (!element || !visible(element) || element.disabled || element.readOnly) return false;
    const tag = element.tagName;
    if (tag === "INPUT") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      return !["hidden", "button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
    }
    return tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable || element.getAttribute("role") === "textbox";
  };
  const resolveLastFilledElement = () => {
    const remembered = window.__zenmindLastFilledElement;
    if (isEditable(remembered)) return remembered;
    const marked = document.querySelector("[data-zenmind-last-filled='true']");
    if (isEditable(marked)) return marked;
    return null;
  };
  const active = document.activeElement;
  const baseInput = isEditable(active) ? active : resolveLastFilledElement();
  if (baseInput) {
    try { baseInput.focus({ preventScroll: true }); } catch { baseInput.focus(); }
  }

  const candidates = [];
  const ref = parseRef(input?.elementRef || "");
  if (ref.selector) {
    try {
      const element = document.querySelector(ref.selector);
      if (element && visible(element)) candidates.push(element);
    } catch {}
  }
  for (const element of Array.from(document.querySelectorAll(selectors))) {
    if (visible(element)) candidates.push(element);
  }

  let best = null;
  const baseRect = baseInput?.getBoundingClientRect?.();
  for (const candidate of candidates) {
    const label = textFor(candidate);
    const compactLabel = compact(label);
    const attrs = [
      label,
      labelFor(candidate),
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("title"),
      candidate.getAttribute("name"),
      candidate.id,
      candidate.className,
      candidate.getAttribute("type"),
      candidate.getAttribute("role")
    ].map(normalize).join(" ");
    if (!compactLabel && !attrs) continue;
    if (genericSearchTarget && forbiddenSubmitPattern.test(attrs)) continue;

    let score = 0;
    const exactRef = Boolean(ref.selector && candidate.matches?.(ref.selector));
    const type = String(candidate.getAttribute("type") || "").toLowerCase();
    const tag = candidate.tagName;
    const role = String(candidate.getAttribute("role") || "").toLowerCase();
    let submitIntent = exactRef || type === "submit";
    if (exactRef) score += 900;
    if (compactLabel === compactTarget) {
      score += 700;
      submitIntent = true;
    } else if (compactLabel.includes(compactTarget) || compactTarget.includes(compactLabel)) {
      score += genericSearchTarget ? 180 : 380;
      submitIntent = true;
    }
    if (positiveSubmitPattern.test(compactLabel)) {
      score += 520;
      submitIntent = true;
    }
    if (type === "submit") score += 360;
    if (tag === "BUTTON") score += 260;
    if (role === "button") score += 160;
    if (baseInput?.form && candidate.form && baseInput.form === candidate.form) {
      score += 320;
      submitIntent = true;
    }
    if (baseRect) {
      const rect = candidate.getBoundingClientRect();
      const baseCenterY = baseRect.top + baseRect.height / 2;
      const candidateCenterY = rect.top + rect.height / 2;
      const verticallyAligned = Math.abs(candidateCenterY - baseCenterY) <= Math.max(28, baseRect.height);
      if (verticallyAligned && rect.left >= baseRect.left - 4) {
        score += 180;
        submitIntent = true;
      }
      if (rect.width < 34 && rect.height < 34 && genericSearchTarget) score -= 160;
    }
    if (forbiddenSubmitPattern.test(attrs)) score -= 900;
    if (genericSearchTarget && !submitIntent) continue;

    if (!best || score > best.score) {
      best = { element: candidate, score, label };
    }
  }

  if (best && best.score >= 420) {
    const rect = best.element.getBoundingClientRect();
    return {
      ok: true,
      mode: "click",
      label: best.label || labelFor(best.element),
      x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  }

  if (baseInput) {
    return { ok: true, mode: "enter", label: "Enter" };
  }
  return { ok: true, mode: "enter", label: "Enter" };
}`;

const FILL_BEST_INPUT_SCRIPT = `(value) => {
  const normalize = (text) => String(text || "").replace(/\\s+/g, " ").trim();
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 20 || rect.height < 12) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
  };
  const isEditable = (element) => {
    const tag = element.tagName;
    if (tag === "INPUT") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      return !["hidden", "button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
    }
    return tag === "TEXTAREA" || element.isContentEditable || element.getAttribute("role") === "textbox";
  };
  const describe = (element) => normalize(
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("title") ||
    element.getAttribute("name") ||
    element.id ||
    element.tagName
  );
  const score = (element) => {
    const rect = element.getBoundingClientRect();
    const descriptor = [describe(element), element.id, element.getAttribute("name"), element.className, element.getAttribute("type")]
      .map((item) => normalize(item).toLowerCase())
      .join(" ");
    let nextScore = Math.min(900, rect.width * rect.height / 30);
    if (element === document.activeElement) nextScore += 1200;
    if (/search|wd|query|keyword|关键词|搜索|输入/.test(descriptor)) nextScore += 700;
    if (String(element.getAttribute("type") || "").toLowerCase() === "search") nextScore += 400;
    if (rect.width > 260) nextScore += 180;
    return nextScore;
  };
  const candidates = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'))
    .filter((element) => isEditable(element) && isVisible(element) && !element.disabled && !element.readOnly)
    .sort((left, right) => score(right) - score(left));
  const element = candidates[0];
  if (!element) {
    return { ok: false, message: "当前页面没有找到可输入的文本框。" };
  }

  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus({ preventScroll: true });
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  }

  return { ok: true, inputLabel: describe(element) };
}`;

const READ_HTML_SCRIPT = `(() => [
  String(document.body?.innerText || ""),
  "<!--ZENMIND_HTML_SOURCE-->",
  String(document.documentElement?.outerHTML || "")
].join("\\n"))()`;

const READ_READY_STATE_SCRIPT = `(() => String(document.readyState || ""))()`;

const ACTIONABILITY_SCRIPT = `(input) => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseRef = (value) => {
    if (!value || typeof value !== "string") return {};
    try { return JSON.parse(value); } catch { return { selector: value }; }
  };
  const ref = parseRef(input?.rawElementRef || input?.elementRef || "");
  const selector = input?.selector || ref.selector || "";
  let element = null;
  if (selector) {
    try { element = document.querySelector(selector); } catch {}
  }
  if (!element) {
    return { ok: false, reason: "not_found", reasons: ["元素已不在当前 DOM 中"] };
  }
  const rect = element.getBoundingClientRect();
  const reasons = [];
  if (!rect || rect.width < 4 || rect.height < 4) reasons.push("元素尺寸过小或不可见");
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) reasons.push("元素不在当前视口内");
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0.05) reasons.push("元素隐藏");
  if (element.disabled || element.getAttribute("aria-disabled") === "true") reasons.push("元素 disabled");
  const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
  const topElement = document.elementFromPoint(x, y);
  if (topElement && topElement !== element && !element.contains(topElement) && !topElement.contains(element)) {
    reasons.push("元素中心点被 " + normalize(topElement.getAttribute("aria-label") || topElement.id || topElement.className || topElement.tagName) + " 遮挡");
  }
  return {
    ok: reasons.length === 0,
    reason: reasons.length > 0 ? (reasons.some((reason) => /遮挡/.test(reason)) ? "covered" : "not_actionable") : "",
    reasons,
    x,
    y,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  };
}`;

function getElectronWebContents() {
  const electron = require("electron") as typeof import("electron");
  return electron.webContents;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function browserErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isTransientBrowserContextError(error: unknown) {
  return /Cannot find default execution context|Execution context was destroyed|Cannot find context with specified id|context.*destroyed|target.*(?:closed|navigat)|frame.*(?:detached|navigat)|页面.*导航|上下文.*销毁/iu.test(browserErrorMessage(error));
}

async function withDebugger<T>(contents: WebContentsLike, task: (debuggerApi: DebuggerLike) => Promise<T>) {
  const debuggerApi = contents.debugger;
  const shouldDetach = !debuggerApi.isAttached();
  if (shouldDetach) {
    debuggerApi.attach("1.3");
  }

  try {
    return await task(debuggerApi);
  } finally {
    if (shouldDetach && debuggerApi.isAttached()) {
      debuggerApi.detach();
    }
  }
}

async function evaluateWithCDP<T>(contents: WebContentsLike, expression: string, maxAttempts = 3): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withDebugger(contents, async (debuggerApi) => {
        const result = await debuggerApi.sendCommand("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true
        }) as {
          result?: { value?: T };
          exceptionDetails?: {
            text?: string;
            exception?: {
              description?: string;
              value?: unknown;
            };
          };
        };

        if (result.exceptionDetails) {
          const details = [
            result.exceptionDetails.exception?.description,
            result.exceptionDetails.exception?.value,
            result.exceptionDetails.text
          ].filter((item) => item !== undefined && item !== null && String(item).trim())
            .map((item) => String(item).trim());
          throw new Error(details[0] || "网页脚本执行失败。");
        }

        return result.result?.value as T;
      });
    } catch (error) {
      lastError = error;
      if (!isTransientBrowserContextError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await delay(180 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("网页脚本执行失败。");
}

async function dispatchClickWithCDP(contents: WebContentsLike, x: number, y: number) {
  await withDebugger(contents, async (debuggerApi) => {
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y
    });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1
    });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1
    });
  });
}

async function dispatchEnterWithCDP(contents: WebContentsLike) {
  await withDebugger(contents, async (debuggerApi) => {
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  });
}

function buildFillInputExpression(value: string) {
  return `(${FILL_BEST_INPUT_SCRIPT})(${JSON.stringify(value)})`;
}

function buildUnaryExpression(script: string, input: unknown) {
  return `(${script})(${JSON.stringify(input)})`;
}

function parseElementRef(value: string | undefined): ElementRefPayload {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ElementRefPayload : {};
  } catch {
    return {
      selector: value
    };
  }
}

function fieldScore(field: BrowserObservedField, target: string) {
  const normalizedTarget = normalizeBrowserText(target);
  const candidates = [
    field.label,
    field.placeholder,
    field.type,
    field.role,
    parseElementRef(field.elementRef).label ?? "",
    parseElementRef(field.elementRef).text ?? ""
  ].map(normalizeBrowserText).filter(Boolean);
  if (!normalizedTarget || candidates.length === 0) {
    return 0;
  }

  let score = 0;
  for (const candidate of candidates) {
    if (candidate === normalizedTarget) {
      score = Math.max(score, 1000);
    } else if (candidate.includes(normalizedTarget)) {
      score = Math.max(score, 820 - Math.min(160, candidate.length - normalizedTarget.length));
    } else if (normalizedTarget.includes(candidate)) {
      score = Math.max(score, 700 - Math.min(160, normalizedTarget.length - candidate.length));
    }
  }
  if (field.width > 220) {
    score += 80;
  }
  return score;
}

function chooseBestField(fields: BrowserObservedField[], target: string) {
  let best: { field: BrowserObservedField; score: number } | null = null;
  for (const field of fields) {
    const score = fieldScore(field, target);
    if (!best || score > best.score) {
      best = { field, score };
    }
  }
  return best && best.score >= 220 ? best.field : null;
}

function parseAutofillHints(skill: string | undefined) {
  const hints = new Map<string, string>();
  if (!skill?.trim()) {
    return hints;
  }
  try {
    const parsed = JSON.parse(skill) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          hints.set(normalizeBrowserText(key), String(value));
        }
      }
    }
  } catch {
    // Plain text skills are parsed below.
  }

  for (const line of skill.split(/\r?\n/u)) {
    const match = line.match(/^\s*[-*]?\s*([^:=：=]+?)\s*[:=：]\s*(.+?)\s*$/u);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    hints.set(normalizeBrowserText(match[1]), match[2].trim());
  }
  return hints;
}

function findAutofillHint(field: BrowserObservedField, hints: Map<string, string>) {
  if (hints.size === 0) {
    return null;
  }
  const fieldKeys = [
    field.label,
    field.placeholder,
    field.type,
    parseElementRef(field.elementRef).label ?? "",
    parseElementRef(field.elementRef).text ?? ""
  ].map(normalizeBrowserText).filter(Boolean);
  for (const [hintKey, value] of hints) {
    if (fieldKeys.some((fieldKey) => fieldKey === hintKey || fieldKey.includes(hintKey) || hintKey.includes(fieldKey))) {
      return value;
    }
  }
  return null;
}

function inferSystemName(observation: BrowserObservation, instruction: string | undefined) {
  const source = [
    instruction,
    observation.title,
    observation.bodyText.slice(0, 2000)
  ].filter(Boolean).join(" ");
  const direct = source.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:系统|平台|CRM|crm))/u)?.[1];
  if (direct) {
    return direct;
  }
  return "业务系统";
}

function chooseAutofillOption(field: BrowserObservedField, desired: string) {
  const normalizedDesired = normalizeBrowserText(desired);
  const options = field.options.filter((option) => option.label || option.value);
  if (options.length === 0) {
    return desired;
  }
  const exact = options.find((option) =>
    normalizeBrowserText(option.label) === normalizedDesired ||
    normalizeBrowserText(option.value) === normalizedDesired
  );
  if (exact) {
    return exact.value || exact.label;
  }
  const fuzzy = options.find((option) => {
    const label = normalizeBrowserText(`${option.label}${option.value}`);
    return label.includes(normalizedDesired) || normalizedDesired.includes(label);
  });
  if (fuzzy) {
    return fuzzy.value || fuzzy.label;
  }
  const openOption = options.find((option) => /开通|新增|申请|普通|默认|是|同意/u.test(`${option.label}${option.value}`));
  return openOption?.value || openOption?.label || options[0].value || options[0].label || desired;
}

function inferAutofillValue(field: BrowserObservedField, observation: BrowserObservation, input: BrowserAutofillInput | undefined, hints: Map<string, string>) {
  const hint = findAutofillHint(field, hints);
  if (hint) {
    return chooseAutofillOption(field, hint);
  }

  const label = `${field.label} ${field.placeholder}`;
  const normalizedLabel = normalizeBrowserText(label);
  const systemName = inferSystemName(observation, input?.instruction);
  if (field.options.length > 0 || field.type === "select" || field.role === "combobox") {
    if (/申请类型|操作类型|开通|变更|关闭/u.test(label)) {
      return chooseAutofillOption(field, "开通");
    }
    if (/系统类型|系统名称|所属系统|应用系统/u.test(label)) {
      return chooseAutofillOption(field, systemName);
    }
    return chooseAutofillOption(field, "开通");
  }

  if (/岗位|职位|职务/u.test(label)) {
    return "客户经理";
  }
  if (/姓名|名字|联系人/u.test(label)) {
    return "张三";
  }
  if (/手机|电话|联系方式/u.test(label)) {
    return "13800138000";
  }
  if (/邮箱|邮件/u.test(label)) {
    return "test@example.com";
  }
  if (/部门|分支|机构/u.test(label)) {
    return "信息技术部";
  }
  if (/权限范围|权限|范围|报表需求|需求/u.test(label)) {
    return `申请开通${systemName}相关权限，用于日常业务处理、客户需求跟进和报表查看。`;
  }
  if (/原因|用途|说明|备注|描述/u.test(label)) {
    return `因工作需要使用${systemName}处理客户需求和营销管理相关事项，申请开通对应权限。`;
  }
  if (/意见|审批意见|处理意见/u.test(label)) {
    return "同意按工作需要开通相关权限。";
  }
  if (/日期|时间/u.test(label)) {
    return new Date().toISOString().slice(0, 10);
  }
  if (normalizedLabel.includes("url") || /链接|网址/u.test(label)) {
    return "https://example.com";
  }
  return "测试信息";
}

function shouldAutofillField(field: BrowserObservedField) {
  const label = `${field.label} ${field.placeholder}`;
  if (/附件|上传|文件|图片|验证码|密码|口令|签名|签署|保密协议|模板/u.test(label)) {
    return false;
  }
  if (field.value && normalizeBrowserText(field.value) !== normalizeBrowserText(field.placeholder)) {
    return false;
  }
  return field.tagName === "INPUT" || field.tagName === "TEXTAREA" || field.tagName === "SELECT" || field.role === "combobox";
}

function buildAutofillFields(observation: BrowserObservation, input: BrowserAutofillInput | undefined) {
  const hints = parseAutofillHints(input?.skill);
  const fields: BrowserFieldInput[] = [];
  for (const field of observation.fields) {
    if (!shouldAutofillField(field)) {
      continue;
    }
    fields.push({
      elementRef: field.elementRef,
      label: field.label,
      value: inferAutofillValue(field, observation, input, hints)
    });
  }
  return fields;
}

function isGenericSearchSubmitTarget(target: string) {
  return /^(搜索|搜一下|查询|检索|百度一下|search)$/iu.test(normalizeBrowserText(target));
}

async function waitForPageSettle(contents: WebContentsLike, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableCount = 0;
  let sawReadableState = false;
  let lastTransientError: unknown = null;

  await delay(500);
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = await evaluateWithCDP<{
        readyState: string;
        url: string;
        title: string;
        textLength: number;
        loadingText: boolean;
      }>(contents, `(() => {
        const text = String(document.body?.innerText || "");
        return {
          readyState: document.readyState,
          url: location.href,
          title: document.title,
          textLength: text.length,
          loadingText: /页面加载中|loading/i.test(text.slice(0, 200))
        };
      })()`);
      sawReadableState = true;
      const signature = `${state.url}|${state.title}|${state.textLength}`;
      if (state.readyState !== "loading" && !state.loadingText && state.textLength > 20 && signature === lastSignature) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      if (stableCount >= 2) {
        return;
      }
      lastSignature = signature;
    } catch (error) {
      if (isTransientBrowserContextError(error)) {
        lastTransientError = error;
      }
      stableCount = 0;
    }
    await delay(450);
  }
  if (!sawReadableState && lastTransientError) {
    throw new Error(`page_context_not_ready: ${browserErrorMessage(lastTransientError)}`);
  }
}

export class BrowserUseController {
  private readonly refStore = new Map<string, BrowserElementRef>();
  private snapshotCounter = 0;

  constructor(private readonly options: BrowserUseControllerOptions = {}) {}

  private getWebContents(webContentsId: number): WebContentsLike {
    const resolved = this.options.resolveWebContents?.(webContentsId);
    if (resolved && !resolved.isDestroyed()) {
      return resolved;
    }
    const contents = getElectronWebContents().fromId(webContentsId) as WebContentsLike | undefined;
    if (!contents || contents.isDestroyed()) {
      throw new Error("当前网页已经不可操作，请刷新或重新打开页面。");
    }
    return contents;
  }

  async observeClickableElements(webContentsId: number) {
    const contents = this.getWebContents(webContentsId);
    return evaluateWithCDP<BrowserElementCandidate[]>(contents, OBSERVE_CLICKABLES_SCRIPT);
  }

  private refStoreKey(webContentsId: number, ref: string) {
    return `${webContentsId}:${ref}`;
  }

  private pageSignature(contents: WebContentsLike, fallback?: { url?: string; title?: string }) {
    return {
      url: fallback?.url || contents.getURL(),
      title: fallback?.title || contents.getTitle?.() || ""
    };
  }

  private rememberRefs(webContentsId: number, refs: BrowserElementRef[]) {
    for (const ref of refs) {
      this.refStore.set(this.refStoreKey(webContentsId, ref.ref), ref);
    }
  }

  private getStoredRef(webContentsId: number, ref: string | undefined) {
    if (!ref || !ref.startsWith("@")) {
      return null;
    }
    return this.refStore.get(this.refStoreKey(webContentsId, ref)) ?? null;
  }

  private isStoredRefStale(contents: WebContentsLike, ref: BrowserElementRef) {
    const current = this.pageSignature(contents);
    return current.url !== ref.pageSignature.url || current.title !== ref.pageSignature.title;
  }

  private buildElementRefs(
    snapshotId: string,
    contents: WebContentsLike,
    observation: BrowserObservation
  ) {
    const signature = this.pageSignature(contents, observation);
    const toRef = (
      prefix: "@e" | "@f",
      item: BrowserObservedElement | BrowserObservedField,
      index: number,
      kind: BrowserElementRef["kind"]
    ): BrowserElementRef => {
      const raw = parseElementRef(item.elementRef);
      const text = "text" in item ? item.text : "";
      const label = "label" in item ? item.label : raw.label;
      const selector = raw.selector;
      const bounds = {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height
      };
      const ref = `${prefix}${index + 1}`;
      return {
        ref,
        snapshotId,
        rawElementRef: item.elementRef,
        selector,
        text,
        label,
        tagName: item.tagName,
        role: item.role,
        kind,
        unsafe: "unsafe" in item ? item.unsafe : false,
        bounds,
        pageSignature: signature,
        fingerprint: [
          selector,
          normalizeBrowserText(text || ""),
          normalizeBrowserText(label || ""),
          Math.round(bounds.x),
          Math.round(bounds.y),
          Math.round(bounds.width),
          Math.round(bounds.height)
        ].join("|")
      };
    };
    const elements = observation.elements.map((element, index) => toRef("@e", element, index, element.kind));
    const fields = observation.fields.map((field, index) => toRef("@f", field, index, "field"));
    return { elements, fields };
  }

  private applySnapshotRefs(observation: BrowserObservation, refs: { elements: BrowserElementRef[]; fields: BrowserElementRef[] }) {
    return {
      ...observation,
      elements: observation.elements.map((element, index) => ({
        ...element,
        elementRef: refs.elements[index]?.ref || element.elementRef,
        ref: refs.elements[index]?.ref,
        selector: refs.elements[index]?.selector
      })),
      fields: observation.fields.map((field, index) => ({
        ...field,
        elementRef: refs.fields[index]?.ref || field.elementRef,
        ref: refs.fields[index]?.ref,
        selector: refs.fields[index]?.selector
      }))
    };
  }

  async observePageRaw(webContentsId: number): Promise<BrowserObservation> {
    const contents = this.getWebContents(webContentsId);
    const observation = await evaluateWithCDP<BrowserObservation>(contents, OBSERVE_PAGE_SCRIPT);
    return {
      ok: true,
      action: "observe",
      url: typeof observation?.url === "string" ? observation.url : contents.getURL(),
      title: typeof observation?.title === "string" ? observation.title : "",
      bodyText: typeof observation?.bodyText === "string" ? observation.bodyText : "",
      elements: Array.isArray(observation?.elements) ? observation.elements : [],
      fields: Array.isArray(observation?.fields) ? observation.fields : []
    };
  }

  async navigateUrl(webContentsId: number, input: { url: string; label?: string }): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const targetUrl = String(input.url || "").trim();
    if (!targetUrl) {
      return {
        ok: false,
        action: "navigate",
        error: "missing_url",
        message: "缺少要打开的网址。"
      };
    }

    await withDebugger(contents, async (debuggerApi) => {
      await debuggerApi.sendCommand("Page.enable").catch(() => undefined);
      await debuggerApi.sendCommand("Page.navigate", { url: targetUrl });
    });
    await waitForPageSettle(contents, 9000).catch(() => undefined);

    const pageContext = await this.readPageContext(webContentsId).catch(() => null);
    return {
      ok: true,
      action: "navigate",
      target: targetUrl,
      url: pageContext?.url || contents.getURL(),
      title: pageContext?.title || contents.getTitle?.() || "",
      message: `已在当前网页打开${input.label || targetUrl}。`
    };
  }

  async snapshotPage(webContentsId: number): Promise<BrowserActionSnapshot> {
    const contents = this.getWebContents(webContentsId);
    const snapshotId = `snap_${Date.now().toString(36)}_${(this.snapshotCounter += 1).toString(36)}`;
    const [observationResult, pageContextResult, accessibilityResult, domSnapshotResult] = await Promise.allSettled([
      this.observePageRaw(webContentsId),
      this.readPageContext(webContentsId),
      this.readAccessibilitySnapshot(webContentsId),
      withDebugger(contents, async (debuggerApi) => {
        await debuggerApi.sendCommand("DOMSnapshot.enable").catch(() => undefined);
        return debuggerApi.sendCommand("DOMSnapshot.captureSnapshot", {
          computedStyles: ["display", "visibility", "opacity", "pointer-events"]
        });
      })
    ]);
    const rawObservation = observationResult.status === "fulfilled"
      ? observationResult.value
      : {
          ok: true as const,
          action: "observe" as const,
          url: contents.getURL(),
          title: contents.getTitle?.() || "",
          bodyText: "",
          elements: [],
          fields: []
        };
    const refs = this.buildElementRefs(snapshotId, contents, rawObservation);
    this.rememberRefs(webContentsId, [...refs.elements, ...refs.fields]);
    const observation = this.applySnapshotRefs(rawObservation, refs);
    const pageContext = pageContextResult.status === "fulfilled" ? pageContextResult.value : undefined;
    return {
      snapshotId,
      readyState: "",
      url: pageContext?.url || rawObservation.url || contents.getURL(),
      title: pageContext?.title || rawObservation.title || contents.getTitle?.() || "",
      observation,
      pageContext,
      accessibility: accessibilityResult.status === "fulfilled" ? accessibilityResult.value : [],
      elements: refs.elements,
      fields: refs.fields,
      ...(domSnapshotResult.status === "fulfilled" ? { domSnapshot: domSnapshotResult.value } as Record<string, unknown> : {})
    } as BrowserActionSnapshot;
  }

  async observePage(webContentsId: number): Promise<BrowserObservation> {
    return (await this.snapshotPage(webContentsId)).observation;
  }

  async waitForPageSettle(webContentsId: number, timeoutMs = 8000): Promise<void> {
    const contents = this.getWebContents(webContentsId);
    await waitForPageSettle(contents, timeoutMs);
  }

  private async checkActionability(contents: WebContentsLike, ref: BrowserElementRef): Promise<BrowserActionabilityCheck> {
    if (!ref.selector && !ref.rawElementRef) {
      return {
        ok: false,
        reason: "missing_selector",
        reasons: ["缺少可定位 selector"]
      };
    }
    const result = await evaluateWithCDP<BrowserActionabilityCheck>(
      contents,
      buildUnaryExpression(ACTIONABILITY_SCRIPT, {
        selector: ref.selector,
        rawElementRef: ref.rawElementRef,
        elementRef: ref.rawElementRef
      })
    ).catch((error) => ({
      ok: false,
      reason: "actionability_check_failed",
      reasons: [error instanceof Error ? error.message : String(error)]
    }));
    if (typeof result?.ok === "boolean") {
      return result;
    }
    return {
      ok: true,
      x: ref.bounds.x,
      y: ref.bounds.y,
      reasons: []
    };
  }

  async click(webContentsId: number, input: { elementRef?: string; target?: string; allowSensitive?: boolean }): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const target = (input.target ?? "").trim();
    const storedRef = this.getStoredRef(webContentsId, input.elementRef);
    if (input.elementRef?.startsWith("@") && !storedRef) {
      return {
        ok: false,
        action: "click",
        target,
        url: contents.getURL(),
        error: "ref_not_found",
        message: "这个页面引用已经不存在，请重新观察页面。"
      };
    }
    if (storedRef) {
      if (this.isStoredRefStale(contents, storedRef)) {
        return {
          ok: false,
          action: "click",
          target: storedRef.text || storedRef.label || target,
          url: contents.getURL(),
          error: "stale_ref",
          message: "页面已经变化，这个元素引用已失效，请重新观察页面后再操作。",
          data: {
            ref: storedRef.ref,
            snapshotId: storedRef.snapshotId,
            previous: storedRef.pageSignature,
            current: this.pageSignature(contents)
          }
        };
      }
      if (!input.allowSensitive && (storedRef.unsafe || isPotentiallySensitiveClickTarget(storedRef.text || storedRef.label || target))) {
        return {
          ok: false,
          action: "click",
          target: storedRef.text || storedRef.label || target,
          url: contents.getURL(),
          error: "sensitive_action_blocked",
          message: `“${storedRef.text || storedRef.label || target}”可能涉及敏感操作，已停止自动点击。请用户确认后再执行。`
        };
      }
      const check = await this.checkActionability(contents, storedRef);
      if (!check.ok) {
        return {
          ok: false,
          action: "click",
          target: storedRef.text || storedRef.label || target,
          url: contents.getURL(),
          error: "element_not_actionable",
          message: `元素当前不可操作：${(check.reasons || [check.reason || "不可操作"]).join("；")}`,
          data: {
            ref: storedRef,
            actionability: check
          }
        };
      }
      contents.focus();
      await dispatchClickWithCDP(contents, Number(check.x ?? storedRef.bounds.x), Number(check.y ?? storedRef.bounds.y));
      await waitForPageSettle(contents, 3500);
      return {
        ok: true,
        action: "click",
        target: storedRef.text || storedRef.label || target,
        url: contents.getURL(),
        title: contents.getTitle?.() || "",
        message: `已点击“${storedRef.text || storedRef.label || target}”。`,
        data: {
          element: storedRef,
          verification: {
            ok: true,
            actionability: check
          }
        }
      };
    }
    if (!input.elementRef && target && isGenericSearchSubmitTarget(target)) {
      return this.submit(webContentsId, { target, allowSensitive: input.allowSensitive });
    }
    if (!input.allowSensitive && target && isPotentiallySensitiveClickTarget(target)) {
      return {
        ok: false,
        action: "click",
        target,
        url: contents.getURL(),
        error: "sensitive_action_blocked",
        message: `“${target}”可能涉及敏感操作，已停止自动点击。请用户确认后再执行。`
      };
    }

    const observation = await this.observePage(webContentsId);
    const refPayload = parseElementRef(input.elementRef);
    let selected: BrowserObservedElement | undefined = input.elementRef
      ? observation.elements.find((element) => element.elementRef === input.elementRef)
      : undefined;
    if (!selected && refPayload.selector) {
      selected = observation.elements.find((element) => parseElementRef(element.elementRef).selector === refPayload.selector);
    }
    if (!selected) {
      const matchTarget = target || refPayload.label || refPayload.text || "";
      const match = chooseBestBrowserElement(observation.elements, matchTarget);
      selected = match?.candidate as BrowserObservedElement | undefined;
    }

    if (!selected) {
      return {
        ok: false,
        action: "click",
        target: target || refPayload.label || refPayload.text || "",
        url: contents.getURL(),
        error: "element_not_found",
        message: "当前页面没有找到匹配的可点击元素。",
        data: {
          candidates: observation.elements.slice(0, 12).map((element) => element.text || element.ariaLabel).filter(Boolean)
        }
      };
    }
    if (!input.allowSensitive && (selected.unsafe || isPotentiallySensitiveClickTarget(selected.text || selected.ariaLabel || target))) {
      return {
        ok: false,
        action: "click",
        target: selected.text || target,
        url: contents.getURL(),
        error: "sensitive_action_blocked",
        message: `“${selected.text || target}”可能涉及敏感操作，已停止自动点击。请用户确认后再执行。`
      };
    }

    contents.focus();
    const selectedRef: BrowserElementRef = {
      ref: selected.ref || selected.elementRef,
      snapshotId: "semantic",
      rawElementRef: selected.elementRef,
      selector: selected.selector ?? parseElementRef(selected.elementRef).selector,
      text: selected.text,
      label: selected.ariaLabel,
      tagName: selected.tagName,
      role: selected.role,
      kind: selected.kind,
      unsafe: selected.unsafe,
      bounds: {
        x: selected.x,
        y: selected.y,
        width: selected.width,
        height: selected.height
      },
      pageSignature: this.pageSignature(contents, observation),
      fingerprint: selected.elementRef
    };
    const check = await this.checkActionability(contents, selectedRef);
    if (!check.ok) {
      return {
        ok: false,
        action: "click",
        target: selected.text || target,
        url: contents.getURL(),
        error: "element_not_actionable",
        message: `元素当前不可操作：${(check.reasons || [check.reason || "不可操作"]).join("；")}`,
        data: {
          element: selected,
          actionability: check
        }
      };
    }
    await dispatchClickWithCDP(contents, Number(check.x ?? selected.x), Number(check.y ?? selected.y));
    await waitForPageSettle(contents, 3500);
    return {
      ok: true,
      action: "click",
      target: selected.text || target,
      url: contents.getURL(),
      title: observation.title,
      message: `已点击“${selected.text || target}”。`,
      data: {
        element: selected
      }
    };
  }

  async fillFields(webContentsId: number, fields: BrowserFieldInput[]): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const observation = await this.observePage(webContentsId);
    const results: unknown[] = [];
    let filledCount = 0;

    for (const item of fields) {
      const target = (item.elementRef || item.field || item.label || "").trim();
      const matched = item.elementRef
        ? observation.fields.find((field) => field.elementRef === item.elementRef)
        : chooseBestField(observation.fields, target);
      const storedFieldRef = this.getStoredRef(webContentsId, item.elementRef ?? matched?.elementRef);
      const input = {
        ...item,
        elementRef: storedFieldRef?.rawElementRef ?? item.elementRef ?? matched?.elementRef,
        field: item.field ?? item.label ?? matched?.label
      };
      const result = await evaluateWithCDP<{ ok: boolean; label?: string; value?: string; message?: string }>(
        contents,
        buildUnaryExpression(SET_FIELD_SCRIPT, input)
      );
      results.push({
        target,
        ...result
      });
      if (result.ok) {
        filledCount += 1;
      }
    }

    if (filledCount === 0) {
      return {
        ok: false,
        action: "fill",
        url: contents.getURL(),
        error: "field_not_found",
        message: "没有找到匹配的字段。",
        data: { results }
      };
    }

    return {
      ok: true,
      action: "fill",
      url: contents.getURL(),
      message: filledCount === fields.length
        ? `已填写 ${fields.length} 个字段。`
        : `已填写 ${filledCount} 个字段，${fields.length - filledCount} 个字段未匹配成功。`,
      data: { results }
    };
  }

  async autofillForm(webContentsId: number, input: BrowserAutofillInput = {}): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const observation = await this.observePage(webContentsId);
    const fields = buildAutofillFields(observation, input);
    if (fields.length === 0) {
      return {
        ok: false,
        action: "autofill",
        url: contents.getURL(),
        title: observation.title,
        error: "no_fillable_fields",
        message: "当前页面没有识别到可自动填写的空表单字段。",
        data: {
          observedFieldCount: observation.fields.length,
          fields: observation.fields.map((field) => ({
            label: field.label,
            type: field.type,
            placeholder: field.placeholder,
            value: field.value
          })).slice(0, 40)
        }
      };
    }

    const result = await this.fillFields(webContentsId, fields);
    const filledMessage = result.ok ? result.message || `已自动填写 ${fields.length} 个字段。` : result.message || "自动填写表单失败。";
    let submitResult: BrowserToolResult | null = null;
    if (result.ok && input.submit) {
      submitResult = await this.submit(webContentsId, { target: "提交", allowSensitive: input.allowSensitive });
    }

    return {
      ok: result.ok && (!submitResult || submitResult.ok),
      action: "autofill",
      url: contents.getURL(),
      title: observation.title,
      error: result.ok ? submitResult?.error : result.error,
      message: submitResult
        ? `${filledMessage}${submitResult.ok ? " 已提交表单。" : ` ${submitResult.message || "但提交失败。"}`}`
        : `${filledMessage} 未提交表单。`,
      data: {
        generatedFields: fields,
        fillResult: result,
        submitResult
      }
    };
  }

  async selectOption(webContentsId: number, input: BrowserFieldInput): Promise<BrowserToolResult> {
    const result = await this.fillFields(webContentsId, [input]);
    return {
      ...result,
      action: "select",
      message: result.ok ? `已选择“${input.value}”。` : result.message
    };
  }

  async setChecked(webContentsId: number, input: { field?: string; label?: string; elementRef?: string; checked: boolean }): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const storedRef = this.getStoredRef(webContentsId, input.elementRef);
    const result = await evaluateWithCDP<{ ok: boolean; label?: string; checked?: boolean; message?: string }>(
      contents,
      buildUnaryExpression(SET_CHECKED_SCRIPT, {
        ...input,
        elementRef: storedRef?.rawElementRef ?? input.elementRef
      })
    );
    return {
      ok: result.ok,
      action: "check",
      target: input.field || input.label,
      url: contents.getURL(),
      error: result.ok ? undefined : "field_not_found",
      message: result.ok
        ? `已${input.checked ? "勾选" : "取消勾选"}“${result.label || input.field || input.label || "选项"}”。`
        : result.message || "没有找到匹配的选项。",
      data: result
    };
  }

  async submit(webContentsId: number, input: { target?: string; elementRef?: string; allowSensitive?: boolean } = {}): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const target = (input.target ?? "").trim();
    if (!input.allowSensitive && target && isPotentiallySensitiveClickTarget(target) && !/搜索|查询|百度一下/u.test(target)) {
      return {
        ok: false,
        action: "submit",
        target,
        url: contents.getURL(),
        error: "sensitive_action_blocked",
        message: `“${target}”可能涉及敏感提交，已停止自动执行。请用户确认后再执行。`
      };
    }

    contents.focus();
    const storedRef = this.getStoredRef(webContentsId, input.elementRef);
    const result = await evaluateWithCDP<{ ok: boolean; mode?: string; label?: string; x?: number; y?: number; message?: string }>(
      contents,
      buildUnaryExpression(SUBMIT_SCRIPT, {
        ...input,
        elementRef: storedRef?.rawElementRef ?? input.elementRef
      })
    );
    if (!result.ok) {
      return {
        ok: false,
        action: "submit",
        target,
        url: contents.getURL(),
        error: "submit_failed",
        message: result.message || "没有找到可提交的按钮或表单。"
      };
    }
    if (!input.allowSensitive && result.label && isPotentiallySensitiveClickTarget(result.label) && !/搜索|查询|百度一下/u.test(result.label)) {
      return {
        ok: false,
        action: "submit",
        target: result.label,
        url: contents.getURL(),
        error: "sensitive_action_blocked",
        message: `“${result.label}”可能涉及敏感提交，已停止自动执行。请用户确认后再执行。`
      };
    }
    if (result.mode === "click" && Number.isFinite(result.x) && Number.isFinite(result.y)) {
      await dispatchClickWithCDP(contents, Number(result.x), Number(result.y));
    } else if (result.mode === "enter") {
      await dispatchEnterWithCDP(contents);
    }
    await waitForPageSettle(contents, 7000);
    return {
      ok: true,
      action: "submit",
      target: result.label || target || "Enter",
      url: contents.getURL(),
      message: `已提交“${result.label || target || "当前表单"}”。`,
      data: result
    };
  }

  async clickElementByText(webContentsId: number, target: string): Promise<BrowserClickResult> {
    const contents = this.getWebContents(webContentsId);
    const candidates = await this.observeClickableElements(webContentsId);
    const match = chooseBestBrowserElement(candidates, target);
    if (!match) {
      return {
        ok: false,
        target,
        message: `当前网页没有找到可点击的“${target}”。`,
        candidates: candidates
          .map((candidate) => candidate.text)
          .filter(Boolean)
          .slice(0, 8)
      };
    }

    contents.focus();
    await dispatchClickWithCDP(contents, match.candidate.x, match.candidate.y);
    return {
      ok: true,
      target,
      matchedText: match.candidate.text,
      score: match.score
    };
  }

  async fillBestInput(webContentsId: number, value: string): Promise<BrowserInputResult> {
    const contents = this.getWebContents(webContentsId);
    contents.focus();
    const result = await evaluateWithCDP<{ ok: boolean; inputLabel?: string; message?: string }>(
      contents,
      buildFillInputExpression(value)
    );

    if (!result.ok) {
      return {
        ok: false,
        value,
        submitted: false,
        message: result.message || "当前页面没有找到可输入的文本框。"
      };
    }

    return {
      ok: true,
      value,
      submitted: false,
      inputLabel: result.inputLabel || "输入框"
    };
  }

  async fillBestInputAndSubmit(webContentsId: number, value: string): Promise<BrowserInputResult> {
    const contents = this.getWebContents(webContentsId);
    const fillResult = await this.fillBestInput(webContentsId, value);
    if (!fillResult.ok) {
      return fillResult;
    }

    const beforeURL = contents.getURL();
    const submitResult = await this.submit(webContentsId, { target: "百度一下" });
    if (!submitResult.ok) {
      await dispatchEnterWithCDP(contents);
    }
    await waitForPageSettle(contents, 7000);

    if (contents.getURL() === beforeURL) {
      await delay(500);
    }

    return {
      ...fillResult,
      submitted: true
    };
  }

  async readPageContext(webContentsId: number): Promise<AssistantPageContext> {
    const contents = this.getWebContents(webContentsId);
    const context = await evaluateWithCDP<AssistantPageContext>(contents, READ_PAGE_CONTEXT_SCRIPT);
    return {
      url: typeof context?.url === "string" ? context.url : contents.getURL(),
      title: typeof context?.title === "string" ? context.title : "",
      selectedText: typeof context?.selectedText === "string" ? context.selectedText : "",
      metaDescription: typeof context?.metaDescription === "string" ? context.metaDescription : "",
      headings: Array.isArray(context?.headings)
        ? context.headings.filter((item): item is string => typeof item === "string")
        : [],
      bodyText: typeof context?.bodyText === "string" ? context.bodyText : "",
      browserTarget: {
        kind: "webview",
        webContentsId
      }
    };
  }

  async captureScreenshot(webContentsId: number): Promise<BrowserRuntimeSnapshot["screenshot"]> {
    const contents = this.getWebContents(webContentsId);
    const result = await withDebugger(contents, async (debuggerApi) => {
      await debuggerApi.sendCommand("Page.enable").catch(() => undefined);
      return debuggerApi.sendCommand("Page.captureScreenshot", {
        format: "jpeg",
        quality: 60,
        captureBeyondViewport: false
      }) as Promise<{ data?: string }>;
    });
    return result.data
      ? {
          mimeType: "image/jpeg",
          data: result.data
        }
      : undefined;
  }

  async readAccessibilitySnapshot(webContentsId: number): Promise<unknown[]> {
    const contents = this.getWebContents(webContentsId);
    const result = await withDebugger(contents, async (debuggerApi) => {
      await debuggerApi.sendCommand("Accessibility.enable").catch(() => undefined);
      return debuggerApi.sendCommand("Accessibility.getFullAXTree", {}) as Promise<{ nodes?: unknown[] }>;
    });
    return Array.isArray(result.nodes) ? result.nodes.slice(0, 240) : [];
  }

  async createRuntimeSnapshot(webContentsId: number): Promise<BrowserRuntimeSnapshot> {
    const snapshot = await this.snapshotPage(webContentsId);
    const screenshot = await this.captureScreenshot(webContentsId).catch(() => undefined);
    return {
      ...snapshot,
      ...(screenshot ? { screenshot } : {})
    };
  }

  async extractPage(webContentsId: number, extraction: BrowserExtractionRequest): Promise<BrowserRuntimeExtractionResult> {
    const contents = this.getWebContents(webContentsId);
    const html = await evaluateWithCDP<string>(contents, READ_HTML_SCRIPT);
    return extractBrowserItemsFromHtml(html, contents.getURL(), extraction);
  }

  async waitForCondition(webContentsId: number, condition: BrowserWaitCondition = { type: "dom_stable" }): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const timeoutMs = condition.timeoutMs ?? 8000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const state = await evaluateWithCDP<{
        url: string;
        title: string;
        text: string;
        readyState: string;
      }>(contents, `(() => ({
        url: String(location.href || ""),
        title: String(document.title || ""),
        text: String(document.body?.innerText || ""),
        readyState: String(document.readyState || "")
      }))()`).catch(() => null);
      if (state) {
        const matched =
          condition.type === "dom_stable"
            ? state.readyState !== "loading"
            : condition.type === "text_present"
              ? Boolean(condition.text && state.text.includes(condition.text))
              : condition.type === "text_gone"
                ? Boolean(condition.text && !state.text.includes(condition.text))
                : condition.type === "url_changed"
                  ? Boolean(condition.previousUrl && state.url !== condition.previousUrl)
                  : condition.type === "title_changed"
                    ? Boolean(condition.previousTitle && state.title !== condition.previousTitle)
                    : condition.type === "result_count"
                      ? state.text.split(/\r?\n/u).filter((line) => normalizeBrowserText(line).length > 1).length >= (condition.count ?? 1)
                      : false;
        if (matched) {
          return {
            ok: true,
            action: "wait",
            url: state.url,
            title: state.title,
            message: "等待条件已满足。",
            data: {
              condition,
              elapsedMs: Date.now() - startedAt,
              verification: { ok: true }
            }
          };
        }
      }
      await delay(250);
    }
    return {
      ok: false,
      action: "wait",
      url: contents.getURL(),
      title: contents.getTitle?.() || "",
      error: "wait_timeout",
      message: "等待条件超时未满足。",
      data: {
        condition,
        elapsedMs: Date.now() - startedAt,
        verification: { ok: false, reason: "timeout" }
      }
    };
  }

  async sendCdpCommand(
    webContentsId: number,
    input: { method: string; params?: Record<string, unknown> }
  ): Promise<BrowserToolResult> {
    const contents = this.getWebContents(webContentsId);
    const method = String(input.method || "").trim();
    if (!/^[A-Za-z]+(?:\.[A-Za-z0-9_]+)+$/u.test(method)) {
      return {
        ok: false,
        action: "cdp_command",
        error: "invalid_method",
        message: "CDP method 格式无效。"
      };
    }

    const params = input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? input.params
      : {};
    const data = await withDebugger(contents, async (debuggerApi) => {
      return debuggerApi.sendCommand(method, params);
    });
    await waitForPageSettle(contents, 1500).catch(() => undefined);
    return {
      ok: true,
      action: "cdp_command",
      target: method,
      url: contents.getURL(),
      title: contents.getTitle?.() || "",
      message: `已执行 CDP 命令：${method}。`,
      data
    };
  }
}
