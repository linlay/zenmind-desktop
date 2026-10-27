import type { DesktopClickWait } from "../../../../shared/desktop-click";
import { validateClickParams } from "./click-params";

export type SurfaceObserveParams = { maxTextLength?: number; maxElements?: number; viewportOnly?: boolean };
export type SurfaceRefParams = { observationId: string; ref: string; timeoutMs?: number };
export type SurfaceClickParams = SurfaceRefParams & { waitFor?: DesktopClickWait; captureDownload?: boolean };
export type SurfaceInteractAction = "fill" | "select" | "focus" | "scroll" | "type" | "press" | "hover" | "check" | "uncheck";
/** One target at most: an observed ref, a unique CSS selector, or (scroll/type/press only) the focused page. */
export type SurfaceInteractParams = {
  action: SurfaceInteractAction;
  observationId?: string;
  ref?: string;
  selector?: string;
  value?: string;
  values?: string[];
  key?: SurfacePressKey;
  deltaX?: number;
  deltaY?: number;
  timeoutMs?: number;
};
export type SurfaceScrollParams = { deltaX?: number; deltaY?: number };

export const SURFACE_PRESS_KEYS = [
  "Enter", "Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "Space", "ControlOrMeta+A",
] as const;
export type SurfacePressKey = typeof SURFACE_PRESS_KEYS[number];

export const DEFAULT_OBSERVATION_TEXT_LENGTH = 12_000;
export const DEFAULT_OBSERVATION_ELEMENTS = 200;
/** type dispatches one key event pair per character; longer text belongs to fill. */
export const SURFACE_TYPE_MAX_LENGTH = 2_000;
export const SURFACE_SCROLL_MAX_DELTA = 2_000;
export const SURFACE_SCROLL_DEFAULT_DELTA_Y = 600;

const interactActions: readonly SurfaceInteractAction[] = ["fill", "select", "focus", "scroll", "type", "press", "hover", "check", "uncheck"];
const untargetedActions: readonly SurfaceInteractAction[] = ["scroll", "type", "press"];

/** Preflight before the gateway acquires focus or changes a page. Values are never echoed. */
export function validateObservationParams(method: string, input: unknown): void {
  const fail = (message: string): never => { throw new Error(message); };
  if (input === undefined && (method === "Surface.observe" || method === "Surface.scroll")) return;
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${method} params must be an object`);
  const p = input as Record<string, unknown>;
  const allowed = method === "Surface.observe" ? ["maxTextLength", "maxElements", "viewportOnly"]
    : method === "Surface.click" ? ["observationId", "ref", "waitFor", "timeoutMs", "captureDownload"]
      : method === "Surface.scroll" ? ["deltaX", "deltaY"]
        : ["observationId", "ref", "selector", "action", "value", "values", "key", "deltaX", "deltaY", "timeoutMs"];
  if (Object.keys(p).some((key) => !allowed.includes(key))) fail(`Unknown ${method} parameter`);
  const integer = (name: string, min: number, max: number) => {
    if (Object.hasOwn(p, name) && !(Number.isInteger(p[name]) && (p[name] as number) >= min && (p[name] as number) <= max)) {
      fail(`${name} must be an integer from ${min} to ${max}`);
    }
  };
  const delta = (name: string) => {
    const value = p[name];
    if (Object.hasOwn(p, name) && !(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= SURFACE_SCROLL_MAX_DELTA)) {
      fail(`${name} must be a finite number from -${SURFACE_SCROLL_MAX_DELTA} to ${SURFACE_SCROLL_MAX_DELTA}`);
    }
  };
  const identifier = (name: string) => {
    if (typeof p[name] !== "string" || !(p[name] as string).trim() || (p[name] as string).length > 200) {
      fail(`${name} must be a non-empty string of at most 200 characters`);
    }
  };
  if (method === "Surface.observe") {
    integer("maxTextLength", 1, 30_000);
    integer("maxElements", 1, 500);
    if (Object.hasOwn(p, "viewportOnly") && typeof p.viewportOnly !== "boolean") fail("viewportOnly must be a boolean");
    return;
  }
  if (method === "Surface.scroll") {
    delta("deltaX");
    delta("deltaY");
    return;
  }
  integer("timeoutMs", 100, 10_000);
  if (method === "Surface.click") {
    identifier("observationId");
    identifier("ref");
    // Reuse the existing click condition contract without accepting coordinates/selectors.
    validateClickParams({ x: 0, y: 0, ...(Object.hasOwn(p, "waitFor") ? { waitFor: p.waitFor } : {}),
      ...(Object.hasOwn(p, "timeoutMs") ? { timeoutMs: p.timeoutMs } : {}),
      ...(Object.hasOwn(p, "captureDownload") ? { captureDownload: p.captureDownload } : {}) });
    return;
  }
  const action = p.action as SurfaceInteractAction;
  if (!interactActions.includes(action)) fail("Unsupported Surface.interact action");
  const hasRef = Object.hasOwn(p, "ref") || Object.hasOwn(p, "observationId");
  const hasSelector = Object.hasOwn(p, "selector");
  if (hasRef) { identifier("observationId"); identifier("ref"); }
  if (hasSelector && (typeof p.selector !== "string" || !p.selector.trim() || p.selector.length > 4096)) {
    fail("selector must be a non-empty string of at most 4096 characters");
  }
  if (hasRef && hasSelector) fail("Use an observed ref or a selector, never both");
  if (!hasRef && !hasSelector && !untargetedActions.includes(action)) fail(`${action} requires an observed ref or a selector`);
  if (Object.hasOwn(p, "values") && action !== "select") fail("values is only accepted for select");
  if (Object.hasOwn(p, "key") && action !== "press") fail("key is only accepted for press");
  if ((Object.hasOwn(p, "deltaX") || Object.hasOwn(p, "deltaY")) && (action !== "scroll" || hasRef || hasSelector)) {
    fail("deltaX/deltaY are only accepted for scroll without an element target");
  }
  delta("deltaX");
  delta("deltaY");
  if (action === "fill") {
    if (typeof p.value !== "string" || p.value.length > 30_000) fail("fill requires a string value of at most 30000 characters");
  } else if (action === "select") {
    if (Object.hasOwn(p, "values")) {
      if (Object.hasOwn(p, "value")) fail("Use value or values, never both");
      if (!Array.isArray(p.values) || p.values.length > 100 || !p.values.every((value) => typeof value === "string" && value.length <= 4096)) {
        fail("values must be an array of at most 100 strings of at most 4096 characters");
      }
    } else if (typeof p.value !== "string" || p.value.length > 4096) fail("select requires a string value of at most 4096 characters");
  } else if (action === "type") {
    if (typeof p.value !== "string" || !p.value || p.value.length > SURFACE_TYPE_MAX_LENGTH) {
      fail(`type requires a non-empty string value of at most ${SURFACE_TYPE_MAX_LENGTH} characters; use fill for longer text`);
    }
  } else if (Object.hasOwn(p, "value")) fail("value is only accepted for fill, select and type");
  if (action === "press" && !SURFACE_PRESS_KEYS.includes(p.key as SurfacePressKey)) fail("press requires an allowed key");
}
