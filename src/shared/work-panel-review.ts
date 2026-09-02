export const WORK_PANEL_REVIEW_VERSION = 1 as const;
export const WORK_PANEL_REVIEW_MAX_ANNOTATIONS = 50;
export const WORK_PANEL_REVIEW_MAX_REQUIREMENT_CHARS = 1_000;
export const WORK_PANEL_REVIEW_MAX_PNG_BYTES = 12 * 1024 * 1024;
export const WORK_PANEL_REVIEW_MAX_IMAGE_PIXELS = 40_000_000;
export const WORK_PANEL_REVIEW_MAX_IMAGE_SIDE = 8_192;

export const WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL =
  "workPanel.previewReview.action" as const;
export const WORK_PANEL_PREVIEW_REVIEW_EVENT_CHANNEL =
  "workPanel.previewReview.event" as const;

export type WorkPanelReviewKind = "image" | "html";
export type WorkPanelReviewSourceKind = "workspace-file" | "artifact" | "reference" | "web";

export type WorkPanelPixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkPanelNormalizedRect = WorkPanelPixelRect;

function finiteReviewNumber(value: unknown, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

export function normalizeWorkPanelPixelRect(value: unknown): WorkPanelPixelRect | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rect = value as Record<string, unknown>;
  const x = finiteReviewNumber(rect.x, Number.MAX_SAFE_INTEGER);
  const y = finiteReviewNumber(rect.y, Number.MAX_SAFE_INTEGER);
  const width = finiteReviewNumber(rect.width, Number.MAX_SAFE_INTEGER);
  const height = finiteReviewNumber(rect.height, Number.MAX_SAFE_INTEGER);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

export function normalizeWorkPanelNormalizedRect(value: unknown): WorkPanelNormalizedRect | null {
  const rect = normalizeWorkPanelPixelRect(value);
  if (
    !rect ||
    rect.x > 1 ||
    rect.y > 1 ||
    rect.width > 1 ||
    rect.height > 1 ||
    rect.x + rect.width > 1.000_001 ||
    rect.y + rect.height > 1.000_001
  ) return null;
  return rect;
}

export function workPanelPixelRectFromNormalized(
  value: WorkPanelNormalizedRect,
  imageWidth: number,
  imageHeight: number,
): WorkPanelPixelRect | null {
  const rect = normalizeWorkPanelNormalizedRect(value);
  if (
    !rect ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) return null;
  return {
    x: Math.round(rect.x * imageWidth),
    y: Math.round(rect.y * imageHeight),
    width: Math.round(rect.width * imageWidth),
    height: Math.round(rect.height * imageHeight),
  };
}

export type ReviewSourceRevision = {
  sourceKind: WorkPanelReviewSourceKind;
  fileName: string;
  revision: string;
  relativePath?: string;
  resourceId?: string;
  url?: string;
  liveProjectWeb?: true;
};

export function isLoopbackWorkPanelReviewUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
    const octets = host.split(".");
    return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
      const number = Number(octet);
      return /^\d{1,3}$/u.test(octet) && number >= 0 && number <= 255;
    });
  } catch {
    return false;
  }
}

const SENSITIVE_WEB_REVIEW_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|key|secret|password|passwd|authorization|auth|credential|session|jwt|code|signature|sig)(?:$|[_-])/iu;

export function sanitizeWorkPanelReviewWebUrl(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return "";
    }
    for (const key of new Set(url.searchParams.keys())) {
      if (SENSITIVE_WEB_REVIEW_PARAMETER.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    let decodedHash = url.hash;
    try {
      decodedHash = decodeURIComponent(url.hash);
    } catch {
      // An invalid escape remains opaque and is preserved unless its raw form looks sensitive.
    }
    const hashContainsSensitiveParameter = decodedHash
      .replace(/^#/u, "")
      .split(/[?&;]/u)
      .some((part) => SENSITIVE_WEB_REVIEW_PARAMETER.test(part.split("=")[0] ?? ""));
    if (hashContainsSensitiveParameter) {
      url.hash = "redacted";
    }
    return url.toString();
  } catch {
    return "";
  }
}

export type ImageRegionAnnotation = {
  id: string;
  number: number;
  kind: "image-region";
  rect: WorkPanelPixelRect;
  normalizedRect: WorkPanelNormalizedRect;
  requirement: string;
  invalidReason?: string;
};

export type HtmlElementAnnotation = {
  id: string;
  number: number;
  kind: "html-element";
  fullXPath: string;
  cssSelector: string;
  tagName: string;
  attributes: Record<string, string>;
  textExcerpt: string;
  rect: WorkPanelPixelRect;
  requirement: string;
  invalidReason?: string;
};

export type WorkPanelReviewAnnotation = ImageRegionAnnotation | HtmlElementAnnotation;

export type WorkPanelReviewSession = {
  version: typeof WORK_PANEL_REVIEW_VERSION;
  ownerChatId: string;
  itemId: string;
  kind: WorkPanelReviewKind;
  source: ReviewSourceRevision;
  annotations: WorkPanelReviewAnnotation[];
  invalidReason?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkPanelReviewRuntimeState = {
  sessionsByKey: Record<string, WorkPanelReviewSession>;
  activeItemIdsByOwnerChatId: Record<string, string>;
};

export const EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE: WorkPanelReviewRuntimeState = {
  sessionsByKey: {},
  activeItemIdsByOwnerChatId: {},
};

export type WorkPanelPreviewReviewAction =
  | {
      action: "initialize" | "sync";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      kind: WorkPanelReviewKind;
      enabled: boolean;
      annotations: WorkPanelReviewAnnotation[];
    }
  | {
      action: "export-image";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      requestId: string;
      annotations: ImageRegionAnnotation[];
    };

export type WorkPanelPreviewReviewEvent =
  | {
      event: "capability";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      requestId: string;
      kind: WorkPanelReviewKind | null;
      fileName?: string;
      revision?: string;
    }
  | {
      event: "ready";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      kind: WorkPanelReviewKind;
      width?: number;
      height?: number;
    }
  | {
      event: "unavailable";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      kind: WorkPanelReviewKind;
      reason: "unsupported_document_type";
    }
  | {
      event: "image-region-created";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      rect: WorkPanelPixelRect;
      normalizedRect: WorkPanelNormalizedRect;
      imageWidth: number;
      imageHeight: number;
    }
  | {
      event: "html-element-selected";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      fullXPath: string;
      cssSelector: string;
      tagName: string;
      attributes: Record<string, string>;
      textExcerpt: string;
      rect: WorkPanelPixelRect;
    }
  | {
      event: "annotation-invalid";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      annotationId: string;
      reason: string;
    }
  | {
      event: "image-exported";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      requestId: string;
      ok: true;
      dataUrl: string;
      width: number;
      height: number;
      sizeBytes: number;
    }
  | {
      event: "image-exported" | "error";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      requestId?: string;
      ok: false;
      code: string;
      message: string;
    }
  | {
      event: "composer-draft-result";
      version: typeof WORK_PANEL_REVIEW_VERSION;
      requestId: string;
      ok: boolean;
      code?: string;
      message?: string;
    };

export function workPanelReviewSessionKey(ownerChatId: string, itemId: string) {
  return `${ownerChatId}\u0000${itemId}`;
}

export function getWorkPanelReviewSession(
  state: WorkPanelReviewRuntimeState,
  ownerChatId: string,
  itemId: string,
) {
  return state.sessionsByKey[workPanelReviewSessionKey(ownerChatId, itemId)] ?? null;
}

export function hasWorkPanelReviewDraft(session: WorkPanelReviewSession | null | undefined) {
  return Boolean(session?.annotations.length);
}

export function isWorkPanelReviewReadyForComposer(session: WorkPanelReviewSession) {
  return Boolean(
    session.annotations.length > 0 &&
    !session.invalidReason &&
    session.annotations.every((annotation) =>
      !annotation.invalidReason && Boolean(annotation.requirement.trim()),
    ),
  );
}

export function renumberWorkPanelReviewAnnotations(
  annotations: WorkPanelReviewAnnotation[],
) {
  return annotations.map((annotation, index) => ({
    ...annotation,
    number: index + 1,
  }));
}

function cleanDraftFilename(value: string) {
  const normalized = value.replace(/[\r\n\u0000-\u001f\u007f]/gu, "").trim();
  return normalized.slice(0, 240) || "preview";
}

function roundRect(rect: WorkPanelPixelRect) {
  return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value));
}

export function buildWorkPanelReviewComposerDraft(
  session: WorkPanelReviewSession,
  imageSize?: { width: number; height: number },
) {
  const fileName = cleanDraftFilename(
    session.source.relativePath || session.source.url || session.source.fileName,
  );
  if (session.kind === "image") {
    const size = imageSize && Number.isFinite(imageSize.width) && Number.isFinite(imageSize.height)
      ? `${Math.round(imageSize.width)} × ${Math.round(imageSize.height)}`
      : "未知";
    const lines = [
      `请根据以下标注修改 ${fileName}。`,
      "",
      `原图尺寸：${size}`,
      "坐标格式：[x, y, width, height]，原点为图片左上角。",
      "",
    ];
    for (const annotation of session.annotations) {
      if (annotation.kind !== "image-region") continue;
      lines.push(`标注区 ${annotation.number}：坐标 [${roundRect(annotation.rect).join(", ")}]`);
      lines.push(`标注要求：${annotation.requirement.trim()}`);
      lines.push("");
    }
    lines.push("只修改标注要求涉及的区域，其他内容保持不变。");
    if (session.source.sourceKind === "workspace-file") {
      lines.push("原位修改 workspace 文件，完成后刷新当前 WorkPanel 标签页。");
    } else {
      lines.push("保留原资源，生成一个新版本，并在 WorkPanel 中打开新版本。");
    }
    return lines.join("\n");
  }

  const lines = [`请根据以下元素批注修改 ${fileName}。`, ""];
  for (const annotation of session.annotations) {
    if (annotation.kind !== "html-element") continue;
    lines.push(`标注元素 ${annotation.number}：${annotation.fullXPath}`);
    lines.push(`标注要求：${annotation.requirement.trim()}`);
    lines.push("");
  }
  lines.push("只修改标注要求涉及的元素，其他内容保持不变。");
  if (session.source.sourceKind === "workspace-file") {
    lines.push("原位修改 workspace 文件，完成后刷新当前 WorkPanel 标签页。");
  } else if (session.source.sourceKind === "web" && session.source.liveProjectWeb) {
    lines.push("这是当前 Coder workspace 的实时 loopback 预览；请按元素定位修改 workspace 源码，不要直接改浏览器临时 DOM，完成后通过 HMR 或刷新验证。");
  } else if (session.source.sourceKind === "web") {
    lines.push("这是当前网页的可视化元素批注；请结合页面 URL 与元素定位修改对应实现，无法定位源码时先说明限制，不要猜测修改。");
  } else {
    lines.push("保留原资源，生成一个新版本，并在 WorkPanel 中打开新版本。");
  }
  return lines.join("\n");
}
