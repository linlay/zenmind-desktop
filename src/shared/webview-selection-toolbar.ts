import type { WebviewContextMenuSemanticTargetKind, WebviewContextMenuSurfaceType } from "./webview-context-menu";

export const WEBVIEW_SELECTION_TOOLBAR_VERSION = 1 as const;

export const WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL =
  "desktop:webview-selection-toolbar:change";
export const WEBVIEW_SELECTION_TOOLBAR_STATE_CHANNEL =
  "desktop:webview-selection-toolbar:state";

export type WebviewSelectionToolbarRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WebviewSelectionToolbarPoint = {
  x: number;
  y: number;
};

export type WebviewSelectionToolbarChange =
  | {
      version: typeof WEBVIEW_SELECTION_TOOLBAR_VERSION;
      visible: false;
    }
  | {
      version: typeof WEBVIEW_SELECTION_TOOLBAR_VERSION;
      visible: true;
      rect: WebviewSelectionToolbarRect;
      probe: WebviewSelectionToolbarPoint;
    };

export type WebviewSelectionToolbarState =
  | {
      version: typeof WEBVIEW_SELECTION_TOOLBAR_VERSION;
      visible: false;
      selectionId: string;
      guestId: number;
      registrationId: string;
      surfaceId: string;
    }
  | {
      version: typeof WEBVIEW_SELECTION_TOOLBAR_VERSION;
      visible: true;
      selectionId: string;
      guestId: number;
      registrationId: string;
      surfaceId: string;
      rect: WebviewSelectionToolbarRect;
    };

export type WebviewSelectionToolbarStateListener = (
  state: WebviewSelectionToolbarState
) => void;

export type WebviewSelectionToolbarPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

const MAX_COORDINATE = 100_000;
const VIEWPORT_PADDING = 8;
const TOOLBAR_GAP = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_COORDINATE;
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_COORDINATE;
}

function readRect(value: unknown): WebviewSelectionToolbarRect | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["x", "y", "width", "height"]) ||
    !isCoordinate(value.x) ||
    !isCoordinate(value.y) ||
    !isDimension(value.width) ||
    !isDimension(value.height)
  ) {
    return null;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function readPoint(value: unknown): WebviewSelectionToolbarPoint | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["x", "y"]) ||
    !isCoordinate(value.x) ||
    !isCoordinate(value.y)
  ) {
    return null;
  }
  return { x: value.x, y: value.y };
}

export function validateWebviewSelectionToolbarChange(
  value: unknown
): WebviewSelectionToolbarChange | null {
  if (!isPlainObject(value) || value.version !== WEBVIEW_SELECTION_TOOLBAR_VERSION) {
    return null;
  }
  if (value.visible === false) {
    return hasOnlyKeys(value, ["version", "visible"])
      ? {
          version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
          visible: false,
        }
      : null;
  }
  if (
    value.visible !== true ||
    !hasOnlyKeys(value, ["version", "visible", "rect", "probe"])
  ) {
    return null;
  }
  const rect = readRect(value.rect);
  const probe = readPoint(value.probe);
  if (!rect || !probe) return null;
  return {
    version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
    visible: true,
    rect,
    probe,
  };
}

export function isWebviewSelectionToolbarSurfaceAllowed(
  surfaceType: WebviewContextMenuSurfaceType
) {
  return surfaceType === "agent-chat" || surfaceType === "agent-copilot";
}

export function isWebviewSelectionToolbarTargetAllowed(
  targetKind: WebviewContextMenuSemanticTargetKind
) {
  return targetKind === "message" || targetKind === "code";
}

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return Math.max(0, maximum);
  return Math.min(Math.max(value, minimum), maximum);
}

export function resolveWebviewSelectionToolbarPosition(input: {
  anchor: WebviewSelectionToolbarRect;
  containerWidth: number;
  containerHeight: number;
  toolbarWidth: number;
  toolbarHeight: number;
}): WebviewSelectionToolbarPosition {
  const containerWidth = Math.max(0, input.containerWidth);
  const containerHeight = Math.max(0, input.containerHeight);
  const toolbarWidth = Math.max(0, input.toolbarWidth);
  const toolbarHeight = Math.max(0, input.toolbarHeight);
  const centeredLeft = input.anchor.x + input.anchor.width / 2 - toolbarWidth / 2;
  const left = clamp(
    centeredLeft,
    VIEWPORT_PADDING,
    containerWidth - toolbarWidth - VIEWPORT_PADDING
  );
  const aboveTop = input.anchor.y - toolbarHeight - TOOLBAR_GAP;
  const placement = aboveTop >= VIEWPORT_PADDING ? "above" : "below";
  const preferredTop = placement === "above"
    ? aboveTop
    : input.anchor.y + input.anchor.height + TOOLBAR_GAP;
  const top = clamp(
    preferredTop,
    VIEWPORT_PADDING,
    containerHeight - toolbarHeight - VIEWPORT_PADDING
  );
  return { left, top, placement };
}
