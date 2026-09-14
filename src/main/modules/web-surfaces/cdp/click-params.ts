import type { DesktopClickParams } from "../../../../shared/desktop-click";

export function validateClickParams(value: unknown): asserts value is DesktopClickParams {
  const fail = (message: string): never => { throw Object.assign(new Error(message), { code: "invalid_args" }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Input.click params must be an object");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !["selector", "x", "y", "waitFor", "timeoutMs"].includes(k))) fail("Unknown Input.click parameter");
  const has = (k: string) => Object.hasOwn(p, k);
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 4096;
  if (has("selector")) {
    if (!text(p.selector) || has("x") || has("y")) fail("Use either selector or x/y, never both");
  } else if (![p.x, p.y].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    fail("x and y must both be finite non-negative JSON numbers");
  }
  if (has("timeoutMs") && !(typeof p.timeoutMs === "number" && Number.isInteger(p.timeoutMs) && p.timeoutMs >= 100 && p.timeoutMs <= 10000)) fail("timeoutMs must be an integer from 100 to 10000");
  if (!has("waitFor")) return;
  if (!p.waitFor || typeof p.waitFor !== "object" || Array.isArray(p.waitFor)) fail("waitFor must be an object or omitted");
  const w = p.waitFor as Record<string, unknown>;
  if (Object.keys(w).some(k => !["selector", "state", "value", "checked"].includes(k))) fail("Unknown waitFor parameter");
  if (!["visible", "hidden", "value", "checked", "url"].includes(w.state as string)) fail("Unsupported waitFor state");
  if (w.state === "url") {
    if (!text(w.value) || Object.hasOwn(w, "selector")) fail("URL condition requires value and no selector");
  } else if (!text(w.selector)) fail("waitFor.selector is required");
  if (w.state === "value" && typeof w.value !== "string") fail("Value condition requires a string value");
  if (w.state !== "url" && w.state !== "value" && Object.hasOwn(w, "value")) fail("value is only valid for value/url conditions");
  if (w.state === "checked" ? typeof w.checked !== "boolean" : Object.hasOwn(w, "checked")) fail("checked condition requires a boolean checked, exclusive to that state");
}
