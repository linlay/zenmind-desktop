import type { DesktopClickWait } from "../../../../shared/desktop-click";

export type ObservationProbeRequest = {
  kind: "observe" | "locate" | "verify" | "wait" | "fill" | "verify-focus" | "verify-fill" | "select" | "focus" | "scroll"
    | "check-state" | "viewport" | "file-input" | "file-input-element";
  observationId: string;
  ref?: string;
  /** A unique CSS selector in the main document; replaces ref and needs no snapshot. */
  selector?: string;
  value?: string;
  values?: string[];
  maxTextLength?: number;
  maxElements?: number;
  viewportOnly?: boolean;
  waitFor?: DesktopClickWait;
};

/** Runs only in a host-created isolated world. It must not reference module variables. */
function observationRuntime(key: string, request: ObservationProbeRequest) {
  type Frame = { element: HTMLIFrameElement; document: Document };
  type Entry = { element: Element; document: Document; frames: Frame[] };
  type Snapshot = { id: string; document: Document; entries: Map<string, Entry> };
  const store = globalThis as unknown as Record<string, Snapshot | undefined>;
  const clean = (value: unknown, limit = 240) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const parent = (element: Element): Element | null => element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;
  const rendered = (element: Element) => {
    for (let current: Element | null = element; current; current = parent(current)) {
      const style = current.ownerDocument.defaultView!.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || style.opacity === "0" || style.contentVisibility === "hidden"
        || current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const intersectsViewport = (element: Element) => {
    const rect = element.getBoundingClientRect(), view = element.ownerDocument.defaultView!;
    return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
  };
  const disabled = (element: Element) => {
    for (let current: Element | null = element; current; current = parent(current)) {
      if (current.matches(":disabled, [inert]") || current.getAttribute("aria-disabled") === "true") return true;
    }
    return false;
  };
  const sensitiveField = (element: Element) => element.getAttribute("type")?.toLowerCase() === "password"
    || (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/u)
      .some(token => ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(token));
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      const role = explicit.split(/\s/u)[0];
      return ["button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox", "option", "tab",
        "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "switch", "treeitem"].includes(role) ? role : "";
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea" || (element as HTMLElement).isContentEditable && !(parent(element) as HTMLElement | null)?.isContentEditable) return "textbox";
    if (tag === "select") return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "input") {
      const type = (element as HTMLInputElement).type;
      return type === "checkbox" || type === "radio" ? type : ["button", "submit", "reset", "image"].includes(type) ? "button"
        : type === "range" ? "slider" : type === "number" ? "spinbutton" : type === "file" ? "button" : "textbox";
    }
    return element.hasAttribute("tabindex") ? "generic" : "";
  };
  const nameOf = (element: Element) => {
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled) {
      const root = element.getRootNode() as Document | ShadowRoot;
      const name = labelled.split(/\s+/u).map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "").join(" ");
      if (clean(name)) return clean(name);
    }
    const labels = (element as HTMLInputElement).labels;
    return clean(element.getAttribute("aria-label") || (labels ? [...labels].map((label) => label.innerText).join(" ") : "")
      || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder")
      || (element.tagName === "INPUT" && ["button", "submit", "reset"].includes((element as HTMLInputElement).type) ? (element as HTMLInputElement).value : "")
      || (element as HTMLElement).innerText || element.textContent);
  };
  if (request.kind === "observe") {
    const entries = new Map<string, Entry>();
    const elements: Record<string, unknown>[] = [];
    const maxText = request.maxTextLength!;
    const maxElements = request.maxElements!;
    const text: string[] = [];
    let textLength = 0, visited = 0, truncated = false;
    let optionCount = 0, optionCharacters = 24_000;
    // Viewport filtering keeps frame-local boxes: each frame element must also intersect its parent viewport.
    const inView = (element: Element, frames: Frame[]) => !request.viewportOnly
      || intersectsViewport(element) && frames.every((frame) => intersectsViewport(frame.element));
    const appendText = (value: string) => {
      const normalized = clean(value, maxText + 1);
      if (!normalized) return;
      const remaining = maxText - textLength;
      if (remaining <= 0) { truncated = true; return; }
      const part = normalized.slice(0, remaining);
      text.push(part); textLength += part.length + 1;
      if (part.length < normalized.length) truncated = true;
    };
    const visit = (node: Node, frames: Frame[], depth = 0) => {
      if (++visited > 15_000 || depth > 100) { truncated = true; return; }
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement && rendered(node.parentElement) && inView(node.parentElement, frames)) appendText(node.textContent ?? "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null;
      if (element) {
        if (/^(script|style|noscript|template)$/iu.test(element.tagName)) return;
        // display:contents has no own box; its children can still be visible.
        const style = element.ownerDocument.defaultView!.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
          || style.opacity === "0" || style.contentVisibility === "hidden"
          || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return;
        const role = roleOf(element);
        if (role && rendered(element) && inView(element, frames) && !(element.tagName === "INPUT" && (element as HTMLInputElement).type === "hidden")) {
          if (elements.length < maxElements) {
            const ref = `e${elements.length + 1}`;
            const item: Record<string, unknown> = { ref, role, name: nameOf(element), tag: element.tagName.toLowerCase(), disabled: disabled(element) };
            const sensitive = sensitiveField(element);
            if (element.matches("input:not([type=password]):not([type=file]), textarea, select") && !sensitive) {
              item.value = clean((element as HTMLInputElement).value, 1000);
            }
            if (element.tagName === "SELECT" && !sensitive) {
              const select = element as HTMLSelectElement;
              const options: Array<{ label: string; value: string; selected: boolean; disabled: boolean }> = [];
              let clipped = select.options.length > 100;
              for (let index = 0; index < Math.min(select.options.length, 100); index += 1) {
                const option = select.options[index];
                if (option.closest('[hidden], [aria-hidden="true"]') || option.ownerDocument.defaultView!.getComputedStyle(option).display === "none") continue;
                const normalizedLabel = clean(option.label, 241), label = normalizedLabel.slice(0, 240), value = option.value;
                if (normalizedLabel.length > label.length) clipped = true;
                if (value.length > 1000) { clipped = true; continue; }
                if (optionCount >= 500 || label.length + value.length > optionCharacters) { clipped = true; break; }
                options.push({ label, value, selected: option.selected, disabled: item.disabled === true || option.disabled || !!option.closest('optgroup[disabled]') });
                optionCount += 1; optionCharacters -= label.length + value.length;
              }
              item.options = options; item.multiple = select.multiple; item.optionsTruncated = clipped;
              if (clipped) truncated = true;
            } else if (element.tagName === "SELECT") {
              item.name = clean(element.getAttribute("aria-label") || element.getAttribute("title"));
            }
            if (element.matches("input[type=checkbox], input[type=radio]")) item.checked = (element as HTMLInputElement).checked;
            else if (element.hasAttribute("aria-checked")) item.checked = element.getAttribute("aria-checked") === "true";
            if (element.tagName === "A") item.href = clean((element as HTMLAnchorElement).href, 2000);
            if (frames.length) item.frameUrl = clean(element.ownerDocument.location.href, 2000);
            elements.push(item);
            entries.set(ref, { element, document: element.ownerDocument, frames: [...frames] });
          } else truncated = true;
        }
        if (element.tagName === "IFRAME" && rendered(element)) {
          try {
            const frame = element as HTMLIFrameElement, frameDocument = frame.contentDocument;
            if (frameDocument?.body && frames.length < 8) visit(frameDocument.body, [...frames, { element: frame, document: frameDocument }], depth + 1);
          } catch { /* Cross-origin frames remain outside this same-origin observation. */ }
        }
        if (element.shadowRoot) visit(element.shadowRoot, frames, depth + 1);
        if (element.tagName === "SELECT" && sensitiveField(element)) return;
      }
      for (const child of node.childNodes) {
        if (visited >= 15_000) { truncated = true; break; }
        visit(child, frames, depth + 1);
      }
    };
    if (document.body) visit(document.body, []);
    store[key] = { id: request.observationId, document, entries };
    return { observationId: request.observationId, url: location.href, title: document.title,
      text: text.join(" ").slice(0, maxText), elements, truncated, ...(request.viewportOnly ? { viewportOnly: true } : {}) };
  }
  if (request.kind === "viewport") return { width: innerWidth, height: innerHeight };
  let entry: Entry | undefined;
  if (request.selector !== undefined) {
    // A selector targets the main document only; frame content needs an observed ref.
    let matches: NodeListOf<Element>;
    try { matches = document.querySelectorAll(request.selector); }
    catch { return { error: "invalid_selector" }; }
    if (matches.length === 0) return { error: "element_not_found" };
    if (matches.length > 1) return { error: "ambiguous_selector" };
    entry = { element: matches[0], document, frames: [] };
  }
  const snapshot = store[key];
  if (!entry && (!snapshot || snapshot.id !== request.observationId || snapshot.document !== document)) return { error: "observation_stale" };
  // Invalid postconditions must fail before scrolling or dispatching a press.
  if (request.waitFor?.selector) {
    try { document.querySelectorAll(request.waitFor.selector); }
    catch { return { error: "invalid_wait_selector" }; }
  }
  if (request.kind === "wait") {
    const wait = request.waitFor!;
    const candidates = document.querySelectorAll(wait.selector!);
    if (candidates.length > 1) return { error: "ambiguous_wait_selector" };
    const element = candidates[0];
    if (wait.state === "hidden") return { matched: !element || !rendered(element) };
    if (!element) return { matched: false };
    if (wait.state === "visible") return { matched: rendered(element) };
    if (wait.state === "value") return { matched: (element as HTMLInputElement).value === wait.value };
    const checked = typeof (element as HTMLInputElement).checked === "boolean" ? (element as HTMLInputElement).checked : element.getAttribute("aria-checked") === "true";
    return { matched: checked === wait.checked, checked };
  }
  entry ??= snapshot!.entries.get(request.ref!);
  if (!entry) return { error: "element_ref_not_found" };
  const element = entry.element, elementDocument = entry.document;
  try {
    if (!element.isConnected || element.ownerDocument !== elementDocument || elementDocument.defaultView?.document !== elementDocument
      || entry.frames.some((frame) => !frame.element.isConnected || frame.element.contentDocument !== frame.document)) return { error: "element_ref_stale" };
  } catch { return { error: "element_ref_stale" }; }
  if (!rendered(element) || entry.frames.some((frame) => !rendered(frame.element))) return { error: "element_not_visible" };
  if (disabled(element) || entry.frames.some((frame) => disabled(frame.element))) return { error: "element_disabled" };
  const scroll = () => {
    for (const frame of entry.frames) frame.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  };
  const activeElement = () => {
    let current = elementDocument.activeElement;
    while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
    return current;
  };
  const focusEvidence = () => ({ domFocused: activeElement() === element, documentFocused: elementDocument.hasFocus(),
    topDocumentFocused: document.hasFocus(), targetIsMainDocument: elementDocument === document,
    valueMatched: ((element as HTMLElement).isContentEditable ? element.textContent : (element as HTMLInputElement).value) === request.value });
  if (request.kind === "verify-focus") return activeElement() === element ? { matched: true, ...focusEvidence() } : { error: "element_focus_changed" };
  if (request.kind === "verify-fill") {
    const value = (element as HTMLElement).isContentEditable ? element.textContent : (element as HTMLInputElement).value;
    return { matched: value === request.value, ...focusEvidence() };
  }
  if (request.kind === "fill") {
    const input = element as HTMLInputElement;
    if (input.readOnly) return { error: "element_readonly" };
    if (!element.matches("input, textarea") && !(element as HTMLElement).isContentEditable) return { error: "element_not_editable" };
    if (element.tagName === "INPUT" && !["text", "search", "email", "url", "tel", "password", "number"].includes(input.type)) return { error: "element_not_editable" };
    scroll();
    (element as HTMLElement).focus({ preventScroll: true });
    if ((element as HTMLElement).isContentEditable) {
      const range = elementDocument.createRange(); range.selectNodeContents(element);
      const selection = elementDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } else input.select();
    return activeElement() === element ? { prepared: true } : { error: "element_focus_changed" };
  }
  if (request.kind === "select") {
    if (element.tagName !== "SELECT") return { error: "element_not_selectable" };
    const select = element as HTMLSelectElement;
    const wanted = request.values ?? [request.value!];
    if (!select.multiple && wanted.length !== 1) return { error: "element_not_multiple" };
    const usable = (option: HTMLOptionElement) => !option.disabled && !option.closest("optgroup[disabled]");
    if (!wanted.every((value) => [...select.options].some((option) => option.value === value && usable(option)))) return { error: "option_not_found" };
    scroll(); select.focus({ preventScroll: true });
    if (select.multiple) for (const option of select.options) option.selected = wanted.includes(option.value) && usable(option);
    else select.value = wanted[0];
    const EventClass = elementDocument.defaultView!.Event;
    select.dispatchEvent(new EventClass("input", { bubbles: true }));
    select.dispatchEvent(new EventClass("change", { bubbles: true }));
    const selected = [...select.selectedOptions].map((option) => option.value);
    return { matched: selected.length === wanted.length && wanted.every((value) => selected.includes(value)) };
  }
  if (request.kind === "file-input" || request.kind === "file-input-element") {
    if (!element.matches("input[type=file]")) return { error: "element_not_file_input" };
    // The element itself is returned only by reference, for DOM.setFileInputFiles.
    return request.kind === "file-input" ? { matched: true, multiple: (element as HTMLInputElement).multiple } : element;
  }
  if (request.kind === "check-state") {
    const role = element.getAttribute("role") ?? "";
    const native = element.matches("input[type=checkbox], input[type=radio]");
    if (!native && !["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) return { error: "element_not_checkable" };
    return { checked: native ? (element as HTMLInputElement).checked : element.getAttribute("aria-checked") === "true",
      radio: native ? (element as HTMLInputElement).type === "radio" : role === "radio" || role === "menuitemradio" };
  }
  if (request.kind === "focus" || request.kind === "scroll") {
    scroll();
    if (request.kind === "focus") (element as HTMLElement).focus({ preventScroll: true });
    return { matched: request.kind === "scroll" || activeElement() === element };
  }
  if (request.kind === "locate") scroll();
  const rect = element.getBoundingClientRect();
  let x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hitMatches = (doc: Document, expected: Element, atX: number, atY: number) => {
    let hit = doc.elementFromPoint(atX, atY);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(atX, atY);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return !!hit && (hit === expected || expected.contains(hit));
  };
  if (!hitMatches(elementDocument, element, x, y)) return { error: "element_obscured" };
  for (const frame of [...entry.frames].reverse()) {
    const frameRect = frame.element.getBoundingClientRect();
    const style = frame.element.ownerDocument.defaultView!.getComputedStyle(frame.element);
    if (style.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return { error: "unsupported_frame_transform" };
    }
    const scaleX = frameRect.width / frame.element.offsetWidth, scaleY = frameRect.height / frame.element.offsetHeight;
    x = frameRect.left + (frame.element.clientLeft + x) * scaleX;
    y = frameRect.top + (frame.element.clientTop + y) * scaleY;
    if (!hitMatches(frame.element.ownerDocument, frame.element, x, y)) return { error: "element_obscured" };
  }
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: "outside_viewport" };
  return { x, y, tag: element.tagName.toLowerCase(), matched: true };
}

export function observationExpression(key: string, request: ObservationProbeRequest) {
  return `(${observationRuntime.toString()})(${JSON.stringify(key)},${JSON.stringify(request)})`;
}
