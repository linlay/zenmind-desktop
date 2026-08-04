export type EmbeddedWebReadInclude = "forms" | "links" | "images";
export type EmbeddedWebStructuredTarget = "tables" | "lists" | "forms" | "links";
export type EmbeddedWebInteractAction = "click" | "fill" | "scroll" | "focus" | "select";

export type EmbeddedWebInteractArgs = {
  selector: string;
  action: EmbeddedWebInteractAction;
  value?: string;
};

export const READ_PAGE_DATA_SCRIPT = `(() => {
  const MAX_BODY_TEXT = 12000;
  const MAX_SELECTED_TEXT = 4000;
  const MAX_HEADING_COUNT = 32;
  const MAX_FORM_COUNT = 20;
  const MAX_FIELD_COUNT = 80;
  const MAX_LINK_COUNT = 120;
  const MAX_IMAGE_COUNT = 80;
  const MAX_FIELD_VALUE = 1000;
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const truncate = (value, maxLength) => normalize(value).slice(0, maxLength);
  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\\\]/g, "\\\\$&");
  };
  const selectorFor = (element) => {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      return "#" + escapeCss(element.id);
    }
    const name = element.getAttribute("name");
    if (name) {
      return element.tagName.toLowerCase() + "[name=\\"" + escapeCss(name) + "\\"]";
    }
    const parent = element.parentElement;
    if (!parent) {
      return element.tagName.toLowerCase();
    }
    const siblings = Array.from(parent.children).filter((node) => node.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    return selectorFor(parent) + " > " + element.tagName.toLowerCase() + (siblings.length > 1 ? ":nth-of-type(" + index + ")" : "");
  };
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelFor = (field) => {
    if (!(field instanceof HTMLElement)) {
      return "";
    }
    const ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel) {
      return normalize(ariaLabel);
    }
    const labelledBy = field.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelledText = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (normalize(labelledText)) {
        return normalize(labelledText);
      }
    }
    if ("labels" in field && field.labels && field.labels.length > 0) {
      return normalize(Array.from(field.labels).map((label) => label.textContent || "").join(" "));
    }
    const id = field.getAttribute("id");
    if (id) {
      const label = document.querySelector("label[for=\\"" + escapeCss(id) + "\\"]");
      if (label) {
        return normalize(label.textContent || "");
      }
    }
    return "";
  };
  const readField = (field) => {
    if (!(field instanceof HTMLElement)) {
      return null;
    }
    const input = field instanceof HTMLInputElement ? field : null;
    const textarea = field instanceof HTMLTextAreaElement ? field : null;
    const select = field instanceof HTMLSelectElement ? field : null;
    const type = input ? (input.type || "text") : select ? "select" : textarea ? "textarea" : field.tagName.toLowerCase();
    const rawValue = input || textarea || select ? String((field).value || "") : "";
    const visible = isVisible(field);
    const shouldReadValue = type !== "password" && type !== "hidden" && visible;
    return {
      selector: selectorFor(field),
      tag: field.tagName.toLowerCase(),
      type,
      id: field.id || "",
      name: field.getAttribute("name") || "",
      label: labelFor(field),
      placeholder: field.getAttribute("placeholder") || "",
      value: shouldReadValue ? truncate(rawValue, MAX_FIELD_VALUE) : "",
      checked: input && ["checkbox", "radio"].includes(type) ? input.checked : undefined,
      required: Boolean((field).required),
      disabled: Boolean((field).disabled),
      visible,
      options: select
        ? Array.from(select.options).slice(0, 60).map((option) => ({
            text: normalize(option.textContent || ""),
            value: option.value,
            selected: option.selected
          }))
        : undefined
    };
  };
  const forms = Array.from(document.forms).slice(0, MAX_FORM_COUNT).map((form) => ({
    selector: selectorFor(form),
    id: form.id || "",
    name: form.getAttribute("name") || "",
    action: form.action || "",
    method: form.method || "",
    text: truncate(form.innerText || form.textContent || "", 1000),
    fields: Array.from(form.querySelectorAll("input, textarea, select, button"))
      .slice(0, MAX_FIELD_COUNT)
      .map(readField)
      .filter(Boolean)
  }));
  const standaloneFields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((field) => !(field).form)
    .slice(0, MAX_FIELD_COUNT)
    .map(readField)
    .filter(Boolean);
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, MAX_LINK_COUNT).map((link) => ({
    selector: selectorFor(link),
    text: truncate(link.innerText || link.textContent || link.getAttribute("aria-label") || "", 300),
    href: link.href,
    title: link.getAttribute("title") || "",
    visible: isVisible(link)
  }));
  const images = Array.from(document.images).slice(0, MAX_IMAGE_COUNT).map((image) => ({
    selector: selectorFor(image),
    src: image.currentSrc || image.src || "",
    alt: image.alt || "",
    title: image.title || "",
    width: image.naturalWidth || image.width || 0,
    height: image.naturalHeight || image.height || 0,
    visible: isVisible(image)
  }));
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  return {
    url: String(location.href || ""),
    title: normalize(document.title || ""),
    selectedText: truncate(getSelection()?.toString() || "", MAX_SELECTED_TEXT),
    metaDescription: truncate(meta?.getAttribute("content") || "", 2000),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => truncate(node.textContent || "", 500))
      .filter(Boolean)
      .slice(0, MAX_HEADING_COUNT),
    bodyText: truncate(document.body?.innerText || document.body?.textContent || "", MAX_BODY_TEXT),
    forms,
    fields: standaloneFields,
    links,
    images
  };
})()`;

export const EXTRACT_STRUCTURED_SCRIPT = `(() => {
  const MAX_TABLE_COUNT = 20;
  const MAX_TABLE_ROWS = 80;
  const MAX_TABLE_COLUMNS = 20;
  const MAX_LIST_COUNT = 40;
  const MAX_LIST_ITEMS = 120;
  const MAX_FORM_COUNT = 20;
  const MAX_FIELD_COUNT = 80;
  const MAX_LINK_COUNT = 160;
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\\\]/g, "\\\\$&");
  };
  const selectorFor = (element) => {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      return "#" + escapeCss(element.id);
    }
    const parent = element.parentElement;
    if (!parent) {
      return element.tagName.toLowerCase();
    }
    const siblings = Array.from(parent.children).filter((node) => node.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    return selectorFor(parent) + " > " + element.tagName.toLowerCase() + (siblings.length > 1 ? ":nth-of-type(" + index + ")" : "");
  };
  const tableCellText = (cell) => normalize(cell.innerText || cell.textContent || "").slice(0, 1000);
  const readTable = (table) => {
    const rows = Array.from(table.rows).slice(0, MAX_TABLE_ROWS);
    const headerRow = rows.find((row) => Array.from(row.cells).some((cell) => cell.tagName.toLowerCase() === "th")) || rows[0] || null;
    const headers = headerRow
      ? Array.from(headerRow.cells).slice(0, MAX_TABLE_COLUMNS).map(tableCellText)
      : [];
    const bodyRows = rows
      .filter((row) => row !== headerRow)
      .map((row) => Array.from(row.cells).slice(0, MAX_TABLE_COLUMNS).map(tableCellText))
      .filter((row) => row.some(Boolean));
    return {
      selector: selectorFor(table),
      caption: normalize(table.caption?.innerText || table.caption?.textContent || ""),
      headers,
      rows: bodyRows
    };
  };
  const readField = (field) => ({
    selector: selectorFor(field),
    tag: field.tagName.toLowerCase(),
    type: field instanceof HTMLInputElement ? field.type || "text" : field instanceof HTMLSelectElement ? "select" : field instanceof HTMLTextAreaElement ? "textarea" : field.tagName.toLowerCase(),
    id: field.id || "",
    name: field.getAttribute("name") || "",
    label: normalize(field.getAttribute("aria-label") || field.closest("label")?.textContent || ""),
    placeholder: field.getAttribute("placeholder") || "",
    value: field instanceof HTMLInputElement && field.type === "password" ? "" : "value" in field ? String(field.value || "") : ""
  });
  const tables = Array.from(document.querySelectorAll("table")).slice(0, MAX_TABLE_COUNT).map(readTable);
  const lists = Array.from(document.querySelectorAll("ul, ol")).slice(0, MAX_LIST_COUNT).map((list) => ({
    selector: selectorFor(list),
    type: list.tagName.toLowerCase(),
    items: Array.from(list.children)
      .filter((item) => item.tagName.toLowerCase() === "li")
      .slice(0, MAX_LIST_ITEMS)
      .map((item) => normalize(item.innerText || item.textContent || "").slice(0, 2000))
      .filter(Boolean)
  })).filter((list) => list.items.length > 0);
  const forms = Array.from(document.forms).slice(0, MAX_FORM_COUNT).map((form) => ({
    selector: selectorFor(form),
    id: form.id || "",
    name: form.getAttribute("name") || "",
    action: form.action || "",
    method: form.method || "",
    fields: Array.from(form.querySelectorAll("input, textarea, select, button"))
      .slice(0, MAX_FIELD_COUNT)
      .map(readField)
  }));
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, MAX_LINK_COUNT).map((link) => ({
    selector: selectorFor(link),
    text: normalize(link.innerText || link.textContent || link.getAttribute("aria-label") || "").slice(0, 500),
    href: link.href,
    title: link.getAttribute("title") || ""
  })).filter((link) => link.text || link.href);
  return {
    url: String(location.href || ""),
    title: normalize(document.title || ""),
    tables,
    lists,
    forms,
    links
  };
})()`;

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
