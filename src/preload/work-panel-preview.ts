import { ipcRenderer } from "electron";
import {
  WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL,
  WORK_PANEL_PREVIEW_REVIEW_EVENT_CHANNEL,
  WORK_PANEL_REVIEW_MAX_IMAGE_PIXELS,
  WORK_PANEL_REVIEW_MAX_IMAGE_SIDE,
  WORK_PANEL_REVIEW_MAX_PNG_BYTES,
  WORK_PANEL_REVIEW_VERSION,
  type HtmlElementAnnotation,
  type ImageRegionAnnotation,
  type WorkPanelPixelRect,
  type WorkPanelPreviewReviewAction,
  type WorkPanelPreviewReviewEvent,
  type WorkPanelReviewAnnotation,
  type WorkPanelReviewKind,
} from "../shared/work-panel-review";
import { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from "../shared/chat-work-panel";

const OVERLAY_ROOT_ID = "__zenmind_work_panel_review_overlay__";
const REVIEW_COLOR = "#ff4d4f";

let reviewKind: WorkPanelReviewKind | null = null;
let reviewEnabled = false;
let annotations: WorkPanelReviewAnnotation[] = [];
let overlayRoot: HTMLDivElement | null = null;
let selectionLayer: HTMLDivElement | null = null;
let hoverBox: HTMLDivElement | null = null;
let draftBox: HTMLDivElement | null = null;
let resizeFrame = 0;
let invalidAnnotationIds = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReviewableDocument() {
  try {
    const url = new URL(window.location.href);
    return (
      url.protocol === `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:` ||
      url.protocol === "http:" ||
      url.protocol === "https:"
    ) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function documentAcceptsReviewKind(kind: WorkPanelReviewKind) {
  if (kind === "image") return Boolean(directImageElement());
  const contentType = document.contentType.toLowerCase();
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

function sendEvent(event: WorkPanelPreviewReviewEvent) {
  if (!isReviewableDocument()) return;
  ipcRenderer.sendToHost(WORK_PANEL_PREVIEW_REVIEW_EVENT_CHANNEL, event);
}

function boundedNumber(value: unknown, min: number, max: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function readPixelRect(value: unknown): WorkPanelPixelRect | null {
  if (!isRecord(value)) return null;
  const x = boundedNumber(value.x, 0, Number.MAX_SAFE_INTEGER);
  const y = boundedNumber(value.y, 0, Number.MAX_SAFE_INTEGER);
  const width = boundedNumber(value.width, 0, Number.MAX_SAFE_INTEGER);
  const height = boundedNumber(value.height, 0, Number.MAX_SAFE_INTEGER);
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height };
}

function readAnnotations(value: unknown, kind: WorkPanelReviewKind) {
  if (!Array.isArray(value) || value.length > 50) return [];
  return value.flatMap((candidate): WorkPanelReviewAnnotation[] => {
    if (!isRecord(candidate)) return [];
    const id = typeof candidate.id === "string" ? candidate.id.trim().slice(0, 256) : "";
    const number = Number.isSafeInteger(candidate.number) && Number(candidate.number) > 0
      ? Number(candidate.number)
      : 0;
    const requirement = typeof candidate.requirement === "string"
      ? candidate.requirement.slice(0, 1_000)
      : "";
    if (!id || !number) return [];
    if (kind === "image" && candidate.kind === "image-region") {
      const rect = readPixelRect(candidate.rect);
      const normalizedRect = readPixelRect(candidate.normalizedRect);
      if (!rect || !normalizedRect) return [];
      return [{
        id,
        number,
        kind: "image-region",
        rect,
        normalizedRect,
        requirement,
      }];
    }
    if (kind === "html" && candidate.kind === "html-element") {
      const fullXPath = typeof candidate.fullXPath === "string"
        ? candidate.fullXPath.trim().slice(0, 2_048)
        : "";
      const rect = readPixelRect(candidate.rect);
      if (!fullXPath.startsWith("/html") || !rect) return [];
      return [{
        id,
        number,
        kind: "html-element",
        fullXPath,
        cssSelector: typeof candidate.cssSelector === "string"
          ? candidate.cssSelector.slice(0, 1_024)
          : "",
        tagName: typeof candidate.tagName === "string"
          ? candidate.tagName.slice(0, 64)
          : "",
        attributes: {},
        textExcerpt: typeof candidate.textExcerpt === "string"
          ? candidate.textExcerpt.slice(0, 240)
          : "",
        rect,
        requirement,
      }];
    }
    return [];
  });
}

function ensureOverlayRoot() {
  if (overlayRoot?.isConnected) return overlayRoot;
  overlayRoot = document.createElement("div");
  overlayRoot.id = OVERLAY_ROOT_ID;
  Object.assign(overlayRoot.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    pointerEvents: "none",
    overflow: "visible",
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  });
  (document.body || document.documentElement).appendChild(overlayRoot);
  return overlayRoot;
}

function clearOverlay() {
  overlayRoot?.remove();
  overlayRoot = null;
  selectionLayer = null;
  hoverBox = null;
  draftBox = null;
}

function createBox(rect: DOMRect | WorkPanelPixelRect, number?: number, dashed = false) {
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${Math.max(0, rect.width)}px`,
    height: `${Math.max(0, rect.height)}px`,
    boxSizing: "border-box",
    border: `2px ${dashed ? "dashed" : "solid"} ${REVIEW_COLOR}`,
    background: dashed ? "rgba(255,77,79,.08)" : "rgba(255,77,79,.05)",
    pointerEvents: "none",
  });
  if (number !== undefined) {
    const label = document.createElement("span");
    label.textContent = String(number);
    Object.assign(label.style, {
      position: "absolute",
      top: "-12px",
      left: "-12px",
      display: "grid",
      placeItems: "center",
      width: "24px",
      height: "24px",
      borderRadius: "999px",
      background: REVIEW_COLOR,
      color: "#fff",
      fontSize: "12px",
      fontWeight: "700",
      lineHeight: "1",
      boxShadow: "0 2px 8px rgba(0,0,0,.24)",
    });
    box.appendChild(label);
  }
  return box;
}

function directImageElement() {
  const images = Array.from(document.images).filter((image) => image.naturalWidth > 0);
  return images.length === 1 ? images[0] : images[0] ?? null;
}

function imageDisplayRect() {
  const image = directImageElement();
  if (!image) return null;
  const rect = image.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function scheduleRender() {
  if (resizeFrame) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0;
    renderOverlay();
  });
}

function positionSelectionLayer(rect: DOMRect) {
  const root = ensureOverlayRoot();
  if (!selectionLayer) {
    selectionLayer = document.createElement("div");
    selectionLayer.dataset.reviewSelectionLayer = "true";
    root.appendChild(selectionLayer);
  }
  Object.assign(selectionLayer.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: reviewEnabled ? "auto" : "none",
    cursor: reviewEnabled ? "crosshair" : "default",
    touchAction: "none",
    background: "transparent",
  });
}

function resolveXPath(fullXPath: string) {
  try {
    const result = document.evaluate(
      fullXPath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
  } catch {
    return null;
  }
}

function renderImageAnnotations(root: HTMLDivElement) {
  const image = directImageElement();
  const displayRect = imageDisplayRect();
  if (!image || !displayRect) return;
  positionSelectionLayer(displayRect);
  for (const annotation of annotations) {
    if (annotation.kind !== "image-region") continue;
    const rect = annotation.normalizedRect;
    root.appendChild(createBox({
      x: displayRect.left + rect.x * displayRect.width,
      y: displayRect.top + rect.y * displayRect.height,
      width: rect.width * displayRect.width,
      height: rect.height * displayRect.height,
    }, annotation.number));
  }
}

function renderHtmlAnnotations(root: HTMLDivElement) {
  positionSelectionLayer(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  for (const annotation of annotations) {
    if (annotation.kind !== "html-element") continue;
    const element = resolveXPath(annotation.fullXPath);
    if (!element) {
      if (!invalidAnnotationIds.has(annotation.id)) {
        invalidAnnotationIds.add(annotation.id);
        sendEvent({
          event: "annotation-invalid",
          version: WORK_PANEL_REVIEW_VERSION,
          annotationId: annotation.id,
          reason: "xpath_unresolved",
        });
      }
      continue;
    }
    invalidAnnotationIds.delete(annotation.id);
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    root.appendChild(createBox(rect, annotation.number));
  }
}

function reviewTargetAtPoint(clientX: number, clientY: number) {
  const elements = document.elementsFromPoint(clientX, clientY);
  return elements.find((element) => !element.closest(`#${OVERLAY_ROOT_ID}`)) ?? null;
}

function renderOverlay() {
  clearOverlay();
  if (!reviewEnabled || !reviewKind || !isReviewableDocument()) return;
  const root = ensureOverlayRoot();
  if (reviewKind === "image") renderImageAnnotations(root);
  else renderHtmlAnnotations(root);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function installImageSelection() {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  document.addEventListener("pointerdown", (event) => {
    if (
      !reviewEnabled ||
      reviewKind !== "image" ||
      !(event.target instanceof Element) ||
      event.target.getAttribute("data-review-selection-layer") !== "true" ||
      event.button !== 0
    ) return;
    const rect = imageDisplayRect();
    if (!rect) return;
    pointerId = event.pointerId;
    startX = clamp(event.clientX, rect.left, rect.right);
    startY = clamp(event.clientY, rect.top, rect.bottom);
    (event.target as Element & { setPointerCapture?(id: number): void }).setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId || !reviewEnabled || reviewKind !== "image") return;
    const rect = imageDisplayRect();
    const root = ensureOverlayRoot();
    if (!rect) return;
    const endX = clamp(event.clientX, rect.left, rect.right);
    const endY = clamp(event.clientY, rect.top, rect.bottom);
    draftBox?.remove();
    draftBox = createBox({
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      width: Math.abs(endX - startX),
      height: Math.abs(endY - startY),
    }, undefined, true);
    root.appendChild(draftBox);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    draftBox?.remove();
    draftBox = null;
    const image = directImageElement();
    const displayRect = imageDisplayRect();
    if (!image || !displayRect || !reviewEnabled || reviewKind !== "image") return;
    const endX = clamp(event.clientX, displayRect.left, displayRect.right);
    const endY = clamp(event.clientY, displayRect.top, displayRect.bottom);
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    if (width < 3 || height < 3 || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const normalizedRect = {
      x: (left - displayRect.left) / displayRect.width,
      y: (top - displayRect.top) / displayRect.height,
      width: width / displayRect.width,
      height: height / displayRect.height,
    };
    sendEvent({
      event: "image-region-created",
      version: WORK_PANEL_REVIEW_VERSION,
      rect: {
        x: normalizedRect.x * image.naturalWidth,
        y: normalizedRect.y * image.naturalHeight,
        width: normalizedRect.width * image.naturalWidth,
        height: normalizedRect.height * image.naturalHeight,
      },
      normalizedRect,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
    });
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", finish, true);
}

function fullXPath(element: Element) {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (!tag) return "";
    if (tag === "html") {
      segments.unshift("html");
      break;
    }
    const parentElement: Element | null = current.parentElement;
    if (!parentElement) return "";
    const currentTagName = current.tagName;
    const siblings = Array.from(parentElement.children).filter(
      (candidate: Element) => candidate.tagName === currentTagName,
    );
    const index = siblings.indexOf(current);
    segments.unshift(siblings.length > 1 ? `${tag}[${index + 1}]` : tag);
    current = parentElement;
  }
  return segments.length > 0 ? `/${segments.join("/")}` : "";
}

function cssIdentifier(value: string) {
  if (!value || value.length > 120 || /token|secret|password|auth|key/iu.test(value)) return "";
  try {
    return CSS.escape(value);
  } catch {
    return "";
  }
}

function auxiliaryCssSelector(element: Element) {
  const id = cssIdentifier(element.id);
  if (id) return `#${id}`;
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && segments.length < 6) {
    const tag = current.tagName.toLowerCase();
    if (!tag) break;
    const parentElement: Element | null = current.parentElement;
    if (!parentElement || tag === "html") {
      segments.unshift(tag);
      break;
    }
    const currentTagName = current.tagName;
    const sameTag = Array.from(parentElement.children).filter(
      (candidate: Element) => candidate.tagName === currentTagName,
    );
    const index = sameTag.indexOf(current);
    segments.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag);
    current = parentElement;
  }
  return segments.join(" > ").slice(0, 1_024);
}

function sanitizeExcerpt(value: string, max: number) {
  return value
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(
      /\b(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function safeElementAttributes(element: Element) {
  const result: Record<string, string> = {};
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") return result;
  for (const name of ["role", "aria-label", "data-testid", "type", "name"] as const) {
    if (/token|secret|password|auth|key/iu.test(name)) continue;
    const value = sanitizeExcerpt(element.getAttribute(name) || "", 160);
    if (value) result[name] = value;
  }
  return result;
}

function inspectElement(element: Element) {
  const xpath = fullXPath(element);
  const rect = element.getBoundingClientRect();
  if (!xpath || rect.width <= 0 || rect.height <= 0) return null;
  const sensitiveInput = element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    Boolean(element.closest("input[type='password']"));
  return {
    event: "html-element-selected" as const,
    version: WORK_PANEL_REVIEW_VERSION,
    fullXPath: xpath,
    cssSelector: auxiliaryCssSelector(element),
    tagName: element.tagName.toLowerCase().slice(0, 64),
    attributes: safeElementAttributes(element),
    textExcerpt: sensitiveInput ? "" : sanitizeExcerpt(element.textContent || "", 240),
    rect: {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    },
  };
}

function installHtmlSelection() {
  document.addEventListener("pointermove", (event) => {
    if (!reviewEnabled || reviewKind !== "html") return;
    const element = reviewTargetAtPoint(event.clientX, event.clientY);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    hoverBox?.remove();
    hoverBox = rect.width > 0 && rect.height > 0 ? createBox(rect, undefined, true) : null;
    if (hoverBox) ensureOverlayRoot().appendChild(hoverBox);
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!reviewEnabled || reviewKind !== "html") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (!reviewEnabled || reviewKind !== "html") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = reviewTargetAtPoint(event.clientX, event.clientY);
    if (!element) return;
    const inspected = inspectElement(element);
    if (inspected) sendEvent(inspected);
  }, true);

  document.addEventListener("click", (event) => {
    if (!reviewEnabled || reviewKind !== "html") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("submit", (event) => {
    if (!reviewEnabled || reviewKind !== "html") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

async function exportAnnotatedImage(requestId: string, imageAnnotations: ImageRegionAnnotation[]) {
  const image = directImageElement();
  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    sendEvent({
      event: "image-exported",
      version: WORK_PANEL_REVIEW_VERSION,
      requestId,
      ok: false,
      code: "image_unavailable",
      message: "The original image is unavailable.",
    });
    return;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (
    width > WORK_PANEL_REVIEW_MAX_IMAGE_SIDE ||
    height > WORK_PANEL_REVIEW_MAX_IMAGE_SIDE ||
    width * height > WORK_PANEL_REVIEW_MAX_IMAGE_PIXELS
  ) {
    sendEvent({
      event: "image-exported",
      version: WORK_PANEL_REVIEW_VERSION,
      requestId,
      ok: false,
      code: "image_too_large",
      message: "The image is too large to render a safe annotation preview.",
    });
    return;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, width, height);
    const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 360));
    const labelSize = Math.max(22, Math.round(Math.min(width, height) / 22));
    context.strokeStyle = REVIEW_COLOR;
    context.fillStyle = REVIEW_COLOR;
    context.lineWidth = lineWidth;
    context.font = `700 ${Math.max(14, Math.round(labelSize * 0.5))}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const annotation of imageAnnotations) {
      const { x, y, width: rectWidth, height: rectHeight } = annotation.rect;
      context.strokeRect(x, y, rectWidth, rectHeight);
      const centerX = clamp(x, labelSize / 2, width - labelSize / 2);
      const centerY = clamp(y, labelSize / 2, height - labelSize / 2);
      context.beginPath();
      context.arc(centerX, centerY, labelSize / 2, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fff";
      context.fillText(String(annotation.number), centerX, centerY);
      context.fillStyle = REVIEW_COLOR;
    }
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const paddingBytes = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const sizeBytes = Math.floor(base64.length * 0.75) - paddingBytes;
    if (sizeBytes > WORK_PANEL_REVIEW_MAX_PNG_BYTES) {
      throw new Error("The annotated PNG exceeds the Desktop size limit");
    }
    sendEvent({
      event: "image-exported",
      version: WORK_PANEL_REVIEW_VERSION,
      requestId,
      ok: true,
      dataUrl,
      width,
      height,
      sizeBytes,
    });
  } catch (error) {
    sendEvent({
      event: "image-exported",
      version: WORK_PANEL_REVIEW_VERSION,
      requestId,
      ok: false,
      code: "image_export_failed",
      message: error instanceof Error ? error.message : "Annotated image export failed.",
    });
  }
}

function handleAction(value: unknown) {
  if (!isReviewableDocument() || !isRecord(value) || value.version !== WORK_PANEL_REVIEW_VERSION) return;
  const action = value.action;
  if (action === "initialize" || action === "sync") {
    const kind = value.kind === "html" || value.kind === "image" ? value.kind : null;
    if (!kind || typeof value.enabled !== "boolean") return;
    reviewKind = kind;
    annotations = readAnnotations(value.annotations, kind);
    invalidAnnotationIds = new Set();
    if (!documentAcceptsReviewKind(kind)) {
      reviewEnabled = false;
      clearOverlay();
      sendEvent({
        event: "unavailable",
        version: WORK_PANEL_REVIEW_VERSION,
        kind,
        reason: "unsupported_document_type",
      });
      return;
    }
    reviewEnabled = value.enabled;
    renderOverlay();
    const image = kind === "image" ? directImageElement() : null;
    sendEvent({
      event: "ready",
      version: WORK_PANEL_REVIEW_VERSION,
      kind,
      ...(image ? { width: image.naturalWidth, height: image.naturalHeight } : {}),
    });
    return;
  }
  if (action === "export-image" && typeof value.requestId === "string" && reviewKind === "image") {
    const imageAnnotations = readAnnotations(value.annotations, "image")
      .filter((annotation): annotation is ImageRegionAnnotation => annotation.kind === "image-region");
    void exportAnnotatedImage(value.requestId.slice(0, 128), imageAnnotations);
  }
}

if (isReviewableDocument()) {
  installImageSelection();
  installHtmlSelection();
  ipcRenderer.on(WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL, (_event, action: WorkPanelPreviewReviewAction) => {
    handleAction(action);
  });
  window.addEventListener("scroll", scheduleRender, true);
  window.addEventListener("resize", scheduleRender);
  window.addEventListener("pagehide", clearOverlay, { once: true });
}
