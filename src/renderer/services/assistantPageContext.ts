import type { AssistantPageContext } from "../../shared/contracts";

export type AssistantPageContextProvider = () => Promise<AssistantPageContext | null>;

let activeProvider: AssistantPageContextProvider | null = null;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function readVisibleAppText() {
  const cloneTarget = document.querySelector(".app-main");
  if (!cloneTarget) {
    return "";
  }
  const clone = cloneTarget.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".assistant-dock-root, .assistant-dock-fab, script, style").forEach((node) => {
    node.remove();
  });
  return normalizeWhitespace(clone.innerText || clone.textContent || "");
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

  const bodyText = readVisibleAppText();
  const title = normalizeWhitespace(document.title || "ZenMind Desktop");
  return {
    url: window.location.href,
    title,
    selectedText: normalizeWhitespace(window.getSelection()?.toString() ?? ""),
    metaDescription: "",
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => normalizeWhitespace(heading.textContent ?? ""))
      .filter(Boolean)
      .slice(0, 24),
    bodyText
  } satisfies AssistantPageContext;
}
