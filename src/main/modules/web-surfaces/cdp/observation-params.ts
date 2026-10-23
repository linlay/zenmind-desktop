import type { DesktopClickWait } from "../../../../shared/desktop-click";
import { validateClickParams } from "./click-params";

export type SurfaceObserveParams = { maxTextLength?: number; maxElements?: number };
export type SurfaceRefParams = { observationId: string; ref: string; timeoutMs?: number };
export type SurfaceClickParams = SurfaceRefParams & { waitFor?: DesktopClickWait };
export type SurfaceInteractParams = SurfaceRefParams & {
  action: "fill" | "select" | "focus" | "scroll";
  value?: string;
};

export const DEFAULT_OBSERVATION_TEXT_LENGTH = 12_000;
export const DEFAULT_OBSERVATION_ELEMENTS = 200;

/** Preflight before the gateway acquires focus or changes a page. Values are never echoed. */
export function validateObservationParams(method: string, input: unknown): void {
  const fail = (message: string): never => { throw new Error(message); };
  if (input === undefined && method === "Surface.observe") return;
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${method} params must be an object`);
  const p = input as Record<string, unknown>;
  const allowed = method === "Surface.observe" ? ["maxTextLength", "maxElements"]
    : method === "Surface.click" ? ["observationId", "ref", "waitFor", "timeoutMs"]
      : ["observationId", "ref", "action", "value", "timeoutMs"];
  if (Object.keys(p).some((key) => !allowed.includes(key))) fail(`Unknown ${method} parameter`);
  const integer = (name: string, min: number, max: number) => {
    if (Object.hasOwn(p, name) && !(Number.isInteger(p[name]) && (p[name] as number) >= min && (p[name] as number) <= max)) {
      fail(`${name} must be an integer from ${min} to ${max}`);
    }
  };
  if (method === "Surface.observe") {
    integer("maxTextLength", 1, 30_000);
    integer("maxElements", 1, 500);
    return;
  }
  for (const name of ["observationId", "ref"]) {
    if (typeof p[name] !== "string" || !(p[name] as string).trim() || (p[name] as string).length > 200) {
      fail(`${name} must be a non-empty string of at most 200 characters`);
    }
  }
  integer("timeoutMs", 100, 10_000);
  if (method === "Surface.click") {
    // Reuse the existing click condition contract without accepting coordinates/selectors.
    validateClickParams({ x: 0, y: 0, ...(Object.hasOwn(p, "waitFor") ? { waitFor: p.waitFor } : {}),
      ...(Object.hasOwn(p, "timeoutMs") ? { timeoutMs: p.timeoutMs } : {}) });
    return;
  }
  if (!["fill", "select", "focus", "scroll"].includes(p.action as string)) fail("Unsupported Surface.interact action");
  if (p.action === "fill" || p.action === "select") {
    if (typeof p.value !== "string" || p.value.length > 30_000) fail("fill/select requires a string value of at most 30000 characters");
  } else if (Object.hasOwn(p, "value")) fail("value is only accepted for fill/select");
}
