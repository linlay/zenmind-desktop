export type EmbeddedWebInteractAction = "click" | "fill" | "scroll" | "focus" | "select";

export type EmbeddedWebInteractArgs = {
  selector: string;
  action: EmbeddedWebInteractAction;
  value?: string;
};

export function buildInteractElementScript(args: EmbeddedWebInteractArgs): string {
  return `(() => {
    const args = ${JSON.stringify({
      selector: args.selector,
      action: args.action,
      value: args.value ?? ""
    })};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
      text: normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || "").slice(0, 500),
      value: "value" in element && !(element instanceof HTMLInputElement && element.type === "password") ? String(element.value || "") : ""
    });
    const dispatchValueEvents = (element) => {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const element = document.querySelector(args.selector);
    if (!element) {
      return { ok: false, error: "element_not_found", selector: args.selector };
    }
    if (!(element instanceof HTMLElement)) {
      return { ok: false, error: "target_is_not_html_element", selector: args.selector };
    }
    try {
      if (args.action === "scroll") {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } else if (args.action === "focus") {
        element.focus();
      } else if (args.action === "click") {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        element.focus();
        element.click();
      } else if (args.action === "fill") {
        if (!("value" in element)) {
          return { ok: false, error: "element_has_no_value", selector: args.selector, element: describe(element) };
        }
        element.focus();
        element.value = String(args.value ?? "");
        dispatchValueEvents(element);
      } else if (args.action === "select") {
        if (element instanceof HTMLSelectElement) {
          element.focus();
          element.value = String(args.value ?? "");
          dispatchValueEvents(element);
        } else if ("value" in element) {
          element.focus();
          element.value = String(args.value ?? "");
          dispatchValueEvents(element);
        } else {
          return { ok: false, error: "element_is_not_selectable", selector: args.selector, element: describe(element) };
        }
      } else {
        return { ok: false, error: "unsupported_action", action: args.action };
      }
      return { ok: true, action: args.action, selector: args.selector, element: describe(element) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        selector: args.selector,
        element: describe(element)
      };
    }
  })()`;
}
