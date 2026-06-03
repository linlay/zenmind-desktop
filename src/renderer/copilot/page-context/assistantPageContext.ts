import type { AssistantPageContext } from "../../../shared/contracts";
import { PRODUCT_NAME } from "../../../shared/generated/brand";

export type AssistantPageContextProvider = () => Promise<AssistantPageContext | null>;

let activeProvider: AssistantPageContextProvider | null = null;
const MAX_HEADING_COUNT = 24;
const APP_CONTEXT_EXCLUDED_SELECTOR = [
  ".agent-webclient-copilot-dock",
  "script",
  "style",
  "iframe",
  "webview",
  "[hidden]",
  '[aria-hidden="true"]'
].join(", ");
const LEFT_REGION_SELECTOR_CANDIDATES = [
  ".service-sider",
  ".help-sidebar",
  ".app-main > aside",
  ".app-main aside"
];
const MODAL_SELECTOR_CANDIDATES = [
  '.app-main [role="dialog"]',
  '[role="dialog"]'
];
const MAIN_CONTENT_EXCLUDED_SELECTOR = [
  APP_CONTEXT_EXCLUDED_SELECTOR,
  '[role="dialog"]',
  ".service-sider",
  ".help-sidebar",
  ".app-main > aside"
].join(", ");

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isElementVisible(node: Element | null | undefined): node is HTMLElement {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (node.hidden || node.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (node.closest("[hidden], [aria-hidden=\"true\"]")) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function stripTextFromClone(source: Element | null, removeSelector: string) {
  if (!(source instanceof HTMLElement)) {
    return "";
  }
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(removeSelector).forEach((node) => {
    node.remove();
  });
  return normalizeWhitespace(clone.textContent || "");
}

function collectHeadingsFromClone(source: Element | null, removeSelector: string) {
  if (!(source instanceof HTMLElement)) {
    return [] as string[];
  }
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(removeSelector).forEach((node) => {
    node.remove();
  });
  return Array.from(clone.querySelectorAll("h1, h2, h3"))
    .map((heading) => normalizeWhitespace(heading.textContent ?? ""))
    .filter(Boolean)
    .slice(0, MAX_HEADING_COUNT);
}

function findFirstVisibleElement(selectors: string[]) {
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find((node) => isElementVisible(node));
    if (visible instanceof HTMLElement) {
      return visible;
    }
  }
  return null;
}

function createVisibleAppSnapshot() {
  const main = document.querySelector(".app-main");
  const shellSidebar = document.querySelector(".app-sidebar");
  const leftRegion = findFirstVisibleElement(LEFT_REGION_SELECTOR_CANDIDATES);
  const modal = findFirstVisibleElement(MODAL_SELECTOR_CANDIDATES);

  return {
    bodyText: stripTextFromClone(main, MAIN_CONTENT_EXCLUDED_SELECTOR),
    headings: collectHeadingsFromClone(main, MAIN_CONTENT_EXCLUDED_SELECTOR),
    shellSidebarText: stripTextFromClone(shellSidebar, APP_CONTEXT_EXCLUDED_SELECTOR),
    leftRegionText: stripTextFromClone(leftRegion, APP_CONTEXT_EXCLUDED_SELECTOR),
    modalText: stripTextFromClone(modal, APP_CONTEXT_EXCLUDED_SELECTOR)
  };
}

export function registerAssistantPageContextProvider(provider: AssistantPageContextProvider) {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) {
      activeProvider = null;
    }
  };
}

export async function getAssistantPageContext() {
  if (activeProvider) {
    const provided = await activeProvider();
    if (provided) {
      return provided;
    }
  }

  const snapshot = createVisibleAppSnapshot();
  const title = normalizeWhitespace(document.title || `${PRODUCT_NAME} Desktop`);
  return {
    url: window.location.href,
    title,
    selectedText: normalizeWhitespace(window.getSelection()?.toString() ?? ""),
    metaDescription: "",
    headings: snapshot.headings,
    bodyText: snapshot.bodyText,
    ...(snapshot.shellSidebarText ? { shellSidebarText: snapshot.shellSidebarText } : {}),
    ...(snapshot.leftRegionText ? { leftRegionText: snapshot.leftRegionText } : {}),
    ...(snapshot.modalText ? { modalText: snapshot.modalText } : {})
  } satisfies AssistantPageContext;
}
