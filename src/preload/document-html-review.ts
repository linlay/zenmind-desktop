import { ipcRenderer } from "electron";
import { WORK_PANEL_DOCUMENT_HTML_PROTOCOL, WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, WORK_PANEL_DOCUMENT_HTML_REVIEW_EVENT } from "../shared/work-panel-document-html";

// Runs only in the isolated world. No contextBridge, page messages, eval or
// Desktop API is exposed to document scripts (including third-party CDN code).
if (location.protocol === `${WORK_PANEL_DOCUMENT_HTML_PROTOCOL}:`) {
  const rootId = "__zenmind_native_html_review_overlay__";
  let enabled = false;
  let hoverBox: HTMLElement | null = null;
  let previousCursor = "";
  let renderFrame = 0;
  let markers: Array<{ id: string; selector: string; number: number }> = [];
  const send = (payload: unknown) => ipcRenderer.sendToHost(WORK_PANEL_DOCUMENT_HTML_REVIEW_EVENT, payload);
  const root = () => {
    const existing = document.getElementById(rootId);
    if (existing) return existing;
    const element = document.createElement("div");
    element.id = rootId;
    Object.assign(element.style, { position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none", overflow: "visible" });
    (document.body || document.documentElement).appendChild(element);
    return element;
  };
  const query = (selector: string) => {
    try { return selector ? document.querySelector(selector) : null; } catch { return null; }
  };
  const excerpt = (element: Element) => {
    if (element.closest("input,textarea,select,[contenteditable],script,style")) return "";
    return (element.textContent || "").replace(/\s+/gu, " ")
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]")
      .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s&,;]+/giu, "$1[redacted]")
      .trim().slice(0, 240);
  };
  const rectangle = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
  };
  const box = (rect: DOMRect, number: number, dashed = false) => {
    const element = document.createElement("div");
    Object.assign(element.style, {
      position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      boxSizing: "border-box", border: `2px ${dashed ? "dashed" : "solid"} #ff4d4f`, background: "rgba(255,77,79,.05)", pointerEvents: "none",
    });
    if (number) {
      const badge = document.createElement("span");
      badge.textContent = String(number);
      Object.assign(badge.style, { position: "absolute", top: "-11px", left: "-11px", display: "grid", placeItems: "center", width: "22px", height: "22px", borderRadius: "999px", background: "#ff4d4f", color: "#fff", fontSize: "11px", fontWeight: "700" });
      element.appendChild(badge);
    }
    return element;
  };
  const renderMarkers = () => {
    document.getElementById(rootId)?.replaceChildren();
    hoverBox = null;
    if (!enabled) return;
    for (const marker of markers) {
      const element = query(marker.selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) root().appendChild(box(rect, marker.number));
    }
  };
  const scheduleRender = () => {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderMarkers(); });
  };
  const targetAt = (event: PointerEvent) => document.elementsFromPoint(event.clientX, event.clientY).find((element) => !element.closest(`#${rootId}`));
  const paths = (element: Element) => {
    const css: string[] = [];
    const xpath: string[] = [];
    let current: Element | null = element;
    let cssComplete = false;
    while (current) {
      const name = current.tagName.toLowerCase();
      const siblings: Element[] = current.parentElement ? Array.from(current.parentElement.children).filter((item) => item.tagName === current!.tagName) : [current];
      const index = siblings.indexOf(current) + 1;
      xpath.unshift(name === "html" ? "html" : `${name}[${index}]`);
      if (!cssComplete) {
        if (current.id) { css.unshift(`#${CSS.escape(current.id)}`); cssComplete = true; }
        else css.unshift(name + (siblings.length > 1 ? `:nth-of-type(${index})` : ""));
      }
      current = current.parentElement;
    }
    return { selector: css.join(" > ").slice(0, 512), xpath: `/${xpath.join("/")}`.slice(0, 1024) };
  };

  ipcRenderer.on(WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL, (_event, data) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "resize") { window.dispatchEvent(new Event("resize")); scheduleRender(); return; }
    if (data.type === "zenmind-html-annotation-mode") {
      if (typeof data.enabled !== "boolean" || data.enabled === enabled) return;
      enabled = data.enabled;
      if (enabled) { previousCursor = document.documentElement.style.cursor; document.documentElement.style.cursor = "crosshair"; }
      else document.documentElement.style.cursor = previousCursor;
      renderMarkers();
    } else if (data.type === "zenmind-html-annotation-locate" && Array.isArray(data.items)) {
      markers = data.items.slice(0, 64).filter((item: unknown) => item && typeof item === "object").map((item: { id?: unknown; selector?: unknown }, index: number) => ({
        id: typeof item.id === "string" ? item.id.slice(0, 128) : "",
        selector: typeof item.selector === "string" ? item.selector.slice(0, 512) : "", number: index + 1,
      }));
      renderMarkers();
      send({ type: "zenmind-html-annotation-located", items: markers.map((marker) => {
        const element = query(marker.selector);
        if (!element) return { id: marker.id, valid: false };
        const rect = rectangle(element);
        return { id: marker.id, valid: rect.width > 0 && rect.height > 0, text: excerpt(element), rect };
      }) });
    }
  });
  document.addEventListener("pointermove", (event) => {
    if (!enabled) return;
    hoverBox?.remove();
    const element = targetAt(event);
    hoverBox = element ? box(element.getBoundingClientRect(), 0, true) : null;
    if (hoverBox) root().appendChild(hoverBox);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!enabled || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (!enabled || event.button !== 0 || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const element = targetAt(event);
    if (!element) return;
    const rect = rectangle(element);
    if (rect.width > 0 && rect.height > 0) send({ type: "zenmind-html-annotation", ...paths(element), text: excerpt(element), rect });
  }, true);
  for (const type of ["click", "submit"]) document.addEventListener(type, (event) => {
    if (enabled) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener("resize", scheduleRender);
  window.addEventListener("scroll", scheduleRender, true);
}
